import type { Command } from "@dc/contracts";
import { createGame, join, leave, removePlayer, updateSettings } from "./commands/lobby";
import { closeSubmissions, confirmSubmission, pickWinner } from "./commands/rounds";
import { finishWriting, saveDraft, startGame } from "./commands/writing";
import type { Actor, Ctx, Game, Handled, Phase, Rejection, Roles } from "./types";

/** What every spec needs of a command: its `type` and the optional `expectedVersion` (LLD 1 section 7). Real commands are the `Command` union from @dc/contracts. */
export interface BaseCommand { readonly type: string; readonly expectedVersion?: number }

/** What a guard or handler of a state-bound command sees. `roles` is `actorRole(state, ctx.actor)`. */
export interface Input<C extends BaseCommand = Command> { state: Game; cmd: C; actor: Actor; roles: Roles; ctx: Ctx }

/**
 * One row per command, added by the step that implements it. Each member is one rung of the guard ladder in LLD 1 section 5.3.
 * Guard 2 (`actor`) runs before the payload is validated, so it may read `cmd` fields only defensively.
 * Methods (not function properties) so a row for one command type is assignable to the registry's `CommandSpec<BaseCommand>`.
 */
export interface CommandSpec<C extends BaseCommand = Command> {
  readonly type: C["type"];
  readonly creates?: false;
  /** Guard 4, the phases in which the command is allowed (ENDED is rejected by guard 1 for everything but `deleteGame`). */
  readonly phases: readonly Phase[];
  /** Guard 3 applies: a round command, rejected with STALE when `expectedVersion < round.changedAtVersion`. */
  readonly stale?: boolean;
  /** Guard 5: rejected with PAUSED while `state.paused` in PLAYING ("needs play" in 7.1). */
  readonly needsPlay?: boolean;
  /** Guard 2: is this actor eligible for the command at all (host only, seated only, anyone)? false is NOT_AUTHORIZED. */
  actor(i: Input<C>): boolean;
  /** Guard 4 beyond `phases`: round phase, settings keys, status. WRONG_PHASE. */
  phase?(i: Input<C>): Rejection | null;
  /** Guard 6: judge versus non-judge, roster membership. NOT_AUTHORIZED. */
  role?(i: Input<C>): Rejection | null;
  /** Guard 7: payload shape and ranges. INVALID_ARGUMENT. */
  payload?(i: Input<C>): Rejection | null;
  /** Guard 8: Moderation. CONTENT_REJECTED. */
  moderation?(i: Input<C>): Rejection | null;
  /** Guard 9: state preconditions. */
  preconditions?(i: Input<C>): Rejection | null;
  /** The effect. Sets `changedAtVersion = state.version + 1` on any round field it changes; never bumps `version` itself. */
  handle(i: Input<C>): Handled;
}

export interface CreateInput<C extends BaseCommand = Command> { cmd: C; actor: Actor; ctx: Ctx }

/** The command that makes the aggregate (`createGame`): there is no state, so only guards 2, 7 and 8 apply, and a non-null state is WRONG_PHASE. The handler returns `version: 0`; `decide` sets 1. */
export interface CreateSpec<C extends BaseCommand = Command> {
  readonly type: C["type"];
  readonly creates: true;
  actor(i: CreateInput<C>): boolean;
  payload?(i: CreateInput<C>): Rejection | null;
  moderation?(i: CreateInput<C>): Rejection | null;
  handle(i: CreateInput<C>): Handled;
}

export type AnySpec = CommandSpec<BaseCommand> | CreateSpec<BaseCommand>;
export type Registry = Readonly<Record<string, AnySpec>>;

/** The real registry: the lobby commands since #20, the writing commands since #21, the round commands since #22. */
export const REGISTRY: Registry = { createGame, updateSettings, join, leave, removePlayer, startGame, saveDraft, finishWriting, confirmSubmission, closeSubmissions, pickWinner };
