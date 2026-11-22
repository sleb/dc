import { expect, test } from "bun:test";

// T3: the happy-dom preload belongs to `test:web` only. If it ever reaches the root `test` process, the engine sees a DOM.
test("T3 no DOM globals exist in the engine and functions test process", () => {
  expect(typeof document).toBe("undefined");
  expect(typeof window).toBe("undefined");
});
