import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { defineCallable, RT } from "./api/callable";

// Throwaway probes (LLD 0 section 11): `ping` proves the Node bundle and runtime options, `diag` proves custom-token
// signing. #15 removes `diag`. Every name exported here is also in exports.json (check-bundle).

export const ping = defineCallable({
  name: "ping",
  allow: ["guest"],
  runtime: RT.command,
  handler: async () => ({ ok: true as const, node: process.version }),
});

export const diag = defineCallable({
  name: "diag",
  allow: ["guest"],
  runtime: RT.command,
  handler: async () => {
    if (getApps().length === 0) initializeApp();
    return { ok: true as const, token: await getAuth().createCustomToken("seat:probe:probe") };
  },
});
