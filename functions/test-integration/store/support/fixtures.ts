// Built emulator fixtures (LLD 3 sections 10.1 and 10.3, #37). Every fixture is a scripted scenario driven through the real
// createGame and runCommand on the Node bundle (the emulator-only storeHarness), so every stored document is one the production
// path would have written, views included. Fixed game ids and per-command idempotency keys make a second build a replay: no write,
// no `updateTime` change. The real `castVote` is M7, so votes are Admin-patched with the real `Game.votes` shape and the views are
// rebuilt from the patched aggregate; the patch is marked fixture-only here and in LLD 3 section 2.5.
import type { Command, GameId, PlayerId, Settings, Uid } from "@dc/contracts";
import { PROJECTOR_REV } from "@dc/engine";
import type { Actor, Game, Vote } from "@dc/engine";
import { playerName } from "../../../src/store/test-support";
import type { RunResult } from "./harness";
import { create, db, rebuildViews } from "./harness";
import { Table } from "./drive";
import { CATALOGUE, FIXTURE_IDS, FIXTURES, fixtureCreateKey, fixtureHostId } from "./fixture-names";
import type { FixtureName } from "./fixture-names";
import { HOST_NAME, pid } from "./ids";

export { CATALOGUE, FIXTURE_IDS, FIXTURES, fixtureCreateKey, fixtureHostId };
export type { FixtureName };

const NOW = 1_700_000_000_000;
const CREATE_ATTEMPTS = 4;
const BUILD_SETTINGS: Partial<Record<FixtureName, Partial<Settings>>> = {
  // The votes fixture: a two-win game so the People's Choice projection reads the patched votes.
  "finished6-votes": { targetOverride: 2, variants: { pitch: false, writeIn: false, redraw: false, peoplesChoice: true } },
  // 10 players and a target of 10 resolve at most 9 * 10 + 1 = 91 rounds; the builder distributes wins so it reaches exactly 91.
  midsize10: { targetOverride: 10, variants: { pitch: false, writeIn: false, redraw: false, peoplesChoice: true } },
};

export interface SeededFixture {
  name: FixtureName;
  gameId: GameId;
  hostId: Uid;
  roomCode: string;
  /** Commands run through the harness (the create is not one). */
  commands: number;
  /** Distinct documents the harness reported written: 6 for the create, 0 for every replay. */
  writes: number;
  replay: boolean;
}

/** One fixture's driver: deterministic idempotency keys and clock, and the running command/write counts. */
class Build {
  step = 0;
  commands = 0;
  writes = 0;
  constructor(readonly name: FixtureName, readonly t: Table, readonly replay: boolean) {
    this.writes = replay ? 0 : 6;
  }
  actor(k: number): Actor {
    return { kind: "user", uid: this.t.uidOf(k) };
  }
  byUid(uid: Uid): Actor {
    return { kind: "user", uid };
  }
  async run(actor: Actor, cmd: Command, key: string): Promise<RunResult> {
    this.step += 1;
    const r = await this.t.run(actor, cmd, { idemKey: `fx:${this.name}:${key}`, now: NOW + this.step * 1_000 });
    this.commands += 1;
    this.writes += r.writes;
    if (r.outcome.kind !== "accepted") throw new Error(`fixture ${this.name}: ${cmd.type} ${JSON.stringify(r.outcome)}`);
    return r;
  }
  state(): Promise<Game> {
    return this.t.state();
  }
  uidOf(k: number): Uid {
    return this.t.uidOf(k);
  }
}

/** Attempt n draws the code seed then the decide seed; scripted attempts recover a fixed-code collision deterministically. */
const createSeeds = (name: FixtureName): string[] =>
  Array.from({ length: CREATE_ATTEMPTS }, (_, i) => [`fx:${name}:code:${i + 1}`, `fx:${name}:decide:${i + 1}`]).flat();

async function created(name: FixtureName): Promise<Build> {
  const settings = BUILD_SETTINGS[name];
  const r = await create({
    gameId: FIXTURE_IDS[name],
    hostId: fixtureHostId(name),
    hostName: HOST_NAME,
    idemKey: fixtureCreateKey(name),
    seeds: createSeeds(name),
    now: NOW,
    ...(settings === undefined ? {} : { settings }),
  });
  if (r.outcome.kind !== "accepted") throw new Error(`fixture ${name}: createGame ${JSON.stringify(r.outcome)}`);
  return new Build(name, Table.attach(r.outcome.gameId, fixtureHostId(name)), r.outcome.replay);
}

async function joins(b: Build, last: number, from = 1): Promise<void> {
  for (let k = from; k <= last; k++) await b.run(b.byUid(b.uidOf(k)), { type: "join", playerId: pid(k), name: playerName(k) } as Command, `join:${k}`);
}
const leave = (b: Build, k: number): Promise<RunResult> => b.run(b.byUid(b.uidOf(k)), { type: "leave" } as Command, `leave:${k}`);
const start = (b: Build): Promise<RunResult> => b.run(b.actor(0), { type: "startGame" } as Command, "start");

async function saveDraft(b: Build, k: number, key: string, o: { trimRed?: number; tag?: string } = {}): Promise<void> {
  const g = await b.state();
  const p = g.players.find((x) => x.id === pid(k));
  if (p === undefined) throw new Error(`fixture ${b.name}: no player ${pid(k)}`);
  const full = await b.t.draftFor(p, o.tag ?? "");
  const red = o.trimRed === undefined ? full.red : full.red.slice(0, Math.max(0, full.red.length - o.trimRed));
  await b.run(b.byUid(p.uid), { type: "saveDraft", red, green: full.green } as Command, `draft:${key}`);
}

const finish = (b: Build, k: number, key: string): Promise<RunResult> => b.run(b.byUid(b.uidOf(k)), { type: "finishWriting" } as Command, `finish:${key}`);

/** Every still-writing seat saves a full draft and finishes, in seat order (the host's seat id is createGame-derived). */
async function writeAll(b: Build): Promise<void> {
  const g = await b.state();
  for (const p of g.players.filter((x) => x.status === "writing" && x.writeTarget !== null)) {
    const full = await b.t.draftFor(p);
    await b.run(b.byUid(p.uid), { type: "saveDraft", red: full.red, green: full.green } as Command, `draft:${p.id}`);
    await b.run(b.byUid(p.uid), { type: "finishWriting" } as Command, `finish:${p.id}`);
  }
}

/** Every expected player confirms their first hand card; closes the round if it is still SUBMITTING. */
async function submitAll(b: Build): Promise<void> {
  for (;;) {
    const g = await b.state();
    const r = g.round;
    if (g.phase !== "PLAYING" || g.paused || r === null || r.phase !== "SUBMITTING") return;
    const p = g.players.find((x) => x.status === "active" && r.roster.includes(x.id) && x.id !== r.judgeId && !r.submissions.some((s) => s.playerId === x.id) && x.hand.length > 0);
    if (p === undefined) {
      await b.run(b.actor(0), { type: "closeSubmissions", expectedVersion: r.changedAtVersion } as Command, `close:${r.number}`);
      return;
    }
    await b.run(b.byUid(p.uid), { type: "confirmSubmission", cardId: p.hand[0], expectedVersion: r.changedAtVersion } as Command, `submit:${r.number}:${p.id}`);
  }
}

/** The judge picks the submission `choose` names; the round then resolves and the next one opens unless the game finished. */
async function pick(b: Build, choose: (game: Game, submissions: { playerId: PlayerId; cardId: string }[]) => string): Promise<void> {
  const g = await b.state();
  const r = g.round;
  if (r === null || r.phase !== "JUDGING" || r.judgeId === null) throw new Error(`fixture ${b.name}: not judging`);
  const judge = g.players.find((p) => p.id === r.judgeId);
  if (judge === undefined) throw new Error(`fixture ${b.name}: no judge record`);
  const submissionId = choose(g, r.submissions.map((s) => ({ playerId: s.playerId, cardId: s.cardId })));
  await b.run(b.byUid(judge.uid), { type: "pickWinner", submissionId, expectedVersion: r.changedAtVersion } as Command, `pick:${r.number}`);
}

const scoreOf = (g: Game, id: PlayerId): number => g.players.find((p) => p.id === id)?.scorePile.length ?? -1;
/** The judge picks the player with the fewest wins: the wins spread evenly, so a 10-player target-10 game needs all 91 rounds. */
const fewestWins = (g: Game, subs: { playerId: PlayerId; cardId: string }[]): string =>
  [...subs].sort((a, b) => scoreOf(g, a.playerId) - scoreOf(g, b.playerId) || a.playerId.localeCompare(b.playerId))[0]?.cardId ?? "";
/** The judge picks the player with the most wins: a target-2 game finishes in a handful of rounds. */
const mostWins = (g: Game, subs: { playerId: PlayerId; cardId: string }[]): string =>
  [...subs].sort((a, b) => scoreOf(g, b.playerId) - scoreOf(g, a.playerId) || a.playerId.localeCompare(b.playerId))[0]?.cardId ?? "";

/** `count` votes in the real `Game.votes` shape: one per played seat per round, for that round's winning card. */
function voteList(g: Game, count: number): Vote[] {
  const votes: Vote[] = [];
  for (let i = 0; votes.length < count; i++) {
    const h = g.history[i % g.history.length];
    if (h === undefined) throw new Error("fixture: no history to vote on");
    const n = Math.min(6, count - votes.length, h.plays.length);
    for (let j = 0; j < n; j++) {
      const voter = h.plays[(i + j) % h.plays.length];
      if (voter === undefined) throw new Error("fixture: empty plays");
      votes.push({ round: h.round, voter: `p:${voter.playerId}`, cardId: h.winnerCardId });
    }
  }
  return votes;
}

/**
 * Fixture-only until #37's successor (LLD 3 section 2.5): `castVote` is M7. The votes are written with the real shape and the
 * views are rebuilt from the patched aggregate, so a projection test still reads what the production rebuild would write.
 */
async function patchVotes(b: Build, count: number): Promise<boolean> {
  const g = await b.state();
  const votes = voteList(g, count);
  if (JSON.stringify(g.votes) === JSON.stringify(votes)) return false;
  await db.doc(`games/${g.id}`).update({ votes });
  await rebuildViews(g.id, NOW + 100_000);
  return true;
}

/**
 * Lower `store.viewsRev` on the aggregate and every view doc (the `viewsStale` shape, and the stale-view budget rows). Fixture-only:
 * it writes exactly what a deploy behind the current projector leaves behind. Idempotent: an already-stale fixture is untouched.
 */
export async function lowerViewsRev(gameId: GameId): Promise<boolean> {
  const snap = await db.doc(`games/${gameId}`).get();
  const store = snap.get("store") as { viewsRev: number } | undefined;
  const views = await db.collection(`games/${gameId}/views`).get();
  if (store?.viewsRev === PROJECTOR_REV - 1 && views.docs.every((d) => d.get("viewsRev") === PROJECTOR_REV - 1)) return false;
  const batch = db.batch();
  batch.update(db.doc(`games/${gameId}`), { "store.viewsRev": PROJECTOR_REV - 1 });
  for (const d of views.docs) batch.update(d.ref, { viewsRev: PROJECTOR_REV - 1 });
  await batch.commit();
  return true;
}

async function script(b: Build): Promise<void> {
  switch (b.name) {
    case "lobby3":
      await joins(b, 2);
      return;
    case "writing4":
      await joins(b, 3);
      await start(b);
      await saveDraft(b, 1, "p1");
      await finish(b, 1, "p1");
      await saveDraft(b, 2, "p2", { trimRed: 1 });
      return;
    case "submitting5": {
      await joins(b, 4);
      await start(b);
      await writeAll(b);
      // The two lowest-id expected players, chosen from the state, so a replay issues the same keys instead of submitting for others.
      for (let n = 0; n < 2; n++) {
        const g = await b.state();
        const r = g.round;
        if (r === null) throw new Error("fixture submitting5: no round");
        const id = [...r.roster].filter((x) => x !== r.judgeId).sort()[n];
        const p = g.players.find((x) => x.id === id);
        if (p === undefined) throw new Error("fixture submitting5: no expected player");
        await b.run(b.byUid(p.uid), { type: "confirmSubmission", cardId: p.hand[0], expectedVersion: r.changedAtVersion } as Command, `submit:${r.number}:${p.id}`);
      }
      return;
    }
    case "judging6":
      await joins(b, 5);
      await start(b);
      await writeAll(b);
      await submitAll(b);
      return;
    case "paused3":
      await joins(b, 2);
      await start(b);
      await leave(b, 2);
      return;
    case "finished6-votes":
      await joins(b, 5);
      await start(b);
      await writeAll(b);
      for (let k = 0; k < 8 && (await b.state()).phase === "PLAYING"; k++) {
        await submitAll(b);
        if ((await b.state()).phase !== "PLAYING") break;
        await pick(b, mostWins);
      }
      await patchVotes(b, 4);
      return;
    case "ended4":
      await joins(b, 3);
      await b.run(b.actor(0), { type: "endGame" } as Command, "end");
      return;
    case "departed40":
      await joins(b, 9);
      await start(b);
      await leave(b, 0); // the host leaves the table; their seat doc/tombstone stays
      for (let k = 10; k <= 49; k++) {
        await joins(b, k, k);
        await leave(b, k);
      }
      await joins(b, 50, 50);
      return;
    case "viewsStale":
      await joins(b, 3);
      await start(b);
      await saveDraft(b, 1, "p1");
      await lowerViewsRev(FIXTURE_IDS.viewsStale);
      return;
    case "midsize10": {
      await joins(b, 9);
      await start(b);
      await writeAll(b);
      for (let k = 0; k < 100 && (await b.state()).phase === "PLAYING"; k++) {
        await submitAll(b);
        if ((await b.state()).phase !== "PLAYING") break;
        await pick(b, fewestWins);
      }
      const g = await b.state();
      if (g.phase !== "FINISHED" || g.history.length !== 91) throw new Error(`fixture midsize10: ${g.phase} after ${g.history.length} rounds`);
      await patchVotes(b, 500);
      return;
    }
  }
}

/** The `listWaitingOn` paging corpus of I27 (LLD 3 section 7): 249 lean due rows, 50 future and 50 null, all Admin-written
 * aggregates rather than games built through commands. The caller adds its one real game as the 250th due row. */
export interface PagingCorpus {
  lean: { gameId: string; dueAt: number }[];
  future: { gameId: string; dueAt: number }[];
  nulls: { gameId: string }[];
}

export async function seedPaging(now: number): Promise<PagingCorpus> {
  const lean = Array.from({ length: 249 }, (_, i) => ({ gameId: `g${String(i).padStart(19, "0")}`, dueAt: 1000 + Math.floor(i / 10) }));
  const future = Array.from({ length: 50 }, (_, i) => ({ gameId: `f${String(i).padStart(19, "0")}`, dueAt: now + 1 + i }));
  const nulls = Array.from({ length: 50 }, (_, i) => ({ gameId: `n${String(i).padStart(19, "0")}` }));
  const batch = db.batch();
  for (const d of lean) batch.set(db.doc(`games/${d.gameId}`), { reminderDueAt: d.dueAt, episode: `e-${d.gameId}`, episodeGen: 1, waitingOn: ["p_lean"], waitingSince: 5, version: 1 });
  for (const d of future) batch.set(db.doc(`games/${d.gameId}`), { reminderDueAt: d.dueAt, episode: `e-${d.gameId}`, episodeGen: 1, waitingOn: ["p_future"], waitingSince: 5, version: 1 });
  for (const d of nulls) batch.set(db.doc(`games/${d.gameId}`), { reminderDueAt: null, episode: null, episodeGen: 0, waitingOn: [], waitingSince: 0, version: 1 });
  await batch.commit();
  return { lean, future, nulls };
}

export async function seedFixture(name: FixtureName): Promise<SeededFixture> {
  const b = await created(name);
  await script(b);
  const g = await b.state();
  return { name, gameId: g.id, hostId: g.hostId, roomCode: g.roomCode, commands: b.commands, writes: b.writes, replay: b.replay };
}

/** The CI catalogue, in order. Each fixture's commands are idempotent, so a second call replays and writes nothing. */
export async function seedCatalogue(): Promise<SeededFixture[]> {
  const out: SeededFixture[] = [];
  for (const name of CATALOGUE) out.push(await seedFixture(name));
  return out;
}