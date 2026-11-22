// Domain model (LLD 1 section 3), ports (section 5) and the result types of `decide`. Type-only: no runtime code here.
import type { CardId, ErrorCode, GameId, PlayerId, Settings, SubmissionId, Uid } from "@dc/contracts";

export type { CardId, GameId, PlayerId, Settings, SubmissionId, Uid };
export type { ErrorCode };

export type CardKind = "red" | "green";
export interface Card { kind: CardKind; text: string }

export type Phase = "LOBBY" | "WRITING" | "PLAYING" | "FINISHED" | "ENDED";
export type RoundPhase = "SUBMITTING" | "JUDGING";
/**
 * writing: has not finished writing (also used in LOBBY, where writeTarget is null)
 * ready:   finished writing; waiting for play to begin or for the next round boundary
 * active:  in play, holds a hand
 * left | removed: departed (kept for history; hand, pile and draft already released)
 */
export type PlayerStatus = "writing" | "ready" | "active" | "left" | "removed";

export interface Player {
  id: PlayerId;
  uid: Uid; // hostId for the host's seat, else seatUid(gameId, id)
  name: string;
  joinOrder: number; // monotonic per game, never reused
  status: PlayerStatus;
  hand: CardId[];
  scorePile: CardId[]; // green cards
  writeTarget: { red: number; green: number } | null;
  writeProgress: { red: number; green: number }; // counts in the saved draft
  powerUsage: { writeIn: boolean; redraw: boolean }; // server-only; once per game (E16)
}

export interface Pools { redDeck: CardId[]; redDiscard: CardId[]; greenDeck: CardId[]; greenDiscard: CardId[] }

export interface Submission {
  playerId: PlayerId;
  cardId: CardId;
  pitch?: string;
  writeIn?: true; // server-only marker, lives only while the round is open (K-A)
}

export interface Round {
  number: number; // = history.length + 1
  judgeId: PlayerId | null; // null only while paused with no one to take over (8.3)
  judgeReassigned: boolean;
  greenCardId: CardId;
  phase: RoundPhase;
  roster: PlayerId[]; // active players at open time, judge included; fixed
  submissions: Submission[];
  revealOrder: CardId[] | null; // set once at close (E10)
  openedAt: number;
  changedAtVersion: number; // version of the last judge, phase or voiding change (STALE, 5.3)
}

/** Compact, id-only resolved round kept in the aggregate. */
export interface RoundSummary {
  round: number;
  judgeId: PlayerId;
  greenCardId: CardId;
  plays: { playerId: PlayerId; cardId: CardId }[];
  winnerCardId: CardId;
  winnerId: PlayerId;
}

/** Full record written to games/{id}/rounds/{round}; returned by decide, not stored in Game. */
export interface RoundRecord extends RoundSummary {
  green: { id: CardId; text: string };
  playsDetail: { playerId: PlayerId; cardId: CardId; text: string; pitch?: string }[]; // in revealOrder order
  absent: PlayerId[];
  resolvedAt: number;
}

export interface Vote { round: number; voter: string; cardId: CardId } // voter = "p:{playerId}" | "s:{uid}"

export interface Game {
  id: GameId;
  roomCode: string;
  hostId: Uid;
  createdAt: number;
  version: number;
  totalJoins: number;
  phase: Phase;
  paused: boolean;
  settings: Settings;
  target: number | null;
  writeCounts: { red: number; green: number } | null;
  cards: Record<CardId, Card>;
  players: Player[];
  pools: Pools;
  round: Round | null;
  judgeCursor: number | null;
  history: RoundSummary[];
  votes: Vote[];
  winnerId: PlayerId | null;
  // scheduler denormalization (section 4.2)
  waitingOn: PlayerId[];
  waitingSince: number | null;
  reminderDueAt: number | null;
  episode: string | null;
  episodeGen: number;
}

/** Not part of Game: games/{id}/drafts/{playerId}, the only place authorship exists (E8). */
export interface Draft { red: string[]; green: string[] }
export type GameDrafts = Readonly<Record<PlayerId, Draft>>;

export type DomainEvent =
  | { t: "GameCreated"; hostPlayerId: PlayerId }
  | { t: "SettingsUpdated"; keys: (keyof Settings)[] }
  | { t: "PlayerJoined"; playerId: PlayerId }
  | { t: "PlayerLeft"; playerId: PlayerId }
  | { t: "PlayerRemoved"; playerId: PlayerId }
  | { t: "DeckImported"; red: number; green: number }
  | { t: "WritingStarted"; target: number; writeCounts: { red: number; green: number } }
  | { t: "PlayerFinishedWriting"; playerId: PlayerId }
  | { t: "PlayStarted"; playerIds: PlayerId[]; firstJudgeId: PlayerId }
  | { t: "PlayerActivated"; playerId: PlayerId }
  | { t: "RoundOpened"; round: number; judgeId: PlayerId; greenCardId: CardId; expected: PlayerId[] }
  | { t: "SubmissionConfirmed"; round: number; playerId: PlayerId }
  | { t: "HandRedrawn"; playerId: PlayerId }
  | { t: "SubmissionsClosed"; round: number; judgeId: PlayerId; reason: "allIn" | "closed" }
  | { t: "JudgeChanged"; round: number; from: PlayerId | null; to: PlayerId; reason: "passed" | "left" | "removed" | "resumed" }
  | { t: "RoundVoided"; round: number; reason: "no_submissions" }
  | { t: "WinnerPicked"; round: number; judgeId: PlayerId; winnerId: PlayerId; winnerCardId: CardId }
  | { t: "VoteCast"; round: number; voterKind: "player" | "spectator" }
  | { t: "CardRemoved"; cardId: CardId; kind: CardKind }
  | { t: "GameFinished"; winnerId: PlayerId }
  | { t: "GameEnded" }
  | { t: "GameDeleted" }
  | { t: "PausedChanged"; paused: boolean };

/** The Engine's rejection: a code and, for the codes that have one, a detail from the closed set in `DETAIL_BY_CODE`. Not the wire `Rejection` of @dc/contracts, which adds `ok`, `version` and `sv`. */
export interface Rejection { code: ErrorCode; detail?: string }

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface Rng {
  readonly seed: string;
  /** Uniform in [0, maxExclusive), rejection-sampled. */
  int(maxExclusive: number): number;
  /** Fisher-Yates; returns a new array. */
  shuffle<T>(xs: readonly T[]): T[];
}

export type Actor = { kind: "user"; uid: Uid } | { kind: "system" }; // system only for markReminded

export interface Ctx {
  now: number;
  rng: Rng;
  mintId: () => CardId;
  actor: Actor;
  drafts: GameDrafts;
}

export interface Roles {
  host: boolean;
  playerId: PlayerId | null;
  status: PlayerStatus | null;
  judge: boolean;
  spectator: boolean;
}

export interface DraftChange { playerId: PlayerId; draft: Draft | null }

export interface Accepted {
  state: Game;
  aggregateChanged: boolean;
  events: DomainEvent[];
  draftChanges: DraftChange[];
  roundRecords: RoundRecord[];
  seed: string;
  redactEnvelope: boolean;
  deleteGame?: true;
}

/** What a command handler returns; `decide` runs settle, bumps the version and adds the seed. */
export interface Handled {
  state: Game;
  events: DomainEvent[];
  draftChanges: DraftChange[];
  roundRecords: RoundRecord[];
  redactEnvelope: boolean;
  aggregateChanged: boolean;
  deleteGame?: true;
  /** The handler started a new waiting episode (void, reopen, judge change); see `waitingFields`. */
  episodeStarted?: boolean;
}
