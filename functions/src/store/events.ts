import type { Command, PlayerId } from "@dc/contracts";
import type { Accepted } from "@dc/engine";
import type { EventDoc } from "./types";
export function eventDoc(_v: number, _now: number, _a: Accepted, _cmd: Command, _seed: string, _me: PlayerId | null): EventDoc {
  throw new Error("red: not implemented");
}
