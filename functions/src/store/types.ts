// Store types (LLD 3 sections 2.2, 2.3 and 5.1), plus the ordered deletion stage list (a runtime value).
import type { Command, GameId, GameView, PlayerId, Uid } from "@dc/contracts";
import type { Actor, DomainEvent, Game, PlayerStatus, Rejection } from "@dc/engine";
import type { Timestamp } from "firebase-admin/firestore";
import type { LogFields } from "../log";
import type { DocWrite } from "./writeset";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface StoreMeta {
  schema: 1;
  viewsRev: number;
  updatedAt: number;
  deleting: { at: number; by: Uid } | null;
}
export interface GameDoc extends Game { store: StoreMeta }

export interface DraftDoc { red: string[]; green: string[]; seq: number; updatedAt: number }
export interface IdemDoc { at: number; expiresAt: Timestamp; commandType: string; version: number; draftSeq?: number; meta?: Json }
/** `hosts/{hostUid}/idem/{hash}` for createGame (LLD 3 sections 2.3 and 6.1, #34): `IdemDoc` plus the ids a replay returns. */
export interface CreateLedgerDoc extends IdemDoc { commandType: "createGame"; version: 1; gameId: GameId; roomCode: string }
/** `roomCodes/{code}` (LLD 3 sections 2.3 and 6.1, #34): one live game per code (ST8). */
export interface RoomCodeDoc { gameId: GameId; createdAt: number }
export interface EventDoc { version: number; at: number; commandType: Command["type"]; events: DomainEvent[]; seed?: string; actorPlayerId?: PlayerId }

export type ReminderEvent = { t: "Reminder"; episode: string; episodeGen: number; dueAt: number; waitingOn: PlayerId[] };
export interface OutboxRow {
  id: string;
  gameId: GameId;
  version: number;
  i: number;
  topic: "notify" | "identity";
  event: DomainEvent | ReminderEvent;
  at: number;
  roster: { playerId: PlayerId; uid: Uid; status: PlayerStatus }[];
  judgeId: PlayerId | null;
  paused: boolean;
  round?: { number: number; phase: "SUBMITTING" | "JUDGING" };
  waitingOn: PlayerId[];
  processedAt: number | null;
  notifDoneAt?: null;
  expiresAt: Timestamp;
}

export type FaultPoint = "afterWritesBuffered" | "afterCommit";
/** Emulator only (LLD 3 section 10.3): called at the named points; may throw to simulate a crash or an ABORTED. `attempt` is 1-based. */
export interface FaultHooks { fire(point: FaultPoint, attempt: number): void }

export interface Deps {
  clock(): number;
  /** CSPRNG, 128 bit; shuffles only. */
  newSeed(): string;
  /** CSPRNG, non-replayable; card ids (ctx.mintId, C-EV). */
  mintId(): string;
  /**
   * The aggregate id, when the caller supplies one. Production leaves it undefined, so createGame draws a Firestore auto-id
   * (LLD 3 section 2.4); the emulator harness supplies a fixture id (LLD 3 section 10.1, #37).
   */
  newGameId?(): GameId;
  faults?: FaultHooks;
}

export interface CommandInput {
  gameId: GameId;
  cmd: Command;
  actor: Actor;
  /** For join, the keyHash, never the raw key (2.4, K-C); "remind:{episode}:{dueAt}" for the system actor. */
  idemKey: string;
  /** At most 1 KiB, stored in the ledger, echoed on replay. */
  meta?: Json;
  /** Pure; run on a non-replay accept only. */
  extraWrites?: (r: { prev: Game; next: Game }) => DocWrite[];
}

export type CommandOutcome =
  | { kind: "accepted"; version: number; view: GameView | null; draftSeq?: number; replay: boolean; meta?: Json }
  | { kind: "rejected"; rejection: Rejection; version: number }
  | { kind: "deleting" };

/** The ordered cascade stages (LLD 3 section 6.4). The aggregate is last: it is the resume marker. */
export const DELETION_STAGES = ["views", "drafts", "identity", "push", "joinIdem", "hostIdem", "history", "aggregate"] as const;
export type DeletionStage = (typeof DELETION_STAGES)[number];

/** `deletions/{gameId}` (LLD 3 section 2.3): the job survives the aggregate so an interrupted delete can resume. */
export interface DeletionJob {
  gameId: GameId;
  hostId: Uid;
  requestedAt: number;
  status: "running" | "done";
  stagesDone: DeletionStage[];
  seatUids: Uid[];
  heartbeatAt: number;
  attempts: number;
  expiresAt?: Timestamp;
}

/** The Identity half of the cascade (LLD 4 section 6.3). #43 supplies the real Auth implementation. */
export interface IdentityPort {
  purgeSeats(i: { gameId: GameId; uids: Uid[] }): Promise<{ requested: number; deleted: number }>;
}

export interface DeletionFaults {
  afterStage(stage: DeletionStage, point: "work" | "commit"): void;
}

/** What `runDeletion` needs: a clock, an identity port, the logger seam and the emulator-only fault seam. */
export interface DeletionDeps {
  clock(): number;
  identity: IdentityPort;
  log?(fields: LogFields): void;
  faults?: DeletionFaults;
}

export interface DeletionResult {
  kind: "done" | "noop";
  reason?: "missing" | "done";
  stagesRun: DeletionStage[];
  stuck: boolean;
}
