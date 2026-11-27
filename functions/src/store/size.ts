// The aggregate size guard (LLD 3 section 2.5, ST6).
import { StoreError } from "./errors";

export const WARN_BYTES = 600 * 1024;
export const HARD_BYTES = 900 * 1024;

export function estimateBytes(doc: unknown): number {
  return Math.ceil(1.15 * Buffer.byteLength(JSON.stringify(doc), "utf8"));
}

/**
 * Throws AGGREGATE_TOO_LARGE above the hard limit unless the write does not grow the doc, or `escape` is set (endGame, the host's way out, 5.7: it
 * changes no content but can grow by a few bytes of `version` and `store.updatedAt` digits); `warn` asks the caller to log `store.size.warn` after
 * the transaction.
 */
export function guardSize(next: unknown, prev: unknown, o: { escape?: boolean } = {}): { warn: boolean } {
  const n = estimateBytes(next);
  if (n > HARD_BYTES && o.escape !== true && n > estimateBytes(prev)) throw new StoreError("AGGREGATE_TOO_LARGE", `aggregate estimate ${n} bytes over ${HARD_BYTES}`);
  return { warn: n > WARN_BYTES };
}
