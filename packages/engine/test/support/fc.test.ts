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

test("T6f FC_NUM_RUNS must be a positive integer", () => {
  for (const bad of ["2k", "-5", "0", "1.5"]) expect(() => fcParams({ FC_SEED: "1", FC_NUM_RUNS: bad })).toThrow("FC_NUM_RUNS");
});

test("T6g FC_SEED is trimmed, and a blank one means a fresh seed, not 0", () => {
  expect(fcParams({ FC_SEED: " 7 " }).seed).toBe(7);
  expect(Number.isInteger(fcParams({ FC_SEED: "  " }).seed)).toBe(true);
});

test("T6h FC_SEED must fit in 32 bits so the printed seed replays", () => {
  expect(fcParams({ FC_SEED: "2147483647" }).seed).toBe(2147483647);
  expect(() => fcParams({ FC_SEED: "2147483648" })).toThrow("FC_SEED");
  expect(() => fcParams({ FC_SEED: "-2147483649" })).toThrow("FC_SEED");
});
