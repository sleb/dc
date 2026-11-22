// #22 (1.2) V7: the waiting fields as a pure function. #24 (1.7): `markReminded` (M1 to M6) and the X8 scenarios (X8-a to X8-c) through the real REGISTRY; the property is in waiting-properties.test.ts.
import { describe, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { decide } from "../src/decide";
import { REGISTRY } from "../src/registry";
import { REMINDER_INTERVAL_MS, waitingFields } from "../src/rules/waiting";
import type { Accepted, Actor, Ctx, Draft, Game, Rejection } from "../src/types";
import { checkAll } from "./support/checks";
import { GAME_ID, HOST_UID, cid, ctxFor, deepFreeze, gameWithDeck, makeGame, makePlayer, makeRound, pid, seatUidOf, userActor } from "./support/factories";
import { roundGame } from "./support/round-fixtures";

const DAY = 86_400_000;
const NOW = 5_000_000;
const none = { waitingOn: [], episode: null, waitingSince: null, reminderDueAt: null };

/** WRITING with players 0..n-1; `writing` lists who has not finished. */
const writingGame = (n: number, writing: number[], over: Partial<Game> = {}): Game =>
  makeGame({ phase: "WRITING", players: Array.from({ length: n }, (_, i) => makePlayer(i, { status: writing.includes(i) ? "writing" : "ready" })), ...over });

/** PLAYING with active players 0..n-1 (0 judges by default) and an open round. */
const playingGame = (n: number, over: Partial<Game> = {}, round: Parameters<typeof makeRound>[0] = {}): Game =>
  makeGame({
    phase: "PLAYING",
    players: Array.from({ length: n }, (_, i) => makePlayer(i, { status: "active" })),
    round: makeRound({ number: 3, judgeId: pid(0), roster: Array.from({ length: n }, (_, i) => pid(i)), ...round }),
    ...over,
  });

describe("V7 REMINDER_INTERVAL_MS", () => {
  test("is 24 hours", () => expect(REMINDER_INTERVAL_MS).toBe(DAY));
});

describe("V7 waitingOn (LLD 1 section 4.2)", () => {
  test("WRITING: the seated players still writing, in seat order", () => {
    expect(waitingFields(writingGame(4, [1, 3]), NOW, true).waitingOn).toEqual([pid(1), pid(3)]);
  });

  test("WRITING: left and removed players are not waited on", () => {
    const g = writingGame(4, [1, 3]);
    const left = { ...g, players: g.players.map((p) => (p.id === pid(1) ? { ...p, status: "left" as const } : p)) };
    expect(waitingFields(left, NOW, true).waitingOn).toEqual([pid(3)]);
  });

  test("SUBMITTING: expected players (roster, active, not the judge) with no submission", () => {
    const g = playingGame(4, {}, { submissions: [{ playerId: pid(2), cardId: "c_0000000001" }] });
    expect(waitingFields(g, NOW, true).waitingOn).toEqual([pid(1), pid(3)]);
  });

  test("SUBMITTING: a roster member who left, and a player not in the roster, are not expected", () => {
    const base = playingGame(5, {}, { roster: [pid(0), pid(1), pid(2), pid(3)] });
    const g = { ...base, players: base.players.map((p) => (p.id === pid(3) ? { ...p, status: "left" as const } : p)) };
    expect(waitingFields(g, NOW, true).waitingOn).toEqual([pid(1), pid(2)]);
  });

  test("JUDGING: the judge alone; [] when the judge is null", () => {
    expect(waitingFields(playingGame(4, {}, { phase: "JUDGING", revealOrder: ["c_0000000001"] }), NOW, true).waitingOn).toEqual([pid(0)]);
    const nullJudge = waitingFields(playingGame(4, {}, { phase: "JUDGING", judgeId: null }), NOW, true);
    expect(nullJudge.waitingOn).toEqual([]);
    expect(nullJudge.episode).toBeNull();
  });

  test("PLAYING: late joiners still writing are appended in both round phases", () => {
    const withLate = (round: Parameters<typeof makeRound>[0]): Game => {
      const g = playingGame(3, {}, round);
      return { ...g, players: [...g.players, makePlayer(3, { status: "writing" })] };
    };
    expect(waitingFields(withLate({}), NOW, true).waitingOn).toEqual([pid(1), pid(2), pid(3)]);
    expect(waitingFields(withLate({ phase: "JUDGING" }), NOW, true).waitingOn).toEqual([pid(0), pid(3)]);
  });

  test("computed even while paused", () => {
    expect(waitingFields(writingGame(2, [0, 1], { paused: true }), NOW, true).waitingOn).toEqual([pid(0), pid(1)]);
  });

  test("LOBBY, FINISHED and ENDED wait on nobody", () => {
    for (const phase of ["LOBBY", "FINISHED", "ENDED"] as const) {
      expect(waitingFields(makeGame({ phase, players: [makePlayer(0, { status: "writing" })] }), NOW, true)).toMatchObject(none);
    }
  });
});

describe("V7 episode key", () => {
  test("WRITING is \"writing\"; SUBMITTING and JUDGING are {round}:{roundPhase}:{judgeId}", () => {
    expect(waitingFields(writingGame(3, [0]), NOW, true).episode).toBe("writing");
    expect(waitingFields(playingGame(3), NOW, true).episode).toBe(`3:SUBMITTING:${pid(0)}`);
    expect(waitingFields(playingGame(3, {}, { phase: "JUDGING" }), NOW, true).episode).toBe(`3:JUDGING:${pid(0)}`);
  });

  test("null when paused, when nobody is waited on, and in any other phase", () => {
    expect(waitingFields(writingGame(2, [0, 1], { paused: true }), NOW, true).episode).toBeNull();
    expect(waitingFields(playingGame(3, { paused: true }), NOW, true).episode).toBeNull();
    expect(waitingFields(writingGame(3, []), NOW, true).episode).toBeNull();
    expect(waitingFields(makeGame({ phase: "LOBBY" }), NOW, true).episode).toBeNull();
  });

  test("a null episode has null waitingSince and reminderDueAt and keeps episodeGen", () => {
    const f = waitingFields(writingGame(3, [], { episodeGen: 4, waitingSince: 1, reminderDueAt: 2, episode: "writing" }), NOW, true);
    expect(f).toEqual({ waitingOn: [], episode: null, episodeGen: 4, waitingSince: null, reminderDueAt: null });
  });
});

describe("V7 episode clock", () => {
  const running = (over: Partial<Game> = {}) => writingGame(3, [0, 1], { episode: "writing", episodeGen: 2, waitingSince: 100, reminderDueAt: 100 + DAY, ...over });

  test("an episode that starts sets waitingSince = now, reminderDueAt = now + 24 h and episodeGen + 1", () => {
    expect(waitingFields(running(), NOW, true)).toEqual({ waitingOn: [pid(0), pid(1)], episode: "writing", episodeGen: 3, waitingSince: NOW, reminderDueAt: NOW + DAY });
  });

  test("a running episode keeps its clock and generation; only waitingOn is recomputed", () => {
    expect(waitingFields(running(), NOW, false)).toEqual({ waitingOn: [pid(0), pid(1)], episode: "writing", episodeGen: 2, waitingSince: 100, reminderDueAt: 100 + DAY });
  });

  test("a late joiner or a finisher changes waitingOn but not the episode, generation or clock", () => {
    const g = running();
    const joined = { ...g, players: [...g.players, makePlayer(3, { status: "writing" })] };
    expect(waitingFields(joined, NOW, false)).toMatchObject({ waitingOn: [pid(0), pid(1), pid(3)], episodeGen: 2, waitingSince: 100, reminderDueAt: 100 + DAY });
  });

  test("a new episode starts by itself when the key changes (round open, close, judge change) even without the flag", () => {
    const g = playingGame(3, { episode: `3:SUBMITTING:${pid(0)}`, episodeGen: 5, waitingSince: 100, reminderDueAt: 100 + DAY }, { phase: "JUDGING" });
    expect(waitingFields(g, NOW, false)).toMatchObject({ episode: `3:JUDGING:${pid(0)}`, episodeGen: 6, waitingSince: NOW, reminderDueAt: NOW + DAY });
  });

  test("un-pausing starts a new episode: the key was null, so \"writing\" returns with a higher generation", () => {
    const paused = writingGame(3, [0, 1], { episode: null, episodeGen: 2, waitingSince: null, reminderDueAt: null });
    expect(waitingFields(paused, NOW, false)).toMatchObject({ episode: "writing", episodeGen: 3, waitingSince: NOW });
  });

  test("the same key can start again when the caller says so (a voided round reopened with the same number and judge)", () => {
    const g = playingGame(3, { episode: `3:SUBMITTING:${pid(0)}`, episodeGen: 5, waitingSince: 100, reminderDueAt: 100 + DAY });
    expect(waitingFields(g, NOW, true)).toMatchObject({ episodeGen: 6, waitingSince: NOW });
  });

  test("reminderDueAt - waitingSince is exactly 24 h whenever the episode is non-null", () => {
    const f = waitingFields(running(), NOW, true);
    expect((f.reminderDueAt ?? 0) - (f.waitingSince ?? 0)).toBe(DAY);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// #24 (1.7) through the real REGISTRY and `decide`

const cmd = (c: object): Command => c as unknown as Command;
const seat = (n: number): Actor => userActor(n === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(n)));
const system: Actor = { kind: "system" };
const run = (g: Game | null, c: object, actor: Actor, ctx: Partial<Ctx> = {}) => decide(g === null ? null : deepFreeze(structuredClone(g)), cmd(c), ctxFor({ actor, ...ctx }));
const accepted = (g: Game, c: object, actor: Actor, ctx: Partial<Ctx> = {}): Accepted => {
  const r = run(g, c, actor, ctx);
  if (!r.ok) throw new Error(`expected an acceptance of ${JSON.stringify(c)}, got ${JSON.stringify(r.error)}`);
  checkAll({ index: 0, before: g, cmd: c, result: r, actor, drafts: ctx.drafts ?? {} });
  return r.value;
};
const rejected = (g: Game, c: object, actor: Actor): Rejection => {
  const r = run(g, c, actor);
  if (r.ok) throw new Error(`expected a rejection of ${JSON.stringify(c)}`);
  return r.error;
};
const mark = (g: Game, extra: object = {}) => ({ type: "markReminded", episode: g.episode, episodeGen: g.episodeGen, ...extra });
const draft = (red: number, green: number): Draft => ({ red: Array.from({ length: red }, (_, k) => `red ${k}`), green: Array.from({ length: green }, (_, k) => `green ${k}`) });
const T0 = 10_000;
const lobby = (n: number, over: Partial<Game> = {}): Game => makeGame({ version: 3, players: Array.from({ length: n }, (_, i) => makePlayer(i)), ...over });

/** Real flows: a table of four that starts WRITING at T0 on a new deck, and one that starts PLAYING at T0 on a reused deck (round 1 SUBMITTING). */
const writing4 = (): Game => accepted(lobby(4), { type: "startGame" }, seat(0), { now: T0 }).state;
const playing4 = (): Game => accepted(gameWithDeck(4, 40, 32, { version: 3 }), { type: "startGame" }, seat(0), { now: T0 }).state;
const judgeOf = (g: Game): number => g.players.findIndex((p) => p.id === g.round?.judgeId);
const nonJudges = (g: Game): number[] => g.players.map((_, i) => i).filter((i) => i !== judgeOf(g));
const open = (g: Game): NonNullable<Game["round"]> => g.round as NonNullable<Game["round"]>;
const confirmAs = (g: Game, i: number, now: number): Game => {
  const p = g.players[i] as Game["players"][number];
  return accepted(g, { type: "confirmSubmission", cardId: p.hand[0], expectedVersion: open(g).changedAtVersion }, seat(i), { now }).state;
};
const closeAt = (g: Game, now: number): Game => accepted(g, { type: "closeSubmissions", expectedVersion: open(g).changedAtVersion }, seat(0), { now }).state;
const clock = (g: Game) => ({ episode: g.episode, episodeGen: g.episodeGen, waitingSince: g.waitingSince, reminderDueAt: g.reminderDueAt });

describe("M1 markReminded is registered as the system-only, WRITING and PLAYING, not-needs-play, not-stale command (7.1)", () => {
  test("the row: phases WRITING and PLAYING, no needsPlay, no stale; only the system actor passes guard 2", () => {
    const spec = REGISTRY.markReminded;
    expect(spec).toBeDefined();
    expect(spec?.creates).toBeUndefined();
    if (spec === undefined || spec.creates === true) throw new Error("markReminded must be a state-bound spec");
    expect([...spec.phases].sort()).toEqual(["PLAYING", "WRITING"]);
    expect(spec.needsPlay).toBeUndefined();
    expect(spec.stale).toBeUndefined();
  });

  test("a user actor (the host, a seated player, a stranger) gets NOT_AUTHORIZED in WRITING and PLAYING, before the payload is looked at", () => {
    for (const g of [writing4(), playing4()]) {
      for (const who of [seat(0), seat(1), userActor("stranger-uid")]) {
        expect(rejected(g, mark(g), who)).toStrictEqual({ code: "NOT_AUTHORIZED" });
        expect(rejected(g, { type: "markReminded", episode: 5, episodeGen: "x" }, who)).toStrictEqual({ code: "NOT_AUTHORIZED" });
      }
    }
  });

  test("the system actor is accepted (a no-op when not due)", () => {
    const g = writing4();
    expect(run(g, mark(g), system, { now: T0 }).ok).toBe(true);
  });
});

describe("M2 markReminded phases: LOBBY, FINISHED and ENDED are WRONG_PHASE (7.1)", () => {
  const inPhase = (phase: Game["phase"]): Game => makeGame({ phase, players: [0, 1, 2].map((i) => makePlayer(i, { status: phase === "LOBBY" ? "writing" : "active" })) });
  for (const phase of ["LOBBY", "FINISHED", "ENDED"] as const) {
    test(`${phase}: WRONG_PHASE for the system, NOT_AUTHORIZED for a user (guard 2 first, ENDED excepted)`, () => {
      const g = inPhase(phase);
      expect(rejected(g, { type: "markReminded", episode: "writing", episodeGen: 1 }, system)).toStrictEqual({ code: "WRONG_PHASE" });
      expect(rejected(g, { type: "markReminded", episode: "writing", episodeGen: 1 }, seat(0))).toStrictEqual(phase === "ENDED" ? { code: "WRONG_PHASE" } : { code: "NOT_AUTHORIZED" });
    });
  }

  test("the phase guard runs before the payload guard: a malformed payload in LOBBY is WRONG_PHASE", () => {
    expect(rejected(inPhase("LOBBY"), { type: "markReminded", episode: 5, episodeGen: "x" }, system)).toStrictEqual({ code: "WRONG_PHASE" });
  });
});

describe("M3 markReminded payload: a malformed episode or episodeGen is INVALID_ARGUMENT (guard 7)", () => {
  test("episode must be a string; episodeGen a non-negative integer", () => {
    const g = writing4();
    for (const episode of [undefined, null, 5, true, {}, ["writing"]]) expect(rejected(g, { type: "markReminded", episode, episodeGen: g.episodeGen }, system)).toStrictEqual({ code: "INVALID_ARGUMENT" });
    for (const episodeGen of [undefined, null, "1", 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, {}]) expect(rejected(g, { type: "markReminded", episode: "writing", episodeGen }, system)).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("an empty episode string is well formed (it just does not match)", () => {
    const g = writing4();
    const v = accepted(g, { type: "markReminded", episode: "", episodeGen: g.episodeGen }, system, { now: g.reminderDueAt ?? 0 });
    expect(v.aggregateChanged).toBe(false);
  });
});

describe("M4 an accepted markReminded advances reminderDueAt and nothing else (7.4)", () => {
  const due = T0 + DAY;
  const cases: [string, () => Game][] = [
    ["WRITING", writing4],
    ["SUBMITTING", playing4],
    ["JUDGING", () => { const g = playing4(); return closeAt(confirmAs(g, nonJudges(g)[0] as number, T0 + 1), T0 + 2); }],
  ];
  for (const [name, make] of cases) {
    test(`${name}: with matching episode and episodeGen, at the due time or later, reminderDueAt = now + 24 h, version + 1, events [], only those two fields differ`, () => {
      const g = make();
      expect(g.episode).not.toBeNull();
      for (const now of [(g.reminderDueAt ?? 0), (g.reminderDueAt ?? 0) + 7, (g.reminderDueAt ?? 0) + 5 * DAY]) {
        const v = accepted(g, mark(g), system, { now });
        expect(v).toMatchObject({ aggregateChanged: true, events: [], draftChanges: [], roundRecords: [], redactEnvelope: false });
        expect(v.state).toEqual({ ...g, version: g.version + 1, reminderDueAt: now + DAY });
        expect(now + DAY).toBeGreaterThan(g.reminderDueAt ?? 0);
      }
    });
  }

  test("a late joiner's waitingOn entry, waitingSince, episode and episodeGen all survive; expectedVersion is ignored (not stale-checked)", () => {
    const g = writing4();
    const joined = accepted(g, { type: "join", playerId: pid(9), name: "Late Nine" }, seat(9), { now: T0 + 50 }).state;
    expect(joined.waitingOn).toContain(pid(9));
    const v = accepted(joined, mark(joined, { expectedVersion: 0 }), system, { now: due + 1 });
    expect(v.state).toEqual({ ...joined, version: joined.version + 1, reminderDueAt: due + 1 + DAY });
  });

  test("settle still runs, and keeps the advance: a stale waitingOn is recomputed in the same command while reminderDueAt stays now + 24 h", () => {
    const g = { ...writing4(), waitingOn: [pid(0)] };
    const v = accepted(g, mark(g), system, { now: due });
    expect(v.state.waitingOn).toEqual([pid(0), pid(1), pid(2), pid(3)]);
    expect(v.state).toMatchObject({ reminderDueAt: due + DAY, waitingSince: T0, episode: "writing", episodeGen: 1, version: g.version + 1 });
  });

  test("chained: after an advance the same call is a no-op until the new due time, then advances again (24 h apart, never sooner)", () => {
    const g = writing4();
    const first = accepted(g, mark(g), system, { now: due }).state;
    expect(accepted(first, mark(first), system, { now: due + 1 }).aggregateChanged).toBe(false);
    const second = accepted(first, mark(first), system, { now: due + DAY }).state;
    expect(second.reminderDueAt).toBe(due + 2 * DAY);
  });
});

describe("M5 markReminded is a no-op, not a rejection, unless episode, episodeGen and due all match", () => {
  const noop = (g: Game, c: object, now: number): void => {
    const v = accepted(g, c, system, { now });
    expect(v).toMatchObject({ aggregateChanged: false, events: [], draftChanges: [], roundRecords: [], redactEnvelope: false });
    expect(v.state).toEqual(g);
  };

  test("a wrong episode, a stale episodeGen and a future episodeGen leave the state untouched and the version alone", () => {
    for (const g of [writing4(), playing4()]) {
      const now = (g.reminderDueAt ?? 0) + 1;
      noop(g, mark(g, { episode: "7:JUDGING:p_zzzzzzzz" }), now);
      noop(g, mark(g, { episode: "" }), now);
      noop(g, mark(g, { episodeGen: g.episodeGen - 1 }), now);
      noop(g, mark(g, { episodeGen: g.episodeGen + 1 }), now);
    }
  });

  test("not yet due: one millisecond early is a no-op, the due time itself is not", () => {
    const g = writing4();
    noop(g, mark(g), (g.reminderDueAt ?? 0) - 1);
    expect(accepted(g, mark(g), system, { now: g.reminderDueAt ?? 0 }).aggregateChanged).toBe(true);
  });

  test("paused: a no-op even when episode and episodeGen match and the due time passed (a hand-built paused game that still holds an episode), and in a real paused game", () => {
    const g = writing4();
    noop({ ...g, paused: true }, mark(g), (g.reminderDueAt ?? 0) + DAY);
    const p = playing4();
    noop({ ...p, paused: true }, mark(p), (p.reminderDueAt ?? 0) + DAY);
    // real: two leave a table of four in WRITING, the game pauses, the episode is null
    let real = g;
    for (const i of [1, 2]) real = accepted(real, { type: "leave" }, seat(i), { now: T0 + i }).state;
    expect(real).toMatchObject({ paused: true, episode: null });
    noop(real, { type: "markReminded", episode: "writing", episodeGen: real.episodeGen }, T0 + 10 * DAY);
  });

  test("empty waitingOn: a no-op even when everything else matches", () => {
    const g = writing4();
    noop({ ...g, waitingOn: [] }, mark(g), (g.reminderDueAt ?? 0) + DAY);
  });

  test("no episode at all (null) cannot match any string", () => {
    const g = { ...writing4(), episode: null, waitingSince: null, reminderDueAt: null };
    noop(g, { type: "markReminded", episode: "writing", episodeGen: g.episodeGen }, T0 + 10 * DAY);
  });
});

describe("M6 markReminded is not a round command: not stale-checked, does not need play", () => {
  test("a missing, low or absurd expectedVersion changes nothing (no STALE, no INVALID_ARGUMENT)", () => {
    const g = playing4();
    expect(open(g).changedAtVersion).toBeGreaterThan(0);
    for (const expectedVersion of [undefined, 0, -3, 1e9, "x"]) {
      const v = accepted(g, mark(g, expectedVersion === undefined ? {} : { expectedVersion }), system, { now: (g.reminderDueAt ?? 0) });
      expect(v.aggregateChanged).toBe(true);
    }
  });

  test("a paused PLAYING game is not PAUSED for it: the answer is a no-op, not a rejection", () => {
    const g = { ...playing4(), paused: true };
    expect(run(g, mark(g), system, { now: (g.reminderDueAt ?? 0) + 1 })).toMatchObject({ ok: true, value: { aggregateChanged: false } });
  });
});

describe("X8-a episode and episodeGen over the real commands (4.2)", () => {
  test("writing start: the episode \"writing\" starts at the startGame time with generation + 1 and a 24 h clock", () => {
    const g = lobby(4);
    expect(g.episodeGen).toBe(0);
    const w = accepted(g, { type: "startGame" }, seat(0), { now: T0 }).state;
    expect(clock(w)).toEqual({ episode: "writing", episodeGen: 1, waitingSince: T0, reminderDueAt: T0 + DAY });
  });

  test("a finishWriting changes waitingOn only: episode, generation and clock are unchanged", () => {
    const w = writing4();
    const v = accepted(w, { type: "finishWriting" }, seat(1), { now: T0 + 500, drafts: { [pid(1)]: draft(10, 8) } }).state;
    expect(v.waitingOn).toEqual([pid(0), pid(2), pid(3)]);
    expect(clock(v)).toEqual(clock(w));
  });

  test("round open: the first round's episode starts when play begins; a resolved round opens the next with a new key and generation", () => {
    const p = playing4();
    expect(p.episode).toBe(`1:SUBMITTING:${open(p).judgeId}`);
    expect(clock(p)).toMatchObject({ episodeGen: 1, waitingSince: T0, reminderDueAt: T0 + DAY });
    let g = p;
    for (const i of nonJudges(p)) g = confirmAs(g, i, T0 + 10 + i); // the last confirmation closes the round (allIn)
    expect(g.episode).toBe(`1:JUDGING:${open(p).judgeId}`);
    const judge = g.players[judgeOf(g)] as Game["players"][number];
    const pick = open(g).revealOrder?.[0];
    const next = accepted(g, { type: "pickWinner", submissionId: pick, expectedVersion: open(g).changedAtVersion }, userActor(judge.uid), { now: T0 + 99 }).state;
    expect(next.episode).toBe(`2:SUBMITTING:${open(next).judgeId}`);
    expect(clock(next)).toMatchObject({ episodeGen: g.episodeGen + 1, waitingSince: T0 + 99, reminderDueAt: T0 + 99 + DAY });
  });

  test("a submission leaves the episode, generation and clock alone; the submitter leaves waitingOn", () => {
    const p = playing4();
    const first = nonJudges(p)[0] as number;
    const v = confirmAs(p, first, T0 + 5);
    expect(v.waitingOn).not.toContain(pid(first));
    expect(clock(v)).toEqual(clock(p));
  });

  test("close (SUBMITTING to JUDGING) starts a new episode with waitingOn = the judge", () => {
    const p = playing4();
    const v = closeAt(confirmAs(p, nonJudges(p)[0] as number, T0 + 5), T0 + 6);
    expect(v.episode).toBe(`1:JUDGING:${open(p).judgeId}`);
    expect(v.waitingOn).toEqual([open(p).judgeId as string]);
    expect(clock(v)).toEqual({ episode: v.episode, episodeGen: p.episodeGen + 1, waitingSince: T0 + 6, reminderDueAt: T0 + 6 + DAY });
  });

  test("judge change (passJudging in SUBMITTING): the key carries the new judge, the generation rises, the clock restarts", () => {
    const p = playing4();
    const v = accepted(p, { type: "passJudging", expectedVersion: open(p).changedAtVersion }, seat(0), { now: T0 + 77 }).state;
    expect(open(v).judgeId).not.toBe(open(p).judgeId);
    expect(clock(v)).toEqual({ episode: `1:SUBMITTING:${open(v).judgeId}`, episodeGen: p.episodeGen + 1, waitingSince: T0 + 77, reminderDueAt: T0 + 77 + DAY });
  });

  test("void: a judge pass in JUDGING whose new judge held the only submission voids the round, reopens it, and starts one episode (generation + 1, not + 2)", () => {
    const g0 = roundGame({ n: 4, judge: 1, submitted: [2], phase: "JUDGING", extra: { episode: "1:JUDGING:" + pid(1), episodeGen: 4, waitingSince: 100, reminderDueAt: 100 + DAY, waitingOn: [pid(1)] } });
    const v = accepted(g0, { type: "passJudging", expectedVersion: 5 }, seat(0), { now: T0 });
    expect(v.events.map((e) => e.t)).toEqual(["JudgeChanged", "RoundVoided", "RoundOpened"]);
    expect(clock(v.state)).toEqual({ episode: `1:SUBMITTING:${open(v.state).judgeId}`, episodeGen: 5, waitingSince: T0, reminderDueAt: T0 + DAY });
  });

  test("a void that reopens under the same key still starts a new episode (the episodeStarted flag, not the key, decides)", () => {
    // The key repeats only if the reopened round has the stored key; no real command sequence reaches that (see the ledger), so the state is hand-built.
    const g0 = roundGame({ n: 4, judge: 1, submitted: [2], phase: "JUDGING", extra: { waitingOn: [pid(1)], episodeGen: 4, waitingSince: 100, reminderDueAt: 100 + DAY } });
    const probe = accepted(g0, { type: "passJudging", expectedVersion: 5 }, seat(0), { now: T0 }).state;
    const sameKey = { ...g0, episode: probe.episode };
    const v = accepted(sameKey, { type: "passJudging", expectedVersion: 5 }, seat(0), { now: T0 + 1 }).state;
    expect(v.episode).toBe(probe.episode);
    expect(clock(v)).toMatchObject({ episodeGen: 5, waitingSince: T0 + 1 });
  });

  test("pause then un-pause in WRITING: the key is \"writing\" again with a higher generation and a fresh clock", () => {
    let g = writing4();
    for (const i of [1, 2]) g = accepted(g, { type: "leave" }, seat(i), { now: T0 + i }).state;
    expect(clock(g)).toEqual({ episode: null, episodeGen: 1, waitingSince: null, reminderDueAt: null });
    g = accepted(g, { type: "join", playerId: pid(8), name: "Back Eight" }, seat(8), { now: T0 + 1000 }).state;
    expect(g.paused).toBe(false);
    expect(clock(g)).toEqual({ episode: "writing", episodeGen: 2, waitingSince: T0 + 1000, reminderDueAt: T0 + 1000 + DAY });
  });

  test("un-pause in PLAYING (recovery by a late joiner finishing) starts a new episode too", () => {
    let g = playing4();
    g = accepted(g, { type: "leave" }, seat(nonJudges(g)[0] as number), { now: T0 + 1 }).state;
    g = accepted(g, { type: "leave" }, seat(nonJudges(g).filter((i) => g.players[i]?.status === "active")[0] as number), { now: T0 + 2 }).state;
    expect(g).toMatchObject({ paused: true, episode: null });
    const gen = g.episodeGen;
    g = accepted(g, { type: "join", playerId: pid(8), name: "Back Eight" }, seat(8), { now: T0 + 3 }).state;
    expect(g.paused).toBe(true);
    const writer = g.players.find((p) => p.id === pid(8)) as Game["players"][number];
    g = accepted(g, { type: "finishWriting" }, seat(8), { now: T0 + 4000, drafts: { [pid(8)]: draft(writer.writeTarget?.red ?? 0, writer.writeTarget?.green ?? 0) } }).state;
    expect(g.paused).toBe(false);
    expect(g.episodeGen).toBe(gen + 1);
    expect(clock(g)).toMatchObject({ waitingSince: T0 + 4000, reminderDueAt: T0 + 4000 + DAY });
    expect(g.episode).not.toBeNull();
  });
});

describe("X8-b waitingOn and late joiners over the real commands (4.2)", () => {
  test("WRITING: the seated players still writing; a finisher leaves, a leaver leaves", () => {
    let g = writing4();
    expect(g.waitingOn).toEqual([pid(0), pid(1), pid(2), pid(3)]);
    g = accepted(g, { type: "finishWriting" }, seat(2), { now: T0 + 1, drafts: { [pid(2)]: draft(10, 8) } }).state;
    expect(g.waitingOn).toEqual([pid(0), pid(1), pid(3)]);
    g = accepted(g, { type: "leave" }, seat(1), { now: T0 + 2 }).state;
    expect(g.waitingOn).toEqual([pid(0), pid(3)]);
  });

  test("SUBMITTING: the expected players with no submission; JUDGING: the judge", () => {
    const p = playing4();
    expect([...p.waitingOn].sort()).toEqual(nonJudges(p).map((i) => pid(i)).sort());
    const [a, b, c] = nonJudges(p) as [number, number, number];
    const one = confirmAs(p, a, T0 + 1);
    expect([...one.waitingOn].sort()).toEqual([pid(b), pid(c)].sort());
    const judging = closeAt(one, T0 + 2);
    expect(judging.waitingOn).toEqual([open(p).judgeId as string]);
  });

  test("a late joiner in WRITING joins waitingOn at the end with no change to episode, generation or clock, and leaves it on finishWriting", () => {
    const w = writing4();
    const j = accepted(w, { type: "join", playerId: pid(9), name: "Late Nine" }, seat(9), { now: T0 + 900 }).state;
    expect(j.waitingOn).toEqual([...w.waitingOn, pid(9)]);
    expect(clock(j)).toEqual(clock(w));
    const target = j.players.find((p) => p.id === pid(9))?.writeTarget as { red: number; green: number };
    const f = accepted(j, { type: "finishWriting" }, seat(9), { now: T0 + 950, drafts: { [pid(9)]: draft(target.red, target.green) } }).state;
    expect(f.waitingOn).toEqual(w.waitingOn);
    expect(clock(f)).toEqual(clock(w));
  });

  for (const stage of ["SUBMITTING", "JUDGING"] as const) {
    test(`a late joiner in ${stage} joins waitingOn with no change to episode, generation or waitingSince, and leaves it on finishWriting`, () => {
      let p = playing4();
      if (stage === "JUDGING") p = closeAt(confirmAs(p, nonJudges(p)[0] as number, T0 + 1), T0 + 2);
      const j = accepted(p, { type: "join", playerId: pid(9), name: "Late Nine" }, seat(9), { now: T0 + 900 }).state;
      expect(j.phase).toBe("PLAYING");
      expect(j.waitingOn).toEqual([...p.waitingOn, pid(9)]);
      expect(clock(j)).toEqual(clock(p));
      const target = j.players.find((x) => x.id === pid(9))?.writeTarget as { red: number; green: number };
      const f = accepted(j, { type: "finishWriting" }, seat(9), { now: T0 + 950, drafts: { [pid(9)]: draft(target.red, target.green) } }).state;
      expect(f.waitingOn).toEqual(p.waitingOn);
      expect(clock(f)).toEqual(clock(p));
    });
  }

  test("saveDraft by a late joiner in PLAYING is accepted; by a ready player it is WRONG_PHASE (finished)", () => {
    const p = playing4();
    const j = accepted(p, { type: "join", playerId: pid(9), name: "Late Nine" }, seat(9), { now: T0 + 900 }).state;
    expect(run(j, { type: "saveDraft", red: ["a"], green: [] }, seat(9)).ok).toBe(true);
    const target = j.players.find((x) => x.id === pid(9))?.writeTarget as { red: number; green: number };
    const f = accepted(j, { type: "finishWriting" }, seat(9), { now: T0 + 950, drafts: { [pid(9)]: draft(target.red, target.green) } }).state;
    expect(rejected(f, { type: "saveDraft", red: ["a"], green: [] }, seat(9))).toStrictEqual({ code: "WRONG_PHASE", detail: "finished" });
  });
});

describe("X8-c reminderDueAt is null when nobody can be reminded", () => {
  test("paused (WRITING and PLAYING), FINISHED and ENDED", () => {
    let w = writing4();
    for (const i of [1, 2]) w = accepted(w, { type: "leave" }, seat(i), { now: T0 + i }).state;
    expect(w).toMatchObject({ paused: true, episode: null, reminderDueAt: null, waitingSince: null });
    expect(w.waitingOn).toEqual([pid(0), pid(3)]); // still computed while paused

    let p = playing4();
    for (let k = 0; k < 2; k++) p = accepted(p, { type: "leave" }, seat(nonJudges(p).find((i) => p.players[i]?.status === "active") as number), { now: T0 + k }).state;
    expect(p).toMatchObject({ paused: true, episode: null, reminderDueAt: null, waitingSince: null });

    const prior = [{ round: 1, judgeId: pid(0), greenCardId: "c_x", plays: [], winnerCardId: "c_y", winnerId: pid(2) }];
    const g = roundGame({ target: 2, scores: [0, 0, 1, 0], history: prior, judge: 1, submitted: [2, 3], phase: "JUDGING" });
    const done = accepted(g, { type: "pickWinner", submissionId: cid(206), expectedVersion: 5 }, seat(1), { now: T0 }).state;
    expect(done.phase).toBe("FINISHED");
    expect(done).toMatchObject({ episode: null, reminderDueAt: null, waitingSince: null, waitingOn: [] });

    const ended = accepted(writing4(), { type: "endGame" }, seat(0), { now: T0 + 5 }).state;
    expect(ended).toMatchObject({ phase: "ENDED", episode: null, reminderDueAt: null, waitingSince: null, waitingOn: [] });
  });
});
