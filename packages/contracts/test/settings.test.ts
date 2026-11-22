import { describe, expect, test } from "bun:test";
import { SettingsPatchSchema } from "../src/index";

const ok = (v: unknown) => SettingsPatchSchema.safeParse(v).success;
const variants = { pitch: true, writeIn: false, redraw: false, peoplesChoice: false };

describe("C9 settings patch", () => {
  test("targetOverride is 2..10 or null", () => {
    expect(ok({ targetOverride: 2 })).toBe(true);
    expect(ok({ targetOverride: 10 })).toBe(true);
    expect(ok({ targetOverride: null })).toBe(true);
    expect(ok({ targetOverride: 1 })).toBe(false);
    expect(ok({ targetOverride: 11 })).toBe(false);
    expect(ok({ targetOverride: 2.5 })).toBe(false);
  });
  test("profanity is on or off", () => {
    expect(ok({ profanity: "on" })).toBe(true);
    expect(ok({ profanity: "off" })).toBe(true);
    expect(ok({ profanity: "maybe" })).toBe(false);
  });
  test("variants and spectators must be complete objects", () => {
    expect(ok({ variants })).toBe(true);
    expect(ok({ variants: { pitch: true } })).toBe(false);
    expect(ok({ spectators: { enabled: true, vote: false } })).toBe(true);
    expect(ok({ spectators: { enabled: true } })).toBe(false);
  });
  test("writeCountsOverride ranges 0..10 or null", () => {
    expect(ok({ writeCountsOverride: { red: 0, green: 10 } })).toBe(true);
    expect(ok({ writeCountsOverride: null })).toBe(true);
    expect(ok({ writeCountsOverride: { red: 11, green: 0 } })).toBe(false);
    expect(ok({ writeCountsOverride: { red: 0, green: -1 } })).toBe(false);
    expect(ok({ writeCountsOverride: { red: 1 } })).toBe(false);
  });
  test("empty patch parses; every key is optional", () => {
    expect(ok({})).toBe(true);
  });
});
