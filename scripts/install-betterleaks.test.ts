import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { tmp } from "../functions/scripts/fixtures";

// S1 (issue #16): the pinned install. The happy path downloads from GitHub and is proven by the CI run and by hand
// (PR body); offline, these tests prove the two properties that matter: a download whose sha256 is not the pinned one
// installs nothing, and an already installed pinned binary is left alone.

const SCRIPT = join(import.meta.dir, "install-betterleaks.sh");
const run = (args: string[], env: Record<string, string>) =>
  Bun.spawnSync(["bash", SCRIPT, ...args], { env: { PATH: process.env["PATH"], HOME: process.env["HOME"], ...env }, stdin: "ignore" });

test("S1h a tarball whose sha256 is not the pinned one is rejected and nothing is installed", async () => {
  const dir = await tmp("install");
  const serve = join(dir, "serve");
  const dest = join(dir, "bin");
  await mkdir(serve, { recursive: true });
  const work = join(dir, "work");
  await mkdir(work, { recursive: true });
  await writeFile(join(work, "betterleaks"), "#!/bin/sh\necho 1.10.1\n", { mode: 0o755 });
  for (const asset of ["linux_x64", "linux_arm64", "darwin_arm64", "darwin_x64"]) {
    Bun.spawnSync(["tar", "-czf", join(serve, `betterleaks_1.10.1_${asset}.tar.gz`), "-C", work, "betterleaks"]);
  }
  const r = run([dest], { BETTERLEAKS_BASE_URL: `file://${serve}` });
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("sha256");
  expect(await Bun.file(join(dest, "betterleaks")).exists()).toBe(false);
});

test("S1i an installed binary that reports the pinned version is left alone and nothing is downloaded", async () => {
  const dir = await tmp("install");
  const dest = join(dir, "bin");
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, "betterleaks"), "#!/bin/sh\necho 1.10.1\n", { mode: 0o755 });
  const r = run([dest], { BETTERLEAKS_BASE_URL: `file://${join(dir, "nothing-here")}` });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("already installed");
});

test("S1j a missing destination argument is a usage error", () => {
  const r = run([], {});
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("usage");
});
