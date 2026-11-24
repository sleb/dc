// #29: R1 to R3, the PROJECTOR_REV rule (LLD 2 8.2): a pin test replaces the `git diff` wording.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROJECTOR_REV } from "../../src/project/rev";
import { CELLS, goldenOf } from "./cells";
import { canonicalJson, checkRevPins, corpusFingerprint, fingerprint } from "./rev-tools";

const pins = (): Record<string, string> => JSON.parse(readFileSync(new URL("./rev-pins.json", import.meta.url), "utf8")) as Record<string, string>;

describe("R1 the revision and its pin", () => {
  test("PROJECTOR_REV is a positive integer, and every revision up to it has exactly one pin, contiguous from 1", () => {
    expect(Number.isInteger(PROJECTOR_REV) && PROJECTOR_REV >= 1).toBe(true);
    expect(Object.keys(pins()).sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: PROJECTOR_REV }, (_, i) => String(i + 1)));
  });
  test("the pin at the current revision equals the fingerprint of the golden view corpus (a view change needs a bump and a new pin)", () => {
    expect(checkRevPins(PROJECTOR_REV, pins(), corpusFingerprint())).toEqual([]);
  });
});

describe("R2 checkRevPins reports each way the rule can break (test the test)", () => {
  const fp = "a".repeat(64);
  const other = "b".repeat(64);
  test("ok", () => expect(checkRevPins(2, { 1: other, 2: fp }, fp)).toEqual([]));
  test("content changed, no bump", () => expect(checkRevPins(2, { 1: other, 2: other }, fp)).toEqual(["the golden corpus changed without a bump of PROJECTOR_REV 2"]));
  test("bumped, no pin", () => expect(checkRevPins(3, { 1: other, 2: fp }, fp)).toEqual(["PROJECTOR_REV 3 was bumped without a pin for it"]));
  test("a gap in the pins", () => expect(checkRevPins(3, { 1: other, 3: fp }, fp)).toEqual(["gap: no pin for rev 2"]));
  test("a rev below the newest pin", () => expect(checkRevPins(1, { 1: other, 2: fp }, other)).toEqual(["PROJECTOR_REV 1 is below the newest pin 2"]));
  test("a rev that is not a positive integer", () => {
    expect(checkRevPins(0, { 1: fp }, fp)).toHaveLength(1);
    expect(checkRevPins(1.5, { 1: fp }, fp)).toHaveLength(1);
  });
});

describe("R3 the fingerprint", () => {
  const entries = (): [string, unknown][] => CELLS.map((c) => [c.name, goldenOf(c)]);
  test("one changed field in one cell changes it", () => {
    const e = entries();
    const first = e[0];
    if (first === undefined) throw new Error("no cells");
    const bumped = e.map((x, i): [string, unknown] => (i === 0 ? [first[0], { ...(first[1] as object), version: -1 }] : x));
    expect(fingerprint(bumped)).not.toBe(fingerprint(e));
  });
  test("a changed cell name changes it, and entry order does not", () => {
    const e = entries();
    expect(fingerprint([...e].reverse())).toBe(fingerprint(e));
    expect(fingerprint(e.map(([n, v], i): [string, unknown] => [i === 0 ? `${n}!` : n, v]))).not.toBe(fingerprint(e));
  });
  test("it is stable under key reorder at every depth", () => {
    expect(canonicalJson({ b: [{ y: 1, x: 2 }], a: null })).toBe(canonicalJson({ a: null, b: [{ x: 2, y: 1 }] }));
    expect(fingerprint([["n", { b: 1, a: { d: 1, c: 2 } }]])).toBe(fingerprint([["n", { a: { c: 2, d: 1 }, b: 1 }]]));
  });
  test("the corpus fingerprint is 64 hex characters and repeatable", () => {
    expect(corpusFingerprint()).toMatch(/^[0-9a-f]{64}$/);
    expect(corpusFingerprint()).toBe(corpusFingerprint());
  });
});
