// Gates the deploy on Firestore being ready (LLD 0 P16): after `firebase deploy --only firestore` and before the
// functions deploy, poll until every composite index is READY and every TTL field config the six groups need is
// ACTIVE. A query against a still-building index fails at runtime, and TTL starts deleting only once ACTIVE, so a
// deploy that stopped here would ship a half-ready project.
//
//   bun scripts/wait-indexes.ts --project deepcuts-staging --timeout-min 30
//
// Exit codes: 0 ready, 1 not ready, 2 usage. Never prints credentials; `gcloud` uses the ambient ADC.

import { makeGcloud } from "./gcloud";
import type { Gcloud } from "./gcloud";

/** The six TTL collection groups, on field `expiresAt` (LLD 3 section 2.1; the single list). */
export const TTL_GROUPS = ["idem", "outbox", "notifLog", "rateLimits", "deletions", "joinIdem"];

export const POLL_MS = 30_000;
export const DEFAULT_TIMEOUT_MIN = 30;
const TTL_FIELD = "expiresAt";

export interface WaitDeps {
  gcloud: Gcloud;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

export interface WaitOptions {
  project: string;
  timeoutMin: number;
  /** Override the 30 s poll interval (tests only). */
  pollMs?: number;
  deps?: Partial<WaitDeps>;
}

export type WaitOutcome = { ok: true; polls: number } | { ok: false; reason: string };

/** One poll's verdict: everything ready, or why to retry, or why it will never be ready. */
type Poll = { done: { composites: number; ttls: number } } | { retry: string[] } | { fail: string };

const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).at(-1) ?? "(no message)";

/** `projects/../collectionGroups/outbox/indexes/ABC` -> `outbox/ABC`; other shapes are printed whole. */
function indexLabel(name: string): string {
  const m = /collectionGroups\/([^/]+)\/indexes\/([^/]+)$/.exec(name);
  return m ? `${m[1]}/${m[2]}` : name;
}

function parseList(stdout: string, what: string): unknown[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return `\`gcloud ${what}\` did not print JSON; its output starts "${stdout.trim().slice(0, 80)}"`;
  }
  if (!Array.isArray(parsed)) return `\`gcloud ${what}\` did not print a JSON array`;
  return parsed;
}

const objectOf = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const stringOf = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * READY/ACTIVE pass. `CREATING` and `STATE_UNSPECIFIED` are retried: a field config or index the deploy has just
 * created can report either before it settles, and the `--timeout-min` bound (not the state) ends that wait. Anything
 * else, including an empty state, is a failure that never fixes itself: `NEED_REPAIR` needs a person, and an absent
 * config means nothing was declared.
 */
function classify(state: string, ready: string): "ok" | "retry" | "fail" {
  if (state === ready) return "ok";
  if (state === "CREATING" || state === "STATE_UNSPECIFIED") return "retry";
  return "fail";
}

async function poll(d: WaitDeps, project: string): Promise<Poll> {
  const retry: string[] = [];
  const fail: string[] = [];

  const composites = await d.gcloud(["firestore", "indexes", "composite", "list", "--project", project, "--format=json"]);
  if (composites.code !== 0) return { fail: `\`gcloud firestore indexes composite list\` exited ${composites.code}: ${lastLine(composites.stderr)}` };
  const compositeList = parseList(composites.stdout, "firestore indexes composite list");
  if (typeof compositeList === "string") return { fail: compositeList };
  for (const raw of compositeList) {
    const index = objectOf(raw);
    const label = indexLabel(stringOf(index["name"]));
    const state = stringOf(index["state"]);
    const verdict = classify(state, "READY");
    if (verdict === "retry") retry.push(`composite index ${label} is ${state || "absent"}`);
    else if (verdict === "fail") fail.push(`composite index ${label} is ${state || "absent"}`);
  }

  const fieldConfigs = await d.gcloud(["firestore", "fields", "ttls", "list", "--project", project, "--format=json"]);
  if (fieldConfigs.code !== 0) return { fail: `\`gcloud firestore fields ttls list\` exited ${fieldConfigs.code}: ${lastLine(fieldConfigs.stderr)}` };
  const fieldList = parseList(fieldConfigs.stdout, "firestore fields ttls list");
  if (typeof fieldList === "string") return { fail: fieldList };
  const states = new Map<string, string>();
  for (const raw of fieldList) {
    const m = /collectionGroups\/([^/]+)\/fields\/([^/]+)$/.exec(stringOf(objectOf(raw)["name"]));
    if (m?.[1] && m[2] === TTL_FIELD) states.set(m[1], stringOf(objectOf(objectOf(raw)["ttlConfig"])["state"]));
  }
  let ttls = 0;
  for (const group of TTL_GROUPS) {
    const state = states.get(group);
    const label = `${group}.${TTL_FIELD}`;
    if (state === undefined) {
      fail.push(`TTL on ${label} is absent`);
      continue;
    }
    const verdict = classify(state, "ACTIVE");
    if (verdict === "ok") ttls += 1;
    else if (verdict === "retry") retry.push(`TTL on ${label} is ${state}`);
    else fail.push(`TTL on ${label} is ${state}`);
  }

  if (fail.length > 0) return { fail: fail.join("; ") };
  if (retry.length > 0) return { retry };
  return { done: { composites: compositeList.length, ttls } };
}

export async function waitForIndexes(o: WaitOptions): Promise<WaitOutcome> {
  const d: WaitDeps = {
    gcloud: makeGcloud(process.env),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (line) => console.log(line),
    ...o.deps,
  };
  const pollMs = o.pollMs ?? POLL_MS;
  const timeoutMs = o.timeoutMin * 60_000;
  const startedAt = d.now();
  for (let polls = 1; ; polls += 1) {
    const result = await poll(d, o.project);
    if ("fail" in result) return { ok: false, reason: result.fail };
    if ("done" in result) {
      d.log(`wait-indexes: ${result.done.composites} composite indexes READY, ${result.done.ttls} TTL field configs ACTIVE`);
      return { ok: true, polls };
    }
    const elapsedMs = d.now() - startedAt;
    if (elapsedMs >= timeoutMs) return { ok: false, reason: `still not ready after ${o.timeoutMin} min (${polls} polls): ${result.retry.join("; ")}` };
    d.log(`wait-indexes: not ready (${result.retry.join("; ")}); retrying in ${pollMs / 1000} s`);
    await d.sleep(pollMs);
  }
}

const USAGE = "usage: bun scripts/wait-indexes.ts --project <projectId> [--timeout-min <minutes>]";

/** `--project` is required; `--timeout-min` defaults to 30. Returns an error message on bad arguments. */
export function parseArgs(argv: string[]): { project: string; timeoutMin: number } | string {
  let project = "";
  let timeoutMin = DEFAULT_TIMEOUT_MIN;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--project") {
      if (!value) return "--project needs a value";
      project = value;
      i += 1;
    } else if (flag === "--timeout-min") {
      const minutes = Number(value);
      if (!value || !Number.isInteger(minutes) || minutes < 0) return "--timeout-min needs a whole number of minutes";
      timeoutMin = minutes;
      i += 1;
    } else {
      return `unknown argument: ${flag}`;
    }
  }
  if (!project) return "--project is required";
  return { project, timeoutMin };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(`wait-indexes: ${args}\n${USAGE}`);
    process.exit(2);
  }
  const outcome = await waitForIndexes(args);
  if (!outcome.ok) {
    console.error(`wait-indexes: ${outcome.reason}`);
    process.exit(1);
  }
}
