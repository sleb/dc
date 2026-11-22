import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { tmp } from "../functions/scripts/fixtures";

// OB11 (issue #17): `provision-staging.sh channel` creates the `dc-owner` email notification channel that every alert
// policy in ops/alerts/ refers to, creates it once, is a no-op on the second run, refuses with a usage message when
// there is no channel and no ALERT_EMAIL, and never prints the address. The address is supplied at run time
// (AGENTS: no personal email in the repo), so this test uses a placeholder address and asserts it never reaches
// stdout or stderr.
const ROOT = join(import.meta.dir, "..");
const PROJECT = "deepcuts-staging";
const ADDRESS = "alert@example.test";

/** A fake gcloud (for the access token) and a fake curl (for the Monitoring REST calls) on PATH. */
async function fixture(channels?: unknown): Promise<{ env: Record<string, string>; state: string }> {
  const base = await tmp("channel");
  const bin = join(base, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of ["gcloud", "curl"]) {
    await copyFile(join(import.meta.dir, `fixtures/fake-${name}.sh`), join(bin, name));
    await chmod(join(bin, name), 0o755);
  }
  const state = join(base, "state");
  await mkdir(state, { recursive: true });
  if (channels !== undefined) await writeFile(join(state, "channels.json"), JSON.stringify(channels));
  return { env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, FAKE_GCLOUD_STATE: state, FAKE_CURL_STATE: state } as Record<string, string>, state };
}

const run = (env: Record<string, string>, args = ["channel"]) => {
  const child = Bun.spawnSync(["bash", "scripts/provision-staging.sh", ...args], { cwd: ROOT, env, stdin: "ignore" });
  return { code: child.exitCode, out: `${child.stdout.toString()}${child.stderr.toString()}` };
};
const calls = async (state: string): Promise<string[]> => (await readFile(join(state, "calls"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);

test("OB11 the channel step creates dc-owner once from ALERT_EMAIL and never prints the address", async () => {
  const fresh = await fixture();
  const first = run({ ...fresh.env, ALERT_EMAIL: ADDRESS });
  expect(first.code).toBe(0);
  const made = JSON.parse(await readFile(join(fresh.state, "created.json"), "utf8")) as Record<string, unknown>;
  expect(made["type"]).toBe("email");
  expect(made["displayName"]).toBe("dc-owner");
  expect((made["labels"] as Record<string, string>)["email_address"]).toBe(ADDRESS);
  const createdCalls = await calls(fresh.state);
  expect(createdCalls.filter((c) => c.startsWith("POST"))).toEqual([`POST https://monitoring.googleapis.com/v3/projects/${PROJECT}/notificationChannels`]);
  expect(createdCalls.some((c) => c.startsWith("GET"))).toBe(true);
  // The address went over the wire, never into the transcript.
  expect(first.out).not.toContain(ADDRESS);
  expect(first.out).not.toContain("example.test");
});

test("OB11 a second run is a no-op and needs no ALERT_EMAIL", async () => {
  const existing = await fixture({ notificationChannels: [{ name: `projects/${PROJECT}/notificationChannels/1`, displayName: "dc-owner", type: "email" }] });
  const again = run(existing.env);
  expect(again.code).toBe(0);
  expect(again.out).toContain("dc-owner");
  expect(await calls(existing.state)).toEqual([`GET https://monitoring.googleapis.com/v3/projects/${PROJECT}/notificationChannels`]);
});

test("OB11 an absent channel with no ALERT_EMAIL fails with a usage message and creates nothing", async () => {
  const env = { ...(await fixture()).env };
  delete env["ALERT_EMAIL"];
  const missing = run(env);
  expect(missing.code).not.toBe(0);
  expect(missing.out).toContain("ALERT_EMAIL");
  expect(missing.out).not.toContain(ADDRESS);
});

test("OB11 the step is listed in the usage line and in the `all` order", async () => {
  const script = await readFile(join(ROOT, "scripts/provision-staging.sh"), "utf8");
  const usage = script.split("\n").find((line) => line.includes("usage: $0"));
  expect(usage).toContain("channel");
  const allSteps = script.split("\n").find((line) => line.includes('[ "$1" = all ]'));
  expect(allSteps).toContain("channel");
  // The channel must be created before the deploy that applies the policies (LLD 0 section 8, P20).
  expect(allSteps?.indexOf("channel")).toBeLessThan(allSteps?.indexOf("config") ?? -1);
});
