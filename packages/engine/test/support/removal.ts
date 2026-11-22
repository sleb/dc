// An independent model of `removeCard`'s reach and guards, written from LLD 1 section 8.6 (not from the handler or the `shownToTable` selector). Used by the enumerator, the checker and the P-X10 property.
import { meetsMinimums } from "../../src/rules/playability";
import type { Game } from "../../src/types";

const SEATED = new Set(["writing", "ready", "active"]);

/**
 * Shown to the table (U3): the current round's green card, a card in the current `revealOrder` (JUDGING), or a card in any `history` summary (a played red or a won green, wherever it sits now).
 * A card must still be in the registry. A card now sitting in an unrevealed SUBMITTING submission is not touched, even if an earlier round showed it.
 */
export function modelShown(g: Game, id: string): boolean {
  if (!Object.hasOwn(g.cards, id)) return false;
  const r = g.round;
  if (r !== null && r.phase === "SUBMITTING" && r.submissions.some((s) => s.cardId === id)) return false;
  if (r !== null && r.greenCardId === id) return true;
  if (r?.revealOrder?.includes(id) === true) return true;
  return g.history.some((h) => h.greenCardId === id || h.plays.some((p) => p.cardId === id));
}

/** The NOT_PLAYABLE detail a shown card's removal gets, in guard-9 order, or null when nothing blocks it. */
export function modelBlock(g: Game, id: string): "below_minimum" | "no_replacement" | null {
  if (g.phase !== "LOBBY" && g.target !== null) {
    const kind = g.cards[id]?.kind;
    const all = Object.values(g.cards);
    const red = all.filter((c) => c.kind === "red").length - (kind === "red" ? 1 : 0);
    const green = all.filter((c) => c.kind === "green").length - (kind === "green" ? 1 : 0);
    const n = g.players.filter((p) => SEATED.has(p.status)).length;
    if (!meetsMinimums({ red, green }, n, g.target)) return "below_minimum";
  }
  return g.round?.greenCardId === id && g.pools.greenDeck.length === 0 ? "no_replacement" : null;
}
