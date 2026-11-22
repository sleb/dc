import * as logger from "firebase-functions/logger";

// The typed logger (LLD 0 section 9). Minimal for now: only the fields and events the wrapper emits.
// #17 extends the field set and the event list; every addition is a type change here first.
export type LogEvent = "api.done";

export interface LogFields {
  event: LogEvent;
  callable?: string;
  principalKind?: "host" | "seat" | "spectator" | "guest" | "none";
  clientV?: number;
  outcome?: "ok" | "rejected" | "error";
  reason?: string;
  latencyMs?: number;
}

// The runtime allowlist mirrors LogFields (a key missing here is dropped even if a caller bypasses the types).
const KEYS = ["event", "callable", "principalKind", "clientV", "outcome", "reason", "latencyMs"] as const satisfies readonly (keyof LogFields)[];

/** Writes one structured line. Unknown keys are a type error and are dropped at runtime. */
export function log(fields: LogFields): void {
  const entry: Record<string, unknown> = {};
  for (const k of KEYS) if (fields[k] !== undefined) entry[k] = fields[k];
  logger.write({ severity: fields.outcome === "error" ? "ERROR" : "INFO", message: String(fields.event), ...entry });
}
