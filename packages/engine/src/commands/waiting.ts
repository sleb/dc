// The reminder clock command (LLD 1 sections 7.1, 7.4): markReminded.
import type { Command } from "@dc/contracts";
import { reject } from "../errors";
import type { CommandSpec } from "../registry";
import { REMINDER_INTERVAL_MS } from "../rules/waiting";

type Of<T extends Command["type"]> = Extract<Command, { type: T }>;

/**
 * The Scheduler's one write (HLD T1): system only, WRITING and PLAYING, not a round command (no `stale`, no `needsPlay`: a paused game answers with a no-op, not PAUSED).
 * With a matching `episode` and `episodeGen`, an unpaused game that is waiting on someone and `now >= reminderDueAt`, it sets `reminderDueAt = now + 24 h`; settle then runs as for any
 * aggregate change and keeps the advance (the episode is unchanged). Anything else is a no-op (`aggregateChanged: false`, the state untouched), because the game may have moved on since the sweep read it.
 * There is no domain event: the Store writes the EventDoc with `events: []` and the `Reminder` outbox row (M3).
 */
export const markReminded: CommandSpec<Of<"markReminded">> = {
  type: "markReminded",
  phases: ["WRITING", "PLAYING"],
  actor: (i) => i.actor.kind === "system",
  payload: ({ cmd }) => {
    const { episode, episodeGen } = cmd as { episode: unknown; episodeGen: unknown };
    return typeof episode === "string" && typeof episodeGen === "number" && Number.isInteger(episodeGen) && episodeGen >= 0 ? null : reject("INVALID_ARGUMENT");
  },
  handle: ({ state, cmd, ctx }) => {
    const effects = { events: [], draftChanges: [], roundRecords: [], redactEnvelope: false };
    const due = state.reminderDueAt;
    const matches = state.episode !== null && cmd.episode === state.episode && cmd.episodeGen === state.episodeGen;
    const live = !state.paused && state.waitingOn.length > 0 && due !== null && ctx.now >= due;
    if (!matches || !live) return { ...effects, state, aggregateChanged: false };
    return { ...effects, state: { ...state, reminderDueAt: ctx.now + REMINDER_INTERVAL_MS }, aggregateChanged: true };
  },
};
