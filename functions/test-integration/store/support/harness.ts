// The client side of the emulator-only `storeHarness` callable (#33) and the Admin SDK handle the store suites inspect with.
// Requests go over HTTP to the Node bundle in the Functions emulator (LLD 0 P9), with an unsigned App Check token as in ping.test.ts.
import { initializeApp } from "firebase/app";
import { CustomProvider, initializeAppCheck } from "firebase/app-check";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { getApps, initializeApp as adminInit } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Command } from "@dc/contracts";
import type { Actor, Game } from "@dc/engine";
import type { CreateOutcome, RebuildResult, RoomCodeDoc, WaitingPage } from "../../../src/store";
import { harnessProject } from "./fixture-names";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({ app_id: "demo-app", sub: "demo-app", iss: "demo", aud: ["demo"], exp: 4_102_444_800 })}.x`;
const project = harnessProject(); // the guard's demo- project, so the CLI, the clients and clear() agree (#37)
const client = initializeApp({ projectId: project, apiKey: "demo", appId: "demo-app" }, "store-harness");
initializeAppCheck(client, { provider: new CustomProvider({ getToken: async () => ({ token: fakeToken, expireTimeMillis: 4_102_444_800_000 }) }) });
const fns = getFunctions(client, "us-central1");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = httpsCallable<unknown, unknown>(fns, "storeHarness", { timeout: 300_000 });

const adminApp: App = getApps().find((a) => a.name === "store-tests") ?? adminInit({ projectId: project }, "store-tests");
export const db = getFirestore(adminApp);

export interface Faults { throwAt?: "afterWritesBuffered" | "afterCommit"; abortAttempts?: number[] }
export interface RunRequest {
  gameId: string;
  cmd: Command;
  actor: Actor;
  idemKey: string;
  meta?: unknown;
  extraWrites?: { recipe: "testSeat"; keyHash: string };
  now?: number;
  seeds?: string[];
  faults?: Faults;
}
export type Outcome =
  | { kind: "accepted"; version: number; view: { version: number; [k: string]: unknown } | null; draftSeq?: number; replay: boolean; meta?: unknown }
  | { kind: "rejected"; rejection: { code: string; detail?: string }; version: number }
  | { kind: "deleting" };
export interface RunResult { outcome: Outcome; attempts: number; writes: number; seeds: string[] }

export async function run(req: RunRequest): Promise<RunResult> {
  const res = await call({ op: "run", ...req });
  return res.data as RunResult;
}

export async function load(gameId: string): Promise<{ game: Game; store: Record<string, unknown> } | null> {
  const res = await call({ op: "load", gameId });
  return (res.data as { loaded: { game: Game; store: Record<string, unknown> } | null }).loaded;
}

/** createGame (#34): `seeds` are the k-th `newSeed()` call; production draws the code seed then the decide seed per attempt. */
export interface CreateRequest {
  hostId: string;
  hostName: string;
  idemKey: string;
  settings?: unknown;
  /** Emulator fixtures only (LLD 3 section 10.1, #37): the aggregate id a replay names. */
  gameId?: string;
  now?: number;
  seeds?: string[];
}
export interface CreateResult { outcome: CreateOutcome; attempts: number; seeds: string[] }

/** Interleave code seeds with a decide seed each, the order the createGame attempt loop draws them (LLD 3 section 6.1). */
export const createSeeds = (codes: string[]): string[] => codes.flatMap((code, i) => [code, `decide-seed-${i}`]);

export async function create(req: CreateRequest): Promise<CreateResult> {
  const res = await call({ op: "createGame", ...req });
  return res.data as CreateResult;
}

export async function createError(req: CreateRequest): Promise<{ code: string; kind: string | null }> {
  try {
    await create(req);
  } catch (e) {
    return errorOf(e);
  }
  throw new Error("expected the harness call to fail");
}

export async function findRoomCode(code: string): Promise<RoomCodeDoc | null> {
  const res = await call({ op: "findByRoomCode", code });
  return (res.data as { code: RoomCodeDoc | null }).code;
}

/** rebuildViews (#35): the Store repair path through the emulator-only harness. */
export async function rebuildViews(gameId: string, now: number): Promise<RebuildResult> {
  const res = await call({ op: "rebuildViews", gameId, now });
  return (res.data as { result: RebuildResult }).result;
}

/** runDeletion (#36): the emulator-only cascade runner with a recording fake identity port. */
export type DeletionStage = "views" | "drafts" | "identity" | "push" | "joinIdem" | "hostIdem" | "history" | "aggregate";
export interface DeletionResultLike { kind: "done" | "noop"; reason?: "missing" | "done"; stagesRun: DeletionStage[]; stuck: boolean }
export interface PurgeCall { gameId: string; uids: string[]; requested: number; deleted: number }
export interface DeletionRun {
  result: DeletionResultLike;
  purged: PurgeCall[];
  logs: { event: string; gameId?: string }[];
}
export interface DeletionRequest { gameId: string; now?: number; faultAt?: { stage: DeletionStage; point: "work" | "commit" }; captureLog?: boolean }

export async function runDeletion(gameId: string, o: Omit<DeletionRequest, "gameId"> = {}): Promise<DeletionRun> {
  const res = await call({ op: "runDeletion", gameId, ...(o.now === undefined ? {} : { now: o.now }), ...(o.faultAt === undefined ? {} : { faults: { afterStage: o.faultAt } }), ...(o.captureLog === true ? { captureLog: true } : {}) });
  return res.data as DeletionRun;
}

export async function runDeletionError(gameId: string, o: Omit<DeletionRequest, "gameId"> = {}): Promise<{ code: string; kind: string | null; stage: string | null; point: string | null }> {
  try {
    await runDeletion(gameId, o);
  } catch (e) {
    const err = e as { code?: string; details?: { kind?: string; stage?: string; point?: string } };
    return { code: err.code ?? "unknown", kind: err.details?.kind ?? null, stage: err.details?.stage ?? null, point: err.details?.point ?? null };
  }
  throw new Error("expected the harness call to fail");
}

export interface WaitingPageRequest {
  now: number;
  limit?: number;
  after?: WaitingPage["next"];
}

/** listWaitingOn (#35): one page of the registry's `waitingOn` query. */
export async function listWaitingOn(req: WaitingPageRequest): Promise<WaitingPage> {
  const res = await call({ op: "listWaitingOn", ...req });
  return (res.data as { page: WaitingPage }).page;
}

/** The harness error a failed call carries: the HttpsError code and, for a StoreError, its kind. */
export function errorOf(e: unknown): { code: string; kind: string | null } {
  const err = e as { code?: string; details?: { kind?: string } };
  return { code: err.code ?? "unknown", kind: err.details?.kind ?? null };
}

export async function runError(req: RunRequest): Promise<{ code: string; kind: string | null }> {
  try {
    await run(req);
  } catch (e) {
    return errorOf(e);
  }
  throw new Error("expected the harness call to fail");
}

/** Empties the Firestore emulator (between files; every suite also uses fresh game ids). */
export async function clear(): Promise<void> {
  const host = process.env["FIRESTORE_EMULATOR_HOST"] ?? "127.0.0.1:8080";
  const res = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  if (!res.ok) throw new Error(`clear: ${res.status}`);
}
