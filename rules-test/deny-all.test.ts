import { afterAll, expect, test } from "bun:test";
import { assertFails, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc } from "firebase/firestore";

// T4: starts against the Firestore emulator (test:rules). Inline deny-all rules; the real firestore.rules and the
// P10 per-collection denial checks arrive with #32.
const env = await initializeTestEnvironment({
  projectId: "demo-deepcuts",
  firestore: { rules: "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /{d=**} { allow read, write: if false; } } }" },
});
afterAll(() => env.cleanup());

test("T4 a deny-all ruleset denies an authenticated read", async () => {
  const db = env.authenticatedContext("seat:g:a").firestore();
  await assertFails(getDoc(doc(db, "games/g1")));
});
