import type { FirebaseOptions } from "firebase/app";

export type AppEnv = "staging" | "production" | "emulator";
const APP_ENVS: readonly string[] = ["staging", "production", "emulator"];

export type WebConfig = {
  appEnv: AppEnv;
  functionsRegion: string;
  firebase: Required<Pick<FirebaseOptions, "apiKey" | "authDomain" | "projectId" | "storageBucket" | "messagingSenderId" | "appId">>;
  /** Required unless `appEnv` is "emulator" (the emulators do not enforce App Check). */
  recaptchaSiteKey?: string;
};

/** Reads the `VITE_*` values Vite loads from `.env.<mode>` (LLD 0 section 7). Throws naming the first missing key. */
export function readConfig(env: Record<string, string | undefined>): WebConfig {
  const need = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`${key} is missing from the web env (apps/web/.env.<mode>)`);
    return value;
  };
  const appEnv = need("VITE_APP_ENV");
  if (!APP_ENVS.includes(appEnv)) throw new Error(`VITE_APP_ENV must be one of ${APP_ENVS.join(", ")}, got "${appEnv}"`);
  const config: WebConfig = {
    appEnv: appEnv as AppEnv,
    functionsRegion: need("VITE_FUNCTIONS_REGION"),
    firebase: {
      apiKey: need("VITE_FIREBASE_API_KEY"),
      authDomain: need("VITE_FIREBASE_AUTH_DOMAIN"),
      projectId: need("VITE_FIREBASE_PROJECT_ID"),
      storageBucket: need("VITE_FIREBASE_STORAGE_BUCKET"),
      messagingSenderId: need("VITE_FIREBASE_MESSAGING_SENDER_ID"),
      appId: need("VITE_FIREBASE_APP_ID"),
    },
  };
  if (config.appEnv !== "emulator") config.recaptchaSiteKey = need("VITE_RECAPTCHA_SITE_KEY");
  return config;
}
