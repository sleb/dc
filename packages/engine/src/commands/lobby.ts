// The lobby and membership commands (LLD 1 sections 7.1, 7.2, 8.5, 9.4): createGame, updateSettings, join, leave, removePlayer (join, leave and removePlayer also run mid-game since #23).
// Moderation (guard 8) is not wired for createGame and join until #25, so names are stored trimmed and otherwise as given.
import { MAX_SEATED, MAX_TOTAL_JOINS, PlayerIdSchema, RoomCodeSchema, GameIdSchema, SettingsPatchSchema } from "@dc/contracts";
import type { Command, Settings } from "@dc/contracts";
import { reject } from "../errors";
import type { CommandSpec, CreateSpec } from "../registry";
import { evictPlayer } from "../rules/membership";
import { lateJoinerRequirement } from "../rules/playability";
import { seatUid } from "../roles";
import { seated } from "../selectors";
import type { Ctx, Game, Handled, Player, PlayerId, Rejection } from "../types";

type Of<T extends Command["type"]> = Extract<Command, { type: T }>;

const effects = (): Pick<Handled, "draftChanges" | "roundRecords" | "redactEnvelope" | "aggregateChanged"> =>
  ({ draftChanges: [], roundRecords: [], redactEnvelope: false, aggregateChanged: true });

const SETTING_KEYS = ["targetOverride", "profanity", "variants", "spectators", "writeCountsOverride"] as const satisfies readonly (keyof Settings)[];
/** A fresh default Settings each call, so no nested object is shared between games. */
const defaultSettings = (): Settings => ({
  targetOverride: null,
  profanity: "on",
  variants: { pitch: false, writeIn: false, redraw: false, peoplesChoice: false },
  spectators: { enabled: false, vote: false },
  writeCountsOverride: null,
});

/** A patch that parsed as valid, with undefined-valued keys dropped; null when it is not a valid patch. Unknown keys are ignored. */
function parsePatch(raw: unknown): Partial<Settings> | null {
  const r = SettingsPatchSchema.safeParse(raw);
  if (!r.success) return null;
  return Object.fromEntries(Object.entries(r.data).filter(([, v]) => v !== undefined)) as Partial<Settings>;
}

/** The setting keys a raw patch names (validity aside), so the phase guard can run ahead of the payload guard. */
const namedKeys = (raw: unknown): (keyof Settings)[] =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw) ? SETTING_KEYS.filter((k) => (raw as Record<string, unknown>)[k] !== undefined) : [];
const keysOf = (patch: Partial<Settings>): (keyof Settings)[] => SETTING_KEYS.filter((k) => Object.hasOwn(patch, k));
const hasCards = (g: Game): boolean => Object.keys(g.cards).length > 0;
const isString = (v: unknown): v is string => typeof v === "string";
const field = (cmd: object, key: string): unknown => (cmd as Record<string, unknown>)[key];

/** Private name key until #25's `normalize` replaces it: case-insensitive and whitespace-insensitive. */
const nameKey = (name: string): string => name.toLowerCase().replace(/\s+/gu, "");

const invalid = (): Rejection => reject("INVALID_ARGUMENT");

export const createGame: CreateSpec<Of<"createGame">> = {
  type: "createGame",
  creates: true,
  actor: (i) => i.actor.kind === "user" && i.actor.uid === field(i.cmd, "hostId"),
  payload: ({ cmd }) => {
    const settings = field(cmd, "settings");
    const patch = settings === undefined ? {} : parsePatch(settings);
    const ok = GameIdSchema.safeParse(cmd.gameId).success && PlayerIdSchema.safeParse(cmd.hostPlayerId).success
      && RoomCodeSchema.safeParse(cmd.roomCode).success && isString(cmd.hostId) && isString(cmd.hostName)
      && patch !== null && (patch.writeCountsOverride ?? null) === null; // no deck exists yet, so an override cannot apply
    return ok ? null : invalid();
  },
  handle: ({ cmd, ctx }) => {
    const patch = (cmd.settings === undefined ? {} : parsePatch(cmd.settings)) ?? {};
    const host: Player = {
      id: cmd.hostPlayerId,
      uid: cmd.hostId,
      name: cmd.hostName.trim(),
      joinOrder: 0,
      status: "writing",
      hand: [],
      scorePile: [],
      writeTarget: null,
      writeProgress: { red: 0, green: 0 },
      powerUsage: { writeIn: false, redraw: false },
    };
    const state: Game = {
      id: cmd.gameId,
      roomCode: RoomCodeSchema.parse(cmd.roomCode),
      hostId: cmd.hostId,
      createdAt: ctx.now,
      version: 0,
      totalJoins: 0,
      phase: "LOBBY",
      paused: false,
      settings: { ...defaultSettings(), ...patch },
      target: null,
      writeCounts: null,
      cards: {},
      players: [host],
      pools: { redDeck: [], redDiscard: [], greenDeck: [], greenDiscard: [] },
      round: null,
      judgeCursor: null,
      history: [],
      votes: [],
      winnerId: null,
      waitingOn: [],
      waitingSince: null,
      reminderDueAt: null,
      episode: null,
      episodeGen: 0,
    };
    return { ...effects(), state, events: [{ t: "GameCreated", hostPlayerId: host.id }] };
  },
};

export const updateSettings: CommandSpec<Of<"updateSettings">> = {
  type: "updateSettings",
  phases: ["LOBBY", "WRITING", "PLAYING"],
  actor: (i) => i.roles.host,
  // Outside LOBBY only `profanity` may change. An invalid patch is left to guard 7.
  phase: ({ state, cmd }) => (state.phase !== "LOBBY" && namedKeys(field(cmd, "patch")).some((k) => k !== "profanity") ? reject("WRONG_PHASE") : null),
  payload: ({ state, cmd }) => {
    const patch = parsePatch(field(cmd, "patch"));
    if (patch === null) return invalid();
    return (patch.writeCountsOverride ?? null) !== null && !hasCards(state) ? invalid() : null; // an override needs an imported deck
  },
  handle: ({ state, cmd }) => {
    const patch = parsePatch(cmd.patch) ?? {};
    return { ...effects(), state: { ...state, settings: { ...state.settings, ...patch } }, events: [{ t: "SettingsUpdated", keys: keysOf(patch) }] };
  },
};

export const join: CommandSpec<Of<"join">> = {
  type: "join",
  phases: ["LOBBY", "WRITING", "PLAYING"],
  actor: (i) => i.actor.kind === "user" && isString(field(i.cmd, "playerId")) && i.actor.uid === seatUid(i.state.id, field(i.cmd, "playerId") as string),
  payload: ({ state, cmd }) => {
    const ok = PlayerIdSchema.safeParse(field(cmd, "playerId")).success && isString(field(cmd, "name")) && !state.players.some((p) => p.id === cmd.playerId); // any record, left and removed too: a departed id never comes back mid-game (LOBBY deletes records, so it is the same there)
    return ok ? null : invalid();
  },
  preconditions: ({ state, cmd }) => {
    const key = nameKey(cmd.name);
    const here = seated(state);
    if (here.some((p) => nameKey(p.name) === key)) return reject("NAME_TAKEN");
    if (here.length >= MAX_SEATED) return reject("ROOM_FULL");
    if (state.totalJoins >= MAX_TOTAL_JOINS) return reject("ROOM_FULL", "join_cap");
    return null;
  },
  handle: ({ state, cmd }) => {
    // Never reused: past the highest order ever given, even when the last joiner has since left (LOBBY deletes records).
    const joinOrder = Math.max(state.totalJoins, ...state.players.map((p) => p.joinOrder)) + 1;
    const player: Player = {
      id: cmd.playerId,
      uid: seatUid(state.id, cmd.playerId),
      name: cmd.name.trim(),
      joinOrder,
      status: "writing",
      hand: [],
      scorePile: [],
      // LOBBY: nothing to write yet. WRITING and PLAYING: the late joiner's requirement (9.4), recorded once and never recomputed.
      writeTarget: state.phase === "LOBBY" ? null : lateJoinerRequirement(state, seated(state).length + 1),
      writeProgress: { red: 0, green: 0 },
      powerUsage: { writeIn: false, redraw: false },
    };
    return { ...effects(), state: { ...state, players: [...state.players, player], totalJoins: state.totalJoins + 1 }, events: [{ t: "PlayerJoined", playerId: player.id }] };
  },
};

const seatedStatus = (p: Player): boolean => p.status === "writing" || p.status === "ready" || p.status === "active";

/**
 * A seat leaves or is removed. In LOBBY the record is deleted (host powers rest on `hostId`); in WRITING and PLAYING `evictPlayer` runs (8.5) and
 * the departure event comes first, then the eviction's side effects.
 */
function depart(state: Game, id: PlayerId, status: "left" | "removed", ctx: Ctx): Handled {
  const event = status === "left" ? ({ t: "PlayerLeft", playerId: id } as const) : ({ t: "PlayerRemoved", playerId: id } as const);
  if (state.phase === "LOBBY") return { ...effects(), state: { ...state, players: state.players.filter((p) => p.id !== id) }, events: [event] };
  const out = evictPlayer(state, id, status, ctx.rng);
  return { ...effects(), state: out.state, events: [event, ...out.events], draftChanges: out.draftChanges, ...(out.episodeStarted ? { episodeStarted: true } : {}) };
}

export const leave: CommandSpec<Of<"leave">> = {
  type: "leave",
  phases: ["LOBBY", "WRITING", "PLAYING"],
  actor: (i) => i.roles.playerId !== null,
  handle: ({ state, roles, ctx }) => depart(state, roles.playerId as string, "left", ctx),
};

export const removePlayer: CommandSpec<Of<"removePlayer">> = {
  type: "removePlayer",
  phases: ["LOBBY", "WRITING", "PLAYING"],
  actor: (i) => i.roles.host,
  payload: ({ cmd }) => (isString(field(cmd, "playerId")) ? null : invalid()),
  preconditions: ({ state, cmd }) => (state.players.some((p) => p.id === cmd.playerId && seatedStatus(p)) ? null : reject("NOT_FOUND")),
  handle: ({ state, cmd, ctx }) => depart(state, cmd.playerId, "removed", ctx),
};
