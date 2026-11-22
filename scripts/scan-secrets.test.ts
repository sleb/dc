import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { tmp } from "../functions/scripts/fixtures";
import { BETTERLEAKS_VERSION, scanSecrets } from "./scan-secrets";

// S1 (issue #16, LLD 0 P13): the secret scan wrapper. These tests drive the real pinned betterleaks over a throwaway
// git repository that carries the repository's own .betterleaks.toml, so the allowlist and the "source tree only" rule
// are proven against the real binary. Fake credentials are assembled at run time so this file is not itself a finding.

const REPO = join(import.meta.dir, "..");
const rand = (alphabet: string, n: number) => Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3 * (i % 5) + 11) % alphabet.length]).join("");
const ALNUM = "aZ3kQ9mXb7TpL2vWc8NdR5yH1sFgJ4eU6oIA0";
const fakeGithubToken = () => ["gh", "p_", rand(ALNUM, 36)].join("");
const fakeGoogleKey = () => ["AI", "za", "SyD", rand(ALNUM, 32)].join("");

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await tmp("scan");
  await copyFile(join(REPO, ".betterleaks.toml"), join(dir, ".betterleaks.toml"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  return dir;
}

test("S1a the wrapper pins betterleaks 1.10.1", () => {
  expect(BETTERLEAKS_VERSION).toBe("1.10.1");
});

test("S1b a clean tree passes", async () => {
  const dir = await repo({ "src/a.ts": "export const a = 1;\n" });
  const r = await scanSecrets({ root: dir });
  expect(r.code).toBe(0);
});

test("S1c a planted fake key fails the scan and its value is never printed", async () => {
  const key = fakeGithubToken();
  const dir = await repo({ "src/a.ts": `export const token = "${key}";\n` });
  const r = await scanSecrets({ root: dir });
  expect(r.code).toBe(1);
  expect(r.output).not.toContain(key);
  expect(r.output).toContain("src/a.ts");
});

test("S1d the public web config is allowed at apps/web/.env.staging and nowhere else", async () => {
  const body = `VITE_FIREBASE_API_KEY=${fakeGoogleKey()}\n`;
  const ok = await repo({ "apps/web/.env.staging": body });
  expect((await scanSecrets({ root: ok })).code).toBe(0);
  const bad = await repo({ "apps/web/.env.other": body });
  expect((await scanSecrets({ root: bad })).code).toBe(1);
});

test("S1e only the source tree is scanned: a gitignored build output with a key does not count, an untracked source file does", async () => {
  const key = fakeGithubToken();
  const ignored = await repo({ ".gitignore": "dist/\n", "dist/bundle.js": `x="${key}"\n` });
  expect((await scanSecrets({ root: ignored })).code).toBe(0);
  const untracked = await repo({ "notes/x.txt": `x="${key}"\n` });
  expect((await scanSecrets({ root: untracked })).code).toBe(1);
});

test("S1f a binary that is not the pinned version is refused, not trusted", async () => {
  const dir = await repo({ "src/a.ts": "export const a = 1;\n" });
  const fake = join(dir, "fake-betterleaks");
  await writeFile(fake, "#!/bin/sh\necho 9.9.9\n", { mode: 0o755 });
  const r = await scanSecrets({ root: dir, binary: fake });
  expect(r.code).toBe(2);
  expect(r.output).toContain("1.10.1");
});

test("S1g a missing binary is a usage error that says how to install it", async () => {
  const dir = await repo({ "src/a.ts": "export const a = 1;\n" });
  const r = await scanSecrets({ root: dir, binary: join(dir, "no-such-binary") });
  expect(r.code).toBe(2);
  expect(r.output).toContain("install-betterleaks.sh");
});
