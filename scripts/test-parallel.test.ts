import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// Policy test for the parallel unit suite (LLD 0 section 5). `bun run test` runs its files in worker processes
// (`--parallel`, one per core) and reads `test-timings.json` so the slowest files start first: the run is as long as
// its longest file, so a slow file that starts last adds its whole length. `bun run test:timings` rewrites the file.

const ROOT = join(import.meta.dir, "..");
const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
const ROOTS = ["packages", "functions/src", "functions/scripts", "scripts", "lint-test"];
const TIMINGS = "test-timings.json";
const words = (s: string | undefined) => (s ?? "").trim().split(/\s+/);

/** The files `bun test` finds under the suite's roots: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, outside node_modules. */
const testFiles = (): string[] => {
  const out: string[] = [];
  for (const r of ROOTS) for (const f of new Bun.Glob("**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mjs,cjs}").scanSync({ cwd: join(ROOT, r) })) if (!f.split("/").includes("node_modules")) out.push(`${r}/${f}`);
  return out.sort();
};

describe("bun run test runs its files in parallel, slowest first", () => {
  test("the test script: bun test --parallel --timings=test-timings.json --timeout 120000 over the five roots", () => {
    const w = words(scripts.test);
    expect(w.slice(0, 2)).toEqual(["bun", "test"]);
    expect(w).toContain("--parallel");
    expect(w).toContain(`--timings=${TIMINGS}`);
    expect(w.join(" ")).toContain("--timeout 120000");
    expect(w.filter((x) => !x.startsWith("-") && x !== "120000").slice(2)).toEqual(ROOTS);
  });

  test("test:timings is the same run plus --update-timings", () => {
    expect(words(scripts["test:timings"])).toEqual([...words(scripts.test), "--update-timings"]);
  });

  test("test-timings.json is bun's format and lists every test file of the suite, and nothing else (else run bun run test:timings)", () => {
    expect(existsSync(join(ROOT, TIMINGS)), TIMINGS).toBe(true);
    const t = JSON.parse(readFileSync(join(ROOT, TIMINGS), "utf8")) as { version: unknown; files: Record<string, unknown> };
    expect(t.version).toBe(1);
    for (const [f, ms] of Object.entries(t.files)) expect([f, Number.isInteger(ms) && (ms as number) >= 0]).toEqual([f, true]);
    const files = testFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(Object.keys(t.files).sort()).toEqual(files);
  });
});
