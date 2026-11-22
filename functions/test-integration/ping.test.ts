import { expect, test } from "bun:test";
import { initializeApp } from "firebase/app";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

// Runs against functions/dist through the Auth and Functions emulators (P9). App Check is not enforced there.
const app = initializeApp({ projectId: "demo-deepcuts", apiKey: "demo" });
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
