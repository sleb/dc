// The idempotency ledger id (LLD 3 section 2.4): client keys never become document ids directly.
import { createHash } from "node:crypto";
import type { Actor } from "@dc/engine";

export function idemId(actor: Actor, key: string): string {
  const actorKey = actor.kind === "user" ? actor.uid : "system";
  return createHash("sha256").update(`${actorKey}\u0000${key}`).digest("base64url");
}
