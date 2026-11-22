import { expect, test } from "bun:test";
import { initializeApp } from "firebase/app";
import { CustomProvider, initializeAppCheck } from "firebase/app-check";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

// P19 harness input (LLD 0, issue #16). Sentinel strings go into every user-supplied field of one accepted call and
// one rejected call. This test only sends them; the harness (`bun run test:integration:logs`, scripts/run-integration-sentinels.ts)
// captures what the emulators print and fails the run if a sentinel reached a log line. The full-game version, with
// real fields, arrives with #40 and #44.
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({ app_id: "demo-app", sub: "demo-app", iss: "demo", aud: ["demo"], exp: 4_102_444_800 })}.x`;
const SENTINEL_FIELDS = { displayName: "NAME-SENTINEL-ping", card: "CARD-SENTINEL-ping", email: "sentinel@example.test" };

function client(name: string, withAppCheck: boolean) {
  const app = initializeApp({ projectId: "demo-deepcuts", apiKey: "demo", appId: "demo-app" }, name);
  if (withAppCheck) initializeAppCheck(app, { provider: new CustomProvider({ getToken: async () => ({ token: fakeToken, expireTimeMillis: 4_102_444_800_000 }) }) });
  const fns = getFunctions(app, "us-central1");
  connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  return fns;
}

test("L1 an accepted call carrying sentinels succeeds", async () => {
  const res = await httpsCallable<unknown, { ok: boolean }>(client("sentinel-ok", true), "ping")(SENTINEL_FIELDS);
  expect(res.data.ok).toBe(true);
});

test("L1 a rejected call (no App Check token) carrying sentinels is refused", async () => {
  const call = httpsCallable(client("sentinel-rejected", false), "ping");
  await expect(call({ ...SENTINEL_FIELDS, displayName: "NAME-SENTINEL-rejected" })).rejects.toMatchObject({ code: "functions/unauthenticated" });
});
