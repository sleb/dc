import { describe, expect, test } from "bun:test";
import type { Command, RoundDoc } from "@dc/contracts";
import { RoundDocSchema } from "@dc/contracts";
import { DRAFT_REGION_FIELDS, PROJECTOR_REV, VIEW_REGION_FIELDS, decide, toRoundDoc, viewersOf } from "@dc/engine";
import type { Actor, Game } from "@dc/engine";
import { Timestamp } from "firebase-admin/firestore";
import { StoreError } from "./errors";
import { idemId } from "./idem";
import { extraReadPaths, planCommand } from "./plan";
import type { Plan, PlanDeps, Reads } from "./plan";
import { draftPath, eventPath, gamePath, idemPath, outboxPath, roomCodePath, roundPath, viewPath } from "./refs";
import { MemGame, pid, withRepeatedHistory } from "./test-support";
import type { CommandInput, GameDoc, IdemDoc } from "./types";

// The document path is part of the contract; spelled out here until the helper lands with the green commit.
const deletionPath = (id: string): string => `deletions/${id}`;
interface DeletionJobLike {
  gameId: string; hostId: string; requestedAt: number; status: "running" | "done"; stagesDone: string[];
  seatUids: string[]; heartbeatAt: number; attempts: number; expiresAt?: Timestamp;
}
import { MAX_WRITES, increment } from "./writeset";
import type { DocWrite } from "./writeset";

// P1-P6 (LLD 3 sections 5.2-5.7): the pure planner, from the step-1 reads to an outcome and the writes. Games are real, built through `decide`.
const NOW = 50_000_000;
let minted = 0;
const DEPS: PlanDeps = { now: NOW, seed: "plan-seed", mintId: () => `c_z${(minted++).toString(36).padStart(9, "0")}` };

const docOf = (game: Game, viewsRev = PROJECTOR_REV, deleting: GameDoc["store"]["deleting"] = null): GameDoc => ({ ...game, store: { schema: 1, viewsRev, updatedAt: 1, deleting } });
const userOf = (uid: string): Actor => ({ kind: "user", uid });
const input = (game: Game, actor: Actor, cmd: Command, extra: Partial<CommandInput> = {}): CommandInput => ({ gameId: game.id, cmd, actor, idemKey: "k-1", ...extra });

/** Runs the planner the way runCommand does: the first reads, the extra paths from `store` (null where absent), then the plan. */
function plan(reads: Reads, i: CommandInput, store: Record<string, Record<string, unknown>> = {}, deps: PlanDeps = DEPS): Plan & { paths: string[] } {
  const paths = extraReadPaths(reads, i);
  const extra = new Map(paths.map((p) => [p, store[p] ?? null] as const));
  return { ...planCommand(reads, extra, i, deps), paths };
}
const byPath = (writes: readonly DocWrite[]) => new Map(writes.map((w) => [w.path, w]));
const opsOf = (writes: readonly DocWrite[]) => writes.map((w) => `${w.op} ${w.path}`);
const kindOf = (f: () => unknown): string | null => {
  try {
    f();
  } catch (e) {
    return e instanceof StoreError ? e.kind : `not a StoreError: ${String(e)}`;
  }
  return null;
};
const draftDocs = (m: MemGame) => Object.fromEntries(Object.entries(m.drafts).map(([p, d]) => [draftPath(m.game.id, p), { ...d, seq: 4, updatedAt: 1 }]));

describe("P1 step 1: missing, deleting, replay, rejection", () => {
  const m = MemGame.create().joinAll(3);
  const host = userOf(m.game.hostId);

  test("a missing game is rejected NOT_FOUND at version 0, with no extra reads and no writes", () => {
    const p = plan({ game: null, idem: null }, input(m.game, host, { type: "startGame" } as Command));
    expect(p.outcome).toEqual({ kind: "rejected", rejection: { code: "NOT_FOUND" }, version: 0 });
    expect(p.writes).toEqual([]);
    expect(p.paths).toEqual([]);
  });

  test("a deleting game is rejected NOT_FOUND, even with a ledger hit", () => {
    const idem: IdemDoc = { at: 1, expiresAt: Timestamp.fromMillis(2), commandType: "startGame", version: 9 };
    const p = plan({ game: docOf(m.game, PROJECTOR_REV, { at: 1, by: m.game.hostId }), idem }, input(m.game, host, { type: "startGame" } as Command));
    expect(p.outcome).toEqual({ kind: "rejected", rejection: { code: "NOT_FOUND" }, version: 0 });
    expect(p.writes).toEqual([]);
  });

  test("a ledger hit replays before decide: a stale expectedVersion still replays, with the stored version, draftSeq and meta and the current view", () => {
    const g = MemGame.playing(3);
    const r = g.game.round;
    if (r === null) throw new Error("round");
    const judge = g.game.players.find((p) => p.id === r.judgeId);
    if (judge === undefined) throw new Error("judge");
    const idem: IdemDoc = { at: 1, expiresAt: Timestamp.fromMillis(2), commandType: "passJudging", version: 3, draftSeq: 6, meta: { playerId: "p_aaaaaaab" } };
    const stale = { type: "passJudging", expectedVersion: 0 } as Command;
    expect(decide(g.game, stale, { now: NOW, rng: { seed: "s", int: () => 0, shuffle: (x) => [...x] }, mintId: () => "c_0000000000", actor: userOf(g.game.hostId), drafts: {} }).ok).toBe(false);
    const p = plan({ game: docOf(g.game), idem }, input(g.game, userOf(g.game.hostId), stale));
    expect(p.outcome.kind).toBe("accepted");
    if (p.outcome.kind !== "accepted") return;
    expect(p.outcome).toMatchObject({ replay: true, version: 3, draftSeq: 6, meta: { playerId: "p_aaaaaaab" } });
    expect(p.outcome.view?.version).toBe(g.game.version);
    expect(p.writes).toEqual([]);
    expect(p.paths).toEqual([]);
  });

  test("a rejection writes nothing, not even a ledger row, and carries the current version", () => {
    const p = plan({ game: docOf(m.game), idem: null }, input(m.game, userOf(m.uidOf(1)), { type: "startGame" } as Command));
    expect(p.outcome).toEqual({ kind: "rejected", rejection: { code: "NOT_AUTHORIZED" }, version: m.game.version });
    expect(p.writes).toEqual([]);
  });

  test("extra reads: the actor's draft only for saveDraft and finishWriting; nothing for other commands", () => {
    const w = MemGame.create().joinAll(3);
    w.start();
    const me = userOf(w.uidOf(1));
    const reads = { game: docOf(w.game), idem: null };
    expect(extraReadPaths(reads, input(w.game, me, { type: "saveDraft", red: [], green: [] } as Command))).toEqual([draftPath(w.game.id, pid(1))]);
    expect(extraReadPaths(reads, input(w.game, me, { type: "finishWriting" } as Command))).toEqual([draftPath(w.game.id, pid(1))]);
    expect(extraReadPaths(reads, input(w.game, me, { type: "leave" } as Command))).toEqual([]);
    expect(extraReadPaths(reads, input(w.game, userOf("stranger"), { type: "saveDraft", red: [], green: [] } as Command))).toEqual([]);
  });
});

describe("P2 the writes of an accepted aggregate change", () => {
  test("startGame: version assertion holds; full-replace aggregate with a fresh store; one event create; outbox creates; views; ledger create", () => {
    const m = MemGame.create().joinAll(3);
    const step = plan({ game: docOf(m.game, PROJECTOR_REV), idem: null }, input(m.game, userOf(m.game.hostId), { type: "startGame" } as Command));
    expect(step.outcome).toMatchObject({ kind: "accepted", version: m.game.version + 1, replay: false });
    const w = byPath(step.writes);
    const agg = w.get(gamePath(m.game.id));
    expect(agg?.op).toBe("set");
    if (agg?.op !== "set") return;
    expect(agg.data["store"]).toEqual({ schema: 1, viewsRev: PROJECTOR_REV, updatedAt: NOW, deleting: null });
    expect(agg.data["version"]).toBe(m.game.version + 1);
    expect(agg.data["phase"]).toBe("WRITING");
    const ev = w.get(eventPath(m.game.id, m.game.version + 1));
    expect(ev?.op).toBe("create");
    expect(w.get(outboxPath(m.game.id, `v${m.game.version + 1}_0`))?.op).toBe("create");
    const idem = w.get(idemPath(m.game.id, idemId(userOf(m.game.hostId), "k-1")));
    expect(idem?.op).toBe("create");
    if (idem?.op === "create") {
      expect(idem.data).toMatchObject({ at: NOW, commandType: "startGame", version: m.game.version + 1 });
      expect((idem.data["expiresAt"] as Timestamp).toMillis()).toBe(NOW + 7 * 86_400_000);
      expect(Object.hasOwn(idem.data, "draftSeq")).toBe(false);
    }
    const views = step.writes.filter((x) => x.path.includes("/views/"));
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) {
      expect(v.op).toBe("merge");
      if (v.op === "merge") expect([...v.fields].sort()).toEqual([...VIEW_REGION_FIELDS].sort());
    }
  });

  test("a version that does not advance by one is an INVARIANT and nothing is planned", () => {
    const m = MemGame.create().joinAll(3);
    const skip: PlanDeps = { ...DEPS, decide: (s, c, x) => {
      const r = decide(s, c, x);
      return r.ok ? { ok: true, value: { ...r.value, state: { ...r.value.state, version: r.value.state.version + 1 } } } : r;
    } };
    expect(kindOf(() => plan({ game: docOf(m.game), idem: null }, input(m.game, userOf(m.game.hostId), { type: "startGame" } as Command), {}, skip))).toBe("INVARIANT");
  });

  test("pickWinner creates the round doc (strict RoundDoc) with create(), never set", () => {
    const m = MemGame.playing(3);
    const r = m.game.round;
    if (r === null) throw new Error("round");
    for (const p of m.game.players) {
      const rr = m.game.round;
      if (rr === null || rr.phase !== "SUBMITTING" || p.id === rr.judgeId) continue;
      m.run(userOf(p.uid), { type: "confirmSubmission", cardId: p.hand[0], expectedVersion: rr.changedAtVersion } as Command);
    }
    const j = m.game.round;
    if (j === null || j.phase !== "JUDGING") throw new Error("judging");
    const judge = m.game.players.find((p) => p.id === j.judgeId);
    const cmd = { type: "pickWinner", submissionId: j.revealOrder?.[0], expectedVersion: j.changedAtVersion } as Command;
    const p = plan({ game: docOf(m.game), idem: null }, input(m.game, userOf(judge?.uid ?? ""), cmd));
    const rd = byPath(p.writes).get(roundPath(m.game.id, 1));
    expect(rd?.op).toBe("create");
    if (rd?.op === "create") expect(RoundDocSchema.parse(rd.data).round).toBe(1);
    expect(JSON.stringify(rd)).toContain("CARD-SENTINEL"); // round docs carry text (world-readable history), unlike events and outbox
    expect(JSON.stringify(p.writes.filter((x) => x.path.includes("/events/") || x.path.includes("/outbox/")))).not.toContain("SENTINEL");
  });

  test("FINISHED and ENDED release the room code in the same plan; other commands do not", () => {
    const m = MemGame.playing(3);
    let last: MemGame["steps"][number] | undefined;
    while (m.game.phase === "PLAYING") {
      m.submitAll();
      const before = m.game;
      const r = m.game.round;
      if (r?.phase !== "JUDGING") throw new Error("not judging");
      const judge = m.game.players.find((p) => p.id === r.judgeId);
      const cmd = { type: "pickWinner", submissionId: r.revealOrder?.[0], expectedVersion: r.changedAtVersion } as Command;
      const p = plan({ game: docOf(before), idem: null }, input(before, userOf(judge?.uid ?? ""), cmd));
      m.run(userOf(judge?.uid ?? ""), cmd);
      const del = byPath(p.writes).get(roomCodePath(before.roomCode));
      if ((m.game.phase as string) === "FINISHED") expect(del?.op).toBe("delete");
      else expect(del).toBeUndefined();
      last = m.steps.at(-1);
    }
    expect(last?.next.phase).toBe("FINISHED");
    const e = MemGame.playing(3);
    const p = plan({ game: docOf(e.game), idem: null }, input(e.game, userOf(e.game.hostId), { type: "endGame" } as Command));
    expect(byPath(p.writes).get(roomCodePath(e.game.roomCode))?.op).toBe("delete");
  });

  test("a count-changing saveDraft merges the fan-out and the actor's draft region into one write of the actor's view doc", () => {
    const m = MemGame.create().joinAll(3);
    m.start();
    const me = m.game.players[1];
    if (me === undefined) throw new Error("p1");
    const cmd = { type: "saveDraft", ...m.fullDraft(me.id) } as Command;
    const p = plan({ game: docOf(m.game), idem: null }, input(m.game, userOf(me.uid), cmd));
    const mine = p.writes.filter((x) => x.path === viewPath(m.game.id, me.uid));
    expect(mine).toHaveLength(1);
    const v = mine[0];
    expect(v?.op).toBe("merge");
    if (v?.op !== "merge") return;
    expect([...v.fields].sort()).toEqual([...VIEW_REGION_FIELDS, ...DRAFT_REGION_FIELDS].sort());
    expect(v.data["draftSeq"]).toBe(1); // no drafts doc yet: seq 0 + 1, absolute
    expect(p.outcome).toMatchObject({ kind: "accepted", version: m.game.version + 1 });
    expect(p.outcome.kind === "accepted" && Object.hasOwn(p.outcome, "draftSeq")).toBe(false);
    expect(byPath(p.writes).get(gamePath(m.game.id))?.op).toBe("set");
    expect(byPath(p.writes).get(draftPath(m.game.id, me.id))?.op).toBe("set");
  });

  test("a no-op markReminded writes nothing and returns the current version with no view", () => {
    const m = MemGame.playing(3);
    const cmd = { type: "markReminded", episode: m.game.episode, episodeGen: m.game.episodeGen } as Command;
    const p = plan({ game: docOf(m.game), idem: null }, input(m.game, { kind: "system" }, cmd, { idemKey: "remind:x:1" }), {}, { ...DEPS, now: (m.game.reminderDueAt ?? 0) - 1 });
    expect(p.outcome).toEqual({ kind: "accepted", version: m.game.version, view: null, replay: false });
    expect(p.writes).toEqual([]);
  });

  test("an accepted markReminded writes exactly the aggregate, the events doc, the Reminder row and the ledger", () => {
    const m = MemGame.playing(3);
    const cmd = { type: "markReminded", episode: m.game.episode, episodeGen: m.game.episodeGen } as Command;
    const p = plan({ game: docOf(m.game), idem: null }, input(m.game, { kind: "system" }, cmd, { idemKey: "remind:x:1" }), {}, { ...DEPS, now: m.game.reminderDueAt ?? 0 });
    const v = m.game.version + 1;
    expect(opsOf(p.writes).sort()).toEqual([`set ${gamePath(m.game.id)}`, `create ${eventPath(m.game.id, v)}`, `create ${outboxPath(m.game.id, `v${v}_0`)}`, `create ${idemPath(m.game.id, idemId({ kind: "system" }, "remind:x:1"))}`].sort());
    expect(p.outcome).toMatchObject({ kind: "accepted", version: v, view: null });
  });

  test("extraWrites run on an accept and join the plan; meta is stored in the ledger and not echoed on a fresh accept", () => {
    const m = MemGame.create().joinAll(2);
    const uid = m.uidOf(5);
    const extraWrites = ({ next }: { next: Game }): DocWrite[] => [{ op: "create", path: `games/${next.id}/seats/${pid(5)}`, data: { uid } }];
    const p = plan({ game: docOf(m.game), idem: null }, input(m.game, userOf(uid), { type: "join", playerId: pid(5), name: "NAME-SENTINEL-5" } as Command, { extraWrites, meta: { playerId: pid(5) }, idemKey: "hash" }));
    expect(byPath(p.writes).get(`games/${m.game.id}/seats/${pid(5)}`)?.op).toBe("create");
    expect(byPath(p.writes).get(viewPath(m.game.id, uid))?.op).toBe("merge");
    const idem = byPath(p.writes).get(idemPath(m.game.id, idemId(userOf(uid), "hash")));
    expect(idem?.op === "create" ? idem.data["meta"] : null).toEqual({ playerId: pid(5) });
    expect(p.outcome.kind === "accepted" && Object.hasOwn(p.outcome, "meta")).toBe(false);
    const rejected = plan({ game: docOf(m.game), idem: null }, input(m.game, userOf(uid), { type: "join", playerId: pid(5), name: "NAME-SENTINEL-0" } as Command, { extraWrites }));
    expect(rejected.outcome.kind).toBe("rejected");
    expect(rejected.writes).toEqual([]);
  });
});

describe("P3 K-F: stale viewsRev", () => {
  const m = MemGame.create().joinAll(3);
  m.start();
  const me = m.game.players[1];
  if (me === undefined) throw new Error("p1");
  m.run(userOf(me.uid), { type: "saveDraft", ...m.fullDraft(me.id) } as Command);
  const edit = { type: "saveDraft", ...m.fullDraft(me.id, " edited") } as Command;

  test("a text-only saveDraft with a stale viewsRev updates store.viewsRev and rebuilds every view at the unchanged version", () => {
    const p = plan({ game: docOf(m.game, PROJECTOR_REV - 1), idem: null }, input(m.game, userOf(me.uid), edit), draftDocs(m));
    expect(p.outcome).toMatchObject({ kind: "accepted", version: m.game.version, draftSeq: 5 });
    const agg = byPath(p.writes).get(gamePath(m.game.id));
    expect(agg).toEqual({ op: "update", path: gamePath(m.game.id), data: { "store.viewsRev": PROJECTOR_REV, "store.updatedAt": NOW } });
    const views = p.writes.filter((x) => x.path.includes("/views/"));
    expect(views.map((v) => v.path).sort()).toEqual(viewersOf(m.game).map((t) => viewPath(m.game.id, t.docId)).sort());
    for (const v of views) if (v.op === "merge") expect(v.data["version"]).toBe(m.game.version);
    expect(byPath(p.writes).get(eventPath(m.game.id, m.game.version + 1))).toBeUndefined();
  });

  test("the same save with a current viewsRev touches only the drafts doc, the actor's draft region and the ledger", () => {
    const p = plan({ game: docOf(m.game), idem: null }, input(m.game, userOf(me.uid), edit), draftDocs(m));
    expect(opsOf(p.writes).sort()).toEqual([`set ${draftPath(m.game.id, me.id)}`, `merge ${viewPath(m.game.id, me.uid)}`, `create ${idemPath(m.game.id, idemId(userOf(me.uid), "k-1"))}`].sort());
    const v = byPath(p.writes).get(viewPath(m.game.id, me.uid));
    expect(v?.op === "merge" ? [...v.fields].sort() : null).toEqual([...DRAFT_REGION_FIELDS].sort());
  });

  test("a system no-op with a stale viewsRev stays zero-write", () => {
    const g = MemGame.playing(3);
    const cmd = { type: "markReminded", episode: g.game.episode, episodeGen: g.game.episodeGen } as Command;
    const p = plan({ game: docOf(g.game, PROJECTOR_REV - 1), idem: null }, input(g.game, { kind: "system" }, cmd), {}, { ...DEPS, now: 0 });
    expect(p.writes).toEqual([]);
  });

  test("an aggregate change with a stale viewsRev rewrites every view (no skip) and records the running rev", () => {
    const p = plan({ game: docOf(m.game, PROJECTOR_REV - 1), idem: null }, input(m.game, userOf(m.uidOf(2)), { type: "saveDraft", red: ["CARD-SENTINEL-x"], green: [] } as Command));
    const agg = byPath(p.writes).get(gamePath(m.game.id));
    expect(agg?.op === "set" ? (agg.data["store"] as { viewsRev: number }).viewsRev : null).toBe(PROJECTOR_REV);
    expect(p.writes.filter((x) => x.path.includes("/views/")).length).toBe(viewersOf(m.game).length);
  });
});

describe("P4 drafts and draftSeq", () => {
  const m = MemGame.create().joinAll(3);
  m.start();
  const me = m.game.players[1];
  const other = m.game.players[2];
  if (me === undefined || other === undefined) throw new Error("players");
  m.run(userOf(me.uid), { type: "saveDraft", ...m.fullDraft(me.id) } as Command);
  m.run(userOf(other.uid), { type: "saveDraft", ...m.fullDraft(other.id) } as Command);

  test("a text-only save writes the drafts doc at the read seq + 1, an absolute draftSeq, and returns it", () => {
    const p = plan({ game: docOf(m.game), idem: null }, input(m.game, userOf(me.uid), { type: "saveDraft", ...m.fullDraft(me.id, "!") } as Command), draftDocs(m));
    const d = byPath(p.writes).get(draftPath(m.game.id, me.id));
    expect(d?.op === "set" ? d.data : null).toMatchObject({ seq: 5, updatedAt: NOW });
    const v = byPath(p.writes).get(viewPath(m.game.id, me.uid));
    expect(v?.op === "merge" ? v.data : null).toEqual({ draftSeq: 5, draft: m.fullDraft(me.id, "!") });
    expect(p.outcome).toMatchObject({ kind: "accepted", draftSeq: 5, version: m.game.version });
    const idem = p.writes.find((x) => x.path.includes("/idem/"));
    expect(idem?.op === "create" ? idem.data["draftSeq"] : null).toBe(5);
  });

  test("finishWriting deletes the drafts doc and writes the absolute seq; no draftSeq in the outcome (the aggregate changed)", () => {
    const p = plan({ game: docOf(m.game), idem: null }, input(m.game, userOf(me.uid), { type: "finishWriting" } as Command), draftDocs(m));
    expect(byPath(p.writes).get(draftPath(m.game.id, me.id))?.op).toBe("delete");
    const v = byPath(p.writes).get(viewPath(m.game.id, me.uid));
    expect(v?.op === "merge" ? { draft: v.data["draft"], draftSeq: v.data["draftSeq"] } : null).toEqual({ draft: null, draftSeq: 5 });
    expect(p.outcome.kind === "accepted" && Object.hasOwn(p.outcome, "draftSeq")).toBe(false);
  });

  test("leave (self-eviction, no draft read) clears with increment(1), merged with the fan-out clearDraft into one write", () => {
    const p = plan({ game: docOf(m.game), idem: null }, input(m.game, userOf(me.uid), { type: "leave" } as Command), draftDocs(m));
    expect(p.paths).toEqual([]);
    expect(byPath(p.writes).get(draftPath(m.game.id, me.id))?.op).toBe("delete");
    const mine = p.writes.filter((x) => x.path === viewPath(m.game.id, me.uid));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.op === "merge" ? { draft: mine[0].data["draft"], draftSeq: mine[0].data["draftSeq"] } : null).toEqual({ draft: null, draftSeq: increment(1) });
  });

  test("removePlayer of a writer clears their region with increment(1), one write to their view doc", () => {
    const p = plan({ game: docOf(m.game), idem: null }, input(m.game, userOf(m.game.hostId), { type: "removePlayer", playerId: other.id } as Command), draftDocs(m));
    const theirs = p.writes.filter((x) => x.path === viewPath(m.game.id, other.uid));
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.op === "merge" ? theirs[0].data["draftSeq"] : null).toEqual(increment(1));
    expect(byPath(p.writes).get(draftPath(m.game.id, other.id))?.op).toBe("delete");
  });
});

describe("P5 the write budget (LLD 3 section 5.7)", () => {
  test("the worst-case views (10 seated, spectator, unseated host, 40 departed) with a stale viewsRev stay within 75 writes", () => {
    const m = MemGame.departed40();
    expect(viewersOf(m.game)).toHaveLength(52);
    m.writeAll();
    const prev = m.game;
    const writer = prev.players.find((p) => p.status === "active");
    const leave = plan({ game: docOf(prev, PROJECTOR_REV - 1), idem: null }, input(prev, userOf(writer?.uid ?? ""), { type: "leave" } as Command));
    expect(leave.writes.filter((x) => x.path.includes("/views/")).length).toBe(52);
    expect(leave.writes.length).toBeLessThanOrEqual(75);
  });

  /** A PLAYING departed40 game with one more leaver (so a red card can go without breaking the minimums) and `rounds` resolved rounds that all hold one played card. */
  function recycled(rounds: number): { game: Game; cardId: string; docs: Record<string, Record<string, unknown>> } {
    const m = MemGame.departed40();
    m.writeAll();
    m.playRound();
    const leaver = m.game.players.find((p) => p.status === "active" && p.id !== m.game.round?.judgeId);
    m.run(userOf(leaver?.uid ?? ""), { type: "leave" } as Command);
    const game = withRepeatedHistory(m.game, rounds);
    const first = m.steps.map((s) => s.accepted.roundRecords).flat()[0];
    if (first === undefined) throw new Error("no round record");
    const cardId = first.plays[0]?.cardId ?? "";
    const docs: Record<string, Record<string, unknown>> = {};
    for (let n = 1; n <= rounds; n++) docs[roundPath(game.id, n)] = { ...toRoundDoc(first), round: n } as RoundDoc as unknown as Record<string, unknown>;
    return { game, cardId, docs };
  }

  test("removeCard of a card in 91 resolved rounds with every view stale stays within 146 writes, redacting each round doc once", () => {
    const { game, cardId, docs } = recycled(91);
    const p = plan({ game: docOf(game, PROJECTOR_REV - 1), idem: null }, input(game, userOf(game.hostId), { type: "removeCard", cardId } as Command), docs);
    expect(p.paths.filter((x) => x.includes("/rounds/"))).toHaveLength(91);
    const rounds = p.writes.filter((x) => x.path.includes("/rounds/"));
    expect(rounds).toHaveLength(91);
    for (const r of rounds) expect(r.op === "set" && (r.data as unknown as RoundDoc).redacted).toBe(true);
    expect(p.writes.filter((x) => x.path.includes("/views/")).length).toBe(52);
    expect(p.writes.length).toBeLessThanOrEqual(146);
    expect(p.writes.length).toBe(3 + 91 + 52);
  });

  test("above MAX_WRITES (146 rounds plus 52 views plus 3) the planner throws TOO_MANY_WRITES", () => {
    const { game, cardId, docs } = recycled(146);
    expect(MAX_WRITES).toBe(200);
    expect(kindOf(() => plan({ game: docOf(game, PROJECTOR_REV - 1), idem: null }, input(game, userOf(game.hostId), { type: "removeCard", cardId } as Command), docs))).toBe("TOO_MANY_WRITES");
  });

  test("a removeCard of a card in no round touches no round doc, and a refused one (a hand card) writes nothing", () => {
    const m = MemGame.playing(4);
    m.playRound();
    const hand = m.game.players.find((p) => p.hand.length > 0)?.hand[0] ?? "";
    const p = plan({ game: docOf(m.game), idem: null }, input(m.game, userOf(m.game.hostId), { type: "removeCard", cardId: hand } as Command));
    expect(p.paths).toEqual([]);
    expect(p.outcome.kind).toBe("rejected");
    expect(p.writes).toEqual([]);
  });
});

describe("P6 phase 0: the deleting marker, the owned code delete and the job", () => {
  const m = MemGame.create().joinAll(3);
  const host = userOf(m.game.hostId);
  const owned = { [roomCodePath(m.game.roomCode)]: { gameId: m.game.id, createdAt: 1 } };

  test("owned code: update the aggregate, delete roomCodes/{code}, create deletions/{id}; deleting outcome, no ledger, no events, no version bump", () => {
    const p = plan({ game: docOf(m.game), idem: null }, input(m.game, host, { type: "deleteGame" } as Command), owned);
    expect(p.outcome).toEqual({ kind: "deleting" });
    expect(p.writes).toHaveLength(3);
    expect(p.paths).toEqual([roomCodePath(m.game.roomCode)]);
    const w = byPath(p.writes);
    const agg = w.get(gamePath(m.game.id));
    expect(agg?.op).toBe("update");
    if (agg?.op === "update") {
      expect(agg.data).toEqual({ "store.deleting": { at: NOW, by: m.game.hostId }, "store.updatedAt": NOW });
    }
    expect(w.get(roomCodePath(m.game.roomCode))?.op).toBe("delete");
    const job = w.get(deletionPath(m.game.id));
    expect(job?.op).toBe("create");
    if (job?.op === "create") {
      const expected: Record<string, unknown> & DeletionJobLike = {
        gameId: m.game.id,
        hostId: m.game.hostId,
        requestedAt: NOW,
        status: "running",
        stagesDone: [],
        seatUids: m.game.players.map((p) => p.uid).filter((u) => u !== m.game.hostId),
        heartbeatAt: NOW,
        attempts: 0,
      };
      expect(job.data).toEqual(expected);
    }
    expect(p.writes.some((x) => x.path.includes("/events/") || x.path.includes("/idem/"))).toBe(false);
    expect(JSON.stringify(p.writes)).not.toContain(`"version":${m.game.version + 1}`);
  });

  test("a missing code doc or one owned by another game plans 2 writes and no delete", () => {
    for (const store of [{}, { [roomCodePath(m.game.roomCode)]: { gameId: "another-game", createdAt: 1 } }]) {
      const p = plan({ game: docOf(m.game), idem: null }, input(m.game, host, { type: "deleteGame" } as Command), store);
      expect(p.outcome).toEqual({ kind: "deleting" });
      expect(p.writes).toHaveLength(2);
      expect(byPath(p.writes).get(roomCodePath(m.game.roomCode))).toBeUndefined();
    }
  });
});

describe("P7 deleting games stop before decide; no extra reads and no writes", () => {
  test("deleteGame on a game already store.deleting is NOT_FOUND even with a ledger hit", () => {
    const m = MemGame.create().joinAll(3);
    const deleting = docOf(m.game, PROJECTOR_REV, { at: 1, by: m.game.hostId });
    const idem: IdemDoc = { at: 1, expiresAt: Timestamp.fromMillis(2), commandType: "deleteGame", version: m.game.version };
    const p = plan({ game: deleting, idem }, input(m.game, userOf(m.game.hostId), { type: "deleteGame" } as Command), { [roomCodePath(m.game.roomCode)]: { gameId: m.game.id } });
    expect(p.outcome).toEqual({ kind: "rejected", rejection: { code: "NOT_FOUND" }, version: 0 });
    expect(p.paths).toEqual([]);
    expect(p.writes).toEqual([]);
  });
});

describe("P8 seatUids and the missing size guard", () => {
  test("seatUids holds every player uid except the host, including departed players", () => {
    const m = MemGame.create().joinAll(4);
    const g = {
      ...m.game,
      players: m.game.players.map((p) => (p.id === pid(1) ? { ...p, status: "left" as const } : p.id === pid(2) ? { ...p, status: "removed" as const } : p)),
    };
    const p = plan({ game: docOf(g), idem: null }, input(g, userOf(g.hostId), { type: "deleteGame" } as Command), { [roomCodePath(g.roomCode)]: { gameId: g.id } });
    const job = byPath(p.writes).get(deletionPath(g.id));
    if (job?.op !== "create") throw new Error("no job");
    expect(job.data["seatUids"]).toEqual(g.players.map((x) => x.uid).filter((u) => u !== g.hostId));
    expect(job.data["seatUids"]).toContain(m.uidOf(1));
    expect(job.data["seatUids"]).not.toContain(g.hostId);
  });

  test("an oversize aggregate still plans phase 0: the state is not rewritten, so no size guard applies", () => {
    const m = MemGame.create().joinAll(3);
    const big = { ...m.game, cards: { c_big: { kind: "red" as const, text: "x".repeat(950_000) } } };
    const p = plan({ game: docOf(big), idem: null }, input(big, userOf(big.hostId), { type: "deleteGame" } as Command), { [roomCodePath(big.roomCode)]: { gameId: big.id } });
    expect(p.outcome).toEqual({ kind: "deleting" });
    expect(p.writes).toHaveLength(3);
  });
});

describe("P9 extra reads ask for roomCodes only for deleteGame", () => {
  test("deleteGame asks for roomCodes/{prev.roomCode}; other commands do not", () => {
    const m = MemGame.create().joinAll(3);
    const host = userOf(m.game.hostId);
    expect(extraReadPaths({ game: docOf(m.game), idem: null }, input(m.game, host, { type: "deleteGame" } as Command))).toEqual([roomCodePath(m.game.roomCode)]);
    expect(extraReadPaths({ game: docOf(m.game), idem: null }, input(m.game, host, { type: "updateSettings", patch: {} } as Command))).toEqual([]);
  });

  test("a missing, deleting or replayed first read stops before any room-code read", () => {
    const m = MemGame.create().joinAll(3);
    const host = userOf(m.game.hostId);
    const del = { type: "deleteGame" } as Command;
    expect(extraReadPaths({ game: null, idem: null }, input(m.game, host, del))).toEqual([]);
    expect(extraReadPaths({ game: docOf(m.game, PROJECTOR_REV, { at: 1, by: m.game.hostId }), idem: null }, input(m.game, host, del))).toEqual([]);
    const idem: IdemDoc = { at: 1, expiresAt: Timestamp.fromMillis(2), commandType: "deleteGame", version: 1 };
    expect(extraReadPaths({ game: docOf(m.game), idem }, input(m.game, host, del))).toEqual([]);
  });
});

describe("K-A: the ledger records the public command type (review 4714480063)", () => {
  test("an accepted writeIn's ledger row and events doc both say confirmSubmission", () => {
    const m = MemGame.playing(3);
    const r = m.game.round;
    if (r === null) throw new Error("round");
    const p = m.game.players.find((x) => x.status === "active" && x.id !== r.judgeId);
    if (p === undefined) throw new Error("player");
    // writeIn is not registered until M7: a fake decide accepts it as the hand play it must look like.
    const fake: PlanDeps = { ...DEPS, decide: (s, _c, x) => decide(s, { type: "confirmSubmission", cardId: p.hand[0], expectedVersion: r.changedAtVersion } as Command, x) };
    const out = plan({ game: docOf(m.game), idem: null }, input(m.game, userOf(p.uid), { type: "writeIn", text: "CARD-SENTINEL-wi", expectedVersion: r.changedAtVersion } as Command), {}, fake);
    const idem = out.writes.find((w) => w.path.includes("/idem/"));
    expect(idem?.op === "create" ? idem.data["commandType"] : null).toBe("confirmSubmission");
    const ev = out.writes.find((w) => w.path.includes("/events/"));
    expect(ev?.op === "create" ? ev.data["commandType"] : null).toBe("confirmSubmission");
    expect(JSON.stringify(out.writes.filter((w) => !w.path.includes("/views/") && !w.path.endsWith(m.game.id)))).not.toContain("writeIn");
  });
});
