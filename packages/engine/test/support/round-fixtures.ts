// A coherent PLAYING game with an open round, shared by the #22 unit tests.
import type { CardId, Game, Player } from "../../src/types";
import { addCard, cid, makeGame, makePlayer, makeRound, pid } from "./factories";

export const ids = (from: number, n: number): CardId[] => Array.from({ length: n }, (_, i) => cid(from + i));
export interface RoundGameOptions {
  n?: number;
  judge?: number;
  /** Player indices that have submitted (their card is cid(100 * i + 6), taken from a 7-card hand). */
  submitted?: number[];
  phase?: "SUBMITTING" | "JUDGING";
  redDeck?: number;
  redDiscard?: number;
  greenDeck?: number;
  target?: number;
  scores?: number[];
  version?: number;
  history?: Game["history"];
  extra?: Partial<Game>;
}

/**
 * A coherent PLAYING game with an open round. Ids: hands cid(100 i + k), red deck cid(5000+), red discard cid(6000+), green deck cid(7000+),
 * the round's green card cid(900), score piles cid(8000 + 10 i + k). A JUDGING round's revealOrder is the submissions reversed.
 */
export function roundGame(o: RoundGameOptions = {}): Game {
  const n = o.n ?? 4;
  const judge = o.judge ?? 0;
  const submitted = o.submitted ?? [];
  let g = makeGame({ phase: "PLAYING", version: o.version ?? 9, target: o.target ?? 8, players: Array.from({ length: n }, (_, i) => makePlayer(i, { status: "active" })), ...o.extra });
  for (let i = 0; i < n; i++) for (let k = 0; k < 7; k++) g = addCard(g, cid(100 * i + k), "red", { hand: pid(i) });
  for (const c of ids(5000, o.redDeck ?? 20)) g = addCard(g, c, "red", "redDeck");
  for (const c of ids(6000, o.redDiscard ?? 0)) g = addCard(g, c, "red", "redDiscard");
  const scored = (o.scores ?? []).reduce((a, b) => a + b, 0);
  for (const c of ids(7000, o.greenDeck ?? Math.max(1, n * (o.target ?? 8) - 1 - scored))) g = addCard(g, c, "green", "greenDeck");
  (o.scores ?? []).forEach((s, i) => { for (let k = 0; k < s; k++) g = addCard(g, cid(8000 + 10 * i + k), "green", { scorePile: pid(i) }); });
  g = { ...g, cards: { ...g.cards, [cid(900)]: { kind: "green", text: "the green card" } } };
  const subs = submitted.map((i) => ({ playerId: pid(i), cardId: cid(100 * i + 6) }));
  g = { ...g, players: g.players.map((p, i) => (submitted.includes(i) ? { ...p, hand: p.hand.slice(0, 6) } : p)) };
  const round = makeRound({
    number: (o.history?.length ?? 0) + 1,
    judgeId: pid(judge),
    greenCardId: cid(900),
    phase: o.phase ?? "SUBMITTING",
    roster: g.players.map((p) => p.id),
    submissions: subs,
    revealOrder: o.phase === "JUDGING" ? subs.map((s) => s.cardId).reverse() : null,
    played: o.phase === "JUDGING" ? subs.map((s) => s.playerId) : [],
    changedAtVersion: 5,
  });
  return { ...g, round, judgeCursor: judge, history: o.history ?? [] };
}


/** Player `i` has left the table in a fixture: the status is set and the hand and pile go back to the decks, so every card stays in exactly one zone (and a `ready` or `writing` seat holds nothing, E18). */
export function park(g: Game, i: number, status: Player["status"]): Game {
  const who = g.players[i];
  if (who === undefined) throw new Error(`no player ${i}`);
  return {
    ...g,
    players: g.players.map((p, k) => (k === i ? { ...p, status, hand: [], scorePile: [] } : p)),
    pools: { ...g.pools, redDeck: [...g.pools.redDeck, ...who.hand], greenDeck: [...g.pools.greenDeck, ...who.scorePile] },
  };
}
