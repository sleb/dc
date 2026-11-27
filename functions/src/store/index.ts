// The Store's public surface (LLD 3, #33). createGame (#34), rebuildViews and listWaitingOn (#35) and the deletion cascade (#36) build on these.
export { StoreError, mapStoreError } from "./errors";
export type { StoreErrorKind } from "./errors";
export { eventDoc } from "./events";
export { idemId } from "./idem";
export { load } from "./load";
export { IDENTITY_EVENTS, NOTIFY_EVENTS, buildOutbox } from "./outbox";
export { IDEM_TTL_MS, extraReadPaths, planCommand, splitStore, viewFor } from "./plan";
export type { Plan, PlanDeps, Reads } from "./plan";
export { redact, roundsContaining } from "./redact";
export * as paths from "./refs";
export { MAX_ATTEMPTS, execute, runCommand } from "./run";
export type { Execution } from "./run";
export { HARD_BYTES, WARN_BYTES, estimateBytes, guardSize } from "./size";
export type { CommandInput, CommandOutcome, Deps, DraftDoc, EventDoc, FaultHooks, FaultPoint, GameDoc, IdemDoc, Json, OutboxRow, StoreMeta } from "./types";
export { MAX_WRITES, WriteSet, applyWrites, increment } from "./writeset";
export type { DocWrite } from "./writeset";
