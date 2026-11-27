// The deleteGame cascade (LLD 3 section 6.4, S5, ST9): phase 0's job builder and the runner. The runner is ordered so
// clients lose the views first and the aggregate survives as the resume marker until the last stage; each stage commits
// its progress, and every stage is idempotent so a crash at either boundary resumes. The deployed trigger, the real
// identity port and the hourly redrive are #42/M6; here the emulator-only harness op is the caller.
import type { DocumentSnapshot, Firestore, Query } from "firebase-admin/firestore";
import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import type { GameId, Uid } from "@dc/contracts";
import type { Game } from "@dc/engine";
import { log } from "../log";
import type { LogFields } from "../log";
import { deletionPath, gamePath, hostIdemCollectionPath } from "./refs";
import { registryQuery } from "./registry-query";
import type { DeletionDeps, DeletionJob, DeletionResult, DeletionStage } from "./types";
import { DELETION_STAGES } from "./types";

export { DELETION_STAGES };
export const DELETION_TTL_MS = 7 * 86_400_000;
export const STUCK_AFTER_MS = 3_600_000;

/** `deletions/{gameId}` from the aggregate phase 0 is about to hide (LLD 3 section 6.4). The caller passes the id the
 *  document path and `runDeletion` use, not the stored aggregate `id` (the #35 caller-id lesson). */
export function newDeletionJob(gameId: GameId, game: Game, now: number): DeletionJob {
  return {
    gameId,
    hostId: game.hostId,
    requestedAt: now,
    status: "running",
    stagesDone: [],
    // Every seat uid, departed players included; the host's Auth account is theirs and is never purged. LOBBY leavers
    // have no player record, so the identity stage adds `seats/*` to this list (C-SEATS, ST16).
    seatUids: game.players.map((p) => p.uid).filter((u) => u !== game.hostId),
    heartbeatAt: now,
    attempts: 0,
  };
}

/** Older than one hour, not exactly one hour (I35, LLD 3 section 6.4). */
export function isStuck(job: DeletionJob, now: number): boolean {
  return job.status === "running" && now - job.heartbeatAt > STUCK_AFTER_MS;
}

/** The union of the job's copied seat uids and every `seats/*` uid, minus the host (ST16). */
export function identityUids(job: DeletionJob, seatUids: readonly Uid[]): Uid[] {
  return [...new Set([...job.seatUids, ...seatUids])].filter((u) => u !== job.hostId);
}

/** The one alert line: the game id and nothing that could identify a player or a code. */
export function stuckLine(gameId: GameId): LogFields {
  return { event: "deletion.stuck", gameId };
}

const HISTORY_COLLECTIONS = ["rounds", "events", "outbox", "idem", "seats", "notifLog"] as const;

/** Deletes every row of a query in batches; a second pass over nothing is a no-op. */
async function deleteWhere(db: Firestore, query: Query): Promise<void> {
  const PAGE = 400;
  for (;;) {
    const page = await query.limit(PAGE).get();
    if (page.empty) return;
    const batch = db.batch();
    for (const doc of page.docs) batch.delete(doc.ref);
    await batch.commit();
    if (page.size < PAGE) return;
  }
}

/**
 * Deletes the host's `createGame` ledger rows that name one game (ST9). The read is a plain collection scan of
 * `hosts/{hostId}/idem` in `__name__` order, PAGE documents at a time, filtered in code: a collection-group query on
 * `idem.gameId` needed an enabled single-field index, and `wait-indexes` cannot observe one (LLD 0 P16), so a fresh deploy
 * could race the cascade against it (#82). The cursor is the last document *read*, never a count or offset, so deleting a
 * page cannot skip rows; one 400-delete batch per page stays under the 500-write commit limit. A second pass is a no-op.
 */
async function deleteHostLedger(db: Firestore, hostId: Uid, gameId: GameId): Promise<void> {
  const PAGE = 400;
  const collection = db.collection(hostIdemCollectionPath(hostId)).orderBy(FieldPath.documentId());
  let after: DocumentSnapshot | undefined;
  for (;;) {
    const page = await (after === undefined ? collection : collection.startAfter(after)).limit(PAGE).get();
    if (page.empty) return;
    const batch = db.batch();
    let deletes = 0;
    for (const doc of page.docs) {
      if (doc.get("gameId") !== gameId) continue;
      batch.delete(doc.ref);
      deletes++;
    }
    if (deletes > 0) await batch.commit();
    if (page.size < PAGE) return;
    after = page.docs[page.docs.length - 1];
  }
}

/**
 * One deletion run (LLD 3 section 6.4): skip the stages already recorded, commit progress after each, then mark the job
 * `done` with a 7-day `expiresAt`. A missing or done job is a no-op. A stale running job logs `deletion.stuck` before it
 * resumes. `attempts` counts invocations, not stages.
 */
export async function runDeletion(db: Firestore, deps: DeletionDeps, gameId: GameId): Promise<DeletionResult> {
  const jobRef = db.doc(deletionPath(gameId));
  let job = (await jobRef.get()).data() as DeletionJob | undefined;
  if (job === undefined) return { kind: "noop", reason: "missing", stagesRun: [], stuck: false };
  if (job.status === "done") return { kind: "noop", reason: "done", stagesRun: [], stuck: false };

  const now = deps.clock();
  const stuck = isStuck(job, now);
  if (stuck) (deps.log ?? log)(stuckLine(gameId));

  // One increment per invocation; the pseudocode's increment(0) was a no-op.
  await jobRef.update({ attempts: FieldValue.increment(1), heartbeatAt: now });
  job = { ...job, attempts: job.attempts + 1, heartbeatAt: now };

  const game = db.doc(gamePath(gameId));
  const hostId = job.hostId;
  const stages: Record<DeletionStage, () => Promise<void>> = {
    views: () => db.recursiveDelete(game.collection("views")),
    drafts: () => db.recursiveDelete(game.collection("drafts")),
    identity: async () => {
      const seats = await game.collection("seats").get();
      const uids = identityUids(job as DeletionJob, seats.docs.map((d) => d.get("uid") as Uid));
      await deps.identity.purgeSeats({ gameId, uids });
    },
    push: () => deleteWhere(db, registryQuery(db, "pushSubsByGame", { values: { gameId } })),
    joinIdem: () => deleteWhere(db, registryQuery(db, "joinIdemByGame", { values: { gameId } })),
    // The host's createGame ledger carries gameId + roomCode; leaving it would replay a deleted game (ST9). The plain
    // `hosts/{hostId}/idem` scan needs no field index, unlike the collection-group query it replaces (#82).
    hostIdem: () => deleteHostLedger(db, hostId, gameId),
    history: () => Promise.all(HISTORY_COLLECTIONS.map((c) => db.recursiveDelete(game.collection(c)))).then(() => undefined),
    aggregate: () => game.delete().then(() => undefined),
  };

  const stagesRun: DeletionStage[] = [];
  for (const stage of DELETION_STAGES) {
    if (job.stagesDone.includes(stage)) continue;
    await stages[stage]();
    deps.faults?.afterStage(stage, "work");
    job = { ...job, stagesDone: [...job.stagesDone, stage], heartbeatAt: deps.clock() };
    await jobRef.update({ stagesDone: job.stagesDone, heartbeatAt: job.heartbeatAt });
    stagesRun.push(stage);
    deps.faults?.afterStage(stage, "commit");
  }

  const doneAt = deps.clock();
  await jobRef.update({ status: "done", heartbeatAt: doneAt, expiresAt: Timestamp.fromMillis(doneAt + DELETION_TTL_MS) });
  return { kind: "done", stagesRun, stuck };
}
