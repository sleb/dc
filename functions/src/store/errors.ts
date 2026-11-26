export type StoreErrorKind = "CONTENTION" | "UNAVAILABLE" | "INVARIANT" | "AGGREGATE_TOO_LARGE" | "TOO_MANY_WRITES";
export class StoreError extends Error {
  constructor(readonly kind: StoreErrorKind, message: string) {
    super(message);
  }
}
export function mapStoreError(_e: unknown, _attempts: number): StoreError {
  throw new Error("red: not implemented");
}
