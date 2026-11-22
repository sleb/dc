import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { beforeEmailSent as onBeforeEmailSent } from "firebase-functions/v2/identity";
import { defineCallable, RT } from "./api/callable";

// Throwaway probes (LLD 0 section 11): `ping` proves the Node bundle and runtime options, `diag` proves custom-token
// signing. #15 removes `diag`. Every name exported here is also in exports.json (check-bundle).

export const ping = defineCallable({
  name: "ping",
  allow: ["guest"],
  runtime: RT.command,
  handler: async () => ({ ok: true as const, node: process.version }),
});

// firebase-functions initializes its own *named* admin app (`__FIREBASE_FUNCTIONS_SDK__`), so "no apps at all" is not
// the same as "no default app": getAuth() and the rest of the admin SDK need the default one (proven on staging, #15).
function ensureDefaultApp(): void {
  if (!getApps().some((app) => app.name === "[DEFAULT]")) initializeApp();
}

export const diag = defineCallable({
  name: "diag",
  allow: ["guest"],
  runtime: RT.command,
  handler: async () => {
    ensureDefaultApp();
    return { ok: true as const, token: await getAuth().createCustomToken("seat:probe:probe") };
  },
});

// Throwaway pass-through (decision #7, LLD 5 section 8.1): it changes nothing about the email and is never invoked
// from this repo; its only purpose is to record whether the pinned firebase-functions and the deploy accept a
// blocking trigger at all. Removed as soon as the answer is recorded on #7.
export const beforeEmailSent = onBeforeEmailSent(() => undefined);
