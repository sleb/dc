import { expect, test } from "bun:test";
import { EngineInvariantError } from "@dc/engine";
import { ViewDocSchema } from "@dc/contracts";
import { StoreError, mapStoreError } from "./errors";

// U7 (LLD 3 section 5.8).
const coded = (code: number) => Object.assign(new Error(`grpc ${code}`), { code });

test("U7 ABORTED (and the HTTP 409 form) after the attempts gives CONTENTION", () => {
  expect(mapStoreError(coded(10), 8).kind).toBe("CONTENTION");
  expect(mapStoreError(coded(409), 8).kind).toBe("CONTENTION");
});

test("U7 UNAVAILABLE and DEADLINE_EXCEEDED give UNAVAILABLE", () => {
  expect(mapStoreError(coded(14), 1).kind).toBe("UNAVAILABLE");
  expect(mapStoreError(coded(4), 1).kind).toBe("UNAVAILABLE");
});

test("U7 EngineInvariantError, ALREADY_EXISTS, a zod failure and anything unknown give INVARIANT", () => {
  expect(mapStoreError(new EngineInvariantError("x"), 1).kind).toBe("INVARIANT");
  expect(mapStoreError(coded(6), 1).kind).toBe("INVARIANT");
  const zerr = ViewDocSchema.safeParse({ schema: "no" });
  expect(mapStoreError(zerr.success ? null : zerr.error, 1).kind).toBe("INVARIANT");
  expect(mapStoreError(new Error("boom"), 1).kind).toBe("INVARIANT");
  expect(mapStoreError("thrown string", 1).kind).toBe("INVARIANT");
});

test("U7 a StoreError (the version assertion, size, budget) passes through unchanged", () => {
  for (const kind of ["INVARIANT", "AGGREGATE_TOO_LARGE", "TOO_MANY_WRITES"] as const) {
    const e = new StoreError(kind, "x");
    expect(mapStoreError(e, 1)).toBe(e);
  }
});

test("U7 a StoreError carries no numeric code, so the SDK never retries it as a transaction error", () => {
  const e = new StoreError("TOO_MANY_WRITES", "x") as unknown as { code?: unknown };
  expect(typeof e.code === "number").toBe(false);
});

test("U7 the mapped message names the kind and the cause's code, not the cause's message (no payload)", () => {
  const e = mapStoreError(Object.assign(new Error("CARD-SENTINEL-leak"), { code: 6 }), 1);
  expect(e.message).not.toContain("SENTINEL");
  expect(e.message).toContain("INVARIANT");
});
