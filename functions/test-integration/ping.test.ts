import { expect, test } from "bun:test";
import { initializeApp } from "firebase/app";
import { CustomProvider, initializeAppCheck } from "firebase/app-check";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

// Runs against functions/dist through the Auth and Functions emulators (P9).
// The emulator (skipTokenVerification) does not verify an App Check token, but with `enforceAppCheck: true` it still
// rejects a request that carries none, so the client sends a well-formed, unsigned one. Real enforcement: #15 smoke test.
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({ app_id: "demo-app", sub: "demo-app", iss: "demo", aud: ["demo"], exp: 4_102_444_800 })}.x`;
const app = initializeApp({ projectId: "demo-deepcuts", apiKey: "demo", appId: "demo-app" });
initializeAppCheck(app, { provider: new CustomProvider({ getToken: async () => ({ token: fakeToken, expireTimeMillis: 4_102_444_800_000 }) }) });
const fns = getFunctions(app, "us-central1");
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

test("I1 ping returns ok and a Node 22 version (P9)", async () => {
  const res = await httpsCallable<unknown, { ok: boolean; node: string }>(fns, "ping")({});
  expect(res.data.ok).toBe(true);
  expect(res.data.node.startsWith("v22")).toBe(true);
});

test("I2 diag returns a custom token whose uid is seat:probe:probe", async () => {
  const res = await httpsCallable<unknown, { ok: boolean; token: string }>(fns, "diag")({});
  const payload = JSON.parse(Buffer.from(res.data.token.split(".")[1] ?? "", "base64url").toString()) as { uid: string };
  expect(payload.uid).toBe("seat:probe:probe");
});
