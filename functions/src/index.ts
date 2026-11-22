import { defineCallable, RT } from "./api/callable";

// Throwaway probe (LLD 0 section 11): `ping` proves the Node bundle and the runtime options on the deployed runtime.
// Every name exported here is also in exports.json (check-bundle).

export const ping = defineCallable({
  name: "ping",
  allow: ["guest"],
  runtime: RT.command,
  handler: async () => ({ ok: true as const, node: process.version }),
});
