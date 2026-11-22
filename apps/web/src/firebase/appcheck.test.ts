import { describe, expect, test } from "bun:test";
import type { FirebaseApp } from "firebase/app";
import type { ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { initAppCheck, type AppCheckDeps } from "./appcheck";

const APP = { name: "[DEFAULT]" } as FirebaseApp;

function fakes() {
  const target: { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean } = {};
  const calls: { siteKey: string; tokenAtInit: string | boolean | undefined; autoRefresh: boolean | undefined }[] = [];
  const deps: AppCheckDeps = {
    target,
    makeProvider: (siteKey) => ({ siteKey }) as unknown as ReCaptchaEnterpriseProvider,
    init: (_app, options) => {
      calls.push({ siteKey: (options.provider as unknown as { siteKey: string }).siteKey, tokenAtInit: target.FIREBASE_APPCHECK_DEBUG_TOKEN, autoRefresh: options.isTokenAutoRefreshEnabled });
      return {} as ReturnType<AppCheckDeps["init"]>;
    },
  };
  return { target, calls, deps };
}

describe("firebase/appcheck", () => {
  test("V3 staging with a token sets the debug token before init, and auto-refreshes", () => {
    const f = fakes();
    initAppCheck(APP, { appEnv: "staging", recaptchaSiteKey: "site", debugToken: "tok" }, f.deps);
    expect(f.target.FIREBASE_APPCHECK_DEBUG_TOKEN).toBe("tok");
    expect(f.calls).toEqual([{ siteKey: "site", tokenAtInit: "tok", autoRefresh: true }]);
  });

  test("V3 staging without a token (or an empty one) leaves the debug token unset but still inits", () => {
    for (const debugToken of [undefined, ""]) {
      const f = fakes();
      initAppCheck(APP, { appEnv: "staging", recaptchaSiteKey: "site", ...(debugToken === undefined ? {} : { debugToken }) }, f.deps);
      expect("FIREBASE_APPCHECK_DEBUG_TOKEN" in f.target).toBe(false);
      expect(f.calls).toHaveLength(1);
    }
  });

  test("V3 production never sets a debug token, even if one is passed", () => {
    const f = fakes();
    initAppCheck(APP, { appEnv: "production", recaptchaSiteKey: "site", debugToken: "tok" }, f.deps);
    expect("FIREBASE_APPCHECK_DEBUG_TOKEN" in f.target).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  test("V3 emulator skips App Check entirely: no init, no token", () => {
    const f = fakes();
    expect(initAppCheck(APP, { appEnv: "emulator", debugToken: "tok" }, f.deps)).toBeUndefined();
    expect("FIREBASE_APPCHECK_DEBUG_TOKEN" in f.target).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  test("V3 a non-emulator env without a site key is an error", () => {
    const f = fakes();
    expect(() => initAppCheck(APP, { appEnv: "staging" }, f.deps)).toThrow("site key");
    expect(f.calls).toHaveLength(0);
  });
});
