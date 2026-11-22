import { join } from "node:path";
import { expect, test } from "bun:test";
import { smoke } from "./smoke";
import type { CallResult, SmokeDeps } from "./smoke";

// V5 to V7 (issue #15): the post-deploy smoke decides pass or fail, so its mapping from what staging answers to an
// exit code is tested here without a network. Every dependency that would reach Google is injected.

const PROJECT = "deepcuts-staging";
const TOKEN = "debug-token-sentinel-1";
const MINTED = "minted-debug-token-sentinel-2";
const CUSTOM = "custom-token-sentinel-3";
const APP_CHECK = "app-check-token-sentinel-4";
const PROBE_UID = "seat:probe:probe";

type Options = {
  env?: Record<string, string | undefined>;
  ping?: CallResult;
  noToken?: CallResult;
  diag?: CallResult;
  uid?: string;
  minted?: string;
  appCheckToken?: string;
  registerError?: Error;
  exchangeError?: Error;
  signInError?: Error;
  deleteUserError?: Error;
  deleteTokenError?: Error;
};

function harness(o: Options = {}) {
  const rec = { calls: [] as string[], registered: [] as string[], exchanges: [] as string[], tokenDeletes: 0, signIns: [] as string[], userDeletes: 0, lines: [] as string[] };
  const ok = (result: unknown): CallResult => ({ ok: true, result });
  const deps: Partial<SmokeDeps> = {
    env: o.env ?? { APPCHECK_DEBUG_TOKEN: TOKEN },
    log: (line) => void rec.lines.push(line),
    mintToken: () => {
      rec.calls.push("mint");
      return o.minted ?? MINTED;
    },
    registerDebugToken: async (token) => {
      if (o.registerError) throw o.registerError;
      rec.registered.push(token);
      rec.calls.push("register");
      return async () => {
        if (o.deleteTokenError) throw o.deleteTokenError;
        rec.tokenDeletes += 1;
        rec.calls.push("unregister");
      };
    },
    exchangeDebugToken: async (debugToken) => {
      rec.exchanges.push(debugToken);
      if (o.exchangeError) throw o.exchangeError;
      return o.appCheckToken ?? APP_CHECK;
    },
    call: async (name, appCheckToken) => {
      rec.calls.push(appCheckToken === undefined ? `${name}:no-token` : `${name}:token`);
      if (appCheckToken !== undefined && appCheckToken !== (o.appCheckToken ?? APP_CHECK)) throw new Error(`call sent App Check token ${appCheckToken}`);
      if (name === "ping") return appCheckToken === undefined ? (o.noToken ?? { ok: false, status: 401, code: "unauthenticated" }) : (o.ping ?? ok({ ok: true, node: "v22.23.2" }));
      return o.diag ?? ok({ ok: true, token: CUSTOM });
    },
    signInWithCustomToken: async (customToken, appCheckToken) => {
      rec.signIns.push(customToken);
      if (appCheckToken !== (o.appCheckToken ?? APP_CHECK)) throw new Error(`sign-in sent App Check token ${appCheckToken}`);
      if (o.signInError) throw o.signInError;
      return o.uid ?? PROBE_UID;
    },
    deleteSignedInUser: async () => {
      if (o.deleteUserError) throw o.deleteUserError;
      rec.userDeletes += 1;
    },
  };
  return { deps, rec };
}

test("V5 ping with a token that returns ok on Node 22 and a tokenless rejection pass", async () => {
  const { deps, rec } = harness({ noToken: { ok: false, status: 401, code: "unauthenticated" } });
  expect(await smoke({ project: PROJECT, deps })).toEqual({ ok: true, reasons: [] });
  expect(rec.calls).toEqual(["ping:token", "ping:no-token"]);
  expect(rec.lines).toContain("ping: ok (node v22.23.2)");
  expect(rec.lines).toContain("no App Check token: rejected (unauthenticated)");
});

test("V5 failed-precondition is accepted for the tokenless call, any other code is not", async () => {
  for (const code of ["failed-precondition", "unauthenticated"]) {
    const { deps } = harness({ noToken: { ok: false, status: 412, code } });
    expect(await smoke({ project: PROJECT, deps })).toEqual({ ok: true, reasons: [] });
  }
  for (const code of ["internal", "permission-denied", "invalid-argument"]) {
    const { deps } = harness({ noToken: { ok: false, status: 500, code } });
    const out = await smoke({ project: PROJECT, deps });
    expect(out.ok).toBe(false);
    expect(out.reasons.join(" ")).toContain(code);
  }
});

test("V5 a tokenless call that succeeds fails the run: App Check is not enforced", async () => {
  const { deps } = harness({ noToken: { ok: true, result: { ok: true, node: "v22.23.2" } } });
  const out = await smoke({ project: PROJECT, deps });
  expect(out.ok).toBe(false);
  expect(out.reasons.join(" ")).toContain("no App Check token");
});

test("V5 a ping failure, a ping that is not ok, and a Node that is not 22 each fail with one reason", async () => {
  const failures = await smoke({ project: PROJECT, deps: harness({ ping: { ok: false, status: 500, code: "internal" } }).deps });
  expect(failures.reasons).toHaveLength(1);
  expect(failures.reasons[0]).toContain("internal");

  const notOk = await smoke({ project: PROJECT, deps: harness({ ping: { ok: true, result: { ok: false, node: "v22.1.0" } } }).deps });
  expect(notOk.reasons[0]).toContain("ok: true");

  const node20 = await smoke({ project: PROJECT, deps: harness({ ping: { ok: true, result: { ok: true, node: "v20.11.1" } } }).deps });
  expect(node20.ok).toBe(false);
  expect(node20.reasons[0]).toContain("v20.11.1");
});

test("V6 APPCHECK_DEBUG_TOKEN is used as it is, and nothing is minted, registered or deleted", async () => {
  const { deps, rec } = harness();
  await smoke({ project: PROJECT, deps });
  expect(rec.registered).toEqual([]);
  expect(rec.tokenDeletes).toBe(0);
  expect(rec.calls).not.toContain("mint");
});

test("V6 otherwise a token is minted, registered through App Check, and deleted afterwards", async () => {
  const { deps, rec } = harness({ env: {} });
  expect(await smoke({ project: PROJECT, deps })).toEqual({ ok: true, reasons: [] });
  expect(rec.registered).toEqual([MINTED]);
  expect(rec.tokenDeletes).toBe(1);
  expect(rec.lines).toContain("App Check debug token: registered for this run");
  expect(rec.lines).toContain("App Check debug token: deleted");
});

test("V6 the minted token is deleted even when a check fails", async () => {
  const { deps, rec } = harness({ env: {}, noToken: { ok: true, result: { ok: true, node: "v22.23.2" } } });
  const out = await smoke({ project: PROJECT, deps });
  expect(out.ok).toBe(false);
  expect(rec.tokenDeletes).toBe(1);
});

test("V6 the debug token is exchanged for an App Check token before any call, and the exchange failure fails the run", async () => {
  const { deps, rec } = harness({ env: {} });
  expect(await smoke({ project: PROJECT, deps })).toEqual({ ok: true, reasons: [] });
  expect(rec.exchanges).toEqual([MINTED]);

  const failed = harness({ exchangeError: new Error("INVALID_DEBUG_TOKEN") });
  const out = await smoke({ project: PROJECT, deps: failed.deps });
  expect(out.ok).toBe(false);
  expect(out.reasons.join(" ")).toContain("INVALID_DEBUG_TOKEN");
  expect(failed.rec.calls).not.toContain("ping:token");
});

test("V6 a registration failure names the fallback and fails before any call", async () => {
  const { deps, rec } = harness({ env: {}, registerError: new Error("PERMISSION_DENIED: appcheck.debugTokens.create") });
  const out = await smoke({ project: PROJECT, deps });
  expect(out.ok).toBe(false);
  expect(out.reasons.join(" ")).toContain("APPCHECK_DEBUG_TOKEN");
  expect(out.reasons.join(" ")).toContain("PERMISSION_DENIED");
  expect(rec.calls).not.toContain("ping:token");
});

test("V6 a debug token that cannot be deleted fails the run", async () => {
  const { deps } = harness({ env: {}, deleteTokenError: new Error("RESOURCE_EXHAUSTED") });
  const out = await smoke({ project: PROJECT, deps });
  expect(out.ok).toBe(false);
  expect(out.reasons.join(" ")).toContain("RESOURCE_EXHAUSTED");
});

test("V6 no token value is ever printed", async () => {
  for (const env of [{ APPCHECK_DEBUG_TOKEN: TOKEN }, {}]) {
    const { deps, rec } = harness({ env });
    await smoke({ project: PROJECT, diag: true, deps });
    const printed = rec.lines.join("\n");
    for (const secret of [TOKEN, MINTED, CUSTOM, APP_CHECK]) expect(printed).not.toContain(secret);
    expect(printed).toContain(PROBE_UID);
  }
});

test("V7 --diag signs a custom token in as the probe uid and deletes that user", async () => {
  const { deps, rec } = harness();
  expect(await smoke({ project: PROJECT, diag: true, deps })).toEqual({ ok: true, reasons: [] });
  expect(rec.calls).toContain("diag:token");
  expect(rec.signIns).toEqual([CUSTOM]);
  expect(rec.userDeletes).toBe(1);
  expect(rec.lines).toContain(`diag: signed in as ${PROBE_UID}, user deleted`);
});

test("V7 without --diag the diag callable is never called", async () => {
  const { deps, rec } = harness();
  await smoke({ project: PROJECT, deps });
  expect(rec.calls.some((c) => c.startsWith("diag"))).toBe(false);
});

test("V7 a diag failure, a wrong uid, a sign-in failure and a failed delete each fail the run", async () => {
  const diagFailed = await smoke({ project: PROJECT, diag: true, deps: harness({ diag: { ok: false, status: 500, code: "internal" } }).deps });
  expect(diagFailed.reasons.join(" ")).toContain("diag");

  const wrongUid = await smoke({ project: PROJECT, diag: true, deps: harness({ uid: "seat:other:seat" }).deps });
  expect(wrongUid.ok).toBe(false);
  expect(wrongUid.reasons.join(" ")).toContain("seat:other:seat");

  const signInFailed = await smoke({ project: PROJECT, diag: true, deps: harness({ signInError: new Error("INVALID_CUSTOM_TOKEN") }).deps });
  expect(signInFailed.reasons.join(" ")).toContain("INVALID_CUSTOM_TOKEN");

  const { deps, rec } = harness({ deleteUserError: new Error("USER_NOT_FOUND") });
  const deleteFailed = await smoke({ project: PROJECT, diag: true, deps });
  expect(deleteFailed.ok).toBe(false);
  expect(deleteFailed.reasons.join(" ")).toContain("USER_NOT_FOUND");
  expect(rec.userDeletes).toBe(0);
});

test("V5 the CLI refuses to run without --project and on an unknown flag", () => {
  const at = (args: string[]) =>
    Bun.spawnSync(["bun", "scripts/smoke.ts", ...args], { cwd: join(import.meta.dir, ".."), stdin: "ignore" });
  const missing = at([]);
  expect(missing.exitCode).toBe(2);
  expect(missing.stderr.toString()).toContain("--project");
  const unknown = at(["--project", PROJECT, "--force"]);
  expect(unknown.exitCode).toBe(2);
  expect(unknown.stderr.toString()).toContain("--force");
});
