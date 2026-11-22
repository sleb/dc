import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { tmp } from "../functions/scripts/fixtures";
import { makeGcloud, waitForIndexes } from "./wait-indexes";
import type { Gcloud, WaitDeps } from "./wait-indexes";

// V4 (issue #15): `wait-indexes` stands between the Firestore deploy and the functions deploy (LLD 0 P16). It must
// not pass while an index or a TTL field config is still being created, and it must not retry a state that will
// never change. The state machine is tested with injected dependencies; the gcloud invocation is tested against the
// fake `gcloud` in scripts/fixtures (copied onto PATH), so the real child process and arguments are exercised too.

const PROJECT = "deepcuts-staging";
const GROUP_PREFIX = `projects/${PROJECT}/databases/(default)/collectionGroups`;
const GROUPS = ["idem", "outbox", "notifLog", "rateLimits", "deletions", "joinIdem"];

const composite = (state: string, group = "outbox") => [
  {
    name: `${GROUP_PREFIX}/${group}/indexes/CICAgJ${group}`,
    queryScope: "COLLECTION",
    fields: [
      { fieldPath: "processedAt", order: "ASCENDING" },
      { fieldPath: "at", order: "ASCENDING" },
    ],
    state,
  },
];
const ttls = (state: string | ((group: string) => string) = "ACTIVE", groups: string[] = GROUPS) =>
  groups.map((group) => ({
    name: `${GROUP_PREFIX}/${group}/fields/expiresAt`,
    ttlConfig: { state: typeof state === "function" ? state(group) : state },
  }));

/** A gcloud that answers from a list of responses, one per call, in order (the last one repeats). */
function scripted(gcloudCalls: { code?: number; stdout?: unknown; stderr?: string }[]): { gcloud: Gcloud; calls: string[][] } {
  const calls: string[][] = [];
  const gcloud: Gcloud = async (args) => {
    calls.push(args);
    const answer = gcloudCalls[Math.min(calls.length - 1, gcloudCalls.length - 1)] ?? {};
    return { code: answer.code ?? 0, stdout: answer.stdout === undefined ? "" : JSON.stringify(answer.stdout), stderr: answer.stderr ?? "" };
  };
  return { gcloud, calls };
}

/** Dependencies with a virtual clock: each sleep advances `now` by its own duration, so a timeout costs no time. */
function deps(gcloud: Gcloud): { deps: Partial<WaitDeps>; lines: string[]; sleeps: number[] } {
  const lines: string[] = [];
  const sleeps: number[] = [];
  let time = 0;
  return {
    lines,
    sleeps,
    deps: {
      gcloud,
      now: () => time,
      sleep: async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
      log: (line) => void lines.push(line),
    },
  };
}

test("V4 no composite indexes and six ACTIVE TTL field configs returns at once", async () => {
  const calls: string[][] = [];
  const gcloud: Gcloud = async (args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify(args.includes("composite") ? [] : ttls()), stderr: "" };
  };
  const d = deps(gcloud);
  const out = await waitForIndexes({ project: PROJECT, timeoutMin: 30, deps: d.deps });
  expect(out).toEqual({ ok: true, polls: 1 });
  expect(d.sleeps).toEqual([]);
  expect(calls[0]).toEqual(["firestore", "indexes", "composite", "list", "--project", PROJECT, "--format=json"]);
  expect(calls[1]).toEqual(["firestore", "fields", "ttls", "list", "--project", PROJECT, "--format=json"]);
  expect(d.lines.at(-1)).toContain("6 TTL field configs ACTIVE");
});

test("V4 a CREATING field config is retried, and the next poll passes", async () => {
  let poll = 0;
  const gcloud: Gcloud = async (args) => {
    if (args.includes("composite")) return { code: 0, stdout: "[]", stderr: "" };
    poll += 1;
    const state = (g: string) => (g === "joinIdem" && poll === 1 ? "CREATING" : "ACTIVE");
    return { code: 0, stdout: JSON.stringify(ttls(state)), stderr: "" };
  };
  const d = deps(gcloud);
  const out = await waitForIndexes({ project: PROJECT, timeoutMin: 30, deps: d.deps });
  expect(out).toEqual({ ok: true, polls: 2 });
  expect(d.sleeps).toEqual([30_000]);
  expect(d.lines.some((l) => l.includes("joinIdem") && l.includes("CREATING"))).toBe(true);
});

test("V4 a CREATING composite index is retried, and the next poll passes", async () => {
  let poll = 0;
  const gcloud: Gcloud = async (args) => {
    if (args.includes("ttls")) return { code: 0, stdout: JSON.stringify(ttls()), stderr: "" };
    poll += 1;
    return { code: 0, stdout: JSON.stringify(composite(poll === 1 ? "CREATING" : "READY")), stderr: "" };
  };
  const d = deps(gcloud);
  const out = await waitForIndexes({ project: PROJECT, timeoutMin: 30, deps: d.deps });
  expect(out).toEqual({ ok: true, polls: 2 });
  expect(d.lines.some((l) => l.includes("CREATING"))).toBe(true);
});

test("V4 a composite index in a failed state fails at once, naming it", async () => {
  const gcloud: Gcloud = async (args) =>
    args.includes("composite") ? { code: 0, stdout: JSON.stringify(composite("NEED_REPAIR")), stderr: "" } : { code: 0, stdout: JSON.stringify(ttls()), stderr: "" };
  const d = deps(gcloud);
  const out = await waitForIndexes({ project: PROJECT, timeoutMin: 30, deps: d.deps });
  expect(out.ok).toBe(false);
  expect(out.ok ? "" : out.reason).toContain("NEED_REPAIR");
  expect(out.ok ? "" : out.reason).toContain("outbox");
  expect(d.sleeps).toEqual([]);
});

test("V4 a TTL field config that is not ACTIVE and will not change fails at once, naming the group", async () => {
  const gcloud: Gcloud = async (args) =>
    args.includes("composite") ? { code: 0, stdout: "[]", stderr: "" } : { code: 0, stdout: JSON.stringify(ttls((g) => (g === "deletions" ? "NEEDS_REPAIR" : "ACTIVE"))), stderr: "" };
  const d = deps(gcloud);
  const out = await waitForIndexes({ project: PROJECT, timeoutMin: 30, deps: d.deps });
  expect(out.ok).toBe(false);
  expect(out.ok ? "" : out.reason).toContain("deletions.expiresAt");
  expect(out.ok ? "" : out.reason).toContain("NEEDS_REPAIR");
});

test("V4 a missing TTL field config fails, naming the group, instead of waiting for it", async () => {
  const gcloud: Gcloud = async (args) =>
    args.includes("composite") ? { code: 0, stdout: "[]", stderr: "" } : { code: 0, stdout: JSON.stringify(ttls("ACTIVE", GROUPS.filter((g) => g !== "joinIdem"))), stderr: "" };
  const d = deps(gcloud);
  const out = await waitForIndexes({ project: PROJECT, timeoutMin: 30, deps: d.deps });
  expect(out.ok).toBe(false);
  expect(out.ok ? "" : out.reason).toContain("joinIdem.expiresAt is absent");
  expect(d.sleeps).toEqual([]);
});

test("V4 a non-zero gcloud exit fails with the command and its stderr", async () => {
  const { gcloud } = scripted([{ code: 1, stderr: "PERMISSION_DENIED: caller lacks firestore.indexes.list" }]);
  const d = deps(gcloud);
  const out = await waitForIndexes({ project: PROJECT, timeoutMin: 30, deps: d.deps });
  expect(out.ok).toBe(false);
  expect(out.ok ? "" : out.reason).toContain("firestore indexes composite list");
  expect(out.ok ? "" : out.reason).toContain("PERMISSION_DENIED");
});

test("V4 an unreadable gcloud answer (not JSON) fails instead of retrying", async () => {
  const d = deps(async () => ({ code: 0, stdout: "ERROR: (gcloud.firestore) something", stderr: "" }));
  const out = await waitForIndexes({ project: PROJECT, timeoutMin: 30, deps: d.deps });
  expect(out.ok).toBe(false);
  expect(out.ok ? "" : out.reason).toContain("JSON");
});

test("V4 --timeout-min bounds the wait and the failure names the offender", async () => {
  const gcloud: Gcloud = async (args) =>
    args.includes("composite") ? { code: 0, stdout: "[]", stderr: "" } : { code: 0, stdout: JSON.stringify(ttls("CREATING")), stderr: "" };
  const d = deps(gcloud);
  const out = await waitForIndexes({ project: PROJECT, timeoutMin: 1, deps: d.deps });
  expect(out.ok).toBe(false);
  expect(out.ok ? "" : out.reason).toContain("after 1 min");
  expect(out.ok ? "" : out.reason).toContain("CREATING");
  expect(d.sleeps).toEqual([30_000, 30_000]);
});

test("V4 the real gcloud child process: a fake gcloud on PATH, second poll goes READY", async () => {
  const state = join(await tmp("gcloud"), "state");
  await mkdir(join(state, "bin"), { recursive: true });
  await copyFile(join(import.meta.dir, "fixtures/fake-gcloud.sh"), join(state, "bin/gcloud"));
  await chmod(join(state, "bin/gcloud"), 0o755);
  await writeFile(join(state, "composite.1.json"), JSON.stringify(composite("CREATING")));
  await writeFile(join(state, "composite.2.json"), JSON.stringify(composite("READY")));
  await writeFile(join(state, "ttls.1.json"), JSON.stringify(ttls("CREATING")));
  await writeFile(join(state, "ttls.2.json"), JSON.stringify(ttls()));
  const env = { ...process.env, PATH: `${join(state, "bin")}:${process.env["PATH"] ?? ""}`, FAKE_GCLOUD_STATE: state };
  const d = deps(makeGcloud(env));
  const out = await waitForIndexes({ project: PROJECT, timeoutMin: 30, deps: d.deps });
  expect(out).toEqual({ ok: true, polls: 2 });
});

test("V4 the CLI exits 0 and prints what it saw; an absent TTL config exits 1", async () => {
  const state = join(await tmp("gcloud-cli"), "state");
  await mkdir(join(state, "bin"), { recursive: true });
  await copyFile(join(import.meta.dir, "fixtures/fake-gcloud.sh"), join(state, "bin/gcloud"));
  await chmod(join(state, "bin/gcloud"), 0o755);
  await writeFile(join(state, "composite.json"), "[]");
  await writeFile(join(state, "ttls.json"), JSON.stringify(ttls()));
  const env = { ...process.env, PATH: `${join(state, "bin")}:${process.env["PATH"] ?? ""}`, FAKE_GCLOUD_STATE: state };
  const run = () =>
    Bun.spawnSync(["bun", "scripts/wait-indexes.ts", "--project", PROJECT, "--timeout-min", "1"], { cwd: join(import.meta.dir, ".."), env, stdin: "ignore" });
  const good = run();
  expect(good.exitCode).toBe(0);
  expect(good.stdout.toString()).toContain("0 composite indexes READY, 6 TTL field configs ACTIVE");

  await writeFile(join(state, "ttls.json"), JSON.stringify(ttls("ACTIVE", GROUPS.filter((g) => g !== "outbox"))));
  const bad = run();
  expect(bad.exitCode).toBe(1);
  expect(`${bad.stdout.toString()}${bad.stderr.toString()}`).toContain("outbox.expiresAt is absent");
});

test("V4 --project is required and unknown flags are refused", async () => {
  const at = (args: string[]) => Bun.spawnSync(["bun", "scripts/wait-indexes.ts", ...args], { cwd: join(import.meta.dir, ".."), stdin: "ignore" });
  const missing = at(["--timeout-min", "1"]);
  expect(missing.exitCode).toBe(2);
  expect(missing.stderr.toString()).toContain("--project");
  const unknown = at(["--project", PROJECT, "--nope"]);
  expect(unknown.exitCode).toBe(2);
  expect(unknown.stderr.toString()).toContain("--nope");
});
