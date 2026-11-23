import { awards, votesFor } from "./rules/awards";
import { defaultTarget, meetsMinimums, gMin, rMin, totals } from "./rules/playability";
import type { CardId, Game, Player, PlayerId } from "./types";

export { awards, votesFor };
export type { Awards, Podium } from "./rules/awards";

/** Players holding a seat: writing, ready or active (LLD 1 section 3.2, derived sets). */
export function seated(g: Game): Player[] {
  return g.players.filter((p) => p.status === "writing" || p.status === "ready" || p.status === "active");
}

export function activePlayers(g: Game): Player[] {
  return g.players.filter((p) => p.status === "active");
}

/**
 * Has this card been shown to the table (LLD 1 section 8.6, user decision U3)? `removeCard`'s precondition; SERVER-ONLY, never exposed to clients.
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

export function isPaused(g: Game): boolean {
  return g.paused;
}

/** The target in force: the one frozen at `startGame`, else the host's override, else the default for the seated count (LOBBY has no frozen target yet). */
export function effectiveTarget(g: Game): number {
  return g.target ?? g.settings.targetOverride ?? defaultTarget(seated(g).length);
}

/** Who owes a card this round: the roster minus the judge, still active. Empty outside an open round. Who, never what (V3). */
export function expectedSubmitters(g: Game): PlayerId[] {
  const r = g.round;
  if (r === null) return [];
  const active = new Set(activePlayers(g).map((p) => p.id));
  return r.roster.filter((id) => id !== r.judgeId && active.has(id));
}

/** The players the scheduler waits on: the settled `waitingOn` field, as a copy (LLD 1 section 4.2). */
export function waitingOn(g: Game): PlayerId[] {
  return [...g.waitingOn];
}

/** Who has played this round, in the order they confirmed; never what they played (V3). */
export function submittedBy(g: Game): PlayerId[] {
  return g.round?.submissions.map((s) => s.playerId) ?? [];
}

/** A card's text, or "" for an unknown id. Callers (the Projector) gate by viewer. */
export function cardText(g: Game, id: CardId): string {
  return Object.hasOwn(g.cards, id) ? (g.cards[id]?.text ?? "") : "";
}

/** A player's hand, as a copy; empty for an unknown player. Callers gate by viewer. */
export function handOf(g: Game, playerId: PlayerId): CardId[] {
  return [...(g.players.find((p) => p.id === playerId)?.hand ?? [])];
}

/** The reveal list: JUDGING only, in `revealOrder`, with no owner (V3, E9). Empty in any other state. */
export function revealList(g: Game): { submissionId: CardId; text: string; pitch: string | null }[] {
  const r = g.round;
  if (r === null || r.phase !== "JUDGING" || r.revealOrder === null) return [];
  return r.revealOrder.map((id) => ({ submissionId: id, text: cardText(g, id), pitch: r.submissions.find((s) => s.cardId === id)?.pitch ?? null }));
}

/** The viewer's own play this round; the only owner-keyed read (LLD 2 `you.ts`). Null when they have not played. */
export function ownSubmission(g: Game, playerId: PlayerId): { cardId: CardId; text: string; pitch: string | null } | null {
  const mine = g.round?.submissions.find((s) => s.playerId === playerId);
  return mine === undefined ? null : { cardId: mine.cardId, text: cardText(g, mine.cardId), pitch: mine.pitch ?? null };
}

/**
 * SERVER-ONLY: who played a card, in the open round or in `history`. Legal to expose to a client only for a resolved round (the owner is public from `WinnerPicked`);
 * for the open round it is the hidden pairing E9 protects.
 */
export function submissionOwner(g: Game, cardId: CardId): PlayerId | undefined {
  const open = g.round?.submissions.find((s) => s.cardId === cardId);
  if (open !== undefined) return open.playerId;
  for (const h of g.history) for (const p of h.plays) if (p.cardId === cardId) return p.playerId;
  return undefined;
}

/** What a player still has to write: the target minus the saved progress, never negative; zero for an unknown player or one with no target. */
export function cardsStillToWrite(g: Game, playerId: PlayerId): { red: number; green: number } {
  const p = g.players.find((x) => x.id === playerId);
  if (p === undefined || p.writeTarget === null) return { red: 0, green: 0 };
  return { red: Math.max(0, p.writeTarget.red - p.writeProgress.red), green: Math.max(0, p.writeTarget.green - p.writeProgress.green) };
}

/** Playability at a glance (LLD 1 section 9): seated count, target in force, registry totals, the minimums and whether they are met. */
export function playabilityReport(g: Game): { n: number; target: number; totals: { red: number; green: number }; rMin: number; gMin: number; meets: boolean } {
  const n = seated(g).length;
  const target = effectiveTarget(g);
  const t = totals(g);
  return { n, target, totals: t, rMin: rMin(n), gMin: gMin(n, target), meets: meetsMinimums(t, n, target) };
}
