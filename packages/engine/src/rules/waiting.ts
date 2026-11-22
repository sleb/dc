import { activePlayers, seated } from "../selectors";
import type { Game, PlayerId } from "../types";

export const REMINDER_INTERVAL_MS = 86_400_000;

export type WaitingFields = Pick<Game, "waitingOn" | "episode" | "episodeGen" | "waitingSince" | "reminderDueAt">;

function waitingOn(g: Game): PlayerId[] {
  const writers = seated(g).filter((p) => p.status === "writing").map((p) => p.id);
  if (g.phase === "WRITING") return writers;
  if (g.phase !== "PLAYING") return [];
  const r = g.round;
  if (r === null) return writers;
  if (r.phase === "JUDGING") return [...(r.judgeId === null ? [] : [r.judgeId]), ...writers];
  const active = new Set(activePlayers(g).map((p) => p.id));
  const submitted = new Set(r.submissions.map((s) => s.playerId));
  const expected = r.roster.filter((id) => id !== r.judgeId && active.has(id) && !submitted.has(id));
  return [...expected, ...writers];
}

function episodeKey(g: Game, waiting: readonly PlayerId[]): string | null {
  if (g.paused || waiting.length === 0) return null;
  if (g.phase === "WRITING") return "writing";
  if (g.phase === "PLAYING" && g.round !== null) return `${g.round.number}:${g.round.phase}:${g.round.judgeId ?? "none"}`;
  return null;
}

/**
 * Settle step 5 (LLD 1 section 4.2): the four scheduler fields plus `episodeGen`, recomputed from the post-step state `g`.
 * `g` also carries the previous values of `episode`, `episodeGen`, `waitingSince` and `reminderDueAt`.
 *
 * A new episode starts when `episodeStarted` is true (the caller knows: round open, close, judge change, void) or when the key
 * differs from the stored one, which also covers writing start and un-pause (the stored key was null). A key can repeat across
 * episodes (a voided round reopened with the same number and judge), which is why the caller's flag exists.
 * Late joiners and finishers change `waitingOn` only.
 */
export function waitingFields(g: Game, now: number, episodeStarted: boolean): WaitingFields {
  const waiting = waitingOn(g);
  const episode = episodeKey(g, waiting);
  if (episode === null) return { waitingOn: waiting, episode: null, episodeGen: g.episodeGen, waitingSince: null, reminderDueAt: null };
  if (episodeStarted || episode !== g.episode || g.waitingSince === null || g.reminderDueAt === null) {
    return { waitingOn: waiting, episode, episodeGen: g.episodeGen + 1, waitingSince: now, reminderDueAt: now + REMINDER_INTERVAL_MS };
  }
  return { waitingOn: waiting, episode, episodeGen: g.episodeGen, waitingSince: g.waitingSince, reminderDueAt: g.reminderDueAt };
}
