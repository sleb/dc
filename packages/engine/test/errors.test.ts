import { describe, expect, test } from "bun:test";
import { DETAIL_BY_CODE, ERROR_CODES } from "@dc/contracts";
import type { ErrorCode } from "@dc/contracts";
import { EngineInvariantError, reject } from "../src/errors";
import type { Rejection } from "../src/types";

describe("V3 reject", () => {
  test("builds {code} without a detail key, and {code, detail} with one", () => {
    expect(reject("STALE")).toStrictEqual({ code: "STALE" });
    expect(reject("WRONG_PHASE", "finished")).toStrictEqual({ code: "WRONG_PHASE", detail: "finished" });
    expect(reject("WRONG_PHASE")).toStrictEqual({ code: "WRONG_PHASE" });
  });

  test("every detail in DETAIL_BY_CODE is accepted for its code", () => {
    for (const [code, details] of Object.entries(DETAIL_BY_CODE)) {
      for (const d of details) expect((reject as (c: ErrorCode, d?: string) => Rejection)(code as ErrorCode, d)).toStrictEqual({ code: code as ErrorCode, detail: d });
    }
    expect(ERROR_CODES.length).toBeGreaterThan(0);
  });

  test("the detail is typed per code (checked by tsc over this file)", () => {
    reject("NOT_AUTHORIZED", "sitting_out");
    reject("CONTENT_REJECTED", "PROFANITY");
    reject("NOT_PLAYABLE", "below_minimum");
    reject("ROOM_FULL", "join_cap");
    reject("VARIANT_UNAVAILABLE", "vote_cap");
    reject("NOT_FOUND", "seat_replaced");
    // @ts-expect-error STALE never carries a detail
    reject("STALE", "finished");
    // @ts-expect-error "finished" belongs to WRONG_PHASE, not NOT_PLAYABLE
    reject("NOT_PLAYABLE", "finished");
    // @ts-expect-error INVALID_ARGUMENT never carries a detail
    reject("INVALID_ARGUMENT", "x");
    // @ts-expect-error not an error code
    reject("NOPE");
    expect(true).toBe(true);
  });
});

describe("V3 EngineInvariantError", () => {
  test("is an Error with a stable name and message", () => {
    const e = new EngineInvariantError("green deck empty");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(EngineInvariantError);
    expect(e.name).toBe("EngineInvariantError");
    expect(e.message).toBe("green deck empty");
  });
});
