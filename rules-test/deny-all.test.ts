import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { assertFails, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";

// T4: starts against the Firestore emulator (test:rules) with the ruleset `firebase deploy` uploads, read from disk.
// Until #32 that file is deny-all; #32 adds the per-collection P10 denial matrix against the same file, so a rule
// change is tested before it is deployed. This suite proves the file is deny-all, not that it is deployed: that is
// check V9 in #15.
const RULES = join(import.meta.dir, "../firestore.rules");
if (!(await Bun.file(RULES).exists())) throw new Error(`firestore.rules is missing (${RULES}); test:rules loads the deployed file`);

const env = await initializeTestEnvironment({ projectId: "demo-deepcuts", firestore: { rules: await Bun.file(RULES).text() } });
afterAll(() => env.cleanup());

test("T4 the deployed ruleset denies an authenticated read", async () => {
  const db = env.authenticatedContext("seat:g:a").firestore();
  await assertFails(getDoc(doc(db, "games/g1")));
});

test("T4 the deployed ruleset denies an unauthenticated write", async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(setDoc(doc(db, "games/g1"), { a: 1 }));
});
