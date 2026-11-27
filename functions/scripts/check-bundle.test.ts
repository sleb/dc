import { describe, expect, test } from "bun:test";
import { checkBundle } from "./check-bundle";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeRoot, tmp } from "./fixtures";

/** A root whose dist holds the given bundle, with the given exports.json names (and exports.emulator.json names, and extra files, when given). */
async function withBundle(bundle: string, names: string[] = [], emulatorNames?: string[], extra: Record<string, string> = {}): Promise<string> {
  return makeRoot({
    "dist/index.cjs": bundle,
    "dist/package.json": JSON.stringify({ dependencies: { "firebase-admin": "1.2.3", "firebase-functions": "4.5.6" } }),
    "exports.json": JSON.stringify(names),
    ...(emulatorNames === undefined ? {} : { "exports.emulator.json": JSON.stringify(emulatorNames) }),
    ...extra,
  });
}

/** A bundle whose `storeHarness` is a function only under the Functions emulator, the way src/harness/store.ts gates it. */
const GATED = 'exports.ping = () => 1;\nexports.storeHarness = process.env.FUNCTIONS_EMULATOR === "true" ? () => 2 : undefined;\n';

const GOOD = 'const fs = require("node:fs");\nconst os = require("os");\nexports.ping = () => [fs, os];\n';

describe("check-bundle", () => {
  test("C5 passes on a good bundle", async () => {
    expect(await checkBundle(await withBundle(GOOD, ["ping"]))).toEqual([]);
  });

  test("C1 fails on a bun: string", async () => {
    const problems = await checkBundle(await withBundle(`${GOOD}// import "bun:test"\n`, ["ping"]));
    expect(problems.join("\n")).toContain("bun:");
  });

  test("C1 fails on Bun. use", async () => {
    const problems = await checkBundle(await withBundle(`${GOOD}exports.x = Bun.version;\n`, ["ping", "x"]));
    expect(problems.join("\n")).toContain("Bun.");
  });

  test("C1 fails on an @dc/ specifier", async () => {
    const problems = await checkBundle(await withBundle(`${GOOD}// "@dc/contracts"\n`, ["ping"]));
    expect(problems.join("\n")).toContain("@dc/");
  });

  test("C2 fails on a require target that is neither a builtin nor a dist dependency", async () => {
    const problems = await checkBundle(await withBundle(`${GOOD}try { require("left-pad"); } catch {}\n`, ["ping"]));
    expect(problems.join("\n")).toContain("left-pad");
  });

  test("C2 accepts a dist dependency and its subpaths, and rejects a prefix lookalike", async () => {
    const ok = 'try { require("firebase-admin/app"); require("firebase-functions"); } catch {}\nexports.ping = 1;\n';
    expect(await checkBundle(await withBundle(ok, ["ping"]))).toEqual([]);
    const bad = 'try { require("firebase-admin-evil"); } catch {}\nexports.ping = 1;\n';
    expect((await checkBundle(await withBundle(bad, ["ping"]))).join("\n")).toContain("firebase-admin-evil");
  });

  test("C3 fails when the bundle does not load under Node", async () => {
    const problems = await checkBundle(await withBundle('throw new Error("boom-at-load");\n', []));
    expect(problems.join("\n")).toContain("boom-at-load");
  });

  test("C4 fails when the bundle exports a name missing from exports.json", async () => {
    const problems = await checkBundle(await withBundle("exports.ping = 1; exports.extra = 2;\n", ["ping"]));
    expect(problems.join("\n")).toMatch(/extra.*not in exports\.json/);
  });

  test("C4 fails when exports.json lists a name the bundle does not export", async () => {
    const problems = await checkBundle(await withBundle("exports.ping = 1;\n", ["ping", "missing"]));
    expect(problems.join("\n")).toMatch(/missing.*not exported/);
  });

  test("C4 an empty bundle matches an empty exports.json", async () => {
    expect(await checkBundle(await withBundle("module.exports = {};\n", []))).toEqual([]);
  });

  test("C2 also scans dynamic import() and __require() targets", async () => {
    const dyn = await checkBundle(await withBundle(`${GOOD}async function f() { return import("left-pad"); }\n`, ["ping"]));
    expect(dyn.join("\n")).toContain("left-pad");
    const req = await checkBundle(await withBundle(`${GOOD}try { __require("other-lib"); } catch {}\n`, ["ping"]));
    expect(req.join("\n")).toContain("other-lib");
    const okDyn = 'async function f() { return import("firebase-admin/app"); }\nexports.ping = f;\n';
    expect(await checkBundle(await withBundle(okDyn, ["ping"]))).toEqual([]);
  });

  test("C3 the load check gets a minimal environment", async () => {
    process.env["DC_LEAK_PROBE"] = "1";
    try {
      const bundle = 'if (process.env.DC_LEAK_PROBE) throw new Error("env-leaked");\nexports.ping = 1;\n';
      expect(await checkBundle(await withBundle(bundle, ["ping"]))).toEqual([]);
    } finally {
      delete process.env["DC_LEAK_PROBE"];
    }
  });

  test("C3 a missing node binary is a problem, not a crash", async () => {
    const problems = await checkBundle(await withBundle(GOOD, ["ping"]), { node: "/nonexistent/node-binary" });
    expect(problems.join("\n")).toMatch(/could not run node/);
  });

  test("C3 requires Node major 22", async () => {
    const dir = await tmp("fakenode");
    await writeFile(join(dir, "node"), `#!/bin/sh\necho '{"node":"20.1.0","exports":["ping"]}'\n`);
    await chmod(join(dir, "node"), 0o755);
    const problems = await checkBundle(await withBundle(GOOD, ["ping"]), { node: join(dir, "node") });
    expect(problems.join("\n")).toMatch(/Node 22.*20\.1\.0/);
  });

  // H1 (#33, LLD 0 P7 and P9 as amended): the bundle is loaded twice, under the default environment and with FUNCTIONS_EMULATOR=true. The deployed export
  // list is exports.json alone; exports.emulator.json names the emulator-only functions, which must be absent (undefined) outside the emulator.
  test("H1 an emulator-only export passes: absent by default, present under FUNCTIONS_EMULATOR=true", async () => {
    expect(await checkBundle(await withBundle(GATED, ["ping"], ["storeHarness"]))).toEqual([]);
  });

  test("H1 an emulator-only name exported outside the emulator fails (it would deploy)", async () => {
    const always = "exports.ping = () => 1;\nexports.storeHarness = () => 2;\n";
    const problems = await checkBundle(await withBundle(always, ["ping"], ["storeHarness"]));
    expect(problems.join("\n")).toMatch(/storeHarness.*outside the emulator/);
  });

  test("H1 an emulator-only name the emulator bundle does not export fails", async () => {
    const problems = await checkBundle(await withBundle("exports.ping = () => 1;\n", ["ping"], ["storeHarness"]));
    expect(problems.join("\n")).toMatch(/exports\.emulator\.json lists "storeHarness".*not exported under the emulator/);
  });

  test("H1 an export that appears only under the emulator and is in neither list fails", async () => {
    const problems = await checkBundle(await withBundle(GATED, ["ping"], []));
    expect(problems.join("\n")).toMatch(/storeHarness.*under the emulator.*not in exports\.json or exports\.emulator\.json/);
  });

  test("H1 a name in both lists fails", async () => {
    const problems = await checkBundle(await withBundle(GATED, ["ping", "storeHarness"], ["storeHarness"]));
    expect(problems.join("\n")).toMatch(/storeHarness.*both exports\.json and exports\.emulator\.json/);
  });

  test("H1 a functions .env file that sets FUNCTIONS_EMULATOR fails (deploy discovery would see the gate open)", async () => {
    for (const file of [".env", ".env.deepcuts-staging", ".env.local", "dist/.env"]) {
      const problems = await checkBundle(await withBundle(GATED, ["ping"], ["storeHarness"], { [file]: "A=1\nFUNCTIONS_EMULATOR=true\n" }));
      expect(problems.join("\n")).toContain(`${file} sets FUNCTIONS_EMULATOR`);
    }
  });

  test("H1 the real lists: exports.emulator.json is exactly storeHarness, disjoint from exports.json", async () => {
    const root = join(import.meta.dir, "..");
    const emulator = JSON.parse(await Bun.file(join(root, "exports.emulator.json")).text()) as string[];
    const deployed = JSON.parse(await Bun.file(join(root, "exports.json")).text()) as string[];
    expect(emulator).toEqual(["storeHarness"]);
    expect(deployed.filter((n) => emulator.includes(n))).toEqual([]);
  });
});
