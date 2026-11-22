import * as logger from "firebase-functions/logger";

// The typed logger (LLD 0 section 9), complete since #17: every event and field of the section 9 tables. An event or a
// key not listed here is a type error, and the runtime drops a key that is not in KEYS. Events arrive with the emitters
// that write them (#38, #40, #44); until then only `api.done` and `api.error` have call sites.
export type LogEvent =
  | "command.done"
  | "command.rejected"
  | "txn.retry"
  | "store.size.warn"
  | "deletion.stuck"
  | "roomcode.collision"
  | "api.done"
  | "api.gate"
  | "api.detail.stripped"
  | "rate.limited"
  | "ip.unresolved"
  | "api.error"
  | "auth.join"
  | "auth.rejoin"
  | "auth.reissue"
  | "auth.revoke"
  | "auth.purge.partial"
  | "notify.row.done"
  | "notify.dedupe"
  | "notify.payload_invalid"
  | "notify.poison"
  | "push.result"
  | "push.register"
  | "push.unregister"
  | "reminder.sweep.done"
  | "reminder.sweep.game_failed"
  | "outbox.redrive";

export interface LogFields {
  event: LogEvent;
  callable?: string;
  principalKind?: "host" | "seat" | "spectator" | "guest" | "none";
  clientV?: number;
  gameId?: string;
  version?: number;
  commandType?: string;
  outcome?: "ok" | "rejected" | "error";
  /** An `ErrorCode`, or one of the log-only codes of LLD 5 section 9. Typed as `string` until `@dc/contracts` (#18). */
  reason?: string;
  playerId?: string;
  latencyMs?: number;
  attempts?: number;
  replay?: boolean;
  bucket?: string;
  retryAfterMs?: number;
  rowId?: string;
  kind?: string;
  recipients?: number;
  devices?: number;
  eventToFcmMs?: number;
  result?: "sent" | "failed" | "pruned" | "invalid_argument";
  ipHash?: string;
  uidHash?: string;
  count?: number;
  sent?: number;
  pruned?: number;
  failed?: number;
  skipped?: number;
  pages?: number;
  listed?: number;
  replayed?: number;
  noop?: number;
}

// The runtime allowlist mirrors LogFields (a key missing here is dropped even if a caller bypasses the types).
export const KEYS = [
  "event",
  "callable",
  "principalKind",
  "clientV",
  "gameId",
  "version",
  "commandType",
  "outcome",
  "reason",
  "playerId",
  "latencyMs",
  "attempts",
  "replay",
  "bucket",
  "retryAfterMs",
  "rowId",
  "kind",
  "recipients",
  "devices",
  "eventToFcmMs",
  "result",
  "ipHash",
  "uidHash",
  "count",
  "sent",
  "pruned",
  "failed",
  "skipped",
  "pages",
  "listed",
  "replayed",
  "noop",
] as const satisfies readonly (keyof LogFields)[];

/** Writes one structured line. Unknown keys are a type error and are dropped at runtime. */
export function log(fields: LogFields): void {
  const entry: Record<string, unknown> = {};
  for (const k of KEYS) if (fields[k] !== undefined) entry[k] = fields[k];
  logger.write({ severity: fields.outcome === "error" ? "ERROR" : fields.outcome === "rejected" ? "WARNING" : "INFO", message: String(fields.event), ...entry });
}

/** Logs an unexpected failure as an Error Reporting entry (message and stack of the Error only, no request data). */
export function logError(e: unknown): void {
  const err = e instanceof Error ? e : new Error(String(e));
  logger.write({ severity: "ERROR", message: err.stack ?? err.message, event: "api.error" });
}
