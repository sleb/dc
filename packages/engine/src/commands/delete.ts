// The host's game deletion (LLD 1 sections 7.1, 7.2, 7.3): authorization only. The Store commits phase 0 and the cascade
// removes the data; the Engine returns the unchanged state with `deleteGame: true` and no version bump.
import type { Command } from "@dc/contracts";
import type { CommandSpec } from "../registry";
import type { Handled } from "../types";

type Of<T extends Command["type"]> = Extract<Command, { type: T }>;

export const deleteGame: CommandSpec<Of<"deleteGame">> = {
  type: "deleteGame",
  phases: ["LOBBY", "WRITING", "PLAYING", "FINISHED", "ENDED"],
  actor: (i) => i.roles.host,
  handle: (i): Handled => ({
    state: i.state,
    events: [{ t: "GameDeleted" }],
    draftChanges: [],
    roundRecords: [],
    redactEnvelope: false,
    aggregateChanged: false,
    deleteGame: true,
  }),
};
