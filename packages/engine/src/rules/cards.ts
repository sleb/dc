import { CardIdSchema } from "@dc/contracts";
import { EngineInvariantError } from "../errors";
import type { Card, CardId, Ctx, Game, Pools, Rng } from "../types";
import { HAND } from "./playability";

export const MINT_ATTEMPTS = 16;

/**
 * A fresh card id from the `mintId` port (a CSPRNG in production, never derived from the replayable rng seed).
 * Re-calls the port on a collision with the registry, up to 16 attempts, then throws EngineInvariantError.
 * A malformed id is a broken port, not a collision, and throws at once. The caller registers each id before minting the next.
 */
export function mintCardId(ctx: Pick<Ctx, "mintId">, cards: Readonly<Record<CardId, Card>>): CardId {
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const id = ctx.mintId();
    if (!CardIdSchema.safeParse(id).success) throw new EngineInvariantError(`mintId returned a malformed card id`);
    if (!Object.hasOwn(cards, id)) return id;
  }
  throw new EngineInvariantError(`mintId collided ${MINT_ATTEMPTS} times in a row`);
}

/**
 * Draw up to `n` red cards from the front of `redDeck` (LLD 1 section 8.4). When the deck is empty and a card is still needed,
 * `redDiscard` is shuffled into it (one `rng.shuffle`, only then); with both piles empty the draw is short (X6 says it cannot happen under the minimums).
 * Pure: returns the new pools and the drawn ids in order. Greens are never drawn here.
 */
export function draw(pools: Pools, n: number, rng: Rng): { pools: Pools; cards: CardId[] } {
  let deck = pools.redDeck;
  let discard = pools.redDiscard;
  const cards: CardId[] = [];
  let taken = 0;
  while (cards.length < n) {
    if (taken === deck.length) {
      if (discard.length === 0) break;
      deck = rng.shuffle(discard);
      discard = [];
      taken = 0;
    }
    cards.push(deck[taken++] as CardId);
  }
  return { pools: { ...pools, redDeck: deck.slice(taken), redDiscard: discard }, cards };
}

/** Draw a hand up to 7 (never discards from an oversized hand). Callers go through players in `joinOrder`. */
export function topUp(pools: Pools, hand: readonly CardId[], rng: Rng): { pools: Pools; hand: CardId[] } {
  const out = draw(pools, Math.max(0, HAND - hand.length), rng);
  return { pools: out.pools, hand: [...hand, ...out.cards] };
}

/**
 * Delete a card from the registry and from whichever zone holds it (LLD 1 section 8.6): a pool (deleted in place), a hand, a score pile, a revealed submission (also from `revealOrder`; the owner is not asked to replay)
 * or the current round's green card (replaced by the top of `greenDeck`). A round zone that was touched gets `changedAtVersion = version + 1`. A card that is the current green with an empty `greenDeck` is an EngineInvariantError
 * (the command's guard 9 refuses it first). A round left with no revealed submission is voided by settle slot 4, not here.
 */
export function removeCardFromGame(game: Game, id: CardId): Game {
  const cards = Object.fromEntries(Object.entries(game.cards).filter(([k]) => k !== id));
  const not = (c: CardId): boolean => c !== id;
  const players = game.players.map((p) => ({ ...p, hand: p.hand.filter(not), scorePile: p.scorePile.filter(not) }));
  let pools: Pools = {
    redDeck: game.pools.redDeck.filter(not),
    redDiscard: game.pools.redDiscard.filter(not),
    greenDeck: game.pools.greenDeck.filter(not),
    greenDiscard: game.pools.greenDiscard.filter(not),
  };
  let round = game.round;
  if (round !== null && round.greenCardId === id) {
    const next = pools.greenDeck[0];
    if (next === undefined) throw new EngineInvariantError("removeCardFromGame: the current green card has no replacement");
    pools = { ...pools, greenDeck: pools.greenDeck.slice(1) };
    round = { ...round, greenCardId: next, changedAtVersion: game.version + 1 };
  } else if (round !== null && round.submissions.some((s) => s.cardId === id)) {
    round = { ...round, submissions: round.submissions.filter((s) => s.cardId !== id), revealOrder: round.revealOrder === null ? null : round.revealOrder.filter(not), changedAtVersion: game.version + 1 };
  }
  return { ...game, cards, players, pools, round };
}
