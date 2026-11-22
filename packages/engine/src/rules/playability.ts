// Playability (LLD 1 section 9): pure functions over counts. `startGame` (#21), `removeCard` and settle step 1 (#22) and the late-join
// requirement (#23, section 9.4, not here) call them.
import type { Game } from "../types";

export const MIN_PLAYERS = 3;
export const HAND = 7;
/** Red cards each player writes for a new deck; the green count is the target. */
export const NEW_DECK_RED = 10;

export interface Counts { red: number; green: number }

export const gMin = (n: number, t: number): number => n * t;
export const rMin = (n: number): number => HAND * n + Math.max(2 * n, HAND);
export const defaultTarget = (n: number): number => (n <= 4 ? 8 : n === 5 ? 7 : n === 6 ? 6 : n === 7 ? 5 : 4);

/** Every registry card of each kind, in any zone (hands, discards, the current round included). Pending drafts are not in the registry. */
export function totals(game: Game): Counts {
  let red = 0;
  let green = 0;
  for (const card of Object.values(game.cards)) {
    if (card.kind === "red") red++;
    else green++;
  }
  return { red, green };
}

/** `n` is the number of seated players, `t` the target. */
export function meetsMinimums(counts: Counts, n: number, t: number): boolean {
  return counts.red >= rMin(n) && counts.green >= gMin(n, t);
}

/**
 * Per-player write counts at `startGame` (section 9.3). `existing` is the pool sizes from `importDeck`.
 * "unmet": an override out of range or below the minimums (NOT_PLAYABLE `minimums`). "invalid": an override with no imported cards (INVALID_ARGUMENT).
 */
export function writeCounts(n: number, t: number, existing: Counts, override: Counts | null): Counts | "unmet" | "invalid" {
  if (existing.red === 0 && existing.green === 0) return override === null ? { red: NEW_DECK_RED, green: t } : "invalid";
  if (override === null) {
    return {
      red: Math.ceil(Math.max(0, rMin(n) - existing.red) / n),
      green: Math.ceil(Math.max(0, gMin(n, t) - existing.green) / n),
    };
  }
  const inRange = override.red >= 0 && override.red <= NEW_DECK_RED && override.green >= 0 && override.green <= t;
  const meets = existing.red + n * override.red >= rMin(n) && existing.green + n * override.green >= gMin(n, t);
  return inRange && meets ? override : "unmet";
}
