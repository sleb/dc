// createGame (LLD 3 section 6.1, #34): the pure planner, the 8-attempt room-code loop and the replay ledger under the host. Typed stub for the red
// commit; the green commit implements it.
import type { GameId, PlayerId, Settings, Uid } from "@dc/contracts";
import type { Rejection } from "@dc/engine";
import type { Firestore } from "firebase-admin/firestore";
import type { CreateLedgerDoc, Deps, RoomCodeDoc } from "./types";
import type { DocWrite } from "./writeset";

export const CREATE_ATTEMPTS = 8;

/** A lost room-code race (LLD 3 section 6.1). A plain Error with no numeric `code`, so the SDK never retries it as a transaction error. */
export class CodeTaken extends Error {
  constructor() {
    super("room code taken");
    this.name = "CodeTaken";
  }
}

export interface CreateInput {
  hostId: Uid;
  hostName: string;
  settings?: Partial<Settings>;
  idemKey: string;
}
/** What one attempt adds: a fresh game id, the code it draw, and the host's seat id (all decided per attempt, LLD 3 section 6.1). */
export interface CreateAttempt extends CreateInput {
  gameId: GameId;
  roomCode: string;
  hostPlayerId: PlayerId;
}
/** The two documents step 1 reads: the host's ledger and the code doc, null where absent. */
export interface CreateReads {
  ledger: CreateLedgerDoc | null;
  code: RoomCodeDoc | null;
}
export interface CreatePlanDeps {
  now: number;
  seed: string;
  mintId: () => string;
}

/** Ruling 3: mirrors CommandOutcome; failures throw `StoreError`. */
export type CreateOutcome =
  | { kind: "accepted"; gameId: GameId; roomCode: string; replay: boolean }
  | { kind: "rejected"; rejection: Rejection };

export type CreatePlan =
  | { kind: "accepted"; outcome: CreateOutcome; writes: DocWrite[] }
  | { kind: "replay"; outcome: CreateOutcome; writes: DocWrite[] }
  | { kind: "rejected"; outcome: CreateOutcome; writes: DocWrite[] }
  | { kind: "taken"; writes: DocWrite[] };

export interface CreateExecution {
  outcome: CreateOutcome;
  attempts: number;
}

const NOT_BUILT: CreateOutcome = { kind: "rejected", rejection: { code: "INVALID_ARGUMENT" } };

export function planCreate(_reads: CreateReads, _i: CreateAttempt, _d: CreatePlanDeps): CreatePlan {
  return { kind: "rejected", outcome: NOT_BUILT, writes: [] };
}

export async function executeCreate(_db: Firestore, _d: Deps, _i: CreateInput): Promise<CreateExecution> {
  return { outcome: NOT_BUILT, attempts: 0 };
}

export async function createGame(db: Firestore, d: Deps, i: CreateInput): Promise<CreateOutcome> {
  return (await executeCreate(db, d, i)).outcome;
}
