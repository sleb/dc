import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { tmp } from "../functions/scripts/fixtures";

// V15: `provision-staging.sh apikey` restricts the public Firebase web API key to the services the client
// calls. The key is public by design (it ships in the bundle), so the restriction is defence in depth: it keeps the
// key from being usable against any other API enabled on the project. The key value is never printed.
const SERVICES = [
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "firestore.googleapis.com",
  "firebaseappcheck.googleapis.com",
  "firebaseinstallations.googleapis.com",
  "fcmregistrations.googleapis.com",
];
const KEY = "web-key-public-value";
const OTHER = "other-key-value";

interface Fixture {
  env: Record<string, string>;
  state: string;
  dir: string;
}

/** A copy of the script in a throwaway tree (so ROOT is private), a fake gcloud on PATH, and canned API-key calls. */
async function fixture(o: {
  envKey?: string | null;
  list?: Array<{ uid: string; displayName: string }>;
  strings?: string[];
  describe?: unknown;
}): Promise<Fixture> {
  const dir = await tmp("apikey");
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await copyFile(join(import.meta.dir, "fixtures/fake-gcloud.sh"), join(bin, "gcloud"));
  await chmod(join(bin, "gcloud"), 0o755);
  await mkdir(join(dir, "scripts"), { recursive: true });
  await copyFile(join(import.meta.dir, "provision-staging.sh"), join(dir, "scripts/provision-staging.sh"));
  await mkdir(join(dir, "apps/web"), { recursive: true });
  if (o.envKey !== null) {
    await writeFile(join(dir, "apps/web/.env.staging"), `VITE_FIREBASE_API_KEY=${o.envKey ?? KEY}\n`);
  }
  const state = join(dir, "state");
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "apikeys-list.json"), JSON.stringify(o.list ?? []));
  for (const [i, keyString] of (o.strings ?? []).entries()) {
    await writeFile(join(state, `apikeys-get-string.${i + 1}.json`), JSON.stringify({ keyString }));
  }
  if (o.describe !== undefined) await writeFile(join(state, "apikeys-describe.json"), JSON.stringify(o.describe));
  return { dir, state, env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, FAKE_GCLOUD_STATE: state } as Record<string, string> };
}

function run(f: Fixture): { code: number | null; out: string } {
  const child = Bun.spawnSync(["bash", join(f.dir, "scripts/provision-staging.sh"), "apikey"], { cwd: f.dir, env: f.env, stdin: "ignore" });
  return { code: child.exitCode, out: `${child.stdout.toString()}${child.stderr.toString()}` };
}

const lines = async (state: string, file: string): Promise<string[]> =>
  (await readFile(join(state, file), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);

const restricted = (services: string[]) => ({ restrictions: { apiTargets: services.map((service) => ({ service })) } });

test("V15 the step finds the key whose string matches the env file and restricts that key only", async () => {
  const f = await fixture({
    list: [
      { uid: "uid-other", displayName: "server key" },
      { uid: "uid-browser", displayName: "Browser key (auto created by Firebase)" },
    ],
    strings: [OTHER, KEY],
    describe: { restrictions: {} },
  });
  const r = run(f);
  expect(r.code).toBe(0);
  const updates = await lines(f.state, "apikeys-update.argv");
  expect(updates).toHaveLength(1);
  expect(updates[0]).toContain("services api-keys update uid-browser");
  expect(updates[0]).not.toContain("uid-other");
  for (const service of SERVICES) expect(updates[0]).toContain(`--api-target=service=${service}`);
  expect(r.out).not.toContain(KEY);
  expect(r.out).not.toContain(OTHER);
});

test("V15 a key already restricted to exactly the client services is a no-op", async () => {
  const f = await fixture({
    list: [{ uid: "uid-browser", displayName: "Browser key" }],
    strings: [KEY],
    describe: restricted([...SERVICES].reverse()),
  });
  const r = run(f);
  expect(r.code).toBe(0);
  expect(r.out).toContain("already restricted");
  expect(await lines(f.state, "apikeys-update.argv")).toHaveLength(0);
});

test("V15 the usage guard is skipped only when APIKEY_SKIP_USAGE_CHECK=1", async () => {
  const guarded = await fixture({
    list: [{ uid: "uid-browser", displayName: "Browser key" }],
    strings: [KEY],
    describe: { restrictions: {} },
  });
  expect(run(guarded).code).toBe(0);
  expect((await lines(guarded.state, "apikeys-update.argv"))[0]).not.toContain("--no-check-existing-usage");

  const skipped = await fixture({
    list: [{ uid: "uid-browser", displayName: "Browser key" }],
    strings: [KEY],
    describe: { restrictions: {} },
  });
  skipped.env["APIKEY_SKIP_USAGE_CHECK"] = "1";
  expect(run(skipped).code).toBe(0);
  expect((await lines(skipped.state, "apikeys-update.argv"))[0]).toContain("--no-check-existing-usage");
});

test("V15 a key restricted to a different set is updated", async () => {
  const f = await fixture({
    list: [{ uid: "uid-browser", displayName: "Browser key" }],
    strings: [KEY],
    describe: restricted(["identitytoolkit.googleapis.com"]),
  });
  const r = run(f);
  expect(r.code).toBe(0);
  expect(await lines(f.state, "apikeys-update.argv")).toHaveLength(1);
});

test("V15 no key matches the env value: fail, name the file, print no key", async () => {
  const f = await fixture({
    list: [{ uid: "uid-a", displayName: "a" }],
    strings: [OTHER],
    describe: { restrictions: {} },
  });
  const r = run(f);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("apps/web/.env.staging");
  expect(r.out).not.toContain(KEY);
  expect(r.out).not.toContain(OTHER);
});

test("V15 a missing env file points at the config step", async () => {
  const f = await fixture({ envKey: null, list: [], strings: [] });
  const r = run(f);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("config step");
  expect(await lines(f.state, "apikeys-update.argv")).toHaveLength(0);
});
