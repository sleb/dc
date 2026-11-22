import type { FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from "firebase/app-check";
import type { AppEnv } from "./config";

export type AppCheckDeps = {
  /** Where the SDK looks for `FIREBASE_APPCHECK_DEBUG_TOKEN` (the global object in a browser). */
  target: { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean };
  init: typeof initializeAppCheck;
  makeProvider: (siteKey: string) => ReCaptchaEnterpriseProvider;
};

const realDeps = (): AppCheckDeps => ({
  target: globalThis as AppCheckDeps["target"],
  init: initializeAppCheck,
  makeProvider: (siteKey) => new ReCaptchaEnterpriseProvider(siteKey),
});

export type AppCheckOptions = { appEnv: AppEnv; recaptchaSiteKey?: string | undefined; debugToken?: string | undefined };

/**
 * App Check for one Firebase app (LLD 7 section 3.1); call it before any callable or listener on that app.
 * The emulator build skips it (the emulators do not enforce App Check) and returns undefined. The debug token is
 * used only for staging, and only when set; production never sees it (vite.config.ts also refuses to build one).
 */
export function initAppCheck(app: FirebaseApp, options: AppCheckOptions, deps: AppCheckDeps = realDeps()): AppCheck | undefined {
  if (options.appEnv === "emulator") return undefined;
  if (!options.recaptchaSiteKey) throw new Error("App Check needs the reCAPTCHA site key (VITE_RECAPTCHA_SITE_KEY)");
  if (options.appEnv === "staging" && options.debugToken) deps.target.FIREBASE_APPCHECK_DEBUG_TOKEN = options.debugToken;
  return deps.init(app, { provider: deps.makeProvider(options.recaptchaSiteKey), isTokenAutoRefreshEnabled: true });
}
