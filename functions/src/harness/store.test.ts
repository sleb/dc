import { afterEach, expect, test } from "bun:test";
import { HttpsError } from "firebase-functions/v2/https";
import { handleStoreHarness } from "./store";

// H2 (#33): the harness refuses outside the Functions emulator even if its export is reached (the export gate is H1, check-bundle).
const saved = process.env["FUNCTIONS_EMULATOR"];
afterEach(() => {
  if (saved === undefined) delete process.env["FUNCTIONS_EMULATOR"];
  else process.env["FUNCTIONS_EMULATOR"] = saved;
});

for (const value of [undefined, "false", "1", "TRUE"]) {
  test(`H2 the handler refuses with failed-precondition when FUNCTIONS_EMULATOR is ${String(value)}`, async () => {
    if (value === undefined) delete process.env["FUNCTIONS_EMULATOR"];
    else process.env["FUNCTIONS_EMULATOR"] = value;
    const err = await handleStoreHarness({ op: "load", gameId: "gaaaaaaaaaaaaaaaaaaa" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HttpsError);
    expect((err as HttpsError).code).toBe("failed-precondition");
  });
}
