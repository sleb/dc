// Store failures (LLD 3 section 5.8). A failure is thrown, never returned; a rejection is a returned outcome. `kind`, not `code`: the Firestore SDK
// retries a callback error whose numeric `code` is retryable (ABORTED, UNAVAILABLE, ...), and a StoreError must never be retried that way.
import { EngineInvariantError } from "@dc/engine";

export type StoreErrorKind = "CONTENTION" | "UNAVAILABLE" | "INVARIANT" | "AGGREGATE_TOO_LARGE" | "TOO_MANY_WRITES" | "ROOM_CODES_EXHAUSTED";

export class StoreError extends Error {
  constructor(readonly kind: StoreErrorKind, message: string, options?: { cause?: unknown }) {
    super(`${kind}: ${message}`, options);
    this.name = "StoreError";
  }
}

const GRPC = { CANCELLED: 1, UNKNOWN: 2, DEADLINE_EXCEEDED: 4, ALREADY_EXISTS: 6, RESOURCE_EXHAUSTED: 8, ABORTED: 10, INTERNAL: 13, UNAVAILABLE: 14 } as const;
/** Codes after which a commit may have landed: the SDK treats them as transient (`isRetryableTransactionError`), so they are not "nothing committed" (review #33). UNAUTHENTICATED (16) stays INVARIANT. */
const MAY_HAVE_COMMITTED: ReadonlySet<unknown> = new Set([GRPC.UNAVAILABLE, GRPC.DEADLINE_EXCEEDED, GRPC.CANCELLED, GRPC.UNKNOWN, GRPC.RESOURCE_EXHAUSTED, GRPC.INTERNAL]);

/** Maps whatever escaped the transaction. The message carries the cause's name and code only, never its message (it may hold payload). */
export function mapStoreError(e: unknown, attempts: number): StoreError {
  if (e instanceof StoreError) return e;
  const code = (e as { code?: unknown } | null)?.code;
  const name = e instanceof Error ? e.name : typeof e;
  const what = `${name}${code === undefined ? "" : ` code ${String(code)}`}`;
  const cause = { cause: e };
  if (code === GRPC.ABORTED || code === 409) return new StoreError("CONTENTION", `aborted after ${attempts} attempt(s) (${what})`, cause);
  if (MAY_HAVE_COMMITTED.has(code)) return new StoreError("UNAVAILABLE", `the commit may have happened (${what})`, cause);
  if (code === GRPC.ALREADY_EXISTS) return new StoreError("INVARIANT", `ALREADY_EXISTS on a create (${what})`, cause);
  if (e instanceof EngineInvariantError) return new StoreError("INVARIANT", "engine invariant", cause);
  return new StoreError("INVARIANT", what, cause);
}
