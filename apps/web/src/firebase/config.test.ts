import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadEnv } from "vite";
import { readConfig } from "./config";

const WEB_ROOT = join(import.meta.dir, "../..");
const fromMode = (mode: string) => loadEnv(mode, WEB_ROOT, "VITE_");

describe("firebase/config", () => {
  test("V2 the staging env file loads by mode with the Firebase keys and the site key", () => {
    const c = readConfig(fromMode("staging"));
    expect(c.appEnv).toBe("staging");
    expect(c.firebase.projectId).toBe("deepcuts-staging");
    for (const key of ["apiKey", "authDomain", "storageBucket", "messagingSenderId", "appId"] as const) expect(c.firebase[key]).toBeTruthy();
    expect(c.recaptchaSiteKey).toBeTruthy();
    expect(c.functionsRegion).toBe("us-central1");
  });

  test("V2 the emulator env file loads by mode: emulator app env and the demo project", () => {
    const c = readConfig(fromMode("emulator"));
    expect(c.appEnv).toBe("emulator");
    expect(c.firebase.projectId).toBe("demo-deepcuts");
    expect(c.functionsRegion).toBe("us-central1");
  });

  test("V2 a missing key or an unknown VITE_APP_ENV is an error that names it", () => {
    const env = { ...fromMode("staging") };
    delete env["VITE_FIREBASE_API_KEY"];
    expect(() => readConfig(env)).toThrow("VITE_FIREBASE_API_KEY");
    expect(() => readConfig({ ...fromMode("staging"), VITE_APP_ENV: "qa" })).toThrow("VITE_APP_ENV");
  });

  test("V2 the site key is required outside the emulator", () => {
    const env = { ...fromMode("staging") };
    delete env["VITE_RECAPTCHA_SITE_KEY"];
    expect(() => readConfig(env)).toThrow("VITE_RECAPTCHA_SITE_KEY");
  });
});
