import type { Actor, Card, CardId, CardKind, Ctx, Game, GameDrafts, GameId, Player, PlayerId, Rng, Round, Settings } from "../../src/types";
import { makeRng } from "../../src/rng";

/** Deterministic ids that satisfy the contracts id formats (p_ + 8 base-32, c_ + 10 base-36, 20 alphanumerics). */
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** Two trailing base-32 digits: 1024 distinct ids, and pid(n) for n < 32 is unchanged from the one-digit form. */
export const pid = (n: number): PlayerId => `p_aaaaaa${B32[Math.floor(n / 32) % 32] ?? "a"}${B32[n % 32] ?? "a"}`;
export const cid = (n: number): CardId => `c_${n.toString(36).padStart(10, "0")}`;
export const GAME_ID: GameId = "gameaaaaaaaaaaaaaaaa";
export const HOST_UID = "host-uid";

/** Independent of the engine's seatUid on purpose: the format is the spec (LLD 1 section 6). */
export const seatUidOf = (gameId: GameId, playerId: PlayerId): string => `seat:${gameId}:${playerId}`;

export const DEFAULT_SETTINGS: Settings = {
  targetOverride: null,
  profanity: "on",
  variants: { pitch: false, writeIn: false, redraw: false, peoplesChoice: false },
  spectators: { enabled: false, vote: false },
  writeCountsOverride: null,
};

/** Player number `n` (0 = host seat). Seat uid for everyone but the host. */
export function makePlayer(n: number, over: Partial<Player> = {}): Player {
  return {
    id: pid(n),
    uid: n === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(n)),
    name: `Player ${n}`,
    joinOrder: n,
    status: "writing",
    hand: [],
    scorePile: [],
    writeTarget: null,
    writeProgress: { red: 0, green: 0 },
    powerUsage: { writeIn: false, redraw: false },
    ...over,
  };
}

/** A LOBBY game with the host seated as player 0. */
export function makeGame(over: Partial<Game> = {}): Game {
  return {
    id: GAME_ID,
    roomCode: "BCDF",
    hostId: HOST_UID,
    createdAt: 0,
    version: 1,
    totalJoins: 0,
    phase: "LOBBY",
    paused: false,
    settings: DEFAULT_SETTINGS,
    target: null,
    writeCounts: null,
    cards: {},
    players: [makePlayer(0)],
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
    ...over,
  };
}

export function makeRound(over: Partial<Round> = {}): Round {
  return {
    number: 1,
    judgeId: pid(0),
    judgeReassigned: false,
    greenCardId: cid(900),
    phase: "SUBMITTING",
    roster: [],
    submissions: [],
    revealOrder: null,
    openedAt: 0,
    changedAtVersion: 1,
    ...over,
  };
}

export type Zone = "redDeck" | "redDiscard" | "greenDeck" | "greenDiscard" | { hand: PlayerId } | { scorePile: PlayerId };

/** Register a card and put it in one zone (card-registration helper; keeps "a card exists iff it is in exactly one zone"). */
export function addCard(game: Game, id: CardId, kind: CardKind, zone: Zone, text = `card ${id}`): Game {
  const cards: Record<CardId, Card> = { ...game.cards, [id]: { kind, text } };
  if (typeof zone === "string") return { ...game, cards, pools: { ...game.pools, [zone]: [...game.pools[zone], id] } };
  if ("hand" in zone) return { ...game, cards, players: game.players.map((p) => (p.id === zone.hand ? { ...p, hand: [...p.hand, id] } : p)) };
  return { ...game, cards, players: game.players.map((p) => (p.id === zone.scorePile ? { ...p, scorePile: [...p.scorePile, id] } : p)) };
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Hands out `c_0000000000`, `c_0000000001`, ... so scenarios are reproducible. `from` shifts the range. */
export function counterMintId(from = 1000): () => CardId {
  let n = from;
  return () => cid(n++);
}

/** An Rng whose `int` returns the scripted values in order (each must be in [0, max)); `shuffle` is Fisher-Yates over them, written here independently of the engine. */
export function scriptedRng(values: readonly number[], seed = "scripted"): Rng & { readonly drawn: number } {
  let i = 0;
  const int = (max: number): number => {
    const v = values[i++];
    if (v === undefined) throw new Error("scriptedRng exhausted");
    if (!Number.isInteger(v) || v < 0 || v >= max) throw new Error(`scriptedRng value ${v} outside [0, ${max})`);
    return v;
  };
  return {
    seed,
    int,
    shuffle<T>(xs: readonly T[]): T[] {
      const a = [...xs];
      for (let k = a.length - 1; k >= 1; k--) {
        const j = int(k + 1);
        [a[k], a[j]] = [a[j] as T, a[k] as T];
      }
      return a;
    },
    get drawn() { return i; },
  };
}
export const userActor = (uid: string): Actor => ({ kind: "user", uid });

/** A Ctx for tests: host actor, a real seeded rng, counter mintId, no drafts. */
export function ctxFor(over: Partial<Ctx> = {}): Ctx {
  return {
    now: 1_000,
    rng: makeRng("test-seed"),
    mintId: counterMintId(),
    actor: userActor(HOST_UID),
    drafts: {} as GameDrafts,
    ...over,
  };
}
