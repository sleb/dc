// The emulator-only Store harness (#33, LLD 3 section 10.3, LLD 0 P9 as amended): the route the Store integration suites use to reach `runCommand`
// and `load` in the Node bundle before the real callables exist (#40). Exported only when FUNCTIONS_EMULATOR is "true" (the Functions emulator sets
// it; `firebase deploy` discovery and the deployed runtime do not), listed in exports.emulator.json, and re-gated in the handler. `check-bundle`
// proves it is absent from the deployed export list. It takes the actor from the request, so it must never deploy.
//
// Per request, also emulator-gated: `now` (the clock), `seeds` (for `run`, the shuffle seed of attempt k is seeds[k-1]; for `createGame`, the k-th
// `newSeed()` call), `faults` (`throwAt` a point, or an ABORTED on the listed attempts), and a named test recipe for `extraWrites`. It reports the
// attempts, the distinct documents written and the seed of every attempt.
import type { Settings } from "@dc/contracts";
import { HttpsError } from "firebase-functions/v2/https";
import { RT, defineCallable } from "../api/callable";
import { newCardId } from "../deps";
import { db } from "../firebase";
import { DELETION_STAGES, StoreError, execute, executeCreate, findByRoomCode, listWaitingOn, load, rebuildViews, runDeletion } from "../store";
import type { CommandInput, CreateInput, DeletionDeps, DeletionResult, DeletionStage, Deps, DocWrite, FaultHooks, FaultPoint, Json } from "../store";
import type { LogFields } from "../log";

const isEmulator = (): boolean => process.env["FUNCTIONS_EMULATOR"] === "true";

/** The fault a `throwAt` raises: not a StoreError, so it reaches the caller as itself (the "crash"). */
class InjectedFault extends Error {
  constructor(readonly point: FaultPoint) {
    super(`injected fault at ${point}`);
  }
}

interface Faults { throwAt?: FaultPoint; abortAttempts?: number[] }
interface RunRequest { op: "run"; gameId: string; cmd: CommandInput["cmd"]; actor: CommandInput["actor"]; idemKey: string; meta?: Json; extraWrites?: { recipe: "testSeat"; keyHash: string }; now?: number; seeds?: string[]; faults?: Faults }
interface LoadRequest { op: "load"; gameId: string }
interface CreateRequest { op: "createGame"; hostId: string; hostName: string; settings?: Partial<Settings>; idemKey: string; now?: number; seeds?: string[] }
interface FindRequest { op: "findByRoomCode"; code: string }
interface RebuildRequest { op: "rebuildViews"; gameId: string; now: number }
interface WaitingRequest { op: "listWaitingOn"; now: number; limit?: number; after?: { dueAt: number; gameId: string } }
interface DeletionFaultRequest { stage: DeletionStage; point: "work" | "commit" }
interface DeletionRequest { op: "runDeletion"; gameId: string; now?: number; faults?: { afterStage?: DeletionFaultRequest }; captureLog?: boolean }
interface PurgeCall { gameId: string; uids: string[]; requested: number; deleted: number }

export const HTTPS_CODE = { CONTENTION: "aborted", UNAVAILABLE: "unavailable", INVARIANT: "internal", AGGREGATE_TOO_LARGE: "resource-exhausted", TOO_MANY_WRITES: "resource-exhausted", ROOM_CODES_EXHAUSTED: "resource-exhausted" } as const;

function bad(what: string): never {
  throw new HttpsError("invalid-argument", `storeHarness: ${what}`);
}

/**
 * The test recipe for `extraWrites` (LLD 3 section 6.2, the Store half only): a seat doc and a `joinIdem` row for the joining player, computed purely
 * from the state and the request. Identity's real writes, `keyHash` handling and the raw-key sentinel are #42.
 */
function testSeat(keyHash: string, at: number): NonNullable<CommandInput["extraWrites"]> {
  return ({ next }) => {
    const p = next.players.at(-1);
    if (p === undefined) return [];
    const writes: DocWrite[] = [
      { op: "create", path: `games/${next.id}/seats/${p.id}`, data: { uid: p.uid, secretHash: "test-recipe-hash", createdAt: at, epoch: 0, notBefore: 0, firstSignInAt: null, revokedAt: null } },
      { op: "create", path: `joinIdem/${keyHash}`, data: { gameId: next.id, playerId: p.id, uid: p.uid, createdAt: at } },
    ];
    return writes;
  };
}

function faultHooks(f: Faults | undefined): FaultHooks | undefined {
  if (f === undefined) return undefined;
  return {
    fire(point, attempt) {
      if (point === "afterWritesBuffered" && f.abortAttempts?.includes(attempt) === true) throw Object.assign(new Error("injected ABORTED"), { code: 10 });
      if (f.throwAt === point) throw new InjectedFault(point);
    },
  };
}

async function runOp(r: RunRequest): Promise<{ ok: true; outcome: unknown; attempts: number; writes: number; seeds: string[] }> {
  if (typeof r.gameId !== "string" || typeof r.idemKey !== "string" || typeof r.cmd !== "object" || r.cmd === null || typeof r.actor !== "object" || r.actor === null) bad("run needs gameId, cmd, actor and idemKey");
  const seeds: string[] = [];
  const at = r.now ?? Date.now();
  const deps: Deps = {
    clock: () => r.now ?? Date.now(),
    newSeed: () => {
      const s = r.seeds?.[seeds.length] ?? `harness-${at}-${seeds.length}-${newCardId()}`;
      seeds.push(s);
      return s;
    },
    mintId: newCardId,
    ...(r.faults === undefined ? {} : { faults: faultHooks(r.faults) as FaultHooks }),
  };
  const input: CommandInput = {
    gameId: r.gameId, cmd: r.cmd, actor: r.actor, idemKey: r.idemKey,
    ...(r.meta === undefined ? {} : { meta: r.meta }),
    ...(r.extraWrites?.recipe === "testSeat" ? { extraWrites: testSeat(r.extraWrites.keyHash, at) } : {}),
  };
  try {
    const x = await execute(db(), deps, input);
    return { ok: true, outcome: x.outcome, attempts: x.attempts, writes: x.writes, seeds };
  } catch (e) {
    // A fault thrown inside the transaction reaches here as the INVARIANT it maps to, with the fault as its cause.
    const fault = e instanceof InjectedFault ? e : e instanceof StoreError && e.cause instanceof InjectedFault ? e.cause : null;
    if (fault !== null) throw new HttpsError("internal", "injected fault", { kind: "FAULT", point: fault.point });
    if (e instanceof StoreError) throw new HttpsError(HTTPS_CODE[e.kind], e.kind, { kind: e.kind });
    throw e;
  }
}

async function createOp(r: CreateRequest): Promise<{ ok: true; outcome: unknown; attempts: number; seeds: string[] }> {
  if (typeof r.hostId !== "string" || typeof r.hostName !== "string" || typeof r.idemKey !== "string") bad("createGame needs hostId, hostName and idemKey");
  const seeds: string[] = [];
  const at = r.now ?? Date.now();
  const input: CreateInput = {
    hostId: r.hostId,
    hostName: r.hostName,
    idemKey: r.idemKey,
    ...(r.settings === undefined ? {} : { settings: r.settings }),
  };
  // The k-th `newSeed()` call is seeds[k]; production draws the code seed then the decide seed once per attempt.
  const deps: Deps = {
    clock: () => r.now ?? Date.now(),
    newSeed: () => {
      const s = r.seeds?.[seeds.length] ?? `harness-create-${at}-${seeds.length}-${newCardId()}`;
      seeds.push(s);
      return s;
    },
    mintId: newCardId,
  };
  try {
    const x = await executeCreate(db(), deps, input);
    return { ok: true, outcome: x.outcome, attempts: x.attempts, seeds };
  } catch (e) {
    if (e instanceof StoreError) throw new HttpsError(HTTPS_CODE[e.kind], e.kind, { kind: e.kind });
    throw e;
  }
}

/** The fault a `runDeletion` request raises: not a StoreError, so it reaches the caller as the "crash". */
class InjectedDeletionFault extends Error {
  constructor(readonly stage: DeletionStage, readonly point: "work" | "commit") {
    super(`injected deletion fault after ${point} of ${stage}`);
  }
}

/**
 * runDeletion (#36): the cascade runner with a recording fake identity port. Nothing is written to Firestore by the port;
 * the purge calls come back as `purged`. `captureLog` returns the lines the runner emitted instead of only sending them
 * to the real logger. `faults.afterStage` throws at the named boundary of the named stage.
 */
async function deletionOp(r: DeletionRequest): Promise<{ ok: true; result: DeletionResult; purged: PurgeCall[]; logs: LogFields[] }> {
  if (typeof r.gameId !== "string" || r.gameId.length === 0) bad("runDeletion needs gameId");
  if (r.now !== undefined && typeof r.now !== "number") bad("runDeletion needs a numeric now");
  if (r.captureLog !== undefined && typeof r.captureLog !== "boolean") bad("runDeletion needs a boolean captureLog");
  const f = r.faults?.afterStage;
  if (f !== undefined && (!(DELETION_STAGES as readonly string[]).includes(f.stage) || (f.point !== "work" && f.point !== "commit"))) bad("runDeletion needs a known stage and point");
  const purged: PurgeCall[] = [];
  const logs: LogFields[] = [];
  const deps: DeletionDeps = {
    clock: () => r.now ?? Date.now(),
    identity: {
      async purgeSeats({ gameId, uids }) {
        purged.push({ gameId, uids: [...uids], requested: uids.length, deleted: uids.length });
        return { requested: uids.length, deleted: uids.length };
      },
    },
    ...(r.captureLog === true ? { log: (fields: LogFields) => void logs.push(fields) } : {}),
    ...(f === undefined
      ? {}
      : {
          faults: {
            afterStage(stage: DeletionStage, point: "work" | "commit") {
              if (stage === f.stage && point === f.point) throw new InjectedDeletionFault(stage, point);
            },
          },
        }),
  };
  try {
    return { ok: true, result: await runDeletion(db(), deps, r.gameId), purged, logs };
  } catch (e) {
    if (e instanceof InjectedDeletionFault) throw new HttpsError("internal", "injected fault", { kind: "FAULT", stage: e.stage, point: e.point });
    if (e instanceof StoreError) throw new HttpsError(HTTPS_CODE[e.kind], e.kind, { kind: e.kind });
    throw e;
  }
}

/** The handler, exported for the H2 unit test. Refuses outside the emulator even if reached. */
export async function handleStoreHarness(data: unknown): Promise<{ ok: true; [k: string]: unknown }> {
  if (!isEmulator()) throw new HttpsError("failed-precondition", "storeHarness runs only in the Functions emulator");
  const req = data as RunRequest | LoadRequest | CreateRequest | FindRequest | RebuildRequest | WaitingRequest | DeletionRequest | null;
  if (req === null || typeof req !== "object") bad("no request");
  if (req.op === "load") {
    if (typeof req.gameId !== "string") bad("load needs gameId");
    return { ok: true, loaded: await load(db(), req.gameId) };
  }
  if (req.op === "run") return runOp(req);
  if (req.op === "createGame") return createOp(req);
  if (req.op === "findByRoomCode") {
    if (typeof req.code !== "string") bad("findByRoomCode needs code");
    return { ok: true, code: await findByRoomCode(db(), req.code) };
  }
  if (req.op === "rebuildViews") {
    if (typeof req.gameId !== "string" || typeof req.now !== "number") bad("rebuildViews needs gameId and now");
    return { ok: true, result: await rebuildViews(db(), req.gameId, { now: req.now }) };
  }
  if (req.op === "listWaitingOn") {
    if (typeof req.now !== "number") bad("listWaitingOn needs now");
    if (req.limit !== undefined && (!Number.isInteger(req.limit) || req.limit <= 0)) bad("listWaitingOn needs a positive integer limit");
    if (req.after !== undefined && (typeof req.after !== "object" || req.after === null || typeof req.after.dueAt !== "number" || typeof req.after.gameId !== "string")) bad("listWaitingOn needs after {dueAt: number, gameId: string}");
    return { ok: true, page: await listWaitingOn(db(), { now: req.now, ...(req.limit === undefined ? {} : { limit: req.limit }), ...(req.after === undefined ? {} : { after: req.after }) }) };
  }
  if (req.op === "runDeletion") return deletionOp(req);
  return bad("unknown op");
}

export const storeHarness = isEmulator()
  ? defineCallable({ name: "storeHarness", allow: ["guest"], runtime: RT.harness, handler: async ({ req }) => handleStoreHarness(req.data) })
  : undefined;
