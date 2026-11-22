import { afterAll, expect, test } from "bun:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// T5: the Admin SDK reaches the Firestore emulator (FIRESTORE_EMULATOR_HOST is set by emulators:exec).
const app = initializeApp({ projectId: "demo-deepcuts" }, "harness");
const db = getFirestore(app);
afterAll(() => deleteApp(app));

test("T5 the Admin SDK can write and read a document through the Firestore emulator", async () => {
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBeTruthy();
  const ref = db.doc(`harness/${crypto.randomUUID()}`);
  try {
    await ref.set({ ok: true });
    expect((await ref.get()).data()).toEqual({ ok: true });
  } finally {
    await ref.delete();
  }
});
