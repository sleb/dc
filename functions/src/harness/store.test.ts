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

// H2 (#34): the gate precedes op dispatch, so the new ops are refused with the same code rather than reaching the store.
for (const request of [
  { op: "createGame", hostId: "host-1", hostName: "NAME-SENTINEL-host", idemKey: "idem-1" },
  { op: "findByRoomCode", code: "BCDF" },
]) {
  test(`H2 ${request.op} is refused with failed-precondition when the gate is off`, async () => {
    delete process.env["FUNCTIONS_EMULATOR"];
    const err = await handleStoreHarness(request).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HttpsError);
    expect((err as HttpsError).code).toBe("failed-precondition");
  });
}
