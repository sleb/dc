// The event log (LLD 3 section 9): one doc per committed version. With `redactEnvelope` (finishWriting, importDeck, writeIn) neither the seed nor the
// actor is stored, so no stored event can be joined with the state to recover who authored a pooled card (E8, C-EV, ST15).
import type { Command, PlayerId } from "@dc/contracts";
import type { Accepted } from "@dc/engine";
import type { EventDoc } from "./types";

/** The command type every stored doc and log line records: a write-in looks like a hand play (K-A), so `writeIn` is `confirmSubmission`. */
export function publicCommandType(cmd: Command): Command["type"] {
  return cmd.type === "writeIn" ? "confirmSubmission" : cmd.type;
}

export function eventDoc(version: number, now: number, a: Accepted, cmd: Command, seed: string, me: PlayerId | null): EventDoc {
  const commandType = publicCommandType(cmd);
  const redacted = a.redactEnvelope || cmd.type === "writeIn";
  return { version, at: now, commandType, events: a.events, ...(redacted ? {} : { seed, ...(me === null ? {} : { actorPlayerId: me }) }) };
}
