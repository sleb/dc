// T1 and T2: the compiler enforces package isolation (LLD 0 section 5 table), and bun types
// exist only under tsconfig.test.json. Each case typechecks a snippet under a throwaway tsconfig
// that extends the real package config.
import { describe, expect, test } from "bun:test";
import { showConfig, tsc } from "./harness";

const NO_NAME = /TS2304|TS2580|TS2584|TS2591/; // cannot find name (variants for process, document, node types)
const CONFIG_MISSING = /TS5083|TS6053/;

async function fails(pkg: string, body: string) {
  const r = await tsc(pkg, `export {};\n${body}\n`);
  expect(r.out).not.toMatch(CONFIG_MISSING); // red must come from the missing policy, not from a missing config
  expect({ code: r.code, out: r.out }).toEqual({ code: 2, out: expect.stringMatching(NO_NAME) });
}
async function passes(pkg: string, body: string) {
  const r = await tsc(pkg, `export {};\n${body}\n`);
  expect(r).toEqual({ code: 0, out: "" });
}

describe("T1 compiler isolation", () => {
  for (const pkg of ["packages/engine", "packages/contracts"]) {
    describe(pkg, () => {
      test("process fails", () => fails(pkg, "export const v = process.env;"));
      test("setTimeout fails", () => fails(pkg, "setTimeout(() => {}, 1);"));
      test("fetch fails", () => fails(pkg, `void fetch("x");`));
      test("Buffer fails", () => fails(pkg, "export const v = Buffer.from('x');"));
      test("document fails", () => fails(pkg, "export const v = document.title;"));
      test("ES2023 only: pure code passes", () => passes(pkg, "export const v = [3, 1, 2].toSorted();"));
    });
  }
  describe("functions", () => {
    test("process passes", () => passes("functions", "export const v = process.env;"));
    test("setTimeout passes", () => passes("functions", "setTimeout(() => {}, 1);"));
    test("fetch passes", () => passes("functions", `void fetch("x");`));
    test("document fails (no DOM)", () => fails("functions", "export const v = document.title;"));
  });
  describe("apps/web", () => {
    test("document passes", () => passes("apps/web", "export const v = document.title;"));
    test("process fails (no Node)", () => fails("apps/web", "export const v = process.env;"));
    test("jsx is react-jsx", async () => {
      const cfg = await showConfig("apps/web");
      expect(cfg).not.toHaveProperty("error");
      expect((cfg as { compilerOptions: { jsx?: string } }).compilerOptions.jsx).toBe("react-jsx");
    });
  });
});

describe("T2 bun types only in test configs", () => {
  const BUN_TEST = `import { test } from "bun:test";\ntest("t", () => {});\n`;
  for (const pkg of ["packages/engine", "packages/contracts", "functions", "apps/web"]) {
    describe(pkg, () => {
      test("bun:test fails in a shipped file", async () => {
        const r = await tsc(pkg, BUN_TEST);
        expect(r.out).not.toMatch(CONFIG_MISSING);
        expect({ code: r.code, out: r.out }).toEqual({ code: 2, out: expect.stringContaining("TS2307") });
      });
      test("bun:test passes under tsconfig.test.json", async () => {
        expect(await tsc(pkg, BUN_TEST, { test: true })).toEqual({ code: 0, out: "" });
      });
      test("the main config excludes test files", async () => {
        const cfg = await showConfig(pkg);
        expect(cfg).not.toHaveProperty("error");
        expect((cfg as { exclude?: string[] }).exclude ?? []).toContain("**/*.test.ts");
      });
      test("the main config does not load bun types", async () => {
        const cfg = await showConfig(pkg);
        expect(cfg).not.toHaveProperty("error");
        expect(((cfg as { compilerOptions: { types?: string[] } }).compilerOptions.types ?? [])).not.toContain("bun");
      });
    });
  }
});
