import { z } from "zod";

export const ERROR_CODES = [
  "NOT_AUTHORIZED", "WRONG_PHASE", "STALE", "NOT_IN_HAND", "ALREADY_SUBMITTED", "ROOM_FULL", "NAME_TAKEN",
  "CONTENT_REJECTED", "PAUSED", "RATE_LIMITED", "NOT_FOUND",
  "NOT_PLAYABLE", "INVALID_ARGUMENT", "VARIANT_UNAVAILABLE",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** Closed set of `detail` strings per code. STALE, NOT_IN_HAND, ALREADY_SUBMITTED, NAME_TAKEN, PAUSED, RATE_LIMITED and INVALID_ARGUMENT never carry one. */
export const DETAIL_BY_CODE = {
  CONTENT_REJECTED: ["EMPTY", "TOO_LONG", "INVALID_CHARS", "PROFANITY"],
  NOT_PLAYABLE: ["below_minimum", "players", "minimums", "no_submissions", "incomplete", "no_replacement"],
  WRONG_PHASE: ["finished"],
  NOT_AUTHORIZED: ["sitting_out", "own_card", "seat_revoked"],
  ROOM_FULL: ["join_cap"],
  VARIANT_UNAVAILABLE: ["vote_cap"],
  NOT_FOUND: ["seat_replaced"],
} as const satisfies Partial<Record<ErrorCode, readonly string[]>>;

/** HttpsError details only, never in a body. */
export const GATE_REASONS = ["CLIENT_OUTDATED"] as const;

export const REJECTION_DETAILS = [...new Set(Object.values(DETAIL_BY_CODE).flat())] as [string, ...string[]];

export const RejectionSchema = z.strictObject({
  ok: z.literal(false),
  reason: ErrorCodeSchema,
  /** Aggregate version the rejection was decided against; 0 when no game state was read. */
  version: z.number().int().nonnegative(),
  detail: z.enum(REJECTION_DETAILS).optional(),
  /** RATE_LIMITED only. */
  retryAfterMs: z.number().int().positive().optional(),
  sv: z.number().int(),
});
export type Rejection = z.infer<typeof RejectionSchema>;
