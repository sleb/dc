// Production Store dependencies (LLD 3 section 5.1): the wall clock and CSPRNG seeds and card ids. No fault hooks: those exist only in the
// emulator-only harness (src/harness/store.ts).
import { randomBytes } from "node:crypto";
import type { Deps } from "./store";

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `c_` + 10 characters of [a-z0-9] (CardIdSchema), uniform by rejection sampling. */
export function newCardId(): string {
  let out = "c_";
  while (out.length < 12) {
    for (const b of randomBytes(16)) {
      if (b >= 252) continue; // 252 = 7 x 36: the unbiased range
      out += ID_ALPHABET[b % 36] ?? "";
      if (out.length === 12) break;
    }
  }
  return out;
}

export const productionDeps: Deps = {
  clock: () => Date.now(),
  newSeed: () => randomBytes(16).toString("base64url"),
  mintId: newCardId,
};
