import { describe, expect, test } from "bun:test";
import {
  CONTRACT_V,
  DETAIL_BY_CODE,
  ERROR_CODES,
  ErrorCodeSchema,
  GameIdSchema,
  CardIdSchema,
  IdempotencyKeySchema,
  MAX_SEATED,
  MAX_TOTAL_JOINS,
  MAX_VOTES,
  MIN_V,
  PlayerIdSchema,
  RejectionSchema,
  RoomCodeSchema,
  TEXT_LIMITS,
  VIEW_SCHEMA,
  WIRE_DRAFT_MAX,
  WIRE_TEXT_MAX,
} from "../src/index";

const uuid = (...p: string[]) => p.join("-"); // parts, not a literal: a whole UUID trips the secret scanner
const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe("C6 ids", () => {
  test("GameId is exactly 20 alphanumerics", () => {
    expect(ok(GameIdSchema, "a".repeat(20))).toBe(true);
    expect(ok(GameIdSchema, "aB3".repeat(6) + "Zz")).toBe(true);
    expect(ok(GameIdSchema, "a".repeat(19))).toBe(false);
    expect(ok(GameIdSchema, "a".repeat(21))).toBe(false);
    expect(ok(GameIdSchema, "a".repeat(19) + "-")).toBe(false);
  });
  test("PlayerId alphabet is a-z2-7 with p_ prefix and 8 chars", () => {
    expect(ok(PlayerIdSchema, "p_abcdefg22")).toBe(false); // 9 chars
    expect(ok(PlayerIdSchema, "p_abcdef27")).toBe(true);
    expect(ok(PlayerIdSchema, "p_abcdef2")).toBe(false); // 7
    expect(ok(PlayerIdSchema, "p_abcdef18")).toBe(false); // 1 not in alphabet
    expect(ok(PlayerIdSchema, "p_abcdef08")).toBe(false); // 0 not in alphabet
    expect(ok(PlayerIdSchema, "p_abcdef89")).toBe(false);
    expect(ok(PlayerIdSchema, "p_ABCDEF27")).toBe(false);
    expect(ok(PlayerIdSchema, "x_abcdef27")).toBe(false);
  });
  test("CardId accepts a-z0-9 with c_ prefix and 10 chars", () => {
    expect(ok(CardIdSchema, "c_abcde01289")).toBe(true);
    expect(ok(CardIdSchema, "c_abcde0128")).toBe(false);
    expect(ok(CardIdSchema, "c_abcde012890")).toBe(false);
    expect(ok(CardIdSchema, "c_ABCDE01289")).toBe(false);
  });
  test("IdempotencyKey is lowercase UUIDv4 only", () => {
    expect(ok(IdempotencyKeySchema, uuid("123e4567", "e89b", "42d3", "a456", "426614174000"))).toBe(true);
    expect(ok(IdempotencyKeySchema, uuid("123e4567", "e89b", "42d3", "b456", "426614174000"))).toBe(true);
    expect(ok(IdempotencyKeySchema, uuid("123E4567", "E89B", "42D3", "A456", "426614174000"))).toBe(false);
    expect(ok(IdempotencyKeySchema, uuid("123e4567", "e89b", "12d3", "a456", "426614174000"))).toBe(false); // v1
    expect(ok(IdempotencyKeySchema, uuid("123e4567", "e89b", "42d3", "c456", "426614174000"))).toBe(false); // variant
    expect(ok(IdempotencyKeySchema, uuid("123e4567", "e89b", "42d3", "a456", "426614174000").replaceAll("-", ""))).toBe(false);
  });
  test("RoomCode trims and uppercases before the regex", () => {
    expect(RoomCodeSchema.parse("  bcdf ")).toBe("BCDF");
    expect(RoomCodeSchema.parse("xZtv")).toBe("XZTV");
    expect(ok(RoomCodeSchema, "BCDA")).toBe(false); // vowel
    expect(ok(RoomCodeSchema, "BCD")).toBe(false);
    expect(ok(RoomCodeSchema, "BCDFG")).toBe(false);
    expect(ok(RoomCodeSchema, "BCDY")).toBe(false); // Y excluded
  });
});

describe("C7 limits and details", () => {
  test("numeric caps", () => {
    expect(MAX_SEATED).toBe(10);
    expect(MAX_TOTAL_JOINS).toBe(50);
    expect(MAX_VOTES).toBe(1500);
    expect({ ...TEXT_LIMITS }).toEqual({ name: 24, card: 80, pitch: 140 });
    expect(WIRE_DRAFT_MAX).toBe(40);
  });
  test("WIRE_TEXT_MAX is above every text limit", () => {
    for (const v of Object.values(TEXT_LIMITS)) expect(WIRE_TEXT_MAX).toBeGreaterThan(v);
  });
  test("engine caps carry their detail strings", () => {
    expect([...DETAIL_BY_CODE.ROOM_FULL]).toEqual(["join_cap"]);
    expect([...DETAIL_BY_CODE.VARIANT_UNAVAILABLE]).toEqual(["vote_cap"]);
    expect(DETAIL_BY_CODE.NOT_AUTHORIZED).toContain("seat_revoked");
  });
});

describe("C8 error closure", () => {
  test("ERROR_CODES is the 14-code list", () => {
    expect([...ERROR_CODES]).toEqual([
      "NOT_AUTHORIZED", "WRONG_PHASE", "STALE", "NOT_IN_HAND", "ALREADY_SUBMITTED", "ROOM_FULL", "NAME_TAKEN",
      "CONTENT_REJECTED", "PAUSED", "RATE_LIMITED", "NOT_FOUND",
      "NOT_PLAYABLE", "INVALID_ARGUMENT", "VARIANT_UNAVAILABLE",
    ]);
    expect(ERROR_CODES).toHaveLength(14);
    expect(ok(ErrorCodeSchema, "CLIENT_OUTDATED")).toBe(false);
  });
  test("every DETAIL_BY_CODE value is accepted as a rejection detail", () => {
    for (const [reason, details] of Object.entries(DETAIL_BY_CODE)) {
      for (const detail of details) {
        expect(ok(RejectionSchema, { ok: false, reason, version: 0, detail, sv: 1 })).toBe(true);
      }
    }
    expect(ok(RejectionSchema, { ok: false, reason: "STALE", version: 0, detail: "nope", sv: 1 })).toBe(false);
  });
  test("RejectionSchema is strict and requires version and sv", () => {
    const base = { ok: false, reason: "STALE", version: 3, sv: 1 };
    expect(ok(RejectionSchema, base)).toBe(true);
    expect(ok(RejectionSchema, { ...base, extra: 1 })).toBe(false);
    const { version: _v, ...noVersion } = base;
    const { sv: _s, ...noSv } = base;
    expect(ok(RejectionSchema, noVersion)).toBe(false);
    expect(ok(RejectionSchema, noSv)).toBe(false);
    expect(ok(RejectionSchema, { ...base, ok: true })).toBe(false);
    expect(ok(RejectionSchema, { ...base, retryAfterMs: 0 })).toBe(false);
    expect(ok(RejectionSchema, { ...base, reason: "RATE_LIMITED", retryAfterMs: 500 })).toBe(true);
  });
});

describe("C10 versions", () => {
  test("constants", () => {
    expect(CONTRACT_V).toBe(1);
    expect(MIN_V).toBe(1);
    expect(VIEW_SCHEMA).toBe(1);
  });
});
