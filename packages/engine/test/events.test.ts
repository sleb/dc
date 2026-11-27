// #26 (1.9): the domain event catalog (LLD 1 sections 7.2, 11) and the EventDoc inputs the Engine supplies (`seed`, `redactEnvelope`, `events`).
// EV1 exact ordered events per command, EV2 the catalog against section 11, EV3 the envelope inputs, P-N2 events carry ids, counts and enums only, P-E9 no submitted card before WinnerPicked.
// The Store assembles the EventDoc (LLD 3 section 2.3); there is no builder in the Engine, so these tests pin what the Store receives.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "@dc/contracts";
import { decide } from "../src/decide";
import { REGISTRY } from "../src/registry";
import { makeRng } from "../src/rng";
import type { Accepted, Actor, Ctx, DomainEvent, Draft, Game } from "../src/types";
import { checkAll } from "./support/checks";
import { GAME_ID, HOST_UID, cid, ctxFor, deepFreeze, makeGame, makePlayer, pid, seatUidOf, userActor } from "./support/factories";
import { assertProperty } from "./support/fc";
import { enumerators } from "./support/legal";
import { membershipDriver, progressDriver, runScenario } from "./support/scenario";
import type { Picks, Trace } from "./support/scenario";
import { park, roundGame } from "./support/round-fixtures";

const cmd = (c: object): Command => c as unknown as Command;
const seat = (n: number): Actor => userActor(n === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(n)));
const run = (g: Game | null, c: object, actor: Actor = seat(0), ctx: Partial<Ctx> = {}) => decide(g === null ? null : deepFreeze(structuredClone(g)), cmd(c), ctxFor({ actor, ...ctx }));
const ok = (g: Game | null, c: object, actor: Actor = seat(0), ctx: Partial<Ctx> = {}): Accepted => {
  const r = run(g, c, actor, ctx);
  if (!r.ok) throw new Error(`expected an acceptance of ${JSON.stringify(c)}, got ${JSON.stringify(r.error)}`);
  checkAll({ index: 0, before: g, cmd: c, result: r, actor, drafts: ctx.drafts ?? {} });
  return r.value;
};
const tags = (events: readonly DomainEvent[]): string[] => events.map((e) => e.t);
const env = (): Record<string, string | undefined> => ({ ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? "8" });
const placeholders: Picks = Array.from({ length: 900 }, () => ({ kind: "legal" as const, pick: 0 }));

/** A new LOBBY game, optionally with the pitch variant on (so confirmSubmission enumerates pitched plays too). */
function lobby(pitch: boolean): Game {
  const created = ok(null, { type: "createGame", gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "Host" });
  if (!pitch) return created.state;
  return ok(created.state, { type: "updateSettings", patch: { variants: { pitch: true, writeIn: false, redraw: false, peoplesChoice: false } } }).state;
}
const play = (n: number, seed: number, churn: boolean, pitch = true): Trace => runScenario(decide, lobby(pitch), placeholders, {
  seed, table: enumerators, drive: churn ? membershipDriver(`${seed}`, n, enumerators) : progressDriver(`${seed}`, n, enumerators, true),
});
const accepts = (t: Trace): Accepted[] => t.results.flatMap((r) => (r.ok ? [r.value] : []));

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("EV1 exact ordered events per registered command (LLD 1 section 7.2), including the side-effect events", () => {
  test("a scripted game from createGame to the second round, command by command", () => {
    const seen = new Map<string, string[][]>();
    const redacted = new Set<string>();
    const record = (type: string, a: Accepted): Accepted => { seen.set(type, [...(seen.get(type) ?? []), tags(a.events)]); if (a.redactEnvelope) redacted.add(type); return a; };
    let g = record("createGame", ok(null, { type: "createGame", gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "Host" })).state;
    const step = (type: string, c: object, actor: Actor, drafts: Record<string, Draft> = {}): Accepted => {
      const a = record(type, ok(g, { type, ...c }, actor, { drafts, mintId: (() => { let n = 100 * (g.version + 1); return () => cid(n++); })() }));
      g = a.state;
      return a;
    };
    expect(step("updateSettings", { patch: { profanity: "off" } }, seat(0)).events).toStrictEqual([{ t: "SettingsUpdated", keys: ["profanity"] }]);
    expect(step("join", { playerId: pid(1), name: "Ann" }, seat(1)).events).toStrictEqual([{ t: "PlayerJoined", playerId: pid(1) }]);
    expect(step("join", { playerId: pid(2), name: "Bob" }, seat(2)).events).toStrictEqual([{ t: "PlayerJoined", playerId: pid(2) }]);
    expect(step("leave", {}, seat(2)).events).toStrictEqual([{ t: "PlayerLeft", playerId: pid(2) }]);
    expect(step("join", { playerId: pid(3), name: "Cy" }, seat(3)).events).toStrictEqual([{ t: "PlayerJoined", playerId: pid(3) }]);
    expect(step("removePlayer", { playerId: pid(3) }, seat(0)).events).toStrictEqual([{ t: "PlayerRemoved", playerId: pid(3) }]);
    step("join", { playerId: pid(2), name: "Bob" }, seat(2));
    const started = step("startGame", {}, seat(0));
    expect(started.events).toStrictEqual([{ t: "WritingStarted", target: 8, writeCounts: { red: 10, green: 8 } }]);
    const draft = (i: number): Draft => ({ red: Array.from({ length: 10 }, (_, k) => `r ${i} ${k}`), green: Array.from({ length: 8 }, (_, k) => `g ${i} ${k}`) });
    const drafts: Record<string, Draft> = {};
    for (const i of [0, 1, 2]) {
      drafts[pid(i)] = draft(i);
      expect(step("saveDraft", draft(i), seat(i), drafts).events).toStrictEqual([]);
    }
    expect(tags(step("finishWriting", {}, seat(0), drafts).events)).toStrictEqual(["PlayerFinishedWriting"]);
    expect(tags(step("finishWriting", {}, seat(1), drafts).events)).toStrictEqual(["PlayerFinishedWriting"]);
    const last = step("finishWriting", {}, seat(2), drafts);
    expect(tags(last.events)).toStrictEqual(["PlayerFinishedWriting", "PlayStarted", "PlayerActivated", "PlayerActivated", "PlayerActivated", "RoundOpened"]);
    const opened = last.events.at(-1) as Extract<DomainEvent, { t: "RoundOpened" }>;
    expect(last.events[1]).toStrictEqual({ t: "PlayStarted", playerIds: [pid(0), pid(1), pid(2)], firstJudgeId: opened.judgeId });
    expect(opened.round).toBe(1);
    expect(opened.expected).toStrictEqual([pid(0), pid(1), pid(2)].filter((p) => p !== opened.judgeId));
    const [a, b] = opened.expected as [string, string];
    const handOf = (p: string): string => (g.players.find((x) => x.id === p)?.hand[0]) as string;
    const as = (p: string): Actor => userActor((g.players.find((x) => x.id === p) as Game["players"][number]).uid);
    const first = step("confirmSubmission", { cardId: handOf(a), expectedVersion: g.round?.changedAtVersion }, as(a));
    expect(first.events).toStrictEqual([{ t: "SubmissionConfirmed", round: 1, playerId: a }]);
    const second = step("confirmSubmission", { cardId: handOf(b), expectedVersion: g.round?.changedAtVersion }, as(b));
    expect(second.events).toStrictEqual([{ t: "SubmissionConfirmed", round: 1, playerId: b }, { t: "SubmissionsClosed", round: 1, judgeId: opened.judgeId, reason: "allIn" }]);
    const judge = g.players.find((p) => p.id === opened.judgeId) as Game["players"][number];
    const winnerCard = (g.round?.revealOrder as string[])[0] as string;
    const picked = step("pickWinner", { submissionId: winnerCard, expectedVersion: g.round?.changedAtVersion }, userActor(judge.uid));
    expect(tags(picked.events)).toStrictEqual(["WinnerPicked", "RoundOpened"]);
    expect(picked.events[0]).toMatchObject({ t: "WinnerPicked", round: 1, judgeId: opened.judgeId, winnerCardId: winnerCard });
    expect((picked.events[1] as { round: number }).round).toBe(2);
    expect(seen.get("saveDraft")).toStrictEqual([[], [], []]);
    expect([...redacted]).toStrictEqual(["finishWriting"]);
  });

  test("closeSubmissions: SubmissionsClosed with reason closed", () => {
    const g = roundGame({ judge: 1, submitted: [2] });
    expect(ok(g, { type: "closeSubmissions", expectedVersion: 5 }, seat(0)).events).toStrictEqual([{ t: "SubmissionsClosed", round: 1, judgeId: pid(1), reason: "closed" }]);
  });

  test("pickWinner to the target: WinnerPicked then GameFinished, no RoundOpened", () => {
    const g = roundGame({ judge: 0, submitted: [1, 2], phase: "JUDGING", target: 1 });
    const win = g.round?.revealOrder?.[0] as string;
    const a = ok(g, { type: "pickWinner", submissionId: win, expectedVersion: 5 }, seat(0));
    expect(tags(a.events)).toStrictEqual(["WinnerPicked", "GameFinished"]);
  });

  test("passJudging: JudgeChanged{passed} in SUBMITTING and in JUDGING; the void case adds RoundVoided and RoundOpened", () => {
    const s = ok(roundGame({ judge: 1, submitted: [2] }), { type: "passJudging", expectedVersion: 5 });
    expect(s.events).toStrictEqual([{ t: "JudgeChanged", round: 1, from: pid(1), to: pid(2), reason: "passed" }]);
    const j = ok(roundGame({ judge: 1, submitted: [2, 3], phase: "JUDGING" }), { type: "passJudging", expectedVersion: 5 });
    expect(tags(j.events)).toStrictEqual(["JudgeChanged"]);
    // the new judge's own card was the only play: nothing left to judge
    const v = ok(roundGame({ judge: 1, submitted: [2], phase: "JUDGING" }), { type: "passJudging", expectedVersion: 5 });
    expect(tags(v.events)).toStrictEqual(["JudgeChanged", "RoundVoided", "RoundOpened"]);
    expect(v.events[1]).toStrictEqual({ t: "RoundVoided", round: 1, reason: "no_submissions" });
  });

  test("leave and removePlayer of the judge: the departure event first, then JudgeChanged with the reason", () => {
    const g = roundGame({ judge: 1, submitted: [2] });
    const l = ok(g, { type: "leave" }, seat(1));
    expect(l.events).toStrictEqual([{ t: "PlayerLeft", playerId: pid(1) }, { t: "JudgeChanged", round: 1, from: pid(1), to: pid(2), reason: "left" }]);
    const r = ok(g, { type: "removePlayer", playerId: pid(1) }, seat(0));
    expect(r.events).toStrictEqual([{ t: "PlayerRemoved", playerId: pid(1) }, { t: "JudgeChanged", round: 1, from: pid(1), to: pid(2), reason: "removed" }]);
  });

  test("removeCard: CardRemoved{cardId, kind}, with the side effects when the round empties", () => {
    const g = roundGame({ judge: 0, submitted: [1], phase: "JUDGING", greenDeck: 40 });
    const played = g.round?.revealOrder?.[0] as string;
    expect(tags(ok(g, { type: "removeCard", cardId: played }, seat(0)).events)).toStrictEqual(["CardRemoved", "RoundVoided", "RoundOpened"]);
    expect(ok(g, { type: "removeCard", cardId: cid(900) }, seat(0)).events[0]).toStrictEqual({ t: "CardRemoved", cardId: cid(900), kind: "green" });
  });

  test("endGame: GameEnded only, from any live phase", () => {
    expect(ok(roundGame({ judge: 1, submitted: [2] }), { type: "endGame" }).events).toStrictEqual([{ t: "GameEnded" }]);
    expect(ok(makeGame({ phase: "LOBBY", players: [makePlayer(0)] }), { type: "endGame" }).events).toStrictEqual([{ t: "GameEnded" }]);
  });

  test("markReminded due: an accepted command with no events; not due: no change at all", () => {
    const g = ok(roundGame({ judge: 1 }), { type: "updateSettings", patch: { profanity: "off" } }, seat(0), { now: 1_000 }).state; // settle runs and starts the episode
    expect(g.episode).not.toBeNull();
    const c = { type: "markReminded", episode: g.episode, episodeGen: g.episodeGen };
    const due = ok(g, c, { kind: "system" }, { now: (g.reminderDueAt as number) + 1 });
    expect([due.aggregateChanged, due.events]).toStrictEqual([true, []]);
    const early = ok(g, c, { kind: "system" }, { now: (g.reminderDueAt as number) - 1 });
    expect([early.aggregateChanged, early.events]).toStrictEqual([false, []]);
  });

  test("every command in the real registry has an EV1 row here (a new command must add one)", () => {
    expect(Object.keys(REGISTRY).sort()).toStrictEqual(["closeSubmissions", "confirmSubmission", "createGame", "deleteGame", "endGame", "finishWriting", "join", "leave", "markReminded", "passJudging", "pickWinner", "removeCard", "removePlayer", "saveDraft", "startGame", "updateSettings"]);
  });

  test("settle's PausedChanged rides with the command that caused it, and cancels when there is no net change", () => {
    // 3 active, one leaves: two remain, so the game pauses and the round is kept.
    const g = roundGame({ n: 3, judge: 1, submitted: [2] });
    const a = ok(g, { type: "leave" }, seat(0));
    expect(tags(a.events)).toContain("PausedChanged");
    expect(a.events.filter((e) => e.t === "PausedChanged")).toStrictEqual([{ t: "PausedChanged", paused: true }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("EV2 the catalog equals LLD 1 section 11; deferred tags have no emitter", () => {
  // Exhaustive by type: a tag added to or dropped from `DomainEvent` is a compile error here until section 11 and this list agree.
  const CATALOG: Record<DomainEvent["t"], true> = {
    GameCreated: true, SettingsUpdated: true, PlayerJoined: true, PlayerLeft: true, PlayerRemoved: true, DeckImported: true, WritingStarted: true, PlayerFinishedWriting: true,
    PlayStarted: true, PlayerActivated: true, RoundOpened: true, SubmissionConfirmed: true, HandRedrawn: true, SubmissionsClosed: true, JudgeChanged: true, RoundVoided: true,
    WinnerPicked: true, VoteCast: true, CardRemoved: true, GameFinished: true, GameEnded: true, GameDeleted: true, PausedChanged: true,
  };
  const DEFERRED = ["DeckImported", "HandRedrawn", "VoteCast"];
  const src = (): string => [...new Glob("**/*.ts").scanSync(join(import.meta.dir, "../src"))].filter((f) => !f.endsWith(".test.ts"))
    .filter((f) => f !== "types.ts").map((f) => readFileSync(join(import.meta.dir, "../src", f), "utf8")).join("\n");

  test("the tags in src/types.ts are exactly the 23 of section 11", () => {
    const types = readFileSync(join(import.meta.dir, "../src/types.ts"), "utf8");
    const declared = [...types.matchAll(/\{ t: "(\w+)"/g)].map((m) => m[1]).sort();
    expect(declared).toStrictEqual(Object.keys(CATALOG).sort());
    expect(declared).toHaveLength(23);
    const lld = readFileSync(join(import.meta.dir, "../../../docs/lld/01-game-engine.md"), "utf8");
    const section = lld.slice(lld.indexOf("## 11. Domain events"), lld.indexOf("### 11.1"));
    expect([...section.matchAll(/\{ t: "(\w+)"/g)].map((m) => m[1]).sort()).toStrictEqual(declared);
  });

  test("DeckImported (M9), HandRedrawn and VoteCast (M7) are in the union but nothing emits them yet; GameDeleted is emitted since #36", () => {
    const code = src();
    for (const t of DEFERRED) expect(code).not.toContain(`t: "${t}"`);
    for (const t of Object.keys(CATALOG).filter((k) => !DEFERRED.includes(k))) expect(code).toContain(`t: "${t}"`);
  });

  // GameDeleted is emitted by the real deleteGame row and asserted exactly in D1 (`delete-game.test.ts`); the scenario
  // drivers pick only named types, so they never issue it. It is not seeded into `seen`: that would make this loop
  // unable to fail for it.
  const DIRECT = new Set(["GameDeleted"]);
  test("over seeded games every non-deferred tag is emitted at least once and no deferred tag ever is", () => {
    const seen = new Set<string>(["GameCreated", "SettingsUpdated"]); // the driven games start from a lobby that createGame and updateSettings built
    for (let seed = 1; seed <= 60; seed++) for (const a of accepts(play(3 + (seed % 5), seed, true))) for (const e of a.events) seen.add(e.t);
    for (const t of Object.keys(CATALOG).filter((k) => !DEFERRED.includes(k) && !DIRECT.has(k))) expect(seen.has(t) ? t : `missing ${t}`).toBe(t);
    for (const t of DEFERRED) expect(seen.has(t)).toBe(false);
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("EV3 the EventDoc inputs: redactEnvelope, seed, events", () => {
  test("redactEnvelope is true for finishWriting and for nothing else, over whole games with churn", () => {
    let finishes = 0;
    assertProperty(fc.property(fc.integer({ min: 3, max: 7 }), fc.integer(), (n, seed) => {
      const trace = play(n, seed, true);
      const types = commandTypes(trace);
      trace.results.forEach((r, i) => {
        if (!r.ok) return;
        const t = types[i];
        if (t === "finishWriting") finishes++;
        expect(r.value.redactEnvelope).toBe(t === "finishWriting");
      });
    }), env());
    expect(finishes).toBeGreaterThan(0);
  });

  test("seed is always the ctx seed; markReminded and a count-only saveDraft give events [] (and the latter is aggregateChanged false when the counts did not move)", () => {
    const g = roundGame({ judge: 1 });
    expect(ok(g, { type: "endGame" }, seat(0)).seed).toBe("test-seed");
    expect(ok(g, { type: "endGame" }, seat(0), { rng: makeRng("another") }).seed).toBe("another");
    const w = makeGame({ phase: "WRITING", target: 8, writeCounts: { red: 2, green: 1 }, players: [0, 1, 2].map((i) => makePlayer(i, { status: "writing", writeTarget: { red: 2, green: 1 }, writeProgress: { red: 1, green: 0 } })) });
    const edit = ok(w, { type: "saveDraft", red: ["only"], green: [] }, seat(0));
    expect([edit.aggregateChanged, edit.events, edit.redactEnvelope]).toStrictEqual([false, [], false]);
    const more = ok(w, { type: "saveDraft", red: ["a", "b"], green: ["c"] }, seat(0));
    expect([more.aggregateChanged, more.events, more.redactEnvelope]).toStrictEqual([true, [], false]);
  });

  test("a rejection carries no events, and an aggregateChanged:false acceptance carries none except deleteGame's GameDeleted, over whole games with junk commands", () => {
    assertProperty(fc.property(fc.integer({ min: 3, max: 6 }), fc.integer(), (n, seed) => {
      const trace = runScenario(decide, lobby(true), Array.from({ length: 400 }, (_, i) => ({ kind: i % 4 === 3 ? ("junk" as const) : ("legal" as const), pick: (i * 7919 + seed) & 0xffff })), { seed, table: enumerators });
      trace.results.forEach((r, i) => {
        if (!r.ok) expect(Object.keys(r)).toStrictEqual(["ok", "error"]);
        else if (!r.value.aggregateChanged) expect(r.value.events).toStrictEqual(trace.commands[i]?.type === "deleteGame" ? [{ t: "GameDeleted" }] : []);
      });
      expect(n).toBeGreaterThan(2);
    }), env());
  });
});

const commandTypes = (trace: Trace): string[] => trace.commands.map((c) => c.type);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
type Kind = "pid" | "cid" | "count" | "bool" | "round" | "enum" | "pids" | "counts" | "keys" | "pidOrNull";
/** Per tag, the exact field names and what each may hold. Nothing here can carry text: ids, counts, booleans and enumerated strings. */
const SHAPE: Record<DomainEvent["t"], Record<string, Kind>> = {
  GameCreated: { hostPlayerId: "pid" },
  SettingsUpdated: { keys: "keys" },
  PlayerJoined: { playerId: "pid" },
  PlayerLeft: { playerId: "pid" },
  PlayerRemoved: { playerId: "pid" },
  DeckImported: { red: "count", green: "count" },
  WritingStarted: { target: "count", writeCounts: "counts" },
  PlayerFinishedWriting: { playerId: "pid" },
  PlayStarted: { playerIds: "pids", firstJudgeId: "pid" },
  PlayerActivated: { playerId: "pid" },
  RoundOpened: { round: "round", judgeId: "pid", greenCardId: "cid", expected: "pids" },
  SubmissionConfirmed: { round: "round", playerId: "pid" },
  HandRedrawn: { playerId: "pid" },
  SubmissionsClosed: { round: "round", judgeId: "pid", reason: "enum" },
  JudgeChanged: { round: "round", from: "pidOrNull", to: "pid", reason: "enum" },
  RoundVoided: { round: "round", reason: "enum" },
  WinnerPicked: { round: "round", judgeId: "pid", winnerId: "pid", winnerCardId: "cid" },
  VoteCast: { round: "round", voterKind: "enum" },
  CardRemoved: { cardId: "cid", kind: "enum" },
  GameFinished: { winnerId: "pid" },
  GameEnded: {},
  GameDeleted: {},
  PausedChanged: { paused: "bool" },
};
const ENUMS: Record<string, readonly string[]> = {
  "SubmissionsClosed.reason": ["allIn", "closed"],
  "JudgeChanged.reason": ["passed", "left", "removed", "resumed"],
  "RoundVoided.reason": ["no_submissions"],
  "VoteCast.voterKind": ["player", "spectator"],
  "CardRemoved.kind": ["red", "green"],
};
const SETTINGS_KEYS = ["profanity", "variants", "spectators", "targetOverride", "writeCountsOverride"];
const PID = /^p_[a-z2-7]{8}$/;
const CID = /^c_[a-z0-9]{10}$/;
const isCount = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Why `e` is not a pure id/count/enum/boolean event, or null. */
export function n2Violation(e: DomainEvent): string | null {
  const shape = SHAPE[e.t] as Record<string, Kind> | undefined;
  if (shape === undefined) return `unknown tag ${String((e as { t: unknown }).t)}`;
  const body = e as unknown as Record<string, unknown>;
  const keys = Object.keys(body).filter((k) => k !== "t").sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(shape).sort())) return `${e.t} has fields ${keys.join(",")}`;
  for (const [k, kind] of Object.entries(shape)) {
    const v = body[k];
    const bad = ((): boolean => {
      switch (kind) {
        case "pid": return typeof v !== "string" || !PID.test(v);
        case "pidOrNull": return v !== null && (typeof v !== "string" || !PID.test(v));
        case "cid": return typeof v !== "string" || !CID.test(v);
        case "count": case "round": return !isCount(v);
        case "bool": return typeof v !== "boolean";
        case "enum": return typeof v !== "string" || !(ENUMS[`${e.t}.${k}`] ?? []).includes(v);
        case "pids": return !Array.isArray(v) || v.some((x) => typeof x !== "string" || !PID.test(x));
        case "counts": return typeof v !== "object" || v === null || JSON.stringify(Object.keys(v).sort()) !== '["green","red"]' || !Object.values(v).every(isCount);
        case "keys": return !Array.isArray(v) || v.some((x) => typeof x !== "string" || !SETTINGS_KEYS.includes(x));
      }
    })();
    if (bad) return `${e.t}.${k} = ${JSON.stringify(v)} is not a ${kind}`;
  }
  return null;
}

describe("P-N2 events carry ids, counts and enumerated kinds only (never card text, names, pitches or draft contents)", () => {
  const texts = (t: Trace): Set<string> => {
    const out = new Set<string>();
    for (const s of t.states) {
      if (s === null) continue;
      for (const c of Object.values(s.cards)) out.add(c.text);
      for (const p of s.players) out.add(p.name);
      for (const sub of s.round?.submissions ?? []) if (sub.pitch !== undefined) out.add(sub.pitch);
    }
    return out;
  };
  const strings = (v: unknown, out: string[] = []): string[] => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) strings(x, out);
    else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out); }
    return out;
  };

  test("every event of seeded games with churn matches the per-tag whitelist, and no string in any event equals a card text, a name or a pitch", () => {
    let rounds = 0;
    let pitched = 0;
    assertProperty(fc.property(fc.integer({ min: 3, max: 7 }), fc.integer(), (n, seed) => {
      const trace = play(n, seed, true);
      const forbidden = texts(trace);
      for (const a of accepts(trace)) {
        for (const e of a.events) {
          expect(n2Violation(e)).toBeNull();
          for (const s of strings(e)) expect(forbidden.has(s)).toBe(false);
          if (e.t === "RoundOpened") rounds++;
        }
      }
      for (const s of trace.states) if (s?.round?.submissions.some((x) => x.pitch !== undefined) === true) pitched++;
    }), env());
    // not vacuous: rounds were opened and pitches (the one free-text field a round command takes) were in flight
    expect(rounds).toBeGreaterThan(0);
    expect(pitched).toBeGreaterThan(0);
  });

  test("the whitelist is sharp: a stray text field, a name as a player id, a wrong enum or a missing field is each a violation", () => {
    const base: DomainEvent = { t: "SubmissionConfirmed", round: 1, playerId: pid(1) };
    expect(n2Violation(base)).toBeNull();
    expect(n2Violation({ ...base, text: "a card" } as unknown as DomainEvent)).not.toBeNull();
    expect(n2Violation({ ...base, playerId: "Alice" })).not.toBeNull();
    expect(n2Violation({ t: "SubmissionsClosed", round: 1, judgeId: pid(1), reason: "because" } as unknown as DomainEvent)).not.toBeNull();
    expect(n2Violation({ t: "RoundOpened", round: 1, judgeId: pid(1), expected: [] } as unknown as DomainEvent)).not.toBeNull();
    expect(n2Violation({ t: "CardRemoved", cardId: cid(1), kind: "red" })).toBeNull();
    expect(n2Violation({ t: "CardRemoved", cardId: "the text", kind: "red" })).not.toBeNull();
  });
});

describe("P-E9 no event before WinnerPicked carries a submitted card, and nothing marks a write-in (K-A)", () => {
  // Test allowance only: a card revealed in JUDGING is already public without an owner, and `CardRemoved` has no player field, so `removeCard` may name it. E9 is the pairing of card and player in events.
  // The leak is the view diff, not the event: see the `submittedBy` test below (LLD 1 open question 20).
  test("over whole seeded games, across every command, the events before WinnerPicked mention no submitted card (except a CardRemoved of a revealed card in JUDGING), and none holds a card and a player together", () => {
    let withSubmissions = 0;
    assertProperty(fc.property(fc.integer({ min: 3, max: 7 }), fc.integer(), (n, seed) => {
      const trace = play(n, seed, true);
      trace.results.forEach((r, i) => {
        if (!r.ok) return;
        const before = trace.states[i];
        const submitted = new Set<string>([...(before?.round?.submissions ?? []), ...(r.value.state.round?.submissions ?? [])].map((s) => s.cardId));
        const cut = r.value.events.findIndex((e) => e.t === "WinnerPicked");
        const early = cut === -1 ? r.value.events : r.value.events.slice(0, cut);
        if (submitted.size > 0) withSubmissions++;
        for (const e of early) {
          const text = JSON.stringify(e);
          const named = [...submitted].filter((id) => text.includes(id));
          if (named.length > 0) {
            expect(e.t).toBe("CardRemoved");
            expect(before?.round?.phase).toBe("JUDGING");
          }
          expect(text.includes("writeIn")).toBe(false);
          expect(/"cardId"|"CardId"/.test(text) && /"playerId"|"judgeId"|"winnerId"/.test(text)).toBe(false);
        }
      });
    }), env());
    expect(withSubmissions).toBeGreaterThan(0);
  });
});

describe("removeCard of a revealed submission in JUDGING (LLD 1 open question 20, ruled in #28)", () => {
  test("the card leaves the reveal, but Round.played still names its author, so the Projector's submittedBy does not shrink; the event names the card and no player", () => {
    const g = roundGame({ n: 5, judge: 0, submitted: [1, 2, 3], phase: "JUDGING", greenDeck: 60 });
    const removed = cid(206); // player 2's play, revealed without an owner
    const a = ok(g, { type: "removeCard", cardId: removed }, seat(0));
    const lost = (g.round?.submissions ?? []).map((s) => s.playerId).filter((p) => !(a.state.round?.submissions ?? []).some((s) => s.playerId === p));
    expect(lost).toStrictEqual([pid(2)]); // the Engine's own record of submissions does shrink ...
    expect(a.state.round?.played).toStrictEqual(g.round?.played); // ... the public trace does not
    expect(a.events).toStrictEqual([{ t: "CardRemoved", cardId: removed, kind: "red" }]);
  });
});
