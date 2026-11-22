import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import exportsList from "../../exports.json";
import { defineCallable, REGISTRY, RT } from "./callable";
// Importing the entry registers ping and diag.
import "../index";

// exports.json entries that are triggers, not callables (LLD 0 section 4); none exist yet.
const NON_CALLABLE = new Set(["beforeEmailSent", "identityOutbox", "deletionRunner", "notifyOutbox", "reminderSweep", "housekeeping"]);
const callables = (exportsList as string[]).filter((n) => !NON_CALLABLE.has(n));

test("T1 REGISTRY keys equal the callable subset of exports.json (API1)", () => {
  const real = [...REGISTRY.keys()].filter((k) => !k.startsWith("test-"));
  expect(real.sort()).toEqual([...callables].sort());
  expect(real.sort()).toEqual(["diag", "ping"]);
});

test("T1 every spec declares allow explicitly (API1)", () => {
  for (const name of callables) {
    const entry = REGISTRY.get(name);
    expect(Array.isArray(entry?.allow)).toBe(true);
    expect(entry?.allow.length).toBeGreaterThan(0);
  }
});

test("T2 registry options: region, service account, App Check, command runtime shape", () => {
  for (const name of callables) {
    const o = REGISTRY.get(name)?.options;
    expect(o).toMatchObject({
      region: "us-central1",
      serviceAccount: "fn-runtime@",
      enforceAppCheck: true,
      consumeAppCheckToken: false,
      cpu: 1,
      memory: "256MiB",
      concurrency: 80,
    });
    expect((o?.minInstances as { name?: string } | undefined)?.name).toBe("COMMAND_MIN_INSTANCES");
  }
  expect(RT.command.memory).toBe("256MiB");
});

test("T2 the built function's __endpoint carries the same options", async () => {
  const mod = (await import("../index")) as unknown as Record<string, { __endpoint: Record<string, unknown> }>;
  for (const name of callables) {
    const ep = mod[name]?.__endpoint;
    expect(ep).toBeDefined();
    expect(ep).toMatchObject({ region: ["us-central1"], serviceAccountEmail: "fn-runtime@", availableMemoryMb: 256, cpu: 1, concurrency: 80 });
    expect((ep?.minInstances as { name?: string } | undefined)?.name).toBe("COMMAND_MIN_INSTANCES");
    expect(ep).toHaveProperty("callableTrigger");
  }
});

// --- wrapper behaviour, through the function's `run` (the wrapped handler, without the HTTP layer) ---

type Req = { auth?: { uid: string; token: object }; data: unknown; rawRequest: object };
const call = (fn: unknown, req: Partial<Req> = {}) => (fn as { run: (r: Req) => Promise<unknown> }).run({ data: {}, rawRequest: {}, ...req });
const lines: Record<string, unknown>[] = [];
beforeEach(() => void spyOn(logger, "write").mockImplementation((e) => void lines.push({ ...e })));
afterEach(() => {
  lines.length = 0;
  for (const k of [...REGISTRY.keys()]) if (k.startsWith("test-")) REGISTRY.delete(k);
});
afterAll(() => void spyOn(logger, "write").mockRestore());
const done = () => lines.filter((l) => l.event === "api.done");

test("T3 no auth and no guest in allow gives unauthenticated", async () => {
  const fn = defineCallable({ name: "test-needs-auth", allow: ["seat"], runtime: RT.command, handler: async () => ({ ok: true as const }) });
  const err = await call(fn).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(HttpsError);
  expect((err as HttpsError).code).toBe("unauthenticated");
});

test("T3 guest in allow runs the handler without auth", async () => {
  const fn = defineCallable({ name: "test-guest", allow: ["guest"], runtime: RT.command, handler: async () => ({ ok: true as const }) });
  expect(await call(fn)).toEqual({ ok: true });
  expect(done()).toHaveLength(1);
  expect(done()[0]).toMatchObject({ callable: "test-guest", outcome: "ok" });
});

test("T3 a non-HttpsError throw reaches the client as internal with no message or input, and logs one api.done error", async () => {
  const fn = defineCallable({
    name: "test-throws",
    allow: ["guest"],
    runtime: RT.command,
    handler: async () => {
      throw new Error("SECRET-MESSAGE");
    },
  });
  const err = (await call(fn, { data: { card: "CARD-SENTINEL" } }).then(() => null, (e: unknown) => e)) as HttpsError;
  expect(err).toBeInstanceOf(HttpsError);
  expect(err.code).toBe("internal");
  expect(JSON.stringify([err.message, err.details])).not.toContain("SECRET-MESSAGE");
  expect(JSON.stringify([err.message, err.details])).not.toContain("CARD-SENTINEL");
  expect(done()).toHaveLength(1);
  expect(done()[0]).toMatchObject({ callable: "test-throws", outcome: "error" });
  // The cause is logged for Error Reporting (message and stack), the request data is not.
  const errLines = lines.filter((l) => l.event === "api.error");
  expect(errLines).toHaveLength(1);
  expect(String(errLines[0]?.message)).toContain("SECRET-MESSAGE");
  expect(JSON.stringify(lines)).not.toContain("CARD-SENTINEL");
});

test("T3 client faults are logged as rejected, not error", async () => {
  const fn = defineCallable({ name: "test-rejected", allow: ["seat"], runtime: RT.command, handler: async () => ({ ok: true as const }) });
  await call(fn).catch(() => null);
  expect(done()[0]).toMatchObject({ outcome: "rejected", reason: "unauthenticated", severity: "WARNING" });
  expect(done()[0]).not.toHaveProperty("principalKind");
});

test("T1 a duplicate callable name is refused", () => {
  defineCallable({ name: "test-dup", allow: ["guest"], runtime: RT.command, handler: async () => ({ ok: true as const }) });
  expect(() => defineCallable({ name: "test-dup", allow: ["guest"], runtime: RT.command, handler: async () => ({ ok: true as const }) })).toThrow(/duplicate/);
});

test("T3 a logger failure after a successful handler does not fail the call", async () => {
  const fn = defineCallable({ name: "test-logfail", allow: ["guest"], runtime: RT.command, handler: async () => ({ ok: true as const }) });
  spyOn(logger, "write").mockImplementation(() => {
    throw new Error("log down");
  });
  expect(await call(fn)).toEqual({ ok: true });
});

test("T3 an HttpsError thrown by a handler keeps its code", async () => {
  const fn = defineCallable({
    name: "test-https-error",
    allow: ["guest"],
    runtime: RT.command,
    handler: async () => {
      throw new HttpsError("not-found", "x");
    },
  });
  const err = (await call(fn).then(() => null, (e: unknown) => e)) as HttpsError;
  expect(err.code).toBe("not-found");
  expect(done()[0]).toMatchObject({ outcome: "rejected", reason: "not-found" });
});
