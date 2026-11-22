// L8 (type-aware rules, warnings fail), T3 (engine dependencies), G2 (workspace resolution).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { disallowedDeps } from "./engine-deps";
import { lintTyped, ROOT, ruleIds } from "./harness";

const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
// A file that exists and is in the engine tsconfig; lintText supplies the code, so nothing is written.
const TYPED = "packages/engine/src/index.ts";

describe("L8 type-aware rules (section 5)", () => {
  test("no-floating-promises fires", async () => {
    expect(ruleIds(await lintTyped(TYPED, "Promise.resolve(1);\nexport {};\n"))).toContain("@typescript-eslint/no-floating-promises");
  });
  test("no-misused-promises fires", async () => {
    expect(ruleIds(await lintTyped(TYPED, "[1].forEach(async () => {});\nexport {};\n"))).toContain("@typescript-eslint/no-misused-promises");
  });
  test("consistent-type-imports fires", async () => {
    const code = `import { Foo } from "@dc/contracts";\nexport const v: Foo | undefined = undefined;\n`;
    expect(ruleIds(await lintTyped(TYPED, code))).toContain("@typescript-eslint/consistent-type-imports");
  });
  test("a floating promise that is awaited is not reported", async () => {
    expect(ruleIds(await lintTyped(TYPED, "await Promise.resolve(1);\nexport {};\n"))).not.toContain("@typescript-eslint/no-floating-promises");
  });
  test("an unused disable directive is a warning", async () => {
    const ms = await lintTyped(TYPED, "// eslint-disable-next-line no-console\nexport {};\n");
    expect(ms.map((m) => m.severity)).toContain(1);
  });
  test("root lint script fails on warnings", () => {
    expect(readJson("package.json").scripts?.lint ?? "").toContain("--max-warnings 0");
  });
});

describe("T3 engine dependencies (P5)", () => {
  test("the real packages/engine/package.json depends only on the allowlist", () => {
    expect(disallowedDeps(readJson("packages/engine/package.json"))).toEqual([]);
  });
  test("the check rejects an extra dependency", () => {
    expect(disallowedDeps({ dependencies: { "@dc/contracts": "workspace:*", zod: "1.0.0", lodash: "4.0.0" } })).toEqual(["lodash"]);
  });
  test("the check allows no dependencies", () => {
    expect(disallowedDeps({})).toEqual([]);
  });
});

describe("G2 workspace resolution (P8)", () => {
  test("@dc/contracts resolves from packages/engine", () => {
    expect(Bun.resolveSync("@dc/contracts", join(ROOT, "packages/engine"))).toContain("packages/contracts");
  });
  test("the engine package declares @dc/contracts as a workspace dependency", () => {
    expect(readJson("packages/engine/package.json").dependencies?.["@dc/contracts"]).toBe("workspace:*");
  });
});
