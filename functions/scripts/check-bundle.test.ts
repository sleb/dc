import { describe, expect, test } from "bun:test";
import { checkBundle } from "./check-bundle";
import { makeRoot } from "./fixtures";

/** A root whose dist holds the given bundle, with the given exports.json names. */
async function withBundle(bundle: string, names: string[] = []): Promise<string> {
  return makeRoot({
    "dist/index.cjs": bundle,
    "dist/package.json": JSON.stringify({ dependencies: { "firebase-admin": "1.2.3", "firebase-functions": "4.5.6" } }),
    "exports.json": JSON.stringify(names),
  });
}

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
});
