import { join } from "node:path";
import { expect, test } from "bun:test";
import { exitCodeFor, smoke } from "./smoke";
import type { CallResult, SmokeDeps } from "./smoke";

// V5 and V6 (issue #15): the post-deploy smoke decides pass or fail, so its mapping from what staging answers to an
// exit code is tested here without a network. Every dependency that would reach Google is injected.

const PROJECT = "deepcuts-staging";
const TOKEN = "debug-token-sentinel-1";
const MINTED = "minted-debug-token-sentinel-2";
const APP_CHECK = "app-check-token-sentinel-4";

type Options = {
  env?: Record<string, string | undefined>;
  ping?: CallResult;
  noToken?: CallResult;
  minted?: string;
  appCheckToken?: string;
  registerError?: Error;
  exchangeError?: Error;
  deleteTokenError?: Error;
};

function harness(o: Options = {}) {
  const rec = { calls: [] as string[], registered: [] as string[], exchanges: [] as string[], tokenDeletes: 0, lines: [] as string[] };
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
      if (name !== "ping") throw new Error(`smoke called an unexpected callable: ${name}`);
      return appCheckToken === undefined ? (o.noToken ?? { ok: false, status: 401, code: "unauthenticated" }) : (o.ping ?? ok({ ok: true, node: "v22.23.2" }));
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

test("V6 no token value is ever printed: not in the outcome lines and not in the failure reasons", async () => {
  const secrets = [TOKEN, MINTED, APP_CHECK];
  const assertClean = (text: string) => {
    for (const secret of secrets) expect(text).not.toContain(secret);
  };

  for (const env of [{ APPCHECK_DEBUG_TOKEN: TOKEN }, {}]) {
    const { deps, rec } = harness({ env });
    const out = await smoke({ project: PROJECT, deps });
    expect(out).toEqual({ ok: true, reasons: [] });
    assertClean(rec.lines.join("\n"));
    assertClean(out.reasons.join("\n"));
    expect(rec.lines).toContain("ping: ok (node v22.23.2)");
  }

  // The failure paths are the only ones that can print an error, and Google's messages can echo what we sent: each
  // error here carries the token, and both the stdout lines and the stderr reasons must still be clean.
  const cases: { opts: Options; name: string }[] = [
    { name: "register", opts: { env: {}, registerError: new Error(`POST debugTokens rejected token ${MINTED}`) } },
    { name: "exchange", opts: { env: {}, exchangeError: new Error(`INVALID_ARGUMENT for ${MINTED}`) } },
    { name: "delete", opts: { env: {}, deleteTokenError: new Error(`DELETE /v1/projects/p/apps/a/debugTokens/${MINTED} failed`) } },
    { name: "exchange-env-token", opts: { env: { APPCHECK_DEBUG_TOKEN: TOKEN }, exchangeError: new Error(`INVALID_ARGUMENT for ${TOKEN}`) } },
  ];
  for (const c of cases) {
    const { deps, rec } = harness(c.opts);
    const out = await smoke({ project: PROJECT, deps });
    expect(out.ok).toBe(false);
    assertClean(rec.lines.join("\n"));
    assertClean(out.reasons.join("\n"));
    expect(out.reasons.join("\n")).toContain("<redacted>");
  }
});

test("V6 exit code 0 for a pass and 1 for a failure, so the CI gate lands on the outcome", async () => {
  const passed = await smoke({ project: PROJECT, deps: harness().deps });
  expect(exitCodeFor(passed)).toBe(0);

  const failed = await smoke({ project: PROJECT, deps: harness({ noToken: { ok: true, result: { ok: true, node: "v22.23.2" } } }).deps });
  expect(exitCodeFor(failed)).toBe(1);

  const errored = await smoke({ project: PROJECT, deps: harness({ env: {}, registerError: new Error("PERMISSION_DENIED") }).deps });
  expect(exitCodeFor(errored)).toBe(1);
});

test("V5 the CLI rejects --diag (the diag callable was removed in #15) and any other unknown flag", () => {
  const at = (args: string[]) =>
    Bun.spawnSync(["bun", "scripts/smoke.ts", ...args], { cwd: join(import.meta.dir, ".."), stdin: "ignore" });
  const diag = at(["--project", PROJECT, "--diag"]);
  expect(diag.exitCode).toBe(2);
  expect(diag.stderr.toString()).toContain("unknown argument: --diag");
  const unknown = at(["--project", PROJECT, "--force"]);
  expect(unknown.exitCode).toBe(2);
  expect(unknown.stderr.toString()).toContain("--force");
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
