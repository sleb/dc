// The stall and ending commands (LLD 1 sections 7.1, 7.2, 8.3): passJudging, endGame.
import type { Command } from "@dc/contracts";
import { reject } from "../errors";
import type { CommandSpec } from "../registry";
import { abortRound, reassignJudge } from "../rules/rounds";
import type { Handled } from "../types";
import { versionOk } from "./rounds";

type Of<T extends Command["type"]> = Extract<Command, { type: T }>;

const effects = (): Pick<Handled, "draftChanges" | "roundRecords" | "redactEnvelope" | "aggregateChanged"> =>
  ({ draftChanges: [], roundRecords: [], redactEnvelope: false, aggregateChanged: true });

/**
 * The host hands the round to the next judge (gameplay.md "Stalled judge"): host only, PLAYING with a round, stale-checked and needs play like the other round commands.
 * `reassignJudge("passed")` does the work; a pass starts a new waiting episode.
 */
export const passJudging: CommandSpec<Of<"passJudging">> = {
  type: "passJudging",
  phases: ["PLAYING"],
  stale: true,
  needsPlay: true,
  actor: (i) => i.roles.host,
  phase: (i) => (i.state.round === null ? reject("WRONG_PHASE") : null),
  payload: (i) => (versionOk(i.cmd) ? null : reject("INVALID_ARGUMENT")),
  handle: (i) => ({ ...effects(), ...reassignJudge(i.state, "passed", i.ctx.rng), episodeStarted: true }),
};

/**
 * The host ends the game from LOBBY, WRITING, PLAYING or FINISHED. An open round is aborted (hand plays back to hands, write-ins to `redDiscard`, the green card to the deck bottom).
 * The handler clears `paused` itself, so no `PausedChanged` is emitted (Q4); settle's step 5 clears the waiting fields.
 */
export const endGame: CommandSpec<Of<"endGame">> = {
  type: "endGame",
  phases: ["LOBBY", "WRITING", "PLAYING", "FINISHED"],
  actor: (i) => i.roles.host,
  handle: ({ state }) => ({ ...effects(), state: { ...abortRound(state), phase: "ENDED", paused: false }, events: [{ t: "GameEnded" }] }),
};
