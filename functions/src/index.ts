import { defineCallable, RT } from "./api/callable";

// Throwaway probe (LLD 0 section 11): `ping` proves the Node bundle and the runtime options on the deployed runtime.
// Every name exported here is also in exports.json (check-bundle), except the emulator-only names of exports.emulator.json, which are `undefined`
// outside the Functions emulator and so never deploy (#33).

export const ping = defineCallable({
  name: "ping",
  allow: ["guest"],
  runtime: RT.command,
  handler: async () => ({ ok: true as const, node: process.version }),
});

export { storeHarness } from "./harness/store";
