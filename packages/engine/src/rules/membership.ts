import type { DomainEvent, Game, Player, Rng } from "../types";
import { HAND } from "./playability";
import { draw } from "./cards";

/**
 * Activate every `ready` player, in `joinOrder` (LLD 1 section 8.5): deal 7 with `draw`, set `active`, emit `PlayerActivated`.
 * Called by `openRound` step 1 (the round boundary, E18) and by `beginPlay`; settle slot 3 (paused recovery) is #23's.
 * The deal is in `joinOrder`, not list order, so which player gets which cards is a function of the join sequence (E18).
 * Pure; `rng` is consumed only if the red deck runs dry mid-deal.
 */
export function activateReady(game: Game, rng: Rng): { state: Game; events: DomainEvent[] } {
  const ready = game.players.filter((p) => p.status === "ready").sort((a, b) => a.joinOrder - b.joinOrder);
  if (ready.length === 0) return { state: game, events: [] };
  let pools = game.pools;
  const dealt = new Map<string, Player>();
  const events: DomainEvent[] = [];
  for (const p of ready) {
    const out = draw(pools, HAND, rng);
    pools = out.pools;
    dealt.set(p.id, { ...p, status: "active", hand: [...p.hand, ...out.cards] });
    events.push({ t: "PlayerActivated", playerId: p.id });
  }
  return { state: { ...game, pools, players: game.players.map((p) => dealt.get(p.id) ?? p) }, events };
}
