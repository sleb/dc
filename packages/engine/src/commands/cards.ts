// The card command (LLD 1 sections 7.1, 7.2, 8.6): removeCard.
import type { Command } from "@dc/contracts";
import { reject } from "../errors";
import type { CommandSpec } from "../registry";
import { removeCardFromGame } from "../rules/cards";
import { meetsMinimums, totals } from "../rules/playability";
import { seated, shownToTable } from "../selectors";
import type { Game, Handled, Rejection } from "../types";

type Of<T extends Command["type"]> = Extract<Command, { type: T }>;

/** The registry's card counts after `id` is gone, at the seated count and the frozen target: the guard of 8.6 (every zone and every score pile counts, as in 9.1). Not applied in LOBBY or with no target. */
function dropsBelowMinimum(state: Game, id: string): boolean {
  if (state.phase === "LOBBY" || state.target === null) return false;
  const now = totals(state);
  const kind = state.cards[id]?.kind;
  const after = { red: now.red - (kind === "red" ? 1 : 0), green: now.green - (kind === "green" ? 1 : 0) };
  return !meetsMinimums(after, seated(state).length, state.target);
}

/**
 * The host removes a card shown to the table (U3, `shownToTable`): guard 2 host, 4 LOBBY, WRITING or PLAYING (no `stale`, no `needsPlay`), 7 a string `cardId`, 9 in this order:
 * an unknown or unshown card is `NOT_FOUND` with no detail (the two are indistinguishable, so a hidden card cannot be probed), then `NOT_PLAYABLE` `below_minimum`, then `NOT_PLAYABLE` `no_replacement`
 * (the current green card with an empty `greenDeck`). The effect and the voiding of an emptied JUDGING round are in `removeCardFromGame` and settle slot 4.
 */
export const removeCard: CommandSpec<Of<"removeCard">> = {
  type: "removeCard",
  phases: ["LOBBY", "WRITING", "PLAYING"],
  actor: (i) => i.roles.host,
  payload: ({ cmd }) => (typeof (cmd as { cardId?: unknown }).cardId === "string" ? null : reject("INVALID_ARGUMENT")),
  preconditions: ({ state, cmd }): Rejection | null => {
    if (!shownToTable(state, cmd.cardId)) return reject("NOT_FOUND");
    if (dropsBelowMinimum(state, cmd.cardId)) return reject("NOT_PLAYABLE", "below_minimum");
    return state.round?.greenCardId === cmd.cardId && state.pools.greenDeck.length === 0 ? reject("NOT_PLAYABLE", "no_replacement") : null;
  },
  handle: ({ state, cmd }): Handled => ({
    state: removeCardFromGame(state, cmd.cardId),
    events: [{ t: "CardRemoved", cardId: cmd.cardId, kind: state.cards[cmd.cardId]?.kind ?? "red" }],
    draftChanges: [], roundRecords: [], redactEnvelope: false, aggregateChanged: true,
  }),
};
