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

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({ app_id: "demo-app", sub: "demo-app", iss: "demo", aud: ["demo"], exp: 4_102_444_800 })}.x`;
const client = initializeApp({ projectId: "demo-deepcuts", apiKey: "demo", appId: "demo-app" }, "store-harness");
initializeAppCheck(client, { provider: new CustomProvider({ getToken: async () => ({ token: fakeToken, expireTimeMillis: 4_102_444_800_000 }) }) });
const fns = getFunctions(client, "us-central1");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
const call = httpsCallable<unknown, unknown>(fns, "storeHarness", { timeout: 120_000 });

const adminApp: App = getApps().find((a) => a.name === "store-tests") ?? adminInit({ projectId: "demo-deepcuts" }, "store-tests");
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
  const res = await fetch(`http://${host}/emulator/v1/projects/demo-deepcuts/databases/(default)/documents`, { method: "DELETE" });
  if (!res.ok) throw new Error(`clear: ${res.status}`);
}
