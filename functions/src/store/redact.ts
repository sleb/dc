// removeCard versus append-only round docs (LLD 3 section 6.3, ST13).
import type { RoundDoc } from "@dc/contracts";
import type { Game } from "@dc/engine";

/** Resolved rounds (from the id-only `history`) whose green card or any play is `cardId`, ascending. */
export function roundsContaining(game: Game, cardId: string): number[] {
  return game.history.filter((h) => h.greenCardId === cardId || h.plays.some((p) => p.cardId === cardId)).map((h) => h.round);
}

/** The matching green text, or play text and pitch, become null and `redacted` true; nothing else changes. */
export function redact(doc: RoundDoc, cardId: string): RoundDoc {
  return {
    ...doc,
    green: doc.green.id === cardId ? { ...doc.green, text: null } : doc.green,
    plays: doc.plays.map((p) => (p.cardId === cardId ? { ...p, text: null, pitch: null } : p)),
    redacted: true,
  };
}
