import { EngineInvariantError } from "../errors";
import type { Card, CardId, Ctx } from "../types";

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
