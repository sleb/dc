import { expect, test } from "bun:test";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// T5: the Admin SDK reaches the Firestore emulator (FIRESTORE_EMULATOR_HOST is set by emulators:exec).
const db = getFirestore(initializeApp({ projectId: "demo-deepcuts" }, "harness"));

test("T5 the Admin SDK can write and read a document through the Firestore emulator", async () => {
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBeTruthy();
  const ref = db.doc(`harness/${crypto.randomUUID()}`);
  await ref.set({ ok: true });
  expect((await ref.get()).data()).toEqual({ ok: true });
  await ref.delete();
});
