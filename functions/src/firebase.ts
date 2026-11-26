// The default Admin app and Firestore handle, created lazily on first use. firebase-functions initializes its own *named* app, so the test is for the
// default app by name, not `getApps().length` (functions/README.md, #15). `ignoreUndefinedProperties` stays false: an `undefined` is a bug and fails loudly (LLD 3 section 2.2).
import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";

let firestore: Firestore | null = null;

export function db(): Firestore {
  if (firestore === null) {
    const app = getApps().some((a) => a.name === "[DEFAULT]") ? getApp() : initializeApp();
    firestore = getFirestore(app);
  }
  return firestore;
}
