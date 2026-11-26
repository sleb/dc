import type { Command } from "@dc/contracts";
import type { Accepted, Game } from "@dc/engine";
import type { OutboxRow } from "./types";
export const NOTIFY_EVENTS: ReadonlySet<string> = new Set();
export const IDENTITY_EVENTS: ReadonlySet<string> = new Set();
export function buildOutbox(_prev: Game, _next: Game, _cmd: Command, _a: Accepted, _now: number): OutboxRow[] {
  return [];
}
