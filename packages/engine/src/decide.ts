import type { Command } from "@dc/contracts";
import { reject } from "./errors";
import type { AnySpec, BaseCommand, CommandSpec, CreateSpec, Input, Registry } from "./registry";
import { REGISTRY } from "./registry";
import { actorRole } from "./roles";
import { settle } from "./settle";
import type { Accepted, Ctx, Game, Handled, Rejection, Result } from "./types";

export type Decide = (state: Game | null, cmd: Command, ctx: Ctx) => Result<Accepted, Rejection>;

const fail = (error: Rejection): Result<Accepted, Rejection> => ({ ok: false, error });

function lookup(registry: Registry, cmd: unknown): AnySpec | null {
  if (typeof cmd !== "object" || cmd === null || Array.isArray(cmd)) return null;
  const type: unknown = (cmd as { type?: unknown }).type;
  return typeof type === "string" && Object.hasOwn(registry, type) ? (registry[type] ?? null) : null;
}

/** Guard 3: only round commands, only a numeric expectedVersion, only against an existing round. */
function isStale(spec: CommandSpec<BaseCommand>, state: Game, cmd: BaseCommand): boolean {
  const v: unknown = cmd.expectedVersion;
  return spec.stale === true && typeof v === "number" && state.round !== null && v < state.round.changedAtVersion;
}

/** Settle, bump the version once, and assemble the result. `previous` is null only for the command that creates the game. */
function finish(previous: Game | null, h: Handled, ctx: Ctx): Result<Accepted, Rejection> {
  let state = h.state;
  const events = [...h.events];
  if (h.aggregateChanged) {
    const s = settle(state, ctx.rng, ctx.now, h.episodeStarted === true);
    state = { ...s.state, version: (previous?.version ?? 0) + 1 };
    events.push(...s.events);
  }
  const value: Accepted = {
    state,
    aggregateChanged: h.aggregateChanged,
    events,
    draftChanges: h.draftChanges,
    roundRecords: h.roundRecords,
    seed: ctx.rng.seed,
    redactEnvelope: h.redactEnvelope,
    ...(h.deleteGame === true ? { deleteGame: true as const } : {}),
  };
  return { ok: true, value };
}

function decideCreate(spec: CreateSpec<BaseCommand>, state: Game | null, cmd: BaseCommand, ctx: Ctx): Result<Accepted, Rejection> {
  if (state !== null) return fail(reject("WRONG_PHASE"));
  const i = { cmd, actor: ctx.actor, ctx };
  if (!spec.actor(i)) return fail(reject("NOT_AUTHORIZED"));
  const bad = spec.payload?.(i) ?? spec.moderation?.(i) ?? null;
  if (bad !== null) return fail(bad);
  return finish(null, spec.handle(i), ctx);
}

/**
 * The one pure function (LLD 1 section 5). `makeDecide(registry)` builds it over a registry so tests can use fixture specs;
 * the public `decide` is `makeDecide(REGISTRY)`. Guard order (section 5.3, fixed):
 * 0 unknown or malformed command (INVALID_ARGUMENT), 1 existence and terminal state, 2 actor class, 3 staleness, 4 phase,
 * 5 pause, 6 fine role, 7 payload, 8 moderation, 9 state preconditions. The first failure is the rejection.
 *
 * Never throws for any `cmd` (X1); a handler or guard that throws EngineInvariantError propagates unchanged, and there is
 * deliberately no catch-all, so a bug is loud and nothing commits.
 */
export function makeDecide(registry: Registry): Decide {
  return (state, cmd, ctx) => {
    const spec = lookup(registry, cmd);
    if (spec === null) return fail(reject("INVALID_ARGUMENT")); // 0
    const c: BaseCommand = cmd;
    if (spec.creates === true) return decideCreate(spec, state, c, ctx);
    if (state === null) return fail(reject("NOT_FOUND")); // 1
    if (state.phase === "ENDED" && c.type !== "deleteGame") return fail(reject("WRONG_PHASE"));
    const i: Input<BaseCommand> = { state, cmd: c, actor: ctx.actor, roles: actorRole(state, ctx.actor), ctx };
    if (!spec.actor(i)) return fail(reject("NOT_AUTHORIZED")); // 2
    if (isStale(spec, state, c)) return fail(reject("STALE")); // 3
    if (!spec.phases.includes(state.phase)) return fail(reject("WRONG_PHASE")); // 4
    const wrongPhase = spec.phase?.(i) ?? null;
    if (wrongPhase !== null) return fail(wrongPhase);
    if (spec.needsPlay === true && state.phase === "PLAYING" && state.paused) return fail(reject("PAUSED")); // 5
    const bad = spec.role?.(i) ?? spec.payload?.(i) ?? spec.moderation?.(i) ?? spec.preconditions?.(i) ?? null; // 6, 7, 8, 9
    if (bad !== null) return fail(bad);
    return finish(state, spec.handle(i), ctx);
  };
}

export const decide: Decide = makeDecide(REGISTRY);
