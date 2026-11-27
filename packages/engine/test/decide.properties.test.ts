import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { ERROR_CODES } from "@dc/contracts";
import type { Command } from "@dc/contracts";
import { makeDecide } from "../src/decide";
import { REGISTRY } from "../src/registry";
import { makeRng } from "../src/rng";
import { cid, counterMintId, ctxFor, deepFreeze, pid, seatUidOf, GAME_ID, HOST_UID, userActor } from "./support/factories";
import { assertProperty } from "./support/fc";
import { fixtureEnumerators, fixtureRegistry } from "./support/fixtures";
import { enumerators, exemptions, junkCommands, legalCommands, missingEnumerators } from "./support/legal";
import type { Enumerator } from "./support/legal";
import { arbPicks, arbShape, buildGame, runScenario, zeroTime } from "./support/scenario";
import type { Decide } from "./support/scenario";
import type { Actor, Game, Rejection } from "../src/types";
import { checkAll, zoneIds } from "./support/checks";

// The properties run over the fixture specs (the ladder proof, independent of any real command) and over the real REGISTRY, which holds
// the lobby commands since #20. #21 and #22 add their rows, their enumerators to support/legal.ts, and these properties then cover them.
const fixtureDecide: Decide = makeDecide(fixtureRegistry);
const realDecide: Decide = makeDecide(REGISTRY);
const asCommand = (c: unknown): Command => c as Command;

const arbJson: fc.Arbitrary<unknown> = fc.oneof(fc.anything(), fc.jsonValue(), fc.constantFrom(null, undefined, 0, "", [], {}));
// fxInvariant and fxBug throw on purpose (V3), so X1 runs over the registry without them.
const { fxInvariant: _i, fxBug: _b, ...totalRegistry } = fixtureRegistry;
const totalDecide: Decide = makeDecide(totalRegistry);
const FIXTURE_TYPES = Object.keys(totalRegistry);
/** Typed junk against the fixture specs: a real type name with arbitrary field values. */
const arbTyped = fc.record({
  type: fc.constantFrom(...FIXTURE_TYPES, "__proto__", "constructor"),
  expectedVersion: fc.anything(),
  cardId: fc.anything(),
  pitch: fc.anything(),
  hostId: fc.anything(),
  gameId: fc.anything(),
  hostName: fc.anything(),
  failRole: fc.anything(),
  failPayload: fc.anything(),
}, { requiredKeys: ["type"] });
/** Typed junk against the real rows: a lobby type with arbitrary field values, and with well-formed ones mixed in so some get past the early guards. */
const arbRealTyped = fc.record({
  type: fc.constantFrom(...Object.keys(REGISTRY), "__proto__"),
  expectedVersion: fc.anything(),
  gameId: fc.oneof(fc.anything(), fc.constant(GAME_ID)),
  roomCode: fc.oneof(fc.anything(), fc.constant("BCDF")),
  hostId: fc.oneof(fc.anything(), fc.constant(HOST_UID)),
  hostPlayerId: fc.oneof(fc.anything(), fc.constantFrom(pid(0), pid(1))),
  hostName: fc.oneof(fc.anything(), fc.string()),
  settings: fc.oneof(fc.anything(), fc.constant(undefined)),
  patch: fc.oneof(fc.anything(), fc.record({ profanity: fc.constantFrom("on", "off", "x") }, { requiredKeys: [] }), fc.record({ targetOverride: fc.oneof(fc.integer({ min: -2, max: 12 }), fc.constant(null)) }, { requiredKeys: [] })),
  playerId: fc.oneof(fc.anything(), fc.integer({ min: 0, max: 12 }).map(pid)),
  name: fc.oneof(fc.anything(), fc.string()),
  cardId: fc.oneof(fc.anything(), fc.constantFrom(cid(100), cid(106), cid(700), cid(701), cid(9999))),
  submissionId: fc.oneof(fc.anything(), fc.constantFrom(cid(100), cid(700), cid(701), cid(702), cid(9999))),
  pitch: fc.oneof(fc.anything(), fc.string({ maxLength: 160 })),
  red: fc.oneof(fc.anything(), fc.array(fc.string(), { maxLength: 4 })),
  green: fc.oneof(fc.anything(), fc.array(fc.string(), { maxLength: 4 })),
}, { requiredKeys: ["type"] });
const seatActor = (n: number): Actor => userActor(seatUidOf(GAME_ID, pid(n)));
const arbActor = fc.constantFrom(userActor(HOST_UID), userActor(seatUidOf(GAME_ID, pid(1))), userActor("stranger"), { kind: "system" as const });

describe("X1 decide is total", () => {
  test("arbitrary JSON as cmd never throws over the real registry; anything that is not a registered type is INVALID_ARGUMENT", () => {
    assertProperty(fc.property(arbShape, arbJson, arbActor, (shape, c, actor) => {
      for (const state of [null, buildGame(shape)]) {
        const r = realDecide(state, asCommand(c), ctxFor({ actor }));
        const type = typeof c === "object" && c !== null && !Array.isArray(c) ? (c as { type?: unknown }).type : undefined;
        if (typeof type !== "string" || !Object.hasOwn(REGISTRY, type)) {
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.error).toStrictEqual({ code: "INVALID_ARGUMENT" });
        } else if (!r.ok) expect((ERROR_CODES as readonly string[]).includes(r.error.code)).toBe(true);
      }
    }));
  });

  test("typed junk against the real lobby rows (real type, arbitrary fields) never throws; a rejection carries an allowed code and an acceptance passes every checker", () => {
    assertProperty(fc.property(arbShape, arbRealTyped, arbActor, fc.integer(), (shape, c, actor, seed) => {
      for (const state of [null, buildGame(shape)]) {
        const frozen = state === null ? null : deepFreeze(structuredClone(state));
        const r = realDecide(frozen, asCommand(c), ctxFor({ actor, rng: makeRng(`${seed}`) }));
        if (!r.ok) expect((ERROR_CODES as readonly string[]).includes(r.error.code)).toBe(true);
        else checkAll({ index: 0, seed, before: state, cmd: c, result: r, actor, drafts: {} });
      }
    }));
  });

  test("arbitrary JSON and typed junk never throw over the fixture registry; a rejection always carries an allowed code", () => {
    assertProperty(fc.property(arbShape, fc.oneof(arbJson, arbTyped), arbActor, (shape, c, actor) => {
      for (const state of [null, buildGame(shape)]) {
        const r = totalDecide(state, asCommand(c), ctxFor({ actor }));
        if (!r.ok) expect((ERROR_CODES as readonly string[]).includes(r.error.code)).toBe(true);
      }
    }));
  });

  test("every registry key equals its spec.type, and only createGame may be a creating spec (real and fixture registries)", () => {
    for (const reg of [REGISTRY, fixtureRegistry]) {
      for (const [k, s] of Object.entries(reg)) {
        expect(s.type).toBe(k);
        if (s.creates === true) expect(k).toBe("createGame");
      }
    }
  });

  test("buildGame keeps every card in exactly one zone at the largest supported table (n = 8), where a submission id used to collide with a hand id", () => {
    for (const phase of ["PLAYING", "JUDGING"] as const) {
      const g = buildGame({ n: 8, phase, ready: [], handSize: 2, judge: 0, submitted: Array.from({ length: 8 }, () => true), paused: false });
      const ids = zoneIds(g);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(Object.keys(g.cards).sort());
    }
  });

  test("the junkCommands list over the fixture registry: each registered type gets its guard code, the rest guard 0", () => {
    const g = buildGame({ n: 4, phase: "PLAYING", ready: [], handSize: 2, judge: 1, submitted: [false, false, true, false], paused: false });
    for (const { actor, cmd } of junkCommands(g)) {
      const r = fixtureDecide(deepFreeze(structuredClone(g)), cmd, ctxFor({ actor }));
      const isHost = actor.kind === "user" && actor.uid === g.hostId;
      if (cmd.type === "createGame") expect(r).toStrictEqual({ ok: false, error: { code: "WRONG_PHASE" } });
      else if (cmd.type === "deleteGame" && isHost) expect(r.ok).toBe(true);
      else if (cmd.type === "deleteGame") expect(r).toStrictEqual({ ok: false, error: { code: "NOT_AUTHORIZED" } });
      else expect(r).toStrictEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    }
  });

  // The expected code per junk entry is written out from the guard ladder (5.3) and 7.1, not read off the handlers. Acceptances are not assumed away:
  // the host's updateSettings with an empty patch is legal in LOBBY, WRITING and PLAYING, and a seated player may leave in LOBBY.
  const LOBBY_REAL = new Set(["createGame", "updateSettings", "join", "leave", "removePlayer", "startGame", "saveDraft", "finishWriting", "confirmSubmission", "closeSubmissions", "pickWinner", "passJudging", "endGame", "deleteGame", "markReminded", "removeCard"]); // independent of REGISTRY on purpose
  /** The round commands, from the guard ladder (5.3) and 7.1: 2 actor, 3 stale, 4 phase, 5 pause, 6 role, 9 preconditions 7 expectedVersion required as an integer (the junk bases carry none, so they stop here once past 6). */
  const expectedRound = (g: Game, actor: Actor, c: Command): Rejection | "accepted" => {
    const user = actor.kind === "user" ? actor.uid : null;
    const me = g.players.find((p) => p.uid === user && p.status !== "left" && p.status !== "removed");
    const isHost = user === g.hostId;
    if (c.type === "closeSubmissions" ? me === undefined && !isHost : me === undefined) return { code: "NOT_AUTHORIZED" };
    const r = g.round;
    const v = (c as { expectedVersion?: unknown }).expectedVersion;
    if (typeof v === "number" && r !== null && v < r.changedAtVersion) return { code: "STALE" };
    const want = c.type === "pickWinner" ? "JUDGING" : "SUBMITTING";
    if (g.phase !== "PLAYING" || r === null || r.phase !== want) return { code: "WRONG_PHASE" };
    if (g.paused) return { code: "PAUSED" };
    const isJudge = me !== undefined && r.judgeId === me.id;
    const versionBad = !Number.isInteger(v);
    if (c.type === "confirmSubmission") {
      if (isJudge) return { code: "NOT_AUTHORIZED" };
      if (me === undefined || !r.roster.includes(me.id)) return { code: "NOT_AUTHORIZED", detail: "sitting_out" };
      if (versionBad) return { code: "INVALID_ARGUMENT" };
      if (r.submissions.some((s) => s.playerId === me.id)) return { code: "ALREADY_SUBMITTED" };
      return me.hand.includes((c as { cardId: string }).cardId) ? "accepted" : { code: "NOT_IN_HAND" };
    }
    if (c.type === "closeSubmissions") {
      if (!isJudge && !isHost) return { code: "NOT_AUTHORIZED" };
      if (versionBad) return { code: "INVALID_ARGUMENT" };
      return r.submissions.length === 0 ? { code: "NOT_PLAYABLE", detail: "no_submissions" } : "accepted";
    }
    if (!isJudge) return { code: "NOT_AUTHORIZED" };
    if (versionBad) return { code: "INVALID_ARGUMENT" };
    return r.revealOrder?.includes((c as { submissionId: string }).submissionId) === true ? "accepted" : { code: "NOT_FOUND" };
  };
  const expectedReal = (g: Game, actor: Actor, c: Command): Rejection | "accepted" => {
    if (!LOBBY_REAL.has(c.type)) return { code: "INVALID_ARGUMENT" };
    if (c.type === "createGame") return { code: "WRONG_PHASE" };
    const user = actor.kind === "user" ? actor.uid : null;
    const isHost = user === g.hostId;
    const seated = g.players.some((p) => p.uid === user && p.status !== "left" && p.status !== "removed");
    const inLobby = g.phase === "LOBBY";
    if (c.type === "updateSettings") return !isHost ? { code: "NOT_AUTHORIZED" } : g.phase === "FINISHED" ? { code: "WRONG_PHASE" } : "accepted";
    if (c.type === "startGame") return !isHost ? { code: "NOT_AUTHORIZED" } : inLobby ? "accepted" : { code: "WRONG_PHASE" }; // every junk LOBBY has four seated players and no deck
    if (c.type === "saveDraft" || c.type === "finishWriting") {
      const me = g.players.find((p) => p.uid === user && p.status !== "left" && p.status !== "removed");
      if (me === undefined) return { code: "NOT_AUTHORIZED" };
      if (g.phase !== "WRITING" && g.phase !== "PLAYING") return { code: "WRONG_PHASE" };
      if (me.status !== "writing") return { code: "WRONG_PHASE", detail: "finished" };
      // the junk runs carry no drafts; the oversized-payload entry carries a 10 000-character red text, which guard 8 (#25) refuses as TOO_LONG (in WRITING, where a seat may still save)
      if (c.type === "saveDraft") return (c as unknown as { red: string[] }).red.length > 0 ? { code: "CONTENT_REJECTED", detail: "TOO_LONG" } : "accepted";
      return { code: "NOT_PLAYABLE", detail: "incomplete" };
    }
    if (c.type === "confirmSubmission" || c.type === "closeSubmissions" || c.type === "pickWinner") return expectedRound(g, actor, c);
    if (c.type === "join") return { code: "NOT_AUTHORIZED" }; // none of the junk actors holds the seat uid of pid(9)
    const midGame = g.phase === "LOBBY" || g.phase === "WRITING" || g.phase === "PLAYING"; // #23 widened leave and removePlayer from LOBBY-only
    if (c.type === "leave") return !seated ? { code: "NOT_AUTHORIZED" } : midGame ? "accepted" : { code: "WRONG_PHASE" };
    if (c.type === "endGame") return !isHost ? { code: "NOT_AUTHORIZED" } : g.phase === "ENDED" ? { code: "WRONG_PHASE" } : "accepted";
    if (c.type === "deleteGame") return !isHost ? { code: "NOT_AUTHORIZED" } : "accepted"; // host only, every phase (#36)
    if (c.type === "markReminded") {
      // system only; WRITING and PLAYING; the junk base names episode "writing" at generation 0, which no junk game holds (their waiting fields are unsettled), so it is a no-op
      if (actor.kind !== "system") return { code: "NOT_AUTHORIZED" };
      return g.phase === "WRITING" || g.phase === "PLAYING" ? "accepted" : { code: "WRONG_PHASE" };
    }
    if (c.type === "passJudging") {
      // host only; PLAYING with a round; the junk bases carry no expectedVersion, so an unpaused round ends at guard 7
      if (!isHost) return { code: "NOT_AUTHORIZED" };
      if (g.phase !== "PLAYING" || g.round === null) return { code: "WRONG_PHASE" };
      return g.paused ? { code: "PAUSED" } : { code: "INVALID_ARGUMENT" };
    }
    if (c.type === "removeCard") return !isHost ? { code: "NOT_AUTHORIZED" } : midGame ? { code: "NOT_FOUND" } : { code: "WRONG_PHASE" }; // cid(9999) and "nope" are in no junk game's history or round
    // removePlayer: the target pid(9) is not seated in these games
    return !isHost ? { code: "NOT_AUTHORIZED" } : midGame ? { code: "NOT_FOUND" } : { code: "WRONG_PHASE" };
  };

  test("the junkCommands list over the real registry: each entry gets its guard's code (or the lawful acceptance), the input is unchanged", () => {
    const shapes = [
      { n: 4, phase: "PLAYING" as const, ready: [], handSize: 2, judge: 1, submitted: [false, false, true, false], paused: false },
      { n: 4, phase: "JUDGING" as const, ready: [], handSize: 2, judge: 1, submitted: [false, false, true, false], paused: false },
      { n: 4, phase: "PLAYING" as const, ready: [], handSize: 2, judge: 1, submitted: [false, false, true, false], paused: true },
      { n: 4, phase: "FINISHED" as const, ready: [], handSize: 2, judge: 1, submitted: [], paused: false },
      { n: 4, phase: "LOBBY" as const, ready: [], handSize: 0, judge: 0, submitted: [], paused: false },
      { n: 4, phase: "WRITING" as const, ready: [], handSize: 0, judge: 0, submitted: [], paused: false },
    ];
    for (const shape of shapes) {
      const g = buildGame(shape);
      const before = structuredClone(g);
      for (const { actor, cmd } of junkCommands(g)) {
        const r = realDecide(deepFreeze(structuredClone(g)), cmd, ctxFor({ actor }));
        const want = expectedReal(g, actor, cmd);
        if (want === "accepted") expect(r.ok).toBe(true);
        else expect(r).toStrictEqual({ ok: false, error: want });
      }
      expect(g).toEqual(before);
    }
  });
});

const WORLDS: [string, Decide, Readonly<Record<string, Enumerator>>][] = [["fixture", fixtureDecide, fixtureEnumerators], ["real", realDecide, enumerators]];

describe.each(WORLDS)("X2 to X5 over scenarios of legal and junk commands, %s registry (every step checked by checkAll)", (_name, decideFn, table) => {
  const run = (g: ReturnType<typeof buildGame>, picks: Parameters<typeof runScenario>[2], seed: number, opts: Partial<Parameters<typeof runScenario>[3]> = {}) =>
    runScenario(decideFn, g, picks, { seed, table, ...opts });

  test("X2 state stays plain JSON after every step", () => {
    assertProperty(fc.property(arbShape, arbPicks, fc.integer(), (shape, picks, seed) => { run(buildGame(shape), picks, seed); }));
  });

  test("X3 the same inputs and the same seeds give deep-equal states, events and records at every step", () => {
    assertProperty(fc.property(arbShape, arbPicks, fc.integer(), (shape, picks, seed) => {
      const a = run(buildGame(shape), picks, seed);
      const b = run(buildGame(shape), picks, seed);
      expect(b).toEqual(a);
    }));
  });

  test("X4 inputs are deep-frozen and decide neither mutates nor throws a TypeError", () => {
    assertProperty(fc.property(arbShape, arbPicks, fc.integer(), (shape, picks, seed) => { run(buildGame(shape), picks, seed, { freeze: true }); }));
  });

  test("X5 two runs with different now are equal after zeroing the five time fields", () => {
    assertProperty(fc.property(arbShape, arbPicks, fc.integer(), fc.integer({ min: 0, max: 1e12 }), (shape, picks, seed, shift) => {
      const a = run(buildGame(shape), picks, seed, { now: (i) => 1_000 + i });
      const b = run(buildGame(shape), picks, seed, { now: (i) => 1_000 + i + shift });
      expect(b.states.map((s) => (s === null ? null : zeroTime(s)))).toEqual(a.states.map((s) => (s === null ? null : zeroTime(s))));
    }));
  });
});

describe("X3 and X5 on fixture commands that exercise the rng and the clock", () => {
  test("X3 a different seed changes the shuffle order and nothing else", () => {
    const g = buildGame({ n: 3, phase: "WRITING", ready: [true, true, true], handSize: 0, judge: 0, submitted: [], paused: false });
    const withRedDeck = { ...g, cards: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [cid(i), { kind: "red" as const, text: "t" }])), pools: { ...g.pools, redDeck: Array.from({ length: 12 }, (_, i) => cid(i)) } };
    const go = (seed: string) => fixtureDecide(withRedDeck, asCommand({ type: "fxShuffle" }), ctxFor({ rng: makeRng(seed), mintId: counterMintId(500) }));
    const x = go("seed-a"), y = go("seed-b");
    if (!x.ok || !y.ok) throw new Error("expected acceptance");
    expect(x.value.state.pools.redDeck).not.toEqual(y.value.state.pools.redDeck);
    expect([...x.value.state.pools.redDeck].sort()).toEqual([...y.value.state.pools.redDeck].sort());
    expect({ ...x.value.state, pools: null }).toEqual({ ...y.value.state, pools: null });
    expect(x.value.seed).toBe("seed-a");
  });

  test("X5 is not vacuous: now does land in the time fields", () => {
    const g = buildGame({ n: 3, phase: "WRITING", ready: [false, false, false], handSize: 0, judge: 0, submitted: [], paused: false });
    const at = (now: number) => fixtureDecide(g, asCommand({ type: "fxHost" }), ctxFor({ now }));
    const a = at(10), b = at(99);
    expect(a.ok && b.ok && a.value.state.waitingSince !== b.value.state.waitingSince).toBe(true);
  });
});

describe("G1 generator sanity", () => {
  test.each(WORLDS)("every legalCommands entry is accepted, %s registry", (_name, decideFn, table) => {
    assertProperty(fc.property(arbShape, fc.integer(), (shape, seed) => {
      const g = buildGame(shape);
      legalCommands(g, {}, table).forEach(({ actor, cmd }, i) => {
        const r = decideFn(g, cmd, ctxFor({ actor, rng: makeRng(`${seed}:${i}`) }));
        if (!r.ok) throw new Error(`legal command rejected: ${JSON.stringify(cmd)} as ${JSON.stringify(actor)} -> ${JSON.stringify(r.error)}`);
        checkAll({ index: i, seed, before: g, cmd, result: r, actor, drafts: {} });
      });
    }));
  });

  test("the enumerators are not vacuous: the fixture states do produce legal commands", () => {
    const g = buildGame({ n: 4, phase: "PLAYING", ready: [], handSize: 2, judge: 0, submitted: [false, false, false, false], paused: false });
    expect(legalCommands(g, {}, fixtureEnumerators).length).toBeGreaterThan(6);
  });

  test("the real enumerators are not vacuous: a LOBBY of four offers settings, joins, leaves, removals, start and end; WRITING offers drafts, joins, leaves, removals, end and a profanity patch", () => {
    const lobby = buildGame({ n: 4, phase: "LOBBY", ready: [], handSize: 0, judge: 0, submitted: [], paused: false });
    const types = new Set(legalCommands(lobby, {}, enumerators).map((e) => e.cmd.type));
    expect([...types].sort()).toEqual(["endGame", "join", "leave", "removePlayer", "startGame", "updateSettings"]);
    const writing = buildGame({ n: 4, phase: "WRITING", ready: [false, false, false, false], handSize: 0, judge: 0, submitted: [], paused: false });
    expect([...new Set(legalCommands(writing, {}, enumerators).map((e) => e.cmd.type))].sort()).toEqual(["endGame", "join", "leave", "removePlayer", "saveDraft", "updateSettings"]);
    const full = { [pid(1)]: { red: Array.from({ length: 10 }, () => "r"), green: Array.from({ length: 8 }, () => "g") } };
    expect(legalCommands(writing, full, enumerators).filter((e) => e.cmd.type === "finishWriting").map((e) => e.actor)).toEqual([seatActor(1)]);
  });

  test("the enumerators stop offering joins at the room cap and at the join cap", () => {
    const lobby = buildGame({ n: 10, phase: "LOBBY", ready: [], handSize: 0, judge: 0, submitted: [], paused: false });
    expect(legalCommands(lobby, {}, enumerators).some((e) => e.cmd.type === "join")).toBe(false);
    const capped = { ...buildGame({ n: 4, phase: "LOBBY", ready: [], handSize: 0, judge: 0, submitted: [], paused: false }), totalJoins: 50 };
    expect(legalCommands(capped, {}, enumerators).some((e) => e.cmd.type === "join")).toBe(false);
  });

  test("meta: every registered command in the real registry has an enumerator or an explicit exemption; createGame is the one exemption", () => {
    expect(missingEnumerators(REGISTRY, enumerators, exemptions)).toEqual([]);
    expect(Object.keys(exemptions)).toEqual(["createGame"]);
    expect(Object.keys(enumerators).sort()).toEqual(["closeSubmissions", "confirmSubmission", "endGame", "finishWriting", "join", "leave", "markReminded", "passJudging", "pickWinner", "removeCard", "removePlayer", "saveDraft", "startGame", "updateSettings"]);
  });

  test("meta: a registered lobby command with neither an enumerator nor an exemption fails the check (test the test)", () => {
    expect(missingEnumerators(REGISTRY, {}, {}).sort()).toEqual(Object.keys(REGISTRY).sort());
    const { join: _j, ...withoutJoin } = enumerators;
    expect(missingEnumerators(REGISTRY, withoutJoin, exemptions)).toEqual(["join"]);
  });

  test("createGame, the exempt command, has its own property: arbitrary settings give an acceptance or INVALID_ARGUMENT and never throw", () => {
    const create = (settings: unknown) => realDecide(null, asCommand({ type: "createGame", gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "Host", settings }), ctxFor({ actor: userActor(HOST_UID) }));
    assertProperty(fc.property(fc.oneof(fc.anything(), fc.jsonValue(), fc.record({ targetOverride: fc.integer({ min: -3, max: 14 }), profanity: fc.constantFrom("on", "off", "?") }, { requiredKeys: [] })), (settings) => {
      const r = create(settings);
      if (r.ok) checkAll({ index: 0, before: null, cmd: { settings }, result: r });
      else expect(r.error).toStrictEqual({ code: "INVALID_ARGUMENT" });
    }));
    expect(exemptions["createGame"]).toBeString();
  });

  test("meta: the fixture registry's missing-enumerator check is still sharp", () => {
    expect(missingEnumerators(fixtureRegistry, fixtureEnumerators, {}).sort()).toEqual(["createGame", "fxBug", "fxInvariant", "fxOrder"]);
    expect(missingEnumerators({ ...fixtureRegistry, fxNew: fixtureRegistry["fxHost"] as never }, { ...fixtureEnumerators }, { createGame: "creates", fxBug: "x", fxInvariant: "x", fxOrder: "x" })).toEqual(["fxNew"]);
  });
});
