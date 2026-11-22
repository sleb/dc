import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { tmp } from "../functions/scripts/fixtures";

// C9 (issue #16, LLD 0 P7): the bundle must load under Node with Bun off PATH. The script runs the real `node` with a
// minimal PATH, so a bundle that needs Bun (a Bun global, or spawning `bun`) fails, and so does a PATH where Bun is
// still reachable (the check would then prove nothing).

const SCRIPT = join(import.meta.dir, "check-bundle-no-bun.sh");

async function functionsDir(bundle: string): Promise<string> {
  const root = await tmp("nobun");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist/index.cjs"), bundle);
  return root;
}
const run = (root: string, env: Record<string, string> = {}) =>
  Bun.spawnSync(["bash", SCRIPT, root], { env: { PATH: process.env["PATH"], HOME: process.env["HOME"], ...env }, stdin: "ignore" });

test("C9a a bundle that loads under plain Node passes", async () => {
  const r = run(await functionsDir("exports.ping = () => 1;\n"));
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("ping");
});

test("C9b a bundle that touches the Bun global fails", async () => {
  const r = run(await functionsDir("exports.v = Bun.version;\n"));
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("does not load under Node");
});

test("C9c a bundle that shells out to bun fails because bun is not on PATH", async () => {
  const r = run(await functionsDir('exports.v = require("node:child_process").execSync("bun --version").toString();\n'));
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("does not load under Node");
});

test("C9d a PATH that still reaches bun is refused", async () => {
  const bin = await tmp("fakebun");
  await writeFile(join(bin, "bun"), "#!/bin/sh\necho 1\n", { mode: 0o755 });
  const r = run(await functionsDir("exports.ping = 1;\n"), { CLEAN_PATH: `${bin}:/usr/bin:/bin` });
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("bun is still on PATH");
});

test("C9e a missing bundle fails", async () => {
  const root = await tmp("nobun");
  const r = run(root);
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("dist/index.cjs");
});
