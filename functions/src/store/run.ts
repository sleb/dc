// runCommand (LLD 3 section 5.2): one command is one Firestore transaction. The callback reads (step 1), calls the pure planner (steps 2 and 3,
// plan.ts) and buffers its writes; it mutates nothing outside `attempts` and performs no side effect (ST2), so the SDK may rerun it on ABORTED.
// Logging happens after the transaction.
import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { log } from "../log";
import { StoreError, mapStoreError } from "./errors";
import { idemId } from "./idem";
import { extraReadPaths, planCommand } from "./plan";
import type { Plan } from "./plan";
import { gamePath, idemPath } from "./refs";
import type { CommandInput, CommandOutcome, Deps, GameDoc, IdemDoc } from "./types";
import { applyWrites } from "./writeset";

export const MAX_ATTEMPTS = 8;
export const META_MAX_BYTES = 1024;

/** One run's outcome plus the diagnostics the emulator-only harness reports (`attempts`, distinct documents written). */
export interface Execution { outcome: CommandOutcome; attempts: number; writes: number }

const dataOf = (s: DocumentSnapshot): Record<string, unknown> | null => (s.exists ? (s.data() as Record<string, unknown>) : null);

export async function execute(db: Firestore, d: Deps, i: CommandInput): Promise<Execution> {
  const t0 = Date.now();
  if (i.meta !== undefined && Buffer.byteLength(JSON.stringify(i.meta), "utf8") > META_MAX_BYTES) throw new StoreError("INVARIANT", "meta over 1 KiB");
  const gameRef = db.doc(gamePath(i.gameId));
  const idemRef = db.doc(idemPath(i.gameId, idemId(i.actor, i.idemKey)));
  let attempts = 0;
  let result: { plan: Plan } | null = null;
  try {
    result = await db.runTransaction(async (tx) => {
      attempts++; // the only closure mutation (ST2)
      // ---------- 1. READS: every read before the first write ----------
      const [gSnap, iSnap] = await tx.getAll(gameRef, idemRef);
      if (gSnap === undefined || iSnap === undefined) throw new StoreError("INVARIANT", "getAll returned fewer snapshots than refs");
      const reads = { game: dataOf(gSnap) as GameDoc | null, idem: dataOf(iSnap) as IdemDoc | null };
      const paths = extraReadPaths(reads, i);
      const extra = new Map<string, Record<string, unknown> | null>();
      if (paths.length > 0) for (const s of await tx.getAll(...paths.map((p) => db.doc(p)))) extra.set(s.ref.path, dataOf(s));
      // ---------- 2 and 3: decide and plan (pure), then buffer ----------
      const plan = planCommand(reads, extra, i, { now: d.clock(), seed: d.newSeed(), mintId: d.mintId });
      applyWrites(tx, db, plan.writes);
      d.faults?.fire("afterWritesBuffered", attempts);
      return { plan };
    }, { maxAttempts: MAX_ATTEMPTS });
  } catch (e) {
    const err = mapStoreError(e, attempts);
    logCommand(i, { outcome: "error", reason: err.kind, attempts, latencyMs: Date.now() - t0 });
    throw err;
  }
  const { outcome, writes, sizeWarn } = result.plan;
  logCommand(i, {
    outcome: outcome.kind === "rejected" ? "rejected" : "ok",
    ...(outcome.kind === "rejected" ? { reason: outcome.rejection.code } : {}),
    ...(outcome.kind === "deleting" ? {} : { version: outcome.version }),
    ...(outcome.kind === "accepted" ? { replay: outcome.replay } : {}),
    attempts,
    latencyMs: Date.now() - t0,
  });
  if (sizeWarn) log({ event: "store.size.warn", gameId: i.gameId, commandType: i.cmd.type, ...(outcome.kind === "accepted" ? { version: outcome.version } : {}) });
  d.faults?.fire("afterCommit", attempts);
  return { outcome, attempts, writes: writes.length };
}

/** LLD 3 section 5.1. Failures are thrown as StoreError (5.8). */
export async function runCommand(db: Firestore, d: Deps, i: CommandInput): Promise<CommandOutcome> {
  return (await execute(db, d, i)).outcome;
}

interface LogLine { outcome: "ok" | "rejected" | "error"; reason?: string; version?: number; replay?: boolean; attempts: number; latencyMs: number }

/** `command.done` / `command.rejected`, and `txn.retry` when the transaction ran more than once (LLD 0 section 9). Ids, codes and counts only. */
function logCommand(i: CommandInput, l: LogLine): void {
  try {
    log({ event: l.outcome === "rejected" ? "command.rejected" : "command.done", gameId: i.gameId, commandType: i.cmd.type, ...l });
    if (l.attempts > 1) log({ event: "txn.retry", gameId: i.gameId, commandType: i.cmd.type, attempts: l.attempts });
  } catch {
    // Logging must never change the result of a command.
  }
}
