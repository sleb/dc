import { expect, test } from "bun:test";

// Placeholder so the test tsconfig has an input and `bun test` finds the package.
test("the package entry point loads", async () => {
  expect(await import("./index")).toBeDefined();
});
