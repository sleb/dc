import { EngineInvariantError } from "../errors";
import type { Card, CardId, Ctx, Pools, Rng } from "../types";
import { HAND } from "./playability";

export const MINT_ATTEMPTS = 16;
const CARD_ID = /^c_[a-z0-9]{10}$/;

/**
 * A fresh card id from the `mintId` port (a CSPRNG in production, never derived from the replayable rng seed).
 * Re-calls the port on a collision with the registry, up to 16 attempts, then throws EngineInvariantError.
 * A malformed id is a broken port, not a collision, and throws at once. The caller registers each id before minting the next.
 */
export function mintCardId(ctx: Pick<Ctx, "mintId">, cards: Readonly<Record<CardId, Card>>): CardId {
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const id = ctx.mintId();
    if (!CARD_ID.test(id)) throw new EngineInvariantError(`mintId returned a malformed card id`);
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
