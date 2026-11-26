// Post-deploy smoke for the staging (or prod) project: the only place that proves the seams the emulators cannot
// (LLD 0 section 11 step 15, P12): real App Check enforcement on a deployed callable and the Node runtime version.
//
//   APPCHECK_DEBUG_TOKEN=... bun scripts/smoke.ts --project deepcuts-staging
//
// The App Check debug token comes from APPCHECK_DEBUG_TOKEN when it is set (CI, the GitHub `staging` environment
// secret). Otherwise one is minted and registered for the run, then deleted in the same run; if that registration is
// refused, the message says which permission is missing and how to supply a token instead. No token value is ever
// printed or written. Exit codes: 0 pass, 1 fail, 2 usage.
//
// It also runs every declared Firestore query (`functions/src/store/queries.ts`, LLD 3 section 4) with `limit 1`
// against the deployed database through the REST `runQuery`, as the ambient credential (the deployer in CI). The
// emulator ignores composite indexes, so this is where a missing one is caught: `FAILED_PRECONDITION` fails the run
// naming the query, and `PERMISSION_DENIED` is reported separately, as a missing role on the caller, not an index.
//
// Custom-token signing is not checked here: that probe (`diag`) was removed in #15 after it passed on staging, and the
// extended sign-in probe (epoch claim, disabled user, `deleteUsers`) belongs to the identity step, LLD 4 section 13.

import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { QUERIES } from "../functions/src/store/queries";
import type { DeclaredQuery } from "../functions/src/store/queries";
import { makeGcloud } from "./gcloud";
import { accessToken } from "./ops-apply";

const REGION = "us-central1";
const APPCHECK_API = "https://firebaseappcheck.googleapis.com/v1";
const FIREBASE_API = "https://firebase.googleapis.com/v1beta1";
const ROOT = join(import.meta.dir, "..");
/** The two codes a callable with `enforceAppCheck` can answer a tokenless request with (LLD 0 section 6). */
const TOKENLESS_CODES = new Set(["unauthenticated", "failed-precondition"]);

/** What a callable answered: its result, or the callable's error status (lowercased) and the HTTP status. */
export type CallResult = { ok: true; result: unknown } | { ok: false; status: number; code: string };

/** What one declared query answered: ok, or the Firestore API error status (`FAILED_PRECONDITION`) and message. */
export type QueryResult = { ok: true } | { ok: false; status: string; message: string };

/** Every outward-facing effect, injected so the decision logic is tested without a network. */
export interface SmokeDeps {
  env: Record<string, string | undefined>;
  call: (name: string, appCheckToken?: string) => Promise<CallResult>;
  mintToken: () => string;
  /** Registers a newly minted debug token; resolves to the function that deletes it. */
  registerDebugToken: (token: string) => Promise<() => Promise<void>>;
  /** Exchanges a debug token for a real App Check token (the JWT the callables verify). */
  exchangeDebugToken: (debugToken: string) => Promise<string>;
  /** Runs one declared query (limit 1) against the deployed database. */
  runQuery: (q: DeclaredQuery) => Promise<QueryResult>;
  log: (line: string) => void;
}

export interface SmokeOptions {
  project: string;
  deps?: Partial<SmokeDeps>;
}

export type SmokeOutcome = { ok: boolean; reasons: string[] };

const objectOf = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const stringOf = (v: unknown): string => (typeof v === "string" ? v : "");
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Messages can come back from Google with the value we sent; redact it before it is printed. */
const redact = (e: unknown, ...values: string[]): string => values.reduce((text, value) => (value ? text.replaceAll(value, "<redacted>") : text), message(e));

/** The exit code for an outcome: 0 pass, 1 fail (2 is a usage error, decided before a run starts). */
export function exitCodeFor(outcome: SmokeOutcome): number {
  return outcome.ok ? 0 : 1;
}

async function checkPing(d: SmokeDeps, appCheckToken: string, reasons: string[]): Promise<void> {
  const ping = await d.call("ping", appCheckToken);
  if (!ping.ok) {
    reasons.push(`ping with an App Check token failed: ${ping.code} (HTTP ${ping.status}); a valid App Check token from the debug-token exchange must be accepted`);
  } else {
    const { ok, node } = objectOf(ping.result);
    if (ok !== true) reasons.push(`ping did not return ok: true (got ${JSON.stringify(ping.result)})`);
    else if (!stringOf(node).startsWith("v22")) reasons.push(`ping reports node ${JSON.stringify(node)}, want v22`);
    else d.log(`ping: ok (node ${stringOf(node)})`);
  }

  const noToken = await d.call("ping");
  if (noToken.ok) reasons.push("a call with no App Check token succeeded; App Check is not enforced on the callable");
  else if (!TOKENLESS_CODES.has(noToken.code)) reasons.push(`a call with no App Check token answered ${noToken.code} (HTTP ${noToken.status}), want unauthenticated or failed-precondition`);
  else d.log(`no App Check token: rejected (${noToken.code})`);
}

/** The likely missing permission when the caller may not query; granting it is the project owner's call. */
const QUERY_PERMISSION = "datastore.entities.list (for example roles/datastore.viewer)";

async function checkQueries(d: SmokeDeps, reasons: string[]): Promise<void> {
  for (const q of QUERIES) {
    let r: QueryResult;
    try {
      r = await d.runQuery(q);
    } catch (e) {
      reasons.push(`query ${q.id} could not run: ${message(e)}`);
      continue;
    }
    if (r.ok) d.log(`query ${q.id}: ok`);
    else if (r.status === "FAILED_PRECONDITION")
      reasons.push(`query ${q.id}: missing or building index (FAILED_PRECONDITION): ${r.message}. firestore.indexes.json must declare it and wait-indexes must see it READY`);
    else if (r.status === "PERMISSION_DENIED")
      reasons.push(`query ${q.id}: PERMISSION_DENIED for the smoke's credential, so the index was not checked; the caller likely lacks ${QUERY_PERMISSION} on the project: ${r.message}`);
    else reasons.push(`query ${q.id} failed: ${r.status} ${r.message}`.trim());
  }
}

export async function smoke(o: SmokeOptions): Promise<SmokeOutcome> {
  const d: SmokeDeps = { ...realDeps(o.project), ...o.deps };
  const reasons: string[] = [];

  let debugToken = (d.env["APPCHECK_DEBUG_TOKEN"] ?? "").trim();
  let release: (() => Promise<void>) | undefined;
  if (!debugToken) {
    const minted = d.mintToken();
    try {
      release = await d.registerDebugToken(minted);
      debugToken = minted;
      d.log("App Check debug token: registered for this run");
    } catch (e) {
      reasons.push(
        `could not register an App Check debug token (${redact(e, minted)}). Register one in the console (App Check, Manage debug tokens), export APPCHECK_DEBUG_TOKEN, and re-run.`,
      );
    }
  }

  // The callables verify a real App Check JWT (firebase-admin requires RS256 claims), so the debug token is exchanged
  // first; sending the debug token itself is rejected with `unauthenticated` (observed on staging, #15).
  let appCheckToken = "";
  if (reasons.length === 0) {
    try {
      appCheckToken = await d.exchangeDebugToken(debugToken);
    } catch (e) {
      reasons.push(`could not exchange the App Check debug token for an App Check token (${redact(e, debugToken)})`);
    }
  }

  try {
    if (reasons.length === 0) await checkPing(d, appCheckToken, reasons);
    // Independent of App Check (server credentials bypass it), so the queries run whatever the ping found.
    await checkQueries(d, reasons);
  } finally {
    if (release) {
      try {
        await release();
        d.log("App Check debug token: deleted");
      } catch (e) {
        // The DELETE carries the token's resource name, so this reason is redacted like every other path.
        reasons.push(`could not delete the App Check debug token registered for this run: ${redact(e, debugToken)}`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// The real effects: HTTP to the deployed callable and the App Check REST API, with the operator's Application Default
// Credentials for the App Check admin calls.
// ---------------------------------------------------------------------------

async function adcToken(): Promise<string> {
  const child = Bun.spawnSync(["gcloud", "auth", "print-access-token"], { stdin: "ignore" });
  if (child.exitCode !== 0) throw new Error("`gcloud auth print-access-token` failed; sign in with `gcloud auth application-default login`");
  return child.stdout.toString().trim();
}

async function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Record<string, unknown>> {
  const method = init.method ?? "GET";
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = objectOf(JSON.parse(text));
  } catch {
    parsed = {};
  }
  if (!res.ok) {
    const apiError = objectOf(parsed["error"]);
    throw new Error(`${method} ${new URL(url).pathname} answered ${res.status} ${stringOf(apiError["status"])} ${stringOf(apiError["message"])}`.trim());
  }
  return parsed;
}

function callCallable(project: string): SmokeDeps["call"] {
  return async (name, appCheckToken) => {
    const headers: Record<string, string> = appCheckToken === undefined ? {} : { "X-Firebase-AppCheck": appCheckToken };
    const res = await fetch(`https://${REGION}-${project}.cloudfunctions.net/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ data: {} }),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = objectOf(JSON.parse(text));
    } catch {
      return { ok: false, status: res.status, code: `http-${res.status}` };
    }
    const error = objectOf(body["error"]);
    if (body["error"] !== undefined) return { ok: false, status: res.status, code: (stringOf(error["status"]) || `http-${res.status}`).toLowerCase() };
    return { ok: true, result: body["result"] };
  };
}

async function appCheckAdminHeaders(project: string): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await adcToken()}`, "x-goog-user-project": project };
}

/** The registered web app's App Check app id. The App Check API has no app list; the Firebase management API has one. */
function webAppId(project: string): Promise<string> {
  return appCheckAdminHeaders(project)
    .then((headers) => request(`${FIREBASE_API}/projects/${project}/webApps`, { headers }))
    .then((web) => {
      const appId = stringOf(objectOf(Array.isArray(web["apps"]) ? web["apps"][0] : undefined)["appId"]);
      if (!appId) throw new Error(`project ${project} has no registered web app to attach an App Check debug token to`);
      return appId;
    });
}

function exchangeDebugToken(project: string): SmokeDeps["exchangeDebugToken"] {
  return async (debugToken) => {
    try {
      const appId = await webAppId(project);
      const key = await webApiKey(project);
      const body = await request(`${APPCHECK_API}/projects/${project}/apps/${appId}:exchangeDebugToken?key=${key}`, {
        method: "POST",
        body: { debugToken },
      });
      const token = stringOf(body["token"]);
      if (!token) throw new Error("App Check returned no token for the debug token");
      return token;
    } catch (e) {
      throw new Error(redact(e, debugToken));
    }
  };
}

function registerDebugToken(project: string): SmokeDeps["registerDebugToken"] {
  return async (debugToken) => {
    try {
      const headers = await appCheckAdminHeaders(project);
      const appId = await webAppId(project);
      const created = await request(`${APPCHECK_API}/projects/${project}/apps/${appId}/debugTokens`, {
        method: "POST",
        headers,
        body: { displayName: `smoke-${new Date().toISOString()}`, token: debugToken },
      });
      const createdName = stringOf(created["name"]);
      if (!createdName) throw new Error("App Check did not return the new debug token's name");
      return async () => {
        try {
          await request(`${APPCHECK_API}/${createdName}`, { method: "DELETE", headers: await appCheckAdminHeaders(project) });
        } catch (e) {
          // The path carries the token's resource name; a failure here must not put it on stderr.
          throw new Error(redact(e, debugToken));
        }
      };
    } catch (e) {
      throw new Error(redact(e, debugToken));
    }
  };
}

const FIRESTORE_API = "https://firestore.googleapis.com/v1";
const PROBE_ID = "smoke-probe";
const OPS: Record<DeclaredQuery["where"][number]["op"], string> = { "==": "EQUAL", "<": "LESS_THAN", "<=": "LESS_THAN_OR_EQUAL", ">": "GREATER_THAN", ">=": "GREATER_THAN_OR_EQUAL" };

const valueOf = (v: string | number): Record<string, string> =>
  typeof v === "string" ? { stringValue: v } : Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: String(v) };

/** A declared query as a Firestore REST `StructuredQuery` with `limit 1`. */
export function structuredQuery(q: DeclaredQuery): Record<string, unknown> {
  const filters = q.where.map((w) =>
    w.value === null
      ? { unaryFilter: { field: { fieldPath: w.field }, op: w.op === "==" ? "IS_NULL" : "IS_NOT_NULL" } }
      : { fieldFilter: { field: { fieldPath: w.field }, op: OPS[w.op], value: valueOf(w.value) } },
  );
  return {
    from: [{ collectionId: q.collectionGroup, allDescendants: q.scope === "COLLECTION_GROUP" }],
    ...(filters.length === 0 ? {} : { where: filters.length === 1 ? filters[0] : { compositeFilter: { op: "AND", filters } } }),
    ...(q.orderBy.length === 0 ? {} : { orderBy: q.orderBy.map((o) => ({ field: { fieldPath: o.field }, direction: o.direction })) }),
    limit: 1,
  };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;

/**
 * The real `runQuery`: the Firestore REST `documents:runQuery` (under a probe parent document for a subcollection
 * query), as the ambient credential. The access token stays in memory; any error text is redacted of it.
 */
export function runQueryRest(project: string, io: { fetch: Fetch; token: () => Promise<string> }): SmokeDeps["runQuery"] {
  let cached: Promise<string> | undefined;
  return async (q) => {
    cached ??= io.token();
    const token = await cached;
    const parent = q.parent === "" ? "" : `/${q.parent.replaceAll("{}", PROBE_ID)}`;
    const url = `${FIRESTORE_API}/projects/${project}/databases/(default)/documents${parent}:runQuery`;
    const res = await io.fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ structuredQuery: structuredQuery(q) }),
    });
    if (res.ok) return { ok: true };
    const text = await res.text();
    let error: Record<string, unknown> = {};
    try {
      // runQuery answers an error as an object, or as a one-element array of { error } on a streamed failure.
      const parsed: unknown = JSON.parse(text);
      error = objectOf(objectOf(Array.isArray(parsed) ? parsed[0] : parsed)["error"]);
    } catch {
      error = {};
    }
    const status = stringOf(error["status"]) || `HTTP_${res.status}`;
    return { ok: false, status, message: redact(stringOf(error["message"]) || text.slice(0, 200), token) };
  };
}

/** The public web config for `project` (Firebase web API key), from the committed `apps/web/.env.<mode>` files. */
async function webApiKey(project: string): Promise<string> {
  const dir = join(ROOT, "apps/web");
  for (const file of (await readdir(dir)).filter((f) => /^\.env\.[a-z]+$/.test(f)).sort()) {
    const vars = new Map<string, string>();
    for (const line of (await Bun.file(join(dir, file)).text()).split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m?.[1]) vars.set(m[1], (m[2] ?? "").replace(/^["']|["']$/g, ""));
    }
    const key = vars.get("VITE_FIREBASE_API_KEY");
    if (vars.get("VITE_FIREBASE_PROJECT_ID") === project && key) return key;
  }
  throw new Error(`no apps/web/.env.* names VITE_FIREBASE_PROJECT_ID=${project} with VITE_FIREBASE_API_KEY; the public web config is needed to exchange a debug token`);
}

/** The real dependencies. Constructing them touches nothing; only the calls do. */
export function realDeps(project: string): SmokeDeps {
  return {
    env: process.env,
    call: callCallable(project),
    mintToken: () => randomUUID(),
    registerDebugToken: registerDebugToken(project),
    exchangeDebugToken: exchangeDebugToken(project),
    runQuery: runQueryRest(project, { fetch: (url, init) => fetch(url, init), token: () => accessToken(makeGcloud(process.env)) }),
    log: (line) => console.log(line),
  };
}

const USAGE = "usage: bun scripts/smoke.ts --project <projectId>";

/** `--project` is required. Returns an error message on bad arguments. */
export function parseArgs(argv: string[]): { project: string } | string {
  let project = "";
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--project") {
      const value = argv[i + 1];
      if (!value) return "--project needs a value";
      project = value;
      i += 1;
    } else {
      return `unknown argument: ${flag}`;
    }
  }
  if (!project) return "--project is required";
  return { project };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(`smoke: ${args}\n${USAGE}`);
    process.exit(2);
  }
  const outcome = await smoke(args);
  if (!outcome.ok) {
    for (const reason of outcome.reasons) console.error(`smoke: FAIL ${reason}`);
  } else {
    console.log("smoke: ok");
  }
  process.exit(exitCodeFor(outcome));
}
