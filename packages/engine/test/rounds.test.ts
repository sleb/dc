import { describe, expect, test } from "bun:test";
import { EngineInvariantError } from "../src/errors";
import { makeRng } from "../src/rng";
import * as rounds from "../src/rules/rounds";
import { SETTLE_SLOTS, settle } from "../src/settle";
import type { Game, Player } from "../src/types";
import { addCard, cid, deepFreeze, gameWithDeck, makeGame, makePlayer, makeRound, pid, recordingRng, scriptedRng } from "./support/factories";

const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => cid(from + i));
const actives = (orders: number[]): Player[] => orders.map((o, i) => makePlayer(i, { status: "active", joinOrder: o }));

describe("N1 nextJudge (8.3)", () => {
  test("the smallest joinOrder above the cursor, by joinOrder rather than list position, consuming no rng", () => {
    const rng = scriptedRng([]);
    const ps = actives([4, 1, 2, 9]);
    expect(rounds.nextJudge(ps, 1, rng).joinOrder).toBe(2);
    expect(rounds.nextJudge(ps, 2, rng).joinOrder).toBe(4);
    expect(rounds.nextJudge(ps, 4, rng).joinOrder).toBe(9);
    expect(rng.drawn).toBe(0);
  });

  test("wraps to the smallest joinOrder when the cursor is at or beyond the largest", () => {
    const ps = actives([4, 1, 2, 9]);
    expect(rounds.nextJudge(ps, 9, scriptedRng([])).joinOrder).toBe(1);
    expect(rounds.nextJudge(ps, 50, scriptedRng([])).joinOrder).toBe(1);
  });

  test("a cursor that points at a departed player still rotates by joinOrder", () => {
    expect(rounds.nextJudge(actives([0, 2, 3]), 1, scriptedRng([])).joinOrder).toBe(2);
  });

  test("only active players are candidates", () => {
    const ps = [makePlayer(0, { status: "active", joinOrder: 0 }), makePlayer(1, { status: "ready", joinOrder: 1 }), makePlayer(2, { status: "left", joinOrder: 2 }), makePlayer(3, { status: "writing", joinOrder: 3 }), makePlayer(4, { status: "active", joinOrder: 4 })];
    expect(rounds.nextJudge(ps, 0, scriptedRng([])).id).toBe(pid(4));
  });

  test("a null cursor draws rng.int(active count) over the actives sorted by joinOrder, once", () => {
    const ps = actives([4, 1, 2, 9]); // sorted: 1, 2, 4, 9
    for (const k of [0, 1, 2, 3]) {
      const rng = scriptedRng([k]);
      expect(rounds.nextJudge(ps, null, rng).joinOrder).toBe([1, 2, 4, 9][k] ?? -1);
      expect(rng.drawn).toBe(1);
    }
  });

  test("no active player is an invariant violation", () => {
    expect(() => rounds.nextJudge([makePlayer(0, { status: "ready" })], null, scriptedRng([0]))).toThrow(EngineInvariantError);
  });
});

/** A WRITING-phase game of `n` ready players with an imported-style deck: 10 red and `t` green per player, ids from cid(1), reds first. */
const readyGame = (n: number, over: Partial<Game> = {}): Game => {
  const t = n <= 4 ? 8 : 7;
  return gameWithDeck(n, 10 * n, t * n, { phase: "WRITING", version: 9, target: t, writeCounts: { red: 10, green: t }, ...over }, "ready");
};

describe("B1 openRound (8.3)", () => {
  const playing = (n: number, over: Partial<Game> = {}): Game => {
    let g = makeGame({ phase: "PLAYING", version: 9, players: Array.from({ length: n }, (_, i) => makePlayer(i, { status: "active" })), ...over });
    for (const c of ids(1, 40)) g = addCard(g, c, "red", "redDeck");
    for (const c of ids(100, 5)) g = addCard(g, c, "green", "greenDeck");
    return g;
  };

  test("opens round number history.length + 1: the top green card leaves the deck, roster is the actives, SUBMITTING, changedAtVersion is version + 1", () => {
    const g = playing(4, { history: [{ round: 1, judgeId: pid(0), greenCardId: cid(500), plays: [], winnerCardId: cid(501), winnerId: pid(1) }], judgeCursor: 1 });
    const out = rounds.openRound(g, scriptedRng([]), 777);
    expect(out.state.round).toEqual({
      number: 2, judgeId: pid(2), judgeReassigned: false, greenCardId: cid(100), phase: "SUBMITTING",
      roster: [pid(0), pid(1), pid(2), pid(3)], submissions: [], revealOrder: null, openedAt: 777, changedAtVersion: 10,
    });
    expect(out.state.pools.greenDeck).toEqual(ids(101, 4));
    expect(out.state.judgeCursor).toBe(2);
    expect(out.state.version).toBe(9); // settle's caller bumps it, never the helper
    expect(out.events).toEqual([{ t: "RoundOpened", round: 2, judgeId: pid(2), greenCardId: cid(100), expected: [pid(0), pid(1), pid(3)] }]);
  });

  test("an explicit judge is used and the cursor follows it; the rng is not touched", () => {
    const rng = scriptedRng([]);
    const out = rounds.openRound(playing(4, { judgeCursor: 0 }), rng, 1, pid(3));
    expect(out.state.round?.judgeId).toBe(pid(3));
    expect(out.state.judgeCursor).toBe(3);
    expect(rng.drawn).toBe(0);
  });

  test("a null cursor draws the first judge with rng.int over the active list", () => {
    const rng = scriptedRng([2]);
    const out = rounds.openRound(playing(4), rng, 1);
    expect(out.state.round?.judgeId).toBe(pid(2));
    expect(out.state.judgeCursor).toBe(2);
    expect(rng.drawn).toBe(1);
  });

  test("step 1 first: ready players are activated (dealt 7 in joinOrder) before the judge is chosen and the roster fixed", () => {
    let g = playing(3, { judgeCursor: 2 });
    g = { ...g, players: [...g.players, makePlayer(3, { status: "ready", joinOrder: 3 })] };
    const out = rounds.openRound(g, scriptedRng([]), 5);
    expect(out.state.players[3]).toMatchObject({ status: "active" });
    expect(out.state.players[3]?.hand).toHaveLength(7);
    expect(out.state.round?.roster).toEqual([pid(0), pid(1), pid(2), pid(3)]);
    expect(out.state.round?.judgeId).toBe(pid(3)); // joinOrder 3 is the next after cursor 2, only reachable after activation
    expect(out.events.map((e) => e.t)).toEqual(["PlayerActivated", "RoundOpened"]);
  });

  test("fewer than 3 active players, or an empty green deck, is an invariant violation", () => {
    expect(() => rounds.openRound(playing(2), scriptedRng([0]), 1)).toThrow(EngineInvariantError);
    expect(() => rounds.openRound({ ...playing(3), pools: { ...playing(3).pools, greenDeck: [] } }, scriptedRng([0]), 1)).toThrow(EngineInvariantError);
  });

  test("does not mutate its input", () => {
    const g = playing(3);
    const before = structuredClone(g);
    rounds.openRound(deepFreeze(g), scriptedRng([0]), 1);
    expect(g).toEqual(before);
  });
});

describe("B1 beginPlay and settle slot 1 (8.2 step 1, 8.7)", () => {
  const SEED = "begin-play";

  test("rng order is shuffle red, shuffle green, int(active count); events are PlayStarted, PlayerActivated per player, RoundOpened", () => {
    const g = readyGame(4);
    const rng = recordingRng(SEED);
    const out = rounds.beginPlay(g, rng, 1234);
    expect(rng.log).toEqual([["shuffle", 40], ["shuffle", 32], ["int", 4]]);
    // an independent replay of the same stream
    const ref = makeRng(SEED);
    const red = ref.shuffle(g.pools.redDeck);
    const green = ref.shuffle(g.pools.greenDeck);
    const judge = pid(ref.int(4));
    expect(out.state.players.map((p) => p.hand)).toEqual([red.slice(0, 7), red.slice(7, 14), red.slice(14, 21), red.slice(21, 28)]);
    expect(out.state.pools.redDeck).toEqual(red.slice(28));
    expect(out.state.round?.greenCardId).toBe(green[0]);
    expect(out.state.pools.greenDeck).toEqual(green.slice(1));
    expect(out.state.round?.judgeId).toBe(judge);
    expect(out.events).toEqual([
      { t: "PlayStarted", playerIds: [pid(0), pid(1), pid(2), pid(3)], firstJudgeId: judge },
      ...[0, 1, 2, 3].map((n) => ({ t: "PlayerActivated" as const, playerId: pid(n) })),
      { t: "RoundOpened", round: 1, judgeId: judge, greenCardId: green[0] as string, expected: [0, 1, 2, 3].map(pid).filter((p) => p !== judge) },
    ]);
  });

  test("the result is PLAYING, round 1 SUBMITTING, every player active holding 7 cards, cursor on the first judge, changedAtVersion = version + 1", () => {
    const g = readyGame(3);
    const out = rounds.beginPlay(g, makeRng(SEED), 50);
    expect(out.state.phase).toBe("PLAYING");
    expect(out.state.players.every((p) => p.status === "active" && p.hand.length === 7)).toBe(true);
    const r = out.state.round;
    expect(r).toMatchObject({ number: 1, phase: "SUBMITTING", judgeReassigned: false, openedAt: 50, changedAtVersion: 10, revealOrder: null, submissions: [] });
    expect(out.state.judgeCursor).toBe(out.state.players.find((p) => p.id === r?.judgeId)?.joinOrder ?? -1);
    expect(r?.roster).toEqual([pid(0), pid(1), pid(2)]);
  });

  test("the first judge comes from the scripted int over actives sorted by joinOrder, whatever the list order", () => {
    const base = readyGame(3);
    const players = [makePlayer(0, { status: "ready", joinOrder: 7 }), makePlayer(1, { status: "ready", joinOrder: 2 }), makePlayer(2, { status: "ready", joinOrder: 5 })];
    const g = { ...base, players };
    // shuffles of 30 red and 24 green consume 29 + 23 values (all identity: j = i), then the judge
    const script = [...Array.from({ length: 29 }, (_, k) => 29 - k), ...Array.from({ length: 23 }, (_, k) => 23 - k), 1];
    const out = rounds.beginPlay(g, scriptedRng(script), 1);
    expect(out.state.round?.judgeId).toBe(pid(2)); // sorted joinOrder 2, 5, 7 -> index 1 is joinOrder 5, which is pid(2)
    expect(out.state.judgeCursor).toBe(5);
  });

  const run = (g: Game) => settle(g, recordingRng("s"), 10, false);

  test("slot 1 fires iff WRITING, 3 or more seated, all ready and the minimums hold", () => {
    const fired = (g: Game) => run(g).events.some((e) => e.t === "PlayStarted");
    expect(fired(readyGame(3))).toBe(true);
    expect(fired(readyGame(4))).toBe(true);
    expect(fired(readyGame(3, { phase: "LOBBY" }))).toBe(false);
    expect(fired(readyGame(3, { phase: "PLAYING", round: makeRound({ roster: [pid(0)] }) }))).toBe(false);
    const g = readyGame(3);
    expect(fired({ ...g, players: g.players.map((p, i) => (i === 2 ? { ...p, status: "writing" } : p)) })).toBe(false); // one still writing
    expect(fired({ ...g, players: g.players.slice(0, 2) })).toBe(false); // two seated
    expect(fired({ ...g, players: [...g.players.slice(0, 2), { ...(g.players[2] as Player), status: "left" }] })).toBe(false);
  });

  test("slot 1 does not fire when the minimums are unmet, or target or writeCounts is null", () => {
    const g = readyGame(3);
    const dropped = g.pools.redDeck.slice(0, 3); // 30 red -> 27, one under rMin(3) = 28
    const fewerRed = { ...g, pools: { ...g.pools, redDeck: g.pools.redDeck.slice(3) }, cards: Object.fromEntries(Object.entries(g.cards).filter(([k]) => !dropped.includes(k))) };
    expect(run(fewerRed).state.phase).toBe("WRITING");
    const fewerGreen = { ...g, pools: { ...g.pools, greenDeck: g.pools.greenDeck.slice(1) }, cards: Object.fromEntries(Object.entries(g.cards).filter(([k]) => k !== g.pools.greenDeck[0])) };
    expect(run(fewerGreen).state.phase).toBe("WRITING");
    expect(run({ ...g, target: null }).state.phase).toBe("WRITING");
    expect(run({ ...g, writeCounts: null }).state.phase).toBe("WRITING");
  });

  test("a firing slot 1 starts the first episode and leaves slot 2 unpaused; the rng log is exactly the begin-play draws", () => {
    const rng = recordingRng("s");
    const out = settle(readyGame(3), rng, 10, false);
    expect(rng.log.map(([k]) => k)).toEqual(["shuffle", "shuffle", "int"]);
    expect(out.state.paused).toBe(false);
    expect(out.state.episode).toMatch(/^1:SUBMITTING:p_/);
    expect(out.state.episodeGen).toBe(1);
    expect(out.state.waitingSince).toBe(10);
    expect(out.events.map((e) => e.t)).toEqual(["PlayStarted", "PlayerActivated", "PlayerActivated", "PlayerActivated", "RoundOpened"]);
  });

  test("slots 3 and 3a stay no-ops (#23); slot 4 has nothing to do while players are out; slot 1 is real", () => {
    expect(SETTLE_SLOTS.map((s) => s.id)).toEqual(["1", "2", "3", "3a", "4", "5"]);
    const g = rounds.beginPlay(readyGame(3), makeRng("x"), 1).state;
    for (const id of ["3", "3a", "4"] as const) {
      const out = SETTLE_SLOTS.find((s) => s.id === id)?.run(g, { rng: scriptedRng([]), now: 1, episodeStarted: false });
      expect(out?.state).toBe(g);
      expect(out?.events).toEqual([]);
    }
  });

  test("beginPlay does not mutate its input", () => {
    const g = readyGame(3);
    const before = structuredClone(g);
    rounds.beginPlay(deepFreeze(g), makeRng("x"), 1);
    expect(g).toEqual(before);
  });
});
