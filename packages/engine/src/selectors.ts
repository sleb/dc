import type { CardId, Game, Player } from "./types";

/** Players holding a seat: writing, ready or active (LLD 1 section 3.2, derived sets). */
export function seated(g: Game): Player[] {
  return g.players.filter((p) => p.status === "writing" || p.status === "ready" || p.status === "active");
}

export function activePlayers(g: Game): Player[] {
  return g.players.filter((p) => p.status === "active");
}

/**
 * Has this card been shown to the table (LLD 1 section 8.6, user decision U3)? `removeCard`'s precondition; never exposed to clients.
 * True for a card still in the registry that is the current round's green card, is in the current `revealOrder` (JUDGING), or appears in any `history` summary (a played red or a won green, wherever it sits now).
 * A card in an unrevealed SUBMITTING play is not shown, even when an earlier round showed it: the play is hidden information. Derived, no new state.
 */
export function shownToTable(g: Game, cardId: CardId): boolean {
  if (!Object.hasOwn(g.cards, cardId)) return false;
  const r = g.round;
  if (r !== null) {
    if (r.phase === "SUBMITTING" && r.submissions.some((s) => s.cardId === cardId)) return false;
    if (r.greenCardId === cardId || r.revealOrder?.includes(cardId) === true) return true;
  }
  return g.history.some((h) => h.greenCardId === cardId || h.plays.some((p) => p.cardId === cardId));
}
