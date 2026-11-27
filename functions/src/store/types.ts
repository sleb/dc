// Store types (LLD 3 sections 2.2, 2.3 and 5.1). Type-only.
import type { Command, GameId, GameView, PlayerId, Uid } from "@dc/contracts";
import type { Actor, DomainEvent, Game, PlayerStatus, Rejection } from "@dc/engine";
import type { Timestamp } from "firebase-admin/firestore";
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
