// Awards (LLD 1 section 8.8): computed on demand from `votes` and `history`, nothing stored. `resolveRound` never reads `votes` (E16).
import type { CardId, Game, PlayerId } from "../types";

export interface Podium { rank: 1 | 2 | 3; round: number; cardId: CardId; playerId: PlayerId; votes: number }
export interface Awards { peoplesChoice: PlayerId[]; podium: Podium[] }

/** Votes for one card in one round. */
export function votesFor(g: Game, round: number, cardId: CardId): number {
  return g.votes.reduce((n, v) => (v.round === round && v.cardId === cardId ? n + 1 : n), 0);
}

/**
 * People's Choice and the podium, or null when the variant is off.
 * People's Choice: the player(s) with the most votes across all their plays, at least one; a tie gives co-winners, listed in seat order.
 * Podium: the top three plays with at least one vote, by votes descending, then round ascending, then the play order in `history`; rank is the position.
 * A vote for a card that no resolved round holds (or for a round that does not exist) counts for nobody.
 */
export function awards(g: Game): Awards | null {
  if (!g.settings.variants.peoplesChoice) return null;
  const plays: { round: number; cardId: CardId; playerId: PlayerId; votes: number; at: number }[] = [];
  let at = 0;
  for (const h of g.history) for (const p of h.plays) plays.push({ round: h.round, cardId: p.cardId, playerId: p.playerId, votes: votesFor(g, h.round, p.cardId), at: at++ });
  const voted = plays.filter((p) => p.votes > 0);
  const totals = new Map<PlayerId, number>();
  for (const p of voted) totals.set(p.playerId, (totals.get(p.playerId) ?? 0) + p.votes);
  const best = Math.max(0, ...totals.values());
  const peoplesChoice = best === 0 ? [] : g.players.map((p) => p.id).filter((id) => totals.get(id) === best);
  const podium = voted.sort((a, b) => b.votes - a.votes || a.round - b.round || a.at - b.at).slice(0, 3)
    .map((p, i): Podium => ({ rank: (i + 1) as 1 | 2 | 3, round: p.round, cardId: p.cardId, playerId: p.playerId, votes: p.votes }));
  return { peoplesChoice, podium };
}
