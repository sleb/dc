import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as logger from "firebase-functions/logger";
import { log } from "./log";

// LLD 0 section 9: the logger takes a typed field set; unknown keys are a type error and are dropped at runtime.
const written: Record<string, unknown>[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => void (spy = spyOn(logger, "write").mockImplementation((entry) => void written.push({ ...entry }))));
afterEach(() => (written.length = 0));
afterAll(() => spy.mockRestore());

test("T4 a typed line carries its fields", () => {
  log({ event: "api.done", callable: "ping", principalKind: "none", outcome: "ok", latencyMs: 3 });
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({ event: "api.done", callable: "ping", principalKind: "none", outcome: "ok", latencyMs: 3 });
  expect(spy).toHaveBeenCalled();
});

test("T4 unknown keys are a type error and are dropped at runtime", () => {
  // @ts-expect-error `displayName` is not a logger field (and must never be logged, P19)
  log({ event: "api.done", outcome: "ok", displayName: "NAME-SENTINEL" });
  expect(written).toHaveLength(1);
  expect(JSON.stringify(written[0])).not.toContain("NAME-SENTINEL");
  expect(written[0]).not.toHaveProperty("displayName");
});

test("T4 an unknown event is a type error", () => {
  // @ts-expect-error not in the event list
  log({ event: "made.up.event" });
});
