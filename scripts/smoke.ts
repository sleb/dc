// Post-deploy smoke for the staging (or prod) project: the only place that proves the seams the emulators cannot
// (LLD 0 section 11 steps 15 and 16, P12): real App Check enforcement on a deployed callable, real custom-token
// signing through IAM `signBlob`, and the Node runtime version.
//
//   APPCHECK_DEBUG_TOKEN=... bun scripts/smoke.ts --project deepcuts-staging
//   bun scripts/smoke.ts --project deepcuts-staging --diag
//
// The App Check debug token comes from APPCHECK_DEBUG_TOKEN when it is set (CI, the GitHub `staging` environment
// secret). Otherwise one is minted and registered for the run, then deleted in the same run; if that registration is
// refused, the message says which permission is missing and how to supply a token instead. No token value is ever
// printed or written. Exit codes: 0 pass, 1 fail, 2 usage.

import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const REGION = "us-central1";
const PROBE_UID = "seat:probe:probe";
const APPCHECK_API = "https://firebaseappcheck.googleapis.com/v1";
const FIREBASE_API = "https://firebase.googleapis.com/v1beta1";
const IDENTITY_API = "https://identitytoolkit.googleapis.com/v1";
const ROOT = join(import.meta.dir, "..");
/** The two codes a callable with `enforceAppCheck` can answer a tokenless request with (LLD 0 section 6). */
const TOKENLESS_CODES = new Set(["unauthenticated", "failed-precondition"]);

/** What a callable answered: its result, or the callable's error status (lowercased) and the HTTP status. */
export type CallResult = { ok: true; result: unknown } | { ok: false; status: number; code: string };

/** Every outward-facing effect, injected so the decision logic is tested without a network. */
export interface SmokeDeps {
  env: Record<string, string | undefined>;
  call: (name: string, appCheckToken?: string) => Promise<CallResult>;
  mintToken: () => string;
  /** Registers a newly minted debug token; resolves to the function that deletes it. */
  registerDebugToken: (token: string) => Promise<() => Promise<void>>;
  /** Exchanges a debug token for a real App Check token (the JWT the callables and Auth verify). */
  exchangeDebugToken: (debugToken: string) => Promise<string>;
  signInWithCustomToken: (customToken: string, appCheckToken: string) => Promise<string>;
  deleteSignedInUser: () => Promise<void>;
  log: (line: string) => void;
}

export interface SmokeOptions {
  project: string;
  /** Also run the `diag` path: custom token, sign-in, then delete the probe user. */
  diag?: boolean;
  deps?: Partial<SmokeDeps>;
}

export type SmokeOutcome = { ok: boolean; reasons: string[] };

const objectOf = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const stringOf = (v: unknown): string => (typeof v === "string" ? v : "");
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Messages can come back from Google with the value we sent; redact it before it is printed. */
const redact = (e: unknown, ...values: string[]): string => values.reduce((text, value) => (value ? text.replaceAll(value, "<redacted>") : text), message(e));

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

async function checkDiag(d: SmokeDeps, appCheckToken: string, reasons: string[]): Promise<void> {
  const diag = await d.call("diag", appCheckToken);
  if (!diag.ok) {
    reasons.push(`diag failed: ${diag.code} (HTTP ${diag.status}); if it is a signBlob denial, fn-runtime is missing the self-grant of roles/iam.serviceAccountTokenCreator`);
    return;
  }
  const customToken = stringOf(objectOf(diag.result)["token"]);
  if (!customToken) {
    reasons.push("diag returned no custom token");
    return;
  }
  let uid: string;
  try {
    uid = await d.signInWithCustomToken(customToken, appCheckToken);
  } catch (e) {
    reasons.push(`signInWithCustomToken failed: ${redact(e, customToken)}`);
    return;
  }
  if (uid !== PROBE_UID) {
    reasons.push(`diag signed in as ${uid}, want ${PROBE_UID}`);
    return;
  }
  try {
    await d.deleteSignedInUser();
  } catch (e) {
    reasons.push(`could not delete the Auth user ${uid}: ${message(e)}`);
    return;
  }
  d.log(`diag: signed in as ${uid}, user deleted`);
}

export async function smoke(o: SmokeOptions): Promise<SmokeOutcome> {
  const d: SmokeDeps = { ...realDeps(o.project), ...o.deps };
  const reasons: string[] = [];
  const out = o.diag === true;

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

  // The callables and Auth verify a real App Check JWT (firebase-admin requires RS256 claims), so the debug token is
  // exchanged first; sending the debug token itself is rejected with `unauthenticated` (observed on staging, #15).
  let appCheckToken = "";
  if (reasons.length === 0) {
    try {
      appCheckToken = await d.exchangeDebugToken(debugToken);
    } catch (e) {
      reasons.push(`could not exchange the App Check debug token for an App Check token (${redact(e, debugToken)})`);
    }
  }

  try {
    if (reasons.length === 0) {
      await checkPing(d, appCheckToken, reasons);
      if (out) await checkDiag(d, appCheckToken, reasons);
    }
  } finally {
    if (release) {
      try {
        await release();
        d.log("App Check debug token: deleted");
      } catch (e) {
        reasons.push(`could not delete the App Check debug token registered for this run: ${message(e)}`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// The real effects: HTTP to the deployed callables, the Identity Toolkit REST API and the App Check REST API, with
// the operator's Application Default Credentials for the App Check admin calls.
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
        await request(`${APPCHECK_API}/${createdName}`, { method: "DELETE", headers: await appCheckAdminHeaders(project) });
      };
    } catch (e) {
      throw new Error(redact(e, debugToken));
    }
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
  throw new Error(`no apps/web/.env.* names VITE_FIREBASE_PROJECT_ID=${project} with VITE_FIREBASE_API_KEY; the public web config is needed to sign in with a custom token`);
}

function identityCalls(project: string): Pick<SmokeDeps, "signInWithCustomToken" | "deleteSignedInUser"> {
  let apiKey = "";
  let idToken = "";
  let appCheckToken = "";
  return {
    signInWithCustomToken: async (customToken, token) => {
      appCheckToken = token;
      apiKey ||= await webApiKey(project);
      const body = await request(`${IDENTITY_API}/accounts:signInWithCustomToken?key=${apiKey}`, {
        method: "POST",
        headers: { "X-Firebase-AppCheck": token },
        body: { token: customToken, returnSecureToken: true },
      }).catch((e: unknown) => {
        throw new Error(redact(e, customToken, token));
      });
      idToken = stringOf(body["idToken"]);
      if (!idToken) throw new Error("signInWithCustomToken returned no idToken");
      // This endpoint omits `localId` on staging (observed, #15), so the uid is read back server-side with accounts:lookup.
      const localId = stringOf(body["localId"]);
      if (localId) return localId;
      const lookup = await request(`${IDENTITY_API}/accounts:lookup?key=${apiKey}`, {
        method: "POST",
        headers: { "X-Firebase-AppCheck": token },
        body: { idToken },
      });
      const uid = stringOf(objectOf(Array.isArray(lookup["users"]) ? lookup["users"][0] : undefined)["localId"]);
      if (!uid) throw new Error("could not read the signed-in user's uid");
      return uid;
    },
    deleteSignedInUser: async () => {
      if (!idToken) throw new Error("no signed-in user to delete");
      apiKey ||= await webApiKey(project);
      await request(`${IDENTITY_API}/accounts:delete?key=${apiKey}`, {
        method: "POST",
        headers: appCheckToken ? { "X-Firebase-AppCheck": appCheckToken } : {},
        body: { idToken },
      });
    },
  };
}

/** The real dependencies. Constructing them touches nothing; only the calls do. */
export function realDeps(project: string): SmokeDeps {
  return {
    env: process.env,
    call: callCallable(project),
    mintToken: () => randomUUID(),
    registerDebugToken: registerDebugToken(project),
    exchangeDebugToken: exchangeDebugToken(project),
    ...identityCalls(project),
    log: (line) => console.log(line),
  };
}

const USAGE = "usage: bun scripts/smoke.ts --project <projectId> [--diag]";

/** `--project` is required; `--diag` adds the custom-token sign-in. Returns an error message on bad arguments. */
export function parseArgs(argv: string[]): { project: string; diag: boolean } | string {
  let project = "";
  let diag = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--project") {
      const value = argv[i + 1];
      if (!value) return "--project needs a value";
      project = value;
      i += 1;
    } else if (flag === "--diag") {
      diag = true;
    } else {
      return `unknown argument: ${flag}`;
    }
  }
  if (!project) return "--project is required";
  return { project, diag };
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
    process.exit(1);
  }
  console.log("smoke: ok");
}
