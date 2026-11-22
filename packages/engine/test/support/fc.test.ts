import { expect, test } from "bun:test";
import fc from "fast-check";
import { fcParams, assertProperty } from "./fc";

// P11: FC_SEED comes from the environment and is printed on failure, so a CI failure reproduces locally.
test("T6a FC_SEED is applied and numRuns defaults to 200", () => {
  const p = fcParams({ FC_SEED: "12345" });
  expect(p.seed).toBe(12345);
  expect(p.numRuns).toBe(200);
  expect(fcParams({ FC_SEED: "1", FC_NUM_RUNS: "2000" }).numRuns).toBe(2000);
});

test("T6b without FC_SEED a fresh integer seed is chosen", () => {
  expect(Number.isInteger(fcParams({}).seed)).toBe(true);
});

test("T6c a failing property reports the seed and the same seed reproduces the counterexample", () => {
  const failing = fc.property(fc.integer({ min: 0, max: 1000 }), (n) => n < 500);
  const run = () => {
    try {
      assertProperty(failing, { FC_SEED: "424242" });
      return "no failure";
    } catch (e) {
      return (e as Error).message;
    }
  };
  const first = run();
  expect(first).toContain("FC_SEED=424242");
  expect(run()).toBe(first);
});

test("T6d a passing property does not throw", () => {
  assertProperty(fc.property(fc.integer(), (n) => n === n), { FC_SEED: "1" });
});

test("T6e a non-integer FC_SEED is rejected loudly", () => {
  expect(() => fcParams({ FC_SEED: "abc" })).toThrow("FC_SEED");
});
