// Store failures (LLD 3 section 5.8). A failure is thrown, never returned; a rejection is a returned outcome. `kind`, not `code`: the Firestore SDK
// retries a callback error whose numeric `code` is retryable (ABORTED, UNAVAILABLE, ...), and a StoreError must never be retried that way.
import { EngineInvariantError } from "@dc/engine";

export type StoreErrorKind = "CONTENTION" | "UNAVAILABLE" | "INVARIANT" | "AGGREGATE_TOO_LARGE" | "TOO_MANY_WRITES";

export class StoreError extends Error {
  constructor(readonly kind: StoreErrorKind, message: string, options?: { cause?: unknown }) {
    super(`${kind}: ${message}`, options);
    this.name = "StoreError";
  }
}

const GRPC = { DEADLINE_EXCEEDED: 4, ALREADY_EXISTS: 6, ABORTED: 10, UNAVAILABLE: 14 } as const;

/** Maps whatever escaped the transaction. The message carries the cause's name and code only, never its message (it may hold payload). */
export function mapStoreError(e: unknown, attempts: number): StoreError {
  if (e instanceof StoreError) return e;
  const code = (e as { code?: unknown } | null)?.code;
  const name = e instanceof Error ? e.name : typeof e;
  const what = `${name}${code === undefined ? "" : ` code ${String(code)}`}`;
  const cause = { cause: e };
  if (code === GRPC.ABORTED || code === 409) return new StoreError("CONTENTION", `aborted after ${attempts} attempt(s) (${what})`, cause);
  if (code === GRPC.UNAVAILABLE || code === GRPC.DEADLINE_EXCEEDED) return new StoreError("UNAVAILABLE", `the commit may have happened (${what})`, cause);
  if (e instanceof EngineInvariantError) return new StoreError("INVARIANT", "engine invariant", cause);
  return new StoreError("INVARIANT", what, cause);
}
