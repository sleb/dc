import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Command } from "@dc/contracts";
import { decide } from "../src/decide";
import { makeRng } from "../src/rng";
import type { Accepted, Actor, Ctx, Draft, Game, GameDrafts, Rejection } from "../src/types";
import { checkAll } from "./support/checks";
import { GAME_ID, HOST_UID, cid, counterMintId, ctxFor, deepFreeze, gameWithDeck, makeGame, makePlayer, makeRound, pid, recordingRng, scriptedRng, seatUidOf, userActor } from "./support/factories";
import { assertProperty } from "./support/fc";

const cmd = (c: object): Command => c as unknown as Command;
const accepted = (g: Game | null, c: object, ctx: Ctx = ctxFor()): Accepted => {
  const r = decide(g, cmd(c), ctx);
  if (!r.ok) throw new Error(`expected an acceptance of ${JSON.stringify(c)}, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const rejected = (g: Game | null, c: object, ctx: Ctx = ctxFor()): Rejection => {
  const r = decide(g, cmd(c), ctx);
  if (r.ok) throw new Error(`expected a rejection of ${JSON.stringify(c)}`);
  return r.error;
};
const seat = (n: number): Actor => userActor(n === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(n)));
const as = (n: number, over: Partial<Ctx> = {}): Ctx => ctxFor({ actor: seat(n), ...over });
const T = { red: 2, green: 1 };
const draft = (red: number, green: number, tag = "t"): Draft => ({ red: Array.from({ length: red }, (_, k) => `${tag} red ${k}`), green: Array.from({ length: green }, (_, k) => `${tag} green ${k}`) });

// ---------------------------------------------------------------------------------------------------------------------
// S1, S2 startGame (7.1, 7.2, 9.3)

const lobby = (n: number, over: Partial<Game> = {}): Game => makeGame({ version: 3, players: Array.from({ length: n }, (_, i) => makePlayer(i)), ...over });
/** A LOBBY with an imported deck: `red` and `green` cards in the decks. */
const lobbyWithDeck = (n: number, red: number, green: number, over: Partial<Game> = {}): Game => gameWithDeck(n, red, green, { version: 3, ...over });

describe("S1 startGame preconditions (7.1, 5.3)", () => {
  test("host only: a seated non-host, a stranger and the system actor get NOT_AUTHORIZED", () => {
    expect(rejected(lobby(4), { type: "startGame" }, as(1))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(lobby(4), { type: "startGame" }, ctxFor({ actor: userActor("stranger") }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(lobby(4), { type: "startGame" }, ctxFor({ actor: { kind: "system" } }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
  });

  test("LOBBY only: WRITING, PLAYING and FINISHED are WRONG_PHASE without detail, ENDED too", () => {
    for (const phase of ["WRITING", "PLAYING", "FINISHED", "ENDED"] as const) {
      expect(rejected(lobby(4, { phase }), { type: "startGame" })).toStrictEqual({ code: "WRONG_PHASE" });
    }
  });

  test("fewer than 3 seated players is NOT_PLAYABLE players; departed seats do not count", () => {
    expect(rejected(lobby(2), { type: "startGame" })).toStrictEqual({ code: "NOT_PLAYABLE", detail: "players" });
    expect(rejected(lobby(0), { type: "startGame" })).toStrictEqual({ code: "NOT_PLAYABLE", detail: "players" });
    const g = lobby(4, { players: [makePlayer(0), makePlayer(1), makePlayer(2, { status: "left" }), makePlayer(3, { status: "removed" })] });
    expect(rejected(g, { type: "startGame" })).toStrictEqual({ code: "NOT_PLAYABLE", detail: "players" });
  });

  test("exactly 3 seated players start", () => {
    expect(accepted(lobby(3), { type: "startGame" }).state.phase).toBe("WRITING");
  });

  test("the host may start without holding a seat", () => {
    const g = lobby(0, { players: [makePlayer(1), makePlayer(2), makePlayer(3)] });
    const v = accepted(g, { type: "startGame" });
    expect(v.state.players).toHaveLength(3);
    expect(v.state.phase).toBe("WRITING");
  });

  test("a later guard never leaks past an earlier one: non-host in the wrong phase is NOT_AUTHORIZED; host in the wrong phase with 2 players is WRONG_PHASE", () => {
    expect(rejected(lobby(2, { phase: "PLAYING" }), { type: "startGame" }, as(1))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(lobby(2, { phase: "PLAYING" }), { type: "startGame" })).toStrictEqual({ code: "WRONG_PHASE" });
  });

  test("an unmet writeCountsOverride on an imported deck is NOT_PLAYABLE minimums: 4 players, T=8, existing 30 red and 32 green, override (1, 0)", () => {
    const g = lobbyWithDeck(4, 30, 32, { settings: { ...lobby(1).settings, writeCountsOverride: { red: 1, green: 0 } } });
    expect(rejected(g, { type: "startGame" })).toStrictEqual({ code: "NOT_PLAYABLE", detail: "minimums" });
  });

  test("an override out of range is unmet too (red above 10)", () => {
    const g = lobbyWithDeck(4, 40, 32, { settings: { ...lobby(1).settings, writeCountsOverride: { red: 11, green: 0 } } });
    expect(rejected(g, { type: "startGame" })).toStrictEqual({ code: "NOT_PLAYABLE", detail: "minimums" });
  });

  test("an override with no imported cards is INVALID_ARGUMENT, and it is guard 7: it wins over too few players", () => {
    expect(accepted(lobby(4), { type: "startGame" }).state.phase).toBe("WRITING"); // control: the same game without the override starts
    const s = { ...lobby(1).settings, writeCountsOverride: { red: 1, green: 1 } };
    expect(rejected(lobby(4, { settings: s }), { type: "startGame" })).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(lobby(2, { settings: s }), { type: "startGame" })).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("with too few players the minimums are not looked at: players comes first among the state preconditions", () => {
    const g = lobbyWithDeck(2, 1, 1, { settings: { ...lobby(1).settings, writeCountsOverride: { red: 0, green: 0 } } });
    expect(rejected(g, { type: "startGame" })).toStrictEqual({ code: "NOT_PLAYABLE", detail: "players" });
  });

  test("startGame is not a round command: a stale expectedVersion does not make it STALE", () => {
    expect(accepted(lobby(3), { type: "startGame", expectedVersion: 0 }).state.phase).toBe("WRITING");
  });

  test("a rejection leaves the input untouched", () => {
    const g = deepFreeze(lobby(2));
    const before = structuredClone(g);
    rejected(g, { type: "startGame" });
    expect(g).toEqual(before);
  });
});

describe("S2 startGame effects (7.2, 9.3)", () => {
  test("a new deck: WRITING, target = defaultTarget(N), writeCounts {10, T}, every seated player gets writeTarget, event WritingStarted, the episode starts", () => {
    const v = accepted(lobby(4), { type: "startGame" }, ctxFor({ now: 500 }));
    expect(v.aggregateChanged).toBe(true);
    expect(v.state).toMatchObject({ phase: "WRITING", target: 8, writeCounts: { red: 10, green: 8 }, version: 4, paused: false, episode: "writing", episodeGen: 1, waitingSince: 500 });
    expect(v.state.players.map((p) => [p.status, p.writeTarget])).toEqual(Array.from({ length: 4 }, () => ["writing", { red: 10, green: 8 }]));
    expect(v.state.waitingOn).toEqual([pid(0), pid(1), pid(2), pid(3)]);
    expect(v.events).toEqual([{ t: "WritingStarted", target: 8, writeCounts: { red: 10, green: 8 } }]);
    expect(v.draftChanges).toEqual([]);
    expect(v.redactEnvelope).toBe(false);
  });

  test("the default target follows the player count; a targetOverride wins", () => {
    expect(accepted(lobby(5), { type: "startGame" }).state.target).toBe(7);
    expect(accepted(lobby(6), { type: "startGame" }).state.target).toBe(6);
    expect(accepted(lobby(8), { type: "startGame" }).state.target).toBe(4);
    const s = { ...lobby(1).settings, targetOverride: 5 };
    const v = accepted(lobby(3, { settings: s }), { type: "startGame" });
    expect(v.state).toMatchObject({ target: 5, writeCounts: { red: 10, green: 5 } });
  });

  test("a reused deck, partial: n=5, T=7, existing 20 red and 10 green -> everyone writes 5 and 5", () => {
    const v = accepted(lobbyWithDeck(5, 20, 10), { type: "startGame" });
    expect(v.state.writeCounts).toEqual({ red: 5, green: 5 });
    expect(v.state.phase).toBe("WRITING");
    expect(v.state.players.every((p) => p.status === "writing")).toBe(true);
    expect(Object.keys(v.state.cards)).toHaveLength(30);
  });

  test("a reused deck that suffices: everyone is ready at once and play starts in the same command (PlayStarted ... RoundOpened)", () => {
    const v = accepted(lobbyWithDeck(4, 40, 32), { type: "startGame" });
    expect(v.state.writeCounts).toEqual({ red: 0, green: 0 });
    expect(v.state.phase).toBe("PLAYING");
    expect(v.state.players.every((p) => p.status === "active" && p.hand.length === 7)).toBe(true);
    expect(v.state.round).toMatchObject({ number: 1, phase: "SUBMITTING" });
    expect(v.events.map((e) => e.t)).toEqual(["WritingStarted", "PlayStarted", "PlayerActivated", "PlayerActivated", "PlayerActivated", "PlayerActivated", "RoundOpened"]);
    expect(v.state.version).toBe(4);
  });

  test("a valid override on an imported deck is honoured: players with {0,0} are ready, the rest write", () => {
    const g = lobbyWithDeck(4, 36, 32, { settings: { ...lobby(1).settings, writeCountsOverride: { red: 1, green: 0 } } });
    const v = accepted(g, { type: "startGame" });
    expect(v.state.writeCounts).toEqual({ red: 1, green: 0 });
    expect(v.state.players.every((p) => p.status === "writing")).toBe(true); // (1, 0) is not {0,0}
    const zero = lobbyWithDeck(4, 36, 32, { settings: { ...lobby(1).settings, writeCountsOverride: { red: 0, green: 0 } } });
    expect(accepted(zero, { type: "startGame" }).state.phase).toBe("PLAYING");
  });

  test("the rng is not touched when the game stays in WRITING", () => {
    const rng = scriptedRng([]);
    accepted(lobby(4), { type: "startGame" }, ctxFor({ rng }));
    expect(rng.drawn).toBe(0);
  });

  test("the host without a seat: only seated players get a writeTarget", () => {
    const g = lobby(0, { players: [makePlayer(1), makePlayer(2), makePlayer(3)] });
    const v = accepted(g, { type: "startGame" });
    expect(v.state.waitingOn).toEqual([pid(1), pid(2), pid(3)]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// E7 startGame half: accepted iff the formulas say so, against an independent implementation

const rMin = (n: number) => 7 * n + Math.max(2 * n, 7);
const gMin = (n: number, t: number) => n * t;
const dflt = (n: number) => (n <= 4 ? 8 : n === 5 ? 7 : n === 6 ? 6 : n === 7 ? 5 : 4);
type Counts = { red: number; green: number };
type Expected = { ok: true; wc: Counts } | { ok: false; error: Rejection };
function expectedStart(n: number, ex: Counts, tOverride: number | null, override: Counts | null): Expected {
  if (ex.red === 0 && ex.green === 0 && override !== null) return { ok: false, error: { code: "INVALID_ARGUMENT" } };
  if (n < 3) return { ok: false, error: { code: "NOT_PLAYABLE", detail: "players" } };
  const t = tOverride ?? dflt(n);
  if (ex.red === 0 && ex.green === 0) return { ok: true, wc: { red: 10, green: t } };
  if (override === null) return { ok: true, wc: { red: Math.ceil(Math.max(0, rMin(n) - ex.red) / n), green: Math.ceil(Math.max(0, gMin(n, t) - ex.green) / n) } };
  const inRange = override.red >= 0 && override.red <= 10 && override.green >= 0 && override.green <= t;
  const meets = ex.red + n * override.red >= rMin(n) && ex.green + n * override.green >= gMin(n, t);
  return inRange && meets ? { ok: true, wc: override } : { ok: false, error: { code: "NOT_PLAYABLE", detail: "minimums" } };
}

describe("E7s startGame is accepted iff the formulas say so", () => {
  test("property over player count, imported counts, target override and write-count override (fixture decks, since importDeck has no M1 owner)", () => {
    const arbCounts = fc.record({ red: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 120 })), green: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 60 })) });
    assertProperty(fc.property(
      fc.integer({ min: 0, max: 10 }), arbCounts, fc.option(fc.integer({ min: 2, max: 10 }), { nil: null }),
      fc.option(fc.record({ red: fc.integer({ min: 0, max: 11 }), green: fc.integer({ min: 0, max: 11 }) }), { nil: null }), fc.integer(),
      (n, ex, tOverride, override, seed) => {
        const settings = { ...lobby(1).settings, targetOverride: tOverride, writeCountsOverride: override };
        const g = lobbyWithDeck(n, ex.red, ex.green, { settings });
        const r = decide(g, cmd({ type: "startGame" }), ctxFor({ rng: makeRng(`${seed}`) }));
        const want = expectedStart(n, ex, tOverride, override);
        if (!want.ok) {
          expect(r).toStrictEqual({ ok: false, error: want.error });
          return;
        }
        if (!r.ok) throw new Error(`rejected ${JSON.stringify(r.error)}, expected acceptance with ${JSON.stringify(want.wc)}`);
        const s = r.value.state;
        expect(s.writeCounts).toEqual(want.wc);
        expect(s.target).toBe(tOverride ?? dflt(n));
        const nothing = want.wc.red === 0 && want.wc.green === 0;
        expect(s.phase).toBe(nothing ? "PLAYING" : "WRITING");
        expect(s.players.every((p) => (nothing ? p.status === "active" : p.status === "writing" && p.writeTarget?.red === want.wc.red && p.writeTarget.green === want.wc.green))).toBe(true);
        checkAll({ index: 0, seed, before: g, cmd: { type: "startGame" }, result: r, actor: userActor(HOST_UID), drafts: {} });
      },
    ));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// W1 saveDraft, E3

/** A WRITING game of four players (0 host): 0 and 1 and 3 writing with target {2,1}, 2 ready; plus any overrides. */
const writing = (over: Partial<Game> = {}): Game =>
  makeGame({
    phase: "WRITING", version: 5, target: 8, writeCounts: T,
    players: [0, 1, 2, 3].map((i) => makePlayer(i, { status: i === 2 ? "ready" : "writing", writeTarget: T, writeProgress: i === 2 ? T : { red: 0, green: 0 } })),
    ...over,
  });
/** PLAYING with players 0 to 2 active and a late joiner, player 3, still writing. */
const playingWithLate = (): Game => {
  const base = writing();
  return { ...base, phase: "PLAYING", players: base.players.map((p, i) => (i < 3 ? { ...p, status: "active" as const } : p)), round: makeRound({ judgeId: pid(0), roster: [pid(0), pid(1), pid(2)], changedAtVersion: 4 }) };
};

describe("W1 saveDraft (7.1, 7.2)", () => {
  test("a seated writing player saves in WRITING and, as a late joiner, in PLAYING", () => {
    expect(accepted(writing(), { type: "saveDraft", ...draft(1, 1) }, as(1)).draftChanges).toHaveLength(1);
    expect(accepted(playingWithLate(), { type: "saveDraft", ...draft(1, 1) }, as(3)).draftChanges).toHaveLength(1);
  });

  test("a ready or active player gets WRONG_PHASE with detail finished, in WRITING and in PLAYING", () => {
    const fin: Rejection = { code: "WRONG_PHASE", detail: "finished" };
    expect(rejected(writing(), { type: "saveDraft", red: [], green: [] }, as(2))).toStrictEqual(fin);
    expect(rejected(playingWithLate(), { type: "saveDraft", red: [], green: [] }, as(0))).toStrictEqual(fin); // host seat, active
    expect(rejected(playingWithLate(), { type: "saveDraft", red: [], green: [] }, as(2))).toStrictEqual(fin);
  });

  test("LOBBY, FINISHED and ENDED are WRONG_PHASE (no detail) for a seated player; a non-seat is NOT_AUTHORIZED first", () => {
    for (const phase of ["LOBBY", "FINISHED", "ENDED"] as const) {
      expect(rejected(writing({ phase }), { type: "saveDraft", red: [], green: [] }, as(1))).toStrictEqual({ code: "WRONG_PHASE" });
    }
    expect(rejected(writing({ phase: "LOBBY" }), { type: "saveDraft", red: [], green: [] }, ctxFor({ actor: userActor("stranger") }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
  });

  test("stranger, system and a host without a seat are NOT_AUTHORIZED", () => {
    const noSeat = writing({ players: writing().players.slice(1) });
    for (const ctx of [ctxFor({ actor: userActor("stranger") }), ctxFor({ actor: { kind: "system" } })]) expect(rejected(writing(), { type: "saveDraft", red: [], green: [] }, ctx)).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(noSeat, { type: "saveDraft", red: [], green: [] })).toStrictEqual({ code: "NOT_AUTHORIZED" });
  });

  test("saveDraft does not need play: it works while the game is paused", () => {
    const paused = writing({ paused: true, players: writing().players.slice(0, 2) });
    expect(accepted(paused, { type: "saveDraft", ...draft(1, 0) }, as(1)).draftChanges).toHaveLength(1);
    const latePaused = { ...playingWithLate(), paused: true };
    expect(accepted(latePaused, { type: "saveDraft", ...draft(1, 0) }, as(3)).draftChanges).toHaveLength(1);
  });

  test("counts above writeTarget are INVALID_ARGUMENT; exactly the target is fine; a missing target means nothing may be saved", () => {
    expect(rejected(writing(), { type: "saveDraft", ...draft(3, 1) }, as(1))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(writing(), { type: "saveDraft", ...draft(2, 2) }, as(1))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(accepted(writing(), { type: "saveDraft", ...draft(2, 1) }, as(1)).state.players[1]?.writeProgress).toEqual(T);
    const noTarget = writing({ players: writing().players.map((p) => ({ ...p, writeTarget: null })) });
    expect(rejected(noTarget, { type: "saveDraft", ...draft(1, 0) }, as(1))).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("a malformed payload is INVALID_ARGUMENT: non-array colors, non-string entries, missing keys", () => {
    expect(accepted(writing(), { type: "saveDraft", red: [], green: [] }, as(1)).aggregateChanged).toBe(false); // control: a well-formed empty draft is fine
    for (const bad of [{ red: "x", green: [] }, { red: [], green: {} }, { red: [1], green: [] }, { red: [], green: [null] }, { red: [{}], green: [] }, { red: [] }, { green: [] }, {}]) {
      expect(rejected(writing(), { type: "saveDraft", ...bad }, as(1))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    }
  });

  test("the phase guard runs before the payload guard: a ready player with a bad payload is WRONG_PHASE", () => {
    expect(rejected(writing(), { type: "saveDraft", red: 5 }, as(2))).toStrictEqual({ code: "WRONG_PHASE", detail: "finished" });
  });

  test("stores trimmed text and returns it as the draft change; nothing but counts reaches the state", () => {
    const secret = "ZZ-SECRET-TEXT-ZZ";
    const v = accepted(writing(), { type: "saveDraft", red: [`  ${secret} one  `, "two\n"], green: ["\tthree "] }, as(1));
    expect(v.draftChanges).toEqual([{ playerId: pid(1), draft: { red: [`${secret} one`, "two"], green: ["three"] } }]);
    expect(v.state.players[1]?.writeProgress).toEqual({ red: 2, green: 1 });
    expect(JSON.stringify(v.state)).not.toContain(secret);
    expect(JSON.stringify(v.events)).not.toContain(secret);
    expect(v.events).toEqual([]);
    expect(v.redactEnvelope).toBe(false);
  });

  test("no moderation or length rule is enforced here until #25: empty strings and very long strings are stored", () => {
    const v = accepted(writing(), { type: "saveDraft", red: ["", "x".repeat(500)], green: [] }, as(1));
    expect(v.draftChanges[0]?.draft?.red).toEqual(["", "x".repeat(500)]);
  });
});

describe("E3 saveDraft's aggregateChanged", () => {
  test("a count change is a normal aggregate change: version + 1, no events, the new counts in writeProgress", () => {
    const g = writing();
    const v = accepted(g, { type: "saveDraft", ...draft(1, 0) }, as(1));
    expect(v.aggregateChanged).toBe(true);
    expect(v.state.version).toBe(6);
    expect(v.events).toEqual([]);
    expect(v.state.players[1]?.writeProgress).toEqual({ red: 1, green: 0 });
    expect(v.state.players.filter((_, i) => i !== 1)).toEqual(g.players.filter((_, i) => i !== 1));
  });

  test("a text-only edit leaves the state deep-equal, the version unchanged and events empty, but still returns the draft change", () => {
    const g = writing({ players: writing().players.map((p, i) => (i === 1 ? { ...p, writeProgress: { red: 1, green: 1 } } : p)) });
    const v = accepted(g, { type: "saveDraft", ...draft(1, 1, "rewritten") }, as(1));
    expect(v.aggregateChanged).toBe(false);
    expect(v.state).toEqual(g);
    expect(v.state.version).toBe(5);
    expect(v.events).toEqual([]);
    expect(v.draftChanges).toEqual([{ playerId: pid(1), draft: draft(1, 1, "rewritten") }]);
  });

  test("the comparison is against Player.writeProgress, not against the stored draft document", () => {
    const g = writing();
    const stale: GameDrafts = { [pid(1)]: draft(2, 1) }; // a draft doc that disagrees with the aggregate's counts
    const v = accepted(g, { type: "saveDraft", red: [], green: [] }, as(1, { drafts: stale }));
    expect(v.aggregateChanged).toBe(false);
  });

  test("clearing a draft is a count change when counts were saved", () => {
    const g = writing({ players: writing().players.map((p, i) => (i === 1 ? { ...p, writeProgress: { red: 2, green: 0 } } : p)) });
    const v = accepted(g, { type: "saveDraft", red: [], green: [] }, as(1));
    expect(v.aggregateChanged).toBe(true);
    expect(v.state.players[1]?.writeProgress).toEqual({ red: 0, green: 0 });
  });

  test("a count change while the game is paused still settles (version + 1) without waking anything", () => {
    const paused = writing({ paused: true, players: writing().players.slice(0, 2) });
    const v = accepted(paused, { type: "saveDraft", ...draft(1, 0) }, as(1));
    expect(v.state.version).toBe(6);
    expect(v.state.paused).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// W2 finishWriting, E8

describe("W2 finishWriting (7.1, 7.2)", () => {
  const withDraft = (n: number, d: Draft): Ctx => as(n, { drafts: { [pid(n)]: d } });
  const incomplete: Rejection = { code: "NOT_PLAYABLE", detail: "incomplete" };

  test("the draft counts must equal writeTarget exactly: fewer, more, none, or a malformed draft are NOT_PLAYABLE incomplete", () => {
    expect(rejected(writing(), { type: "finishWriting" }, withDraft(1, draft(1, 1)))).toStrictEqual(incomplete);
    expect(rejected(writing(), { type: "finishWriting" }, withDraft(1, draft(2, 0)))).toStrictEqual(incomplete);
    expect(rejected(writing(), { type: "finishWriting" }, withDraft(1, draft(3, 1)))).toStrictEqual(incomplete);
    expect(rejected(writing(), { type: "finishWriting" }, as(1))).toStrictEqual(incomplete);
    for (const bad of [null, 5, "x", {}, { red: ["a", "b"] }, { red: "ab", green: ["c"] }, { red: ["a", 2], green: ["c"] }]) {
      expect(rejected(writing(), { type: "finishWriting" }, as(1, { drafts: { [pid(1)]: bad } as unknown as GameDrafts }))).toStrictEqual(incomplete);
    }
  });

  test("only the actor's own draft is read", () => {
    const drafts = { [pid(2)]: draft(2, 1), [pid(3)]: draft(2, 1) } as GameDrafts;
    expect(rejected(writing(), { type: "finishWriting" }, as(1, { drafts }))).toStrictEqual(incomplete);
    expect(accepted(writing(), { type: "finishWriting" }, as(1, { drafts: { ...drafts, [pid(1)]: draft(2, 1) } })).state.players[1]?.status).toBe("ready");
  });

  test("a ready or active actor is WRONG_PHASE finished; LOBBY and FINISHED are WRONG_PHASE; non-seats are NOT_AUTHORIZED", () => {
    expect(rejected(writing(), { type: "finishWriting" }, withDraft(2, draft(2, 1)))).toStrictEqual({ code: "WRONG_PHASE", detail: "finished" });
    expect(rejected(playingWithLate(), { type: "finishWriting" }, as(1))).toStrictEqual({ code: "WRONG_PHASE", detail: "finished" });
    expect(rejected(writing({ phase: "LOBBY" }), { type: "finishWriting" }, withDraft(1, draft(2, 1)))).toStrictEqual({ code: "WRONG_PHASE" });
    expect(rejected(writing({ phase: "FINISHED" }), { type: "finishWriting" }, withDraft(1, draft(2, 1)))).toStrictEqual({ code: "WRONG_PHASE" });
    expect(rejected(writing(), { type: "finishWriting" }, ctxFor({ actor: userActor("stranger") }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(writing(), { type: "finishWriting" }, ctxFor({ actor: { kind: "system" } }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
  });

  test("the effects: status ready, writeProgress = writeTarget, event PlayerFinishedWriting, the draft deleted, the envelope redacted", () => {
    const v = accepted(writing(), { type: "finishWriting" }, withDraft(1, draft(2, 1)));
    expect(v.state.players[1]).toMatchObject({ status: "ready", writeProgress: T, hand: [] });
    expect(v.events).toEqual([{ t: "PlayerFinishedWriting", playerId: pid(1) }]);
    expect(v.draftChanges).toEqual([{ playerId: pid(1), draft: null }]);
    expect(v.redactEnvelope).toBe(true);
    expect(v.aggregateChanged).toBe(true);
    expect(v.state.version).toBe(6);
    expect(v.state.waitingOn).toEqual([pid(0), pid(3)]); // the episode runs on; only waitingOn shrinks
    expect(v.state.episodeGen).toBe(1); // the fixture carried no episode, so settle starts one
  });

  test("new cards: ids minted red first then green in draft order, each registered before the next, text as drafted, appended to the decks", () => {
    const g = gameWithDeck(4, 3, 2, { phase: "WRITING", version: 5, target: 8, writeCounts: T, players: writing().players });
    const mint = counterMintId(5000);
    const v = accepted(g, { type: "finishWriting" }, as(1, { mintId: mint, drafts: { [pid(1)]: { red: ["r0", "r1"], green: ["g0"] } } }));
    expect(v.state.cards[cid(5000)]).toEqual({ kind: "red", text: "r0" });
    expect(v.state.cards[cid(5001)]).toEqual({ kind: "red", text: "r1" });
    expect(v.state.cards[cid(5002)]).toEqual({ kind: "green", text: "g0" });
    expect(Object.keys(v.state.cards)).toHaveLength(8);
    expect([...v.state.pools.redDeck].sort()).toEqual([cid(1), cid(2), cid(3), cid(5000), cid(5001)].sort());
    expect([...v.state.pools.greenDeck].sort()).toEqual([cid(4), cid(5), cid(5002)].sort());
  });

  test("a mintId that collides with the registry is retried (mintCardId), and the batch still registers distinct ids", () => {
    const g = gameWithDeck(4, 1, 0, { phase: "WRITING", version: 5, target: 8, writeCounts: T, players: writing().players });
    const ids = [cid(1), cid(1), cid(7), cid(7), cid(8)]; // cid(1) is taken, then the first minted id repeats
    let i = 0;
    const v = accepted(g, { type: "finishWriting" }, as(1, { mintId: () => ids[i++] ?? cid(99), drafts: { [pid(1)]: draft(2, 1) } }));
    expect(Object.keys(v.state.cards).sort()).toEqual([cid(1), cid(7), cid(8), cid(99)].sort());
  });

  test("both decks are reshuffled with the rng, red first then green, unconditionally", () => {
    const g = writing({ players: writing().players.map((p, i) => (i === 1 ? { ...p, writeTarget: { red: 3, green: 2 } } : p)) });
    const rng = scriptedRng([0, 1, 0]); // red [a b c]: i=2 swaps with 0, i=1 with 1; green [x y]: i=1 swaps with 0
    const v = accepted(g, { type: "finishWriting" }, as(1, { rng, mintId: counterMintId(5000), drafts: { [pid(1)]: draft(3, 2) } }));
    expect(rng.drawn).toBe(3);
    expect(v.state.pools.redDeck).toEqual([cid(5002), cid(5001), cid(5000)]);
    expect(v.state.pools.greenDeck).toEqual([cid(5004), cid(5003)]);
    const rec = recordingRng("w");
    accepted(g, { type: "finishWriting" }, as(1, { rng: rec, mintId: counterMintId(5000), drafts: { [pid(1)]: draft(3, 2) } }));
    expect(rec.log).toEqual([["shuffle", 3], ["shuffle", 2]]);
  });

  test("finishing works while paused; a late joiner finishing in PLAYING becomes ready, is dealt nothing, and adds to the pool", () => {
    const paused = writing({ paused: true, players: writing().players.slice(0, 2) });
    expect(accepted(paused, { type: "finishWriting" }, withDraft(1, draft(2, 1))).state.players[1]?.status).toBe("ready");
    const v = accepted(playingWithLate(), { type: "finishWriting" }, withDraft(3, draft(2, 1)));
    expect(v.state.players[3]).toMatchObject({ status: "ready", hand: [] });
    expect(v.state.phase).toBe("PLAYING");
    expect(v.state.pools.redDeck).toHaveLength(2);
    expect(v.state.pools.greenDeck).toHaveLength(1);
    expect(v.events.map((e) => e.t)).toEqual(["PlayerFinishedWriting"]);
  });

  test("the last writer finishing starts play in the same command: events run PlayerFinishedWriting, PlayStarted, PlayerActivated..., RoundOpened", () => {
    const g = gameWithDeck(3, 20, 16, { phase: "WRITING", version: 5, target: 8, writeCounts: { red: 10, green: 8 }, players: [0, 1, 2].map((i) => makePlayer(i, { status: i === 2 ? "writing" : "ready", writeTarget: { red: 10, green: 8 } })) });
    const v = accepted(g, { type: "finishWriting" }, as(2, { drafts: { [pid(2)]: draft(10, 8) } }));
    expect(v.state.phase).toBe("PLAYING");
    expect(v.events.map((e) => e.t)).toEqual(["PlayerFinishedWriting", "PlayStarted", "PlayerActivated", "PlayerActivated", "PlayerActivated", "RoundOpened"]);
    expect(v.state.players.every((p) => p.status === "active" && p.hand.length === 7)).toBe(true);
    expect(v.state.version).toBe(6);
  });

  test("finishing without the minimums met leaves the game in WRITING with everyone ready (slot 1 waits for the minimums)", () => {
    const g = gameWithDeck(3, 0, 0, { phase: "WRITING", version: 5, target: 8, writeCounts: { red: 1, green: 1 }, players: [0, 1, 2].map((i) => makePlayer(i, { status: i === 2 ? "writing" : "ready", writeTarget: { red: 1, green: 1 } })) });
    const v = accepted(g, { type: "finishWriting" }, as(2, { drafts: { [pid(2)]: draft(1, 1) } }));
    expect(v.state.phase).toBe("WRITING");
  });
});

describe("E8 no authorship (3.1, 11)", () => {
  const trio = (): Game => makeGame({
    phase: "WRITING", version: 5, target: 8, writeCounts: { red: 3, green: 0 },
    players: [0, 1, 2].map((i) => makePlayer(i, { status: "writing", writeTarget: { red: 3, green: 0 } })),
  });
  const mine = (n: number, tag: string): Draft => ({ red: [0, 1, 2].map((k) => `${tag}${n} card ${k}`), green: [] });

  /** Finish p1 and p2 (p0 keeps writing) in the given order with real rngs; returns the red deck as texts. */
  function pool(order: [number, number], seed: number): string[] {
    let g = trio();
    for (const [i, n] of order.entries()) {
      const v = accepted(g, { type: "finishWriting" }, as(n, { rng: makeRng(`${seed}:${i}`), mintId: counterMintId(1000 + 1000 * i), drafts: { [pid(n)]: mine(n, "W") } }));
      g = v.state;
    }
    return g.pools.redDeck.map((id) => g.cards[id]?.text ?? "?");
  }

  test("deck positions of one author's batch are spread: not grouped, and the mean position is near the middle over many seeds", () => {
    for (const order of [[1, 2], [2, 1]] as [number, number][]) {
      let grouped = 0;
      let sum = 0;
      const seeds = 200;
      for (let s = 0; s < seeds; s++) {
        const texts = pool(order, s);
        const first = texts.map((t, i) => (t.startsWith("W1") ? i : -1)).filter((i) => i >= 0);
        sum += first.reduce((a, b) => a + b, 0) / first.length;
        if (first.every((i) => i < 3) || first.every((i) => i >= 3)) grouped++;
      }
      expect(grouped / seeds).toBeLessThan(0.25); // two contiguous blocks happen 2 in 20 draws; a leak would be 100%
      expect(sum / seeds).toBeGreaterThan(2.2);
      expect(sum / seeds).toBeLessThan(2.8); // expected 2.5
    }
  });

  test("deck positions do not depend on the finishing order (same distribution of author 1's positions either way)", () => {
    const meanFirst = (order: [number, number]) => {
      let sum = 0;
      for (let s = 0; s < 200; s++) sum += pool(order, s).findIndex((t) => t.startsWith("W1"));
      return sum / 200;
    };
    expect(Math.abs(meanFirst([1, 2]) - meanFirst([2, 1]))).toBeLessThan(0.6);
  });

  test("ids come from mintId, not the rng: another mintId gives other ids with the same shuffle pattern; another seed gives the same ids", () => {
    const g = trio();
    const run = (seed: string, from: number) => accepted(g, { type: "finishWriting" }, as(1, { rng: makeRng(seed), mintId: counterMintId(from), drafts: { [pid(1)]: mine(1, "W") } })).state;
    const a = run("seed", 1000);
    const b = run("seed", 40000);
    const c = run("other-seed", 1000);
    expect(Object.keys(a.cards).some((k) => Object.hasOwn(b.cards, k))).toBe(false);
    expect(a.pools.redDeck.map((id) => Number.parseInt(id.slice(2), 36) - 1000)).toEqual(b.pools.redDeck.map((id) => Number.parseInt(id.slice(2), 36) - 40000));
    expect(Object.keys(c.cards)).toEqual(Object.keys(a.cards));
  });

  test("cards keys are rebuilt in sorted order whatever order ids were minted in", () => {
    let n = 9000;
    const descending = () => cid(n--);
    const g = gameWithDeck(3, 2, 0, { phase: "WRITING", version: 5, target: 8, writeCounts: { red: 3, green: 0 }, players: trio().players });
    const v = accepted(g, { type: "finishWriting" }, as(1, { mintId: descending, drafts: { [pid(1)]: mine(1, "W") } }));
    const keys = Object.keys(v.state.cards);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toHaveLength(5);
  });

  test("no player record, event or draft change holds a new card id or its text before play begins; Game has no drafts field; the envelope is redacted", () => {
    const g = trio();
    const d = mine(1, "ZZ-UNIQUE-");
    const v = accepted(g, { type: "finishWriting" }, as(1, { drafts: { [pid(1)]: d } }));
    const added = Object.keys(v.state.cards);
    expect(added).toHaveLength(3);
    const held = JSON.stringify(v.state.players);
    const events = JSON.stringify(v.events);
    for (const id of added) { expect(held).not.toContain(id); expect(events).not.toContain(id); }
    for (const t of d.red) { expect(events).not.toContain(t); expect(JSON.stringify(v.draftChanges)).not.toContain(t); expect(held).not.toContain(t); }
    expect(Object.hasOwn(v.state, "drafts")).toBe(false);
    expect(v.redactEnvelope).toBe(true);
    expect(v.draftChanges).toEqual([{ playerId: pid(1), draft: null }]);
    checkAll({ index: 0, before: g, cmd: { type: "finishWriting" }, result: { ok: true, value: v }, actor: seat(1), drafts: { [pid(1)]: d } });
  });

  test("the E8 checker is not vacuous: it fails a result that leaks an id into an event, groups the batch, or forgets the redaction", () => {
    const g = trio();
    const d = mine(1, "W");
    const ctx = as(1, { drafts: { [pid(1)]: d } });
    const v = accepted(g, { type: "finishWriting" }, ctx);
    const step = (value: Accepted) => ({ index: 0, before: g, cmd: { type: "finishWriting" }, result: { ok: true as const, value }, actor: seat(1), drafts: { [pid(1)]: d } });
    const id = Object.keys(v.state.cards)[0] ?? "";
    expect(() => checkAll(step({ ...v, events: [...v.events, { t: "CardRemoved", cardId: id, kind: "red" }] }))).toThrow();
    expect(() => checkAll(step({ ...v, redactEnvelope: false }))).toThrow(/redact/);
    expect(() => checkAll(step({ ...v, state: { ...v.state, cards: Object.fromEntries(Object.entries(v.state.cards).reverse()) } }))).toThrow(/sorted/);
    expect(() => checkAll(step({ ...v, state: { ...v.state, players: v.state.players.map((p, i) => (i === 0 ? { ...p, hand: [id] } : p)) } }))).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// E1 command x phase x role over the real registry, written from 7.1 and not from the handlers

describe("E1 startGame, saveDraft, finishWriting: command x phase x role", () => {
  type Who = "host" | "writer" | "ready" | "active" | "hostNoSeat" | "stranger" | "system";
  const WHO: Who[] = ["host", "writer", "ready", "active", "hostNoSeat", "stranger", "system"];
  const PHASES = ["LOBBY", "WRITING", "PLAYING", "FINISHED", "ENDED"] as const;
  const stateFor = (phase: (typeof PHASES)[number], who: Who): Game => {
    const players = [
      makePlayer(0, { status: "writing", writeTarget: T }), makePlayer(1, { status: "writing", writeTarget: T }),
      makePlayer(2, { status: "ready", writeTarget: T }), makePlayer(3, { status: "active", writeTarget: T }),
    ];
    return makeGame({ phase, version: 5, players: who === "hostNoSeat" ? players.slice(1) : players, round: phase === "PLAYING" ? makeRound({ judgeId: pid(3), roster: [pid(3)], changedAtVersion: 4 }) : null });
  };
  const ctxOf = (who: Who): Ctx => ctxFor({ actor: who === "host" || who === "hostNoSeat" ? userActor(HOST_UID) : who === "writer" ? seat(1) : who === "ready" ? seat(2) : who === "active" ? seat(3) : who === "stranger" ? userActor("nobody") : { kind: "system" } });
  const bodies: Record<string, object> = { startGame: {}, saveDraft: { red: [], green: [] }, finishWriting: {} };
  // The host seat in these states is a writer too, so `host` behaves like `writer` for the writer commands.
  const expected = (type: string, phase: (typeof PHASES)[number], who: Who): "accepted" | Rejection => {
    if (phase === "ENDED") return { code: "WRONG_PHASE" };
    const isHost = who === "host" || who === "hostNoSeat";
    if (type === "startGame") return !isHost ? { code: "NOT_AUTHORIZED" } : phase === "LOBBY" ? "accepted" : { code: "WRONG_PHASE" };
    const seated = who === "host" || who === "writer" || who === "ready" || who === "active";
    if (!seated) return { code: "NOT_AUTHORIZED" };
    if (phase !== "WRITING" && phase !== "PLAYING") return { code: "WRONG_PHASE" };
    if (who === "ready" || who === "active") return { code: "WRONG_PHASE", detail: "finished" };
    return type === "saveDraft" ? "accepted" : { code: "NOT_PLAYABLE", detail: "incomplete" };
  };

  for (const type of Object.keys(bodies)) {
    test(`${type}: every phase x every actor gives the code 7.1 lists`, () => {
      for (const phase of PHASES) {
        for (const who of WHO) {
          const g = stateFor(phase, who);
          const r = decide(deepFreeze(structuredClone(g)), cmd({ type, ...bodies[type] }), ctxOf(who));
          const want = expected(type, phase, who);
          if (want === "accepted") expect({ phase, who, ok: r.ok }).toEqual({ phase, who, ok: true });
          else expect({ phase, who, r }).toEqual({ phase, who, r: { ok: false, error: want } });
        }
      }
    });
  }

  test("a rejection never changes anything: the frozen input is untouched and nothing is returned but the error", () => {
    const g = deepFreeze(stateFor("WRITING", "writer"));
    const r = decide(g, cmd({ type: "finishWriting" }), ctxOf("writer"));
    expect(r.ok).toBe(false);
    expect(Object.keys(r)).toEqual(["ok", "error"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// X/G1 scripted LOBBY to PLAYING, every step through the global checkers

describe("X/G1 a scripted LOBBY, startGame, all finished, PLAYING game with round 1 open", () => {
  test("four players write and finish; the last finish begins play; every step passes the global checkers", () => {
    let drafts: Record<string, Draft> = {};
    let n = 0;
    let state: Game | null = null;
    const step = (actor: Actor, c: object): Accepted => {
      const ctx = ctxFor({ actor, now: 1000 + n, rng: makeRng(`scripted:${n}`), mintId: counterMintId(10_000 * (n + 1)), drafts: drafts as GameDrafts });
      const r = decide(state, cmd(c), ctx);
      if (!r.ok) throw new Error(`step ${n} ${JSON.stringify(c)} rejected: ${JSON.stringify(r.error)}`);
      checkAll({ index: n, before: state, cmd: c, result: r, actor, drafts: drafts as GameDrafts });
      for (const ch of r.value.draftChanges) {
        const { [ch.playerId]: _gone, ...rest } = drafts;
        drafts = ch.draft === null ? rest : { ...rest, [ch.playerId]: ch.draft };
      }
      state = r.value.state;
      n++;
      return r.value;
    };
    step(userActor(HOST_UID), { type: "createGame", gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "Host" });
    for (const i of [1, 2, 3]) step(seat(i), { type: "join", playerId: pid(i), name: `Guest ${i}` });
    step(userActor(HOST_UID), { type: "startGame" });
    expect((state as Game | null)?.phase).toBe("WRITING");
    const last = [0, 1, 2, 3];
    for (const i of last) {
      step(seat(i), { type: "saveDraft", ...draft(5, 4, `p${i}`) }); // half-way
      step(seat(i), { type: "saveDraft", ...draft(5, 4, `p${i} edit`) }); // text only: no version change
      step(seat(i), { type: "saveDraft", ...draft(10, 8, `p${i}`) });
    }
    const results: Accepted[] = [];
    for (const i of last) results.push(step(seat(i), { type: "finishWriting" }));
    const g = state as Game | null;
    if (g === null) throw new Error("no state");
    expect(g.phase).toBe("PLAYING");
    expect(g.round).toMatchObject({ number: 1, phase: "SUBMITTING" });
    expect(g.players.every((p) => p.status === "active" && p.hand.length === 7)).toBe(true);
    expect(Object.keys(g.cards)).toHaveLength(72);
    expect(g.pools.redDeck).toHaveLength(12);
    expect(g.pools.greenDeck).toHaveLength(31);
    expect(g.round?.roster).toHaveLength(4);
    expect(g.players.map((p) => p.id)).toContain(g.round?.judgeId ?? "");
    expect(results.slice(0, 3).every((r) => r.events.length === 1)).toBe(true);
    expect(results[3]?.events.map((e) => e.t)[0]).toBe("PlayerFinishedWriting");
    expect(results[3]?.events.map((e) => e.t)).toContain("RoundOpened");
    expect(Object.keys(drafts)).toEqual([]); // every draft was deleted
    expect(g.version).toBe(1 + 3 + 1 + 4 * 2 + 4);
  });
});
