import { describe, expect, test } from "bun:test";
import * as cards from "../src/rules/cards";
import * as membership from "../src/rules/membership";
import type { Pools } from "../src/types";
import { addCard, cid, deepFreeze, gameWithDeck, makeGame, makePlayer, pid, scriptedRng } from "./support/factories";

// E5 and E6, helper half (LLD 1 section 8.4, 8.5): draw, topUp and activateReady, unit-tested per zone move, including the reshuffle branch.
const pools = (over: Partial<Pools> = {}): Pools => ({ redDeck: [], redDiscard: [], greenDeck: [], greenDiscard: [], ...over });
const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => cid(from + i));

describe("E5/E6 draw (8.4)", () => {
  test("takes from the front of the red deck, in order, without touching the rng", () => {
    const rng = scriptedRng([]);
    const out = cards.draw(pools({ redDeck: ids(1, 4) }), 2, rng);
    expect(out.cards).toEqual([cid(1), cid(2)]);
    expect(out.pools.redDeck).toEqual([cid(3), cid(4)]);
    expect(rng.drawn).toBe(0);
  });

  test("drawing nothing changes nothing", () => {
    const p = pools({ redDeck: ids(1, 2), redDiscard: ids(9, 2) });
    expect(cards.draw(p, 0, scriptedRng([]))).toEqual({ pools: p, cards: [] });
  });

  test("an empty deck is refilled by shuffling the discard (red, then draw), and the discard empties", () => {
    // scripted [0, 0] on [a, b, c]: i=2 swaps with 0 -> [c, b, a]; i=1 swaps with 0 -> [b, c, a]
    const rng = scriptedRng([0, 0]);
    const out = cards.draw(pools({ redDiscard: ids(1, 3) }), 2, rng);
    expect(out.cards).toEqual([cid(2), cid(3)]);
    expect(out.pools.redDeck).toEqual([cid(1)]);
    expect(out.pools.redDiscard).toEqual([]);
    expect(rng.drawn).toBe(2);
  });

  test("the reshuffle happens only when the deck is empty and a draw needs a card", () => {
    const rng = scriptedRng([0]); // shuffle([x, y]) with 0: -> [y, x]
    const out = cards.draw(pools({ redDeck: [cid(1)], redDiscard: [cid(8), cid(9)] }), 2, rng);
    expect(out.cards).toEqual([cid(1), cid(9)]);
    expect(out.pools.redDeck).toEqual([cid(8)]);
    expect(out.pools.redDiscard).toEqual([]);
    const enough = cards.draw(pools({ redDeck: ids(1, 3), redDiscard: [cid(9)] }), 3, scriptedRng([]));
    expect(enough.pools.redDiscard).toEqual([cid(9)]); // the deck sufficed, so the discard stayed
  });

  test("both piles empty: a short draw, no throw", () => {
    const out = cards.draw(pools({ redDeck: [cid(1)] }), 3, scriptedRng([]));
    expect(out.cards).toEqual([cid(1)]);
    expect(out.pools.redDeck).toEqual([]);
  });

  test("a deck that exactly covers the draw does not reshuffle the discard (the next draw would)", () => {
    const rng = scriptedRng([]);
    const out = cards.draw(pools({ redDeck: ids(1, 2), redDiscard: [cid(9)] }), 2, rng);
    expect(out.cards).toEqual([cid(1), cid(2)]);
    expect(out.pools.redDiscard).toEqual([cid(9)]);
    expect(rng.drawn).toBe(0);
  });

  test("green piles are never touched, and the inputs are not mutated", () => {
    const p = deepFreeze(pools({ redDeck: ids(1, 2), greenDeck: ids(50, 2), greenDiscard: ids(60, 1) }));
    const out = cards.draw(p, 2, scriptedRng([]));
    expect(out.pools.greenDeck).toEqual(ids(50, 2));
    expect(out.pools.greenDiscard).toEqual(ids(60, 1));
  });
});

describe("E6 topUp (8.4)", () => {
  test("draws 7 minus the hand, appended after what the player holds", () => {
    const out = cards.topUp(pools({ redDeck: ids(10, 10) }), ids(1, 3), scriptedRng([]));
    expect(out.hand).toEqual([...ids(1, 3), ...ids(10, 4)]);
    expect(out.pools.redDeck).toEqual(ids(14, 6));
  });

  test("a full or oversized hand draws nothing", () => {
    const p = pools({ redDeck: ids(10, 3) });
    expect(cards.topUp(p, ids(1, 7), scriptedRng([])).hand).toEqual(ids(1, 7));
    expect(cards.topUp(p, ids(1, 9), scriptedRng([])).pools).toEqual(p);
  });

  test("with an exhausted deck the discard is reshuffled to finish the top-up", () => {
    const rng = scriptedRng([0, 0, 0, 0]); // 5-card shuffle draws 4 values
    const out = cards.topUp(pools({ redDeck: [cid(10)], redDiscard: ids(20, 5) }), ids(1, 3), rng);
    expect(out.hand).toHaveLength(7);
    expect(out.hand.slice(0, 3)).toEqual(ids(1, 3));
    expect(out.hand[3]).toBe(cid(10));
    expect(new Set(out.hand).size).toBe(7);
    expect(rng.drawn).toBe(4);
    expect(out.pools.redDiscard).toEqual([]);
    expect(out.pools.redDeck).toHaveLength(2);
  });
});

describe("E6 activateReady (8.5)", () => {
  const writers = (...orders: number[]) => orders.map((o, i) => makePlayer(i, { status: "ready", joinOrder: o }));

  test("deals 7 to each ready player in joinOrder (not list order), sets them active and emits PlayerActivated in that order", () => {
    let g = makeGame({ phase: "WRITING", players: [...writers(2, 0, 1), makePlayer(3, { status: "writing", joinOrder: 3 })] });
    for (const c of ids(1, 30)) g = addCard(g, c, "red", "redDeck");
    const out = membership.activateReady(g, scriptedRng([]));
    const byId = (n: number) => out.state.players.find((p) => p.id === pid(n));
    expect(byId(1)?.hand).toEqual(ids(1, 7)); // joinOrder 0
    expect(byId(2)?.hand).toEqual(ids(8, 7)); // joinOrder 1
    expect(byId(0)?.hand).toEqual(ids(15, 7)); // joinOrder 2
    expect([0, 1, 2].map((n) => byId(n)?.status)).toEqual(["active", "active", "active"]);
    expect(byId(3)).toMatchObject({ status: "writing", hand: [] }); // a late writer gets no cards
    expect(out.events).toEqual([{ t: "PlayerActivated", playerId: pid(1) }, { t: "PlayerActivated", playerId: pid(2) }, { t: "PlayerActivated", playerId: pid(0) }]);
    expect(out.state.pools.redDeck).toEqual(ids(22, 9));
  });

  test("an exhausted deck is refilled from the discard during the deal (the reshuffle branch)", () => {
    let g = makeGame({ phase: "PLAYING", players: writers(0, 1) });
    for (const c of ids(1, 10)) g = addCard(g, c, "red", "redDeck");
    for (const c of ids(11, 10)) g = addCard(g, c, "red", "redDiscard");
    const rng = scriptedRng(Array.from({ length: 9 }, () => 0));
    const out = membership.activateReady(g, rng);
    expect(out.state.players.map((p) => p.hand.length)).toEqual([7, 7]);
    expect(new Set(out.state.players.flatMap((p) => p.hand)).size).toBe(14);
    expect(out.state.pools.redDiscard).toEqual([]);
    expect(out.state.pools.redDeck).toHaveLength(6);
    expect(rng.drawn).toBe(9);
  });

  test("nobody ready: nothing changes and the state is returned as it was", () => {
    const g = makeGame({ phase: "PLAYING", players: [makePlayer(0, { status: "active" }), makePlayer(1, { status: "writing" })] });
    const out = membership.activateReady(g, scriptedRng([]));
    expect(out.state).toEqual(g);
    expect(out.events).toEqual([]);
  });

  test("does not mutate its input", () => {
    const g = gameWithDeck(3, 30, 0, { phase: "WRITING" }, "ready");
    const before = structuredClone(g);
    membership.activateReady(deepFreeze(g), scriptedRng([]));
    expect(g).toEqual(before);
  });

  test("a card short supply never throws: the deal is short (X6 says it cannot happen under the minimums)", () => {
    const g = gameWithDeck(3, 5, 0, { phase: "WRITING" }, "ready");
    expect(() => membership.activateReady(g, scriptedRng([]))).not.toThrow();
  });
});
