// Fixture command specs. No real command exists in 1.2 (createGame is #20), so the pipeline is exercised with these.
// They are also the executable example of how a step adds a row: one spec here per behavior, one enumerator per spec.
import type { BaseCommand, CommandSpec, CreateSpec, Registry } from "../../src/registry";
import { EngineInvariantError, reject } from "../../src/errors";
import { mintCardId } from "../../src/rules/cards";
import type { Game, Handled } from "../../src/types";
import type { Enumerator } from "./legal";
import { HOST_UID, makeGame, userActor } from "./factories";

type Cmd = BaseCommand & { readonly [k: string]: unknown };
const noEffects = (): Pick<Handled, "draftChanges" | "roundRecords" | "redactEnvelope"> => ({ draftChanges: [], roundRecords: [], redactEnvelope: false });
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Host-only, any phase but ENDED; changes nothing but what settle recomputes. */
export const fxHost: CommandSpec<Cmd> = {
  type: "fxHost",
  phases: ["LOBBY", "WRITING", "PLAYING", "FINISHED"],
  actor: (i) => i.roles.host,
  handle: (i): Handled => ({ ...noEffects(), state: i.state, events: [{ t: "SettingsUpdated", keys: [] }], aggregateChanged: true }),
};

/** Mints a card id and shuffles the red deck: exercises rng, mintId and the redact flag. */
export const fxShuffle: CommandSpec<Cmd> = {
  type: "fxShuffle",
  phases: ["WRITING", "PLAYING", "FINISHED"],
  actor: (i) => i.roles.host,
  handle: (i): Handled => {
    const id = mintCardId(i.ctx, i.state.cards);
    const redDeck = i.ctx.rng.shuffle([...i.state.pools.redDeck, id]);
    return {
      ...noEffects(),
      redactEnvelope: true,
      state: { ...i.state, cards: { ...i.state.cards, [id]: { kind: "red", text: "minted" } }, pools: { ...i.state.pools, redDeck } },
      events: [],
      aggregateChanged: true,
    };
  },
};

/** A round command: stale-checked, needs play, SUBMITTING only, seated non-judge roster members. */
export const fxPlay: CommandSpec<Cmd> = {
  type: "fxPlay",
  phases: ["PLAYING"],
  stale: true,
  needsPlay: true,
  actor: (i) => i.roles.playerId !== null,
  phase: (i) => (i.state.round?.phase === "SUBMITTING" ? null : reject("WRONG_PHASE")),
  role: (i) => (!i.roles.judge && i.state.round !== null && i.roles.playerId !== null && i.state.round.roster.includes(i.roles.playerId) ? null : reject("NOT_AUTHORIZED", "sitting_out")),
  payload: (i) => (typeof i.cmd["cardId"] === "string" ? null : reject("INVALID_ARGUMENT")),
  moderation: (i) => (str(i.cmd["pitch"]).includes("badword") ? reject("CONTENT_REJECTED", "PROFANITY") : null),
  preconditions: (i) => {
    const me = i.state.players.find((p) => p.id === i.roles.playerId);
    if (i.state.round?.submissions.some((s) => s.playerId === me?.id)) return reject("ALREADY_SUBMITTED");
    return me?.hand.includes(str(i.cmd["cardId"])) ? null : reject("NOT_IN_HAND");
  },
  handle: (i): Handled => {
    const round = i.state.round;
    const me = i.state.players.find((p) => p.id === i.roles.playerId);
    if (round === null || me === undefined) throw new EngineInvariantError("fxPlay: no round or player");
    const cardId = str(i.cmd["cardId"]);
    return {
      ...noEffects(),
      state: {
        ...i.state,
        players: i.state.players.map((p) => (p.id === me.id ? { ...p, hand: p.hand.filter((c) => c !== cardId) } : p)),
        round: { ...round, submissions: [...round.submissions, { playerId: me.id, cardId }] },
      },
      events: [{ t: "SubmissionConfirmed", round: round.number, playerId: me.id }],
      aggregateChanged: true,
    };
  },
};

/** A draft-only command: no aggregate change, one draft side effect. */
export const fxDraft: CommandSpec<Cmd> = {
  type: "fxDraft",
  phases: ["WRITING", "PLAYING"],
  actor: (i) => i.roles.status === "writing",
  handle: (i): Handled => ({
    state: i.state,
    events: [],
    draftChanges: [{ playerId: i.roles.playerId ?? "", draft: { red: [], green: [] } }],
    roundRecords: [],
    redactEnvelope: false,
    aggregateChanged: false,
  }),
};

/** Allowed in every phase including ENDED; returns the deleteGame marker. */
export const fxDelete: CommandSpec<Cmd> = {
  type: "deleteGame",
  phases: ["LOBBY", "WRITING", "PLAYING", "FINISHED", "ENDED"],
  actor: (i) => i.roles.host,
  handle: (i): Handled => ({ ...noEffects(), state: i.state, events: [{ t: "GameDeleted" }], aggregateChanged: false, deleteGame: true }),
};

/** The state-creating command: guards 0, 1, 2, 7 and 8 only. */
export const fxCreate: CreateSpec<Cmd> = {
  type: "createGame",
  creates: true,
  actor: (i) => i.actor.kind === "user" && i.actor.uid === i.cmd["hostId"],
  payload: (i) => (typeof i.cmd["gameId"] === "string" ? null : reject("INVALID_ARGUMENT")),
  moderation: (i) => (str(i.cmd["hostName"]).includes("badword") ? reject("CONTENT_REJECTED", "PROFANITY") : null),
  handle: (i): Handled => ({
    ...noEffects(),
    state: makeGame({ id: str(i.cmd["gameId"]), hostId: str(i.cmd["hostId"]), createdAt: i.ctx.now, version: 0 }),
    events: [{ t: "GameCreated", hostPlayerId: "p_aaaaaaaa" }],
    aggregateChanged: true,
  }),
};

/** Every guard step can fail independently, driven by flags on the command: pins the order of LLD 1 section 5.3. */
export const fxOrder: CommandSpec<Cmd> = {
  type: "fxOrder",
  phases: ["PLAYING"],
  stale: true,
  needsPlay: true,
  actor: (i) => i.roles.playerId !== null,
  phase: (i) => (i.state.round?.phase === "SUBMITTING" ? null : reject("WRONG_PHASE")),
  role: (i) => (i.cmd["failRole"] === true ? reject("NOT_AUTHORIZED", "sitting_out") : null),
  payload: (i) => (i.cmd["failPayload"] === true ? reject("INVALID_ARGUMENT") : null),
  moderation: (i) => (i.cmd["failModeration"] === true ? reject("CONTENT_REJECTED", "PROFANITY") : null),
  preconditions: (i) => (i.cmd["failPrecond"] === true ? reject("NOT_IN_HAND") : null),
  handle: (i): Handled => ({ ...noEffects(), state: i.state, events: [], aggregateChanged: true }),
};

/** Handlers that throw: only EngineInvariantError is part of the contract, and decide adds no catch-all. */
export const fxInvariant: CommandSpec<Cmd> = { type: "fxInvariant", phases: ["LOBBY"], actor: () => true, handle: () => { throw new EngineInvariantError("boom"); } };
export const fxBug: CommandSpec<Cmd> = { type: "fxBug", phases: ["LOBBY"], actor: () => true, handle: () => { throw new TypeError("bug"); } };

export const fixtureRegistry: Registry = { fxHost, fxShuffle, fxPlay, fxDraft, deleteGame: fxDelete, createGame: fxCreate, fxOrder, fxInvariant, fxBug };

// Enumerators for the fixtures, written from the intended behavior and not from the specs (G1 cross-checks them).
const hostActor = userActor(HOST_UID);
const notEnded = (g: Game) => g.phase !== "ENDED";
export const fixtureEnumerators: Record<string, Enumerator> = {
  fxHost: (g) => (g.phase === "LOBBY" || g.phase === "WRITING" || g.phase === "PLAYING" || g.phase === "FINISHED" ? [{ actor: hostActor, cmd: { type: "fxHost" } as never }] : []),
  fxShuffle: (g) => (g.phase === "WRITING" || g.phase === "PLAYING" || g.phase === "FINISHED" ? [{ actor: hostActor, cmd: { type: "fxShuffle" } as never }] : []),
  fxPlay: (g) => {
    const r = g.round;
    if (g.phase !== "PLAYING" || g.paused || r === null || r.phase !== "SUBMITTING") return [];
    return g.players
      .filter((p) => r.roster.includes(p.id) && p.id !== r.judgeId && !r.submissions.some((s) => s.playerId === p.id))
      .flatMap((p) => p.hand.map((c) => ({ actor: userActor(p.uid), cmd: { type: "fxPlay", cardId: c, expectedVersion: r.changedAtVersion } as never })));
  },
  fxDraft: (g) => (g.phase === "WRITING" || g.phase === "PLAYING" ? g.players.filter((p) => p.status === "writing").map((p) => ({ actor: userActor(p.uid), cmd: { type: "fxDraft" } as never })) : []),
  deleteGame: (g) => (notEnded(g) || g.phase === "ENDED" ? [{ actor: hostActor, cmd: { type: "deleteGame" } as never }] : []),
};
