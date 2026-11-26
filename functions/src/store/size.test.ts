import { expect, test } from "bun:test";
import { StoreError } from "./errors";
import { HARD_BYTES, WARN_BYTES, estimateBytes, guardSize } from "./size";

// U6 (LLD 3 section 2.5, ST6).
const KiB = 1024;
const docOf = (bytes: number) => ({ pad: "x".repeat(Math.max(0, Math.floor(bytes / 1.15) - 10)) });

test("U6 estimateBytes is 1.15 x the UTF-8 length of JSON.stringify", () => {
  expect(estimateBytes({ a: "é" })).toBe(Math.ceil(1.15 * Buffer.byteLength(JSON.stringify({ a: "é" }), "utf8")));
  expect(estimateBytes({ a: "x".repeat(1000) })).toBe(Math.ceil(1.15 * 1008));
});

test("U6 the thresholds are 600 KiB and 900 KiB", () => {
  expect(WARN_BYTES).toBe(600 * KiB);
  expect(HARD_BYTES).toBe(900 * KiB);
});

test("U6 below 600 KiB: no warning; above: a warning and no throw", () => {
  expect(guardSize(docOf(500 * KiB), docOf(10))).toEqual({ warn: false });
  expect(guardSize(docOf(700 * KiB), docOf(10))).toEqual({ warn: true });
});

test("U6 above 900 KiB a growing write throws AGGREGATE_TOO_LARGE", () => {
  let err: unknown = null;
  try {
    guardSize(docOf(950 * KiB), docOf(940 * KiB));
  } catch (e) {
    err = e;
  }
  expect(err instanceof StoreError && err.kind).toBe("AGGREGATE_TOO_LARGE");
});

test("U6 above 900 KiB a write that does not grow is allowed (endGame, removeCard), with a warning", () => {
  expect(guardSize(docOf(950 * KiB), docOf(960 * KiB))).toEqual({ warn: true });
  const same = docOf(950 * KiB);
  expect(guardSize(same, same)).toEqual({ warn: true });
});

test("U6 endGame (escape) is allowed above 900 KiB even when a few bytes of version and timestamp digits grow the doc", () => {
  const prev = docOf(950 * KiB);
  const next = { ...prev, updatedAt: 1_795_736_706_437 };
  let err: unknown = null;
  try {
    guardSize(next, prev);
  } catch (e) {
    err = e;
  }
  expect(err instanceof StoreError && err.kind).toBe("AGGREGATE_TOO_LARGE");
  expect(guardSize(next, prev, { escape: true })).toEqual({ warn: true });
});
