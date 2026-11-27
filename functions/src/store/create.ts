// createGame (LLD 3 section 6.1, #34): the pure planner, the 8-attempt room-code loop and the replay ledger under the host. A lost room-code race is a
// plain `CodeTaken` (the SDK does not retry it), so the outer loop draws a fresh id and code and tries again; only 8 collisions exhaust it.
import type { Command, GameId, PlayerId, Settings, Uid } from "@dc/contracts";
import { decide, makeRng } from "@dc/engine";
import type { Actor, Rejection } from "@dc/engine";
import { Timestamp } from "firebase-admin/firestore";
import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { log } from "../log";
import { playerIdFromSeed, roomCodeFromSeed } from "./codes";
import { StoreError, mapStoreError } from "./errors";
import { eventDoc } from "./events";
import { idemId } from "./idem";
import { IDEM_TTL_MS, planViews, withStore } from "./plan";
import { eventPath, gamePath, hostIdemPath, roomCodePath } from "./refs";
import type { CreateLedgerDoc, Deps, RoomCodeDoc } from "./types";
import { MAX_WRITES, WriteSet, applyWrites } from "./writeset";
import type { DocWrite } from "./writeset";

export const CREATE_ATTEMPTS = 8;
/** gRPC ALREADY_EXISTS: a create that lost a race at commit time (the emulator normally retries and the code read sees the doc instead). */
const ALREADY_EXISTS = 6;

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
/** What one attempt adds: a fresh game id, the code it drew, and the host's seat id (decided per attempt, LLD 3 section 6.1). */
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

const data = (x: object): Record<string, unknown> => x as Record<string, unknown>;
const dataOf = (s: DocumentSnapshot): Record<string, unknown> | null => (s.exists ? (s.data() as Record<string, unknown>) : null);

/**
 * The pure half of one attempt (LLD 3 section 6.1): from the ledger and code docs step 1 read, decide replay, taken, rejected or accepted and name every
 * write. Replay is decided before the code is judged, so a re-used key wins even when the code now belongs to a newer game (ruling 9).
 */
export function planCreate(reads: CreateReads, i: CreateAttempt, d: CreatePlanDeps): CreatePlan {
  if (reads.ledger !== null) {
    return { kind: "replay", outcome: { kind: "accepted", gameId: reads.ledger.gameId, roomCode: reads.ledger.roomCode, replay: true }, writes: [] };
  }
  if (reads.code !== null) return { kind: "taken", writes: [] };

  const actor: Actor = { kind: "user", uid: i.hostId };
  const cmd: Command = {
    type: "createGame",
    gameId: i.gameId,
    roomCode: i.roomCode,
    hostId: i.hostId,
    hostPlayerId: i.hostPlayerId,
    hostName: i.hostName,
    ...(i.settings === undefined ? {} : { settings: i.settings }),
  };
  const res = decide(null, cmd, { now: d.now, rng: makeRng(d.seed), mintId: d.mintId, actor, drafts: {} });
  if (!res.ok) return { kind: "rejected", outcome: { kind: "rejected", rejection: res.error }, writes: [] };
  const a = res.value;

  const w = new WriteSet({ max: MAX_WRITES });
  w.create(gamePath(i.gameId), data(withStore(a.state, d.now)));
  w.create(eventPath(i.gameId, 1), data(eventDoc(1, d.now, a, cmd, d.seed, i.hostPlayerId)));
  for (const x of planViews(i.gameId, null, a.state, { now: d.now, storedRev: 0 })) w.apply(x); // host and spectator, LLD 2 8.2
  w.create(roomCodePath(i.roomCode), { gameId: i.gameId, createdAt: d.now });
  const ledger: CreateLedgerDoc = {
    at: d.now,
    expiresAt: Timestamp.fromMillis(d.now + IDEM_TTL_MS),
    commandType: "createGame",
    version: 1,
    gameId: i.gameId,
    roomCode: i.roomCode,
  };
  w.create(hostIdemPath(i.hostId, idemId(actor, i.idemKey)), data(ledger));
  return { kind: "accepted", outcome: { kind: "accepted", gameId: i.gameId, roomCode: i.roomCode, replay: false }, writes: w.writes() };
}

/** An ALREADY_EXISTS at commit time is a lost room-code race only when its message names this attempt's code doc; anything else is INVARIANT. */
function lostCodeRace(e: unknown, path: string): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  return err?.code === ALREADY_EXISTS && typeof err.message === "string" && err.message.includes(path);
}

function logCollision(attempts: number): void {
  try {
    log({ event: "roomcode.collision", attempts });
  } catch {
    // Logging must never change the result.
  }
}

/**
 * One createGame: up to 8 attempts, each a transaction that reads the host's ledger and the drawn code doc, plans, and commits the six documents
 * (LLD 3 section 6.1). Both seeds of an attempt are drawn before its transaction, so a rerun of the callback decides identically; `now` is read inside
 * it, so the committing attempt's clock is the recorded one.
 */
export async function executeCreate(db: Firestore, d: Deps, i: CreateInput): Promise<CreateExecution> {
  const actor: Actor = { kind: "user", uid: i.hostId };
  const ledgerRef = db.doc(hostIdemPath(i.hostId, idemId(actor, i.idemKey)));
  let attempts = 0;
  for (let n = 1; n <= CREATE_ATTEMPTS; n++) {
    attempts = n;
    const gameId = db.collection("games").doc().id;
    const codeSeed = d.newSeed();
    const decideSeed = d.newSeed();
    const roomCode = roomCodeFromSeed(codeSeed);
    const hostPlayerId = playerIdFromSeed(codeSeed);
    const path = roomCodePath(roomCode);
    const codeRef = db.doc(path);
    try {
      const outcome = await db.runTransaction(async (tx) => {
        const [lSnap, cSnap] = await tx.getAll(ledgerRef, codeRef);
        if (lSnap === undefined || cSnap === undefined) throw new StoreError("INVARIANT", "getAll returned fewer snapshots than refs");
        const plan = planCreate(
          { ledger: dataOf(lSnap) as CreateLedgerDoc | null, code: dataOf(cSnap) as RoomCodeDoc | null },
          { ...i, gameId, roomCode, hostPlayerId },
          { now: d.clock(), seed: decideSeed, mintId: d.mintId },
        );
        if (plan.kind === "taken") throw new CodeTaken();
        applyWrites(tx, db, plan.writes);
        return plan.outcome;
      });
      return { outcome, attempts };
    } catch (e) {
      if (e instanceof CodeTaken) {
        logCollision(attempts);
        continue;
      }
      if (lostCodeRace(e, path)) {
        logCollision(attempts);
        continue;
      }
      throw mapStoreError(e, attempts);
    }
  }
  throw new StoreError("ROOM_CODES_EXHAUSTED", `no free room code in ${CREATE_ATTEMPTS} attempts`);
}

/** LLD 3 section 6.1. Failures are thrown as `StoreError`; a rejection is a returned outcome and writes nothing. */
export async function createGame(db: Firestore, d: Deps, i: CreateInput): Promise<CreateOutcome> {
  return (await executeCreate(db, d, i)).outcome;
}
