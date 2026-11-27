// rebuildViews (LLD 3 sections 5.6 and 6.5, #35): the second caller of the shared view fan-out (the first is any user command). One transaction reads
// the aggregate, then writes `store.viewsRev = PROJECTOR_REV` and `store.updatedAt = now` and every viewer's doc at the unchanged version, reusing
// `planViews` with `from = null` so the draft region is never touched and no `clearDraft` can be emitted. It never bumps `version`, writes no `events`
// doc, no ledger and no outbox row. It is unconditional (never skips at the current rev) and refuses a `store.deleting` game inside the transaction, so
// the aggregate lock serialises it against the `deleteGame` commit.
import type { GameId } from "@dc/contracts";
import { PROJECTOR_REV } from "@dc/engine";
import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { mapStoreError } from "./errors";
import { planViews, splitStore } from "./plan";
import { gamePath } from "./refs";
import { MAX_ATTEMPTS } from "./run";
import type { GameDoc } from "./types";
import { MAX_WRITES, WriteSet, applyWrites } from "./writeset";
import type { DocWrite } from "./writeset";

/** The pure plan: the outcome plus every write, so the write set is proved without the emulator. */
export type RebuildPlan =
  | { kind: "missing"; writes: [] }
  | { kind: "deleting"; writes: [] }
  | { kind: "rebuilt"; gameId: GameId; version: number; viewsRev: number; writes: DocWrite[] };

/** What the caller gets: the rebuilt version (unchanged) and how many documents were written. */
export type RebuildResult =
  | { kind: "missing" }
  | { kind: "deleting" }
  | { kind: "rebuilt"; gameId: GameId; version: number; viewsRev: number; writes: number };

const dataOf = (s: DocumentSnapshot): GameDoc | null => (s.exists ? (s.data() as GameDoc) : null);

/**
 * The pure half: a missing aggregate or a `store.deleting` one writes nothing; otherwise the aggregate's rev and every `viewersOf` doc. It takes the
 * caller's `gameId` and writes `gamePath(gameId)` (like `planCommand`), so the read and write paths are the same by construction rather than trusting
 * the stored `id` field. `storedRev: 0` never equals `PROJECTOR_REV`, so the fan-out rewrites every doc; `from = null` means no viewer can be
 * departing, so no `clearDraft`.
 */
export function planRebuild(gameId: GameId, doc: GameDoc | null, o: { now: number }): RebuildPlan {
  if (doc === null) return { kind: "missing", writes: [] };
  if (doc.store.deleting !== null) return { kind: "deleting", writes: [] };
  const { prev } = splitStore(doc);
  const w = new WriteSet({ max: MAX_WRITES });
  w.update(gamePath(gameId), { "store.viewsRev": PROJECTOR_REV, "store.updatedAt": o.now });
  for (const x of planViews(gameId, null, prev, { now: o.now, storedRev: 0 })) w.apply(x);
  return { kind: "rebuilt", gameId, version: prev.version, viewsRev: PROJECTOR_REV, writes: w.writes() };
}

/** The shell: one transaction, the aggregate read inside it, the planned writes and a typed result. Failures are thrown as `StoreError` (5.8). */
export async function rebuildViews(db: Firestore, gameId: GameId, o: { now: number }): Promise<RebuildResult> {
  let attempts = 0;
  try {
    return await db.runTransaction(async (tx) => {
      attempts++;
      const plan = planRebuild(gameId, dataOf(await tx.get(db.doc(gamePath(gameId)))), o);
      if (plan.kind !== "rebuilt") return { kind: plan.kind };
      applyWrites(tx, db, plan.writes);
      return { kind: "rebuilt", gameId: plan.gameId, version: plan.version, viewsRev: plan.viewsRev, writes: plan.writes.length };
    }, { maxAttempts: MAX_ATTEMPTS });
  } catch (e) {
    throw mapStoreError(e, attempts);
  }
}
