import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { defaultTarget, gMin, meetsMinimums, rMin, totals, writeCounts } from "../src/rules/playability";
import { addCard, cid, makeGame, makePlayer, pid } from "./support/factories";
import { assertProperty } from "./support/fc";

// E7, formula half (LLD 1 section 9): pinned by the 9.3 worked examples, then a property against an independent implementation.
describe("E7 formulas (9.1)", () => {
  test("rMin = 7n + max(2n, 7) and gMin = n * t, pinned at the table's values", () => {
    expect(rMin(3)).toBe(28);
    expect(rMin(4)).toBe(36);
    expect(rMin(5)).toBe(45);
    expect(rMin(10)).toBe(90);
    expect(gMin(3, 8)).toBe(24);
    expect(gMin(10, 4)).toBe(40);
  });

  test("defaultTarget: 8 for 3 and 4 players, then 7, 6, 5, and 4 from 8 up", () => {
    expect([3, 4, 5, 6, 7, 8, 9, 10].map(defaultTarget)).toEqual([8, 8, 7, 6, 5, 4, 4, 4]);
  });

  test("meetsMinimums is >= on both colors, and neither alone suffices", () => {
    expect(meetsMinimums({ red: 28, green: 24 }, 3, 8)).toBe(true);
    expect(meetsMinimums({ red: 27, green: 24 }, 3, 8)).toBe(false);
    expect(meetsMinimums({ red: 28, green: 23 }, 3, 8)).toBe(false);
    expect(meetsMinimums({ red: 100, green: 40 }, 10, 4)).toBe(true);
  });

  test("totals counts every registry card of each kind in every zone, hands and scores included", () => {
    let g = makeGame({ players: [makePlayer(0), makePlayer(1)] });
    expect(totals(g)).toEqual({ red: 0, green: 0 });
    g = addCard(g, cid(1), "red", "redDeck");
    g = addCard(g, cid(2), "red", "redDiscard");
    g = addCard(g, cid(3), "red", { hand: pid(0) });
    g = addCard(g, cid(4), "green", "greenDeck");
    g = addCard(g, cid(5), "green", "greenDiscard");
    g = addCard(g, cid(6), "green", { scorePile: pid(1) });
    g = addCard(g, cid(7), "green", { scorePile: pid(1) });
    expect(totals(g)).toEqual({ red: 3, green: 4 });
  });
});

describe("E7 writeCounts (9.3), one test per worked example", () => {
  test("new deck, small: n=3, T=8, nothing imported -> 10 red, 8 green, which meets both minimums", () => {
    expect(writeCounts(3, 8, { red: 0, green: 0 }, null)).toEqual({ red: 10, green: 8 });
    expect(meetsMinimums({ red: 30, green: 24 }, 3, 8)).toBe(true);
  });

  test("new deck, full table: n=10, T=4 -> 10 and 4, totals 100 and 40", () => {
    expect(writeCounts(10, 4, { red: 0, green: 0 }, null)).toEqual({ red: 10, green: 4 });
  });

  test("reused deck, partial: n=5, T=7, existing 20 red and 10 green -> 5 and 5", () => {
    expect(writeCounts(5, 7, { red: 20, green: 10 }, null)).toEqual({ red: 5, green: 5 });
  });

  test("reused deck suffices: n=4, T=8, existing 40 red and 32 green -> nothing to write", () => {
    expect(writeCounts(4, 8, { red: 40, green: 32 }, null)).toEqual({ red: 0, green: 0 });
  });

  test("a reused deck short in one color only still asks for the other color's zero", () => {
    expect(writeCounts(4, 8, { red: 36, green: 1 }, null)).toEqual({ red: 0, green: 8 });
  });

  test("override accepted when the minimums still hold, including a partial reduction", () => {
    expect(writeCounts(4, 8, { red: 40, green: 32 }, { red: 0, green: 0 })).toEqual({ red: 0, green: 0 });
    expect(writeCounts(4, 8, { red: 30, green: 32 }, { red: 2, green: 0 })).toEqual({ red: 2, green: 0 });
  });

  test("override too low: n=4, T=8, existing 30 red and 32 green, override (1, 0) -> unmet", () => {
    expect(writeCounts(4, 8, { red: 30, green: 32 }, { red: 1, green: 0 })).toBe("unmet");
  });

  test("override out of range (red > 10, green > T, negative) is unmet even when the minimums would hold", () => {
    expect(writeCounts(3, 8, { red: 50, green: 50 }, { red: 11, green: 0 })).toBe("unmet");
    expect(writeCounts(3, 8, { red: 50, green: 50 }, { red: 0, green: 9 })).toBe("unmet");
    expect(writeCounts(3, 8, { red: 50, green: 50 }, { red: -1, green: 0 })).toBe("unmet");
  });

  test("override without imported cards is invalid, not unmet", () => {
    expect(writeCounts(3, 8, { red: 0, green: 0 }, { red: 10, green: 8 })).toBe("invalid");
  });
});

// The independent implementation: a search instead of a closed form, a lookup instead of a chain of ternaries.
const refRMin = (n: number): number => 7 * n + (2 * n > 7 ? 2 * n : 7);
const refTarget = (n: number): number => [8, 8, 8, 8, 8, 7, 6, 5, 4, 4, 4][n] ?? 4;
const smallest = (have: number, per: number, need: number): number => { let k = 0; while (have + per * k < need) k++; return k; };

describe("E7 property: the formulas against an independent implementation", () => {
  const arbCounts = fc.record({ red: fc.integer({ min: 0, max: 130 }), green: fc.integer({ min: 0, max: 130 }) });
  const arbOverride = fc.option(fc.record({ red: fc.integer({ min: -1, max: 12 }), green: fc.integer({ min: -1, max: 12 }) }), { nil: null });

  test("rMin, gMin, defaultTarget and meetsMinimums agree for every n and T", () => {
    assertProperty(fc.property(fc.integer({ min: 3, max: 10 }), fc.integer({ min: 2, max: 10 }), arbCounts, (n, t, c) => {
      expect(rMin(n)).toBe(refRMin(n));
      expect(gMin(n, t)).toBe(n * t);
      expect(defaultTarget(n)).toBe(refTarget(n));
      expect(meetsMinimums(c, n, t)).toBe(c.red >= refRMin(n) && c.green >= n * t);
    }));
  });

  test("writeCounts: new deck, minimal reuse counts and override acceptance agree with the search", () => {
    assertProperty(fc.property(fc.integer({ min: 3, max: 10 }), fc.integer({ min: 2, max: 10 }), arbCounts, arbOverride, (n, t, existing, override) => {
      const got = writeCounts(n, t, existing, override);
      const none = existing.red === 0 && existing.green === 0;
      if (none) {
        expect(got).toEqual(override === null ? { red: 10, green: t } : "invalid");
      } else if (override === null) {
        expect(got).toEqual({ red: smallest(existing.red, n, refRMin(n)), green: smallest(existing.green, n, n * t) });
      } else {
        const ok = override.red >= 0 && override.red <= 10 && override.green >= 0 && override.green <= t
          && existing.red + n * override.red >= refRMin(n) && existing.green + n * override.green >= n * t;
        expect(got).toEqual(ok ? override : "unmet");
      }
    }));
  });

  test("a result that is not 'unmet' or 'invalid' always makes the table meet the minimums", () => {
    assertProperty(fc.property(fc.integer({ min: 3, max: 10 }), fc.integer({ min: 2, max: 10 }), arbCounts, arbOverride, (n, t, existing, override) => {
      const got = writeCounts(n, t, existing, override);
      if (typeof got === "string") return;
      expect(meetsMinimums({ red: existing.red + n * got.red, green: existing.green + n * got.green }, n, t)).toBe(true);
    }));
  });
});
