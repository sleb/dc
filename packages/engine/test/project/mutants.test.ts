// #30 K1 to K3 (LLD 2 11.4): the anonymity suite must be shown to fail on leaks. 13 hand-written mutants, fixed seeds. K1: each named detector fires alone (the others off, so a kill is never
// only "the strict parse caught the extra key"); K2: every mutant is killed by the default configuration; K3: the real projector survives it (anonymity.test.ts).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { DETECTORS, AnonymityViolation, runAnonymitySuite } from "./anonymity";
import type { Detector, ProjectorUnderTest } from "./anonymity";
import { MUTANTS } from "./mutants";

setDefaultTimeout(180_000); // generated games on a loaded machine must not trip the 5 s default
const names = Object.keys(MUTANTS);
const killedBy = (impl: ProjectorUnderTest, o: { seed: number; numRuns: number }, detectors: readonly Detector[]): Detector | null => {
  try {
    runAnonymitySuite(impl, { ...o, detectors });
    return null;
  } catch (e) {
    if (e instanceof AnonymityViolation) return e.detector;
    throw e;
  }
};

test("the thirteen mutants of 11.4 plus M-keyorder and M-shape", () => {
  expect(names).toEqual(["M-hands", "M-owner", "M-order", "M-time", "M-power", "M-writein", "M-draft", "M-uid", "M-spec", "M-deck", "M-resolve", "M-keyorder", "M-shape"]);
});

describe("K2 every mutant is killed by the default configuration (expect toThrow)", () => {
  for (const name of names) {
    test(name, () => {
      const m = MUTANTS[name]!;
      expect(() => runAnonymitySuite(m.impl, { seed: m.seed, numRuns: m.numRuns })).toThrow(AnonymityViolation);
    });
  }
});

describe("K1 each named detector kills the mutant alone", () => {
  for (const name of names) {
    const m = MUTANTS[name]!;
    for (const d of m.killedBy) {
      test(`${name} by ${d}`, () => {
        expect(m.killedBy.length).toBeGreaterThan(0);
        expect(killedBy(m.impl, m, [d])).toBe(d);
      });
    }
  }
});

describe("the strict-parse-off rule: with the schema parse off the mutants that add a key are still killed, and the shape-valid ones never relied on it", () => {
  const all = [...DETECTORS];
  const noStrict = all.filter((d) => d !== "strictParse");
  for (const name of names) {
    test(`${name}: killed with strictParse off`, () => {
      const m = MUTANTS[name]!;
      expect(killedBy(m.impl, m, noStrict)).not.toBeNull();
    });
  }
  for (const name of ["M-order", "M-time", "M-shape", "M-keyorder"]) {
    test(`${name} is shape-valid: strictParse alone does not kill it`, () => {
      const m = MUTANTS[name]!;
      expect(killedBy(m.impl, { seed: m.seed, numRuns: 8 }, ["strictParse"])).toBeNull(); // 8 of its scenarios are enough to see the parse pass them all
    });
  }
  test("M-keyorder is killed by keyOrder alone and by nothing else", () => {
    const m = MUTANTS["M-keyorder"]!;
    expect(m.killedBy).toEqual(["keyOrder"]);
    expect(killedBy(m.impl, { seed: m.seed, numRuns: 8 }, all.filter((d) => d !== "keyOrder"))).toBeNull();
  });
  test("M-shape is killed by the PJ6 order check and by N2, each alone", () => {
    const m = MUTANTS["M-shape"]!;
    expect([...m.killedBy].sort()).toEqual(["N2", "order"]);
  });
});

describe("the mutants are what the table says", () => {
  test("each mutant records its seed, run count and detectors; seeds are fixed, so detection is not probabilistic", () => {
    for (const name of names) {
      const m = MUTANTS[name]!;
      expect(Number.isInteger(m.seed)).toBe(true);
      expect(m.numRuns).toBeGreaterThan(0);
      expect(m.numRuns).toBeLessThanOrEqual(200);
      expect(m.killedBy.every((d) => (DETECTORS as readonly string[]).includes(d))).toBe(true);
    }
    expect(MUTANTS["M-owner"]!.killedBy).toEqual(["ownership"]);
    expect(MUTANTS["M-draft"]!.killedBy).toEqual(["drafts"]);
    expect(MUTANTS["M-uid"]!.killedBy).toEqual(["identity"]);
    expect(MUTANTS["M-spec"]!.killedBy).toEqual(["subset"]);
    expect(MUTANTS["M-deck"]!.killedBy).toEqual(["cards"]);
    expect(MUTANTS["M-resolve"]!.killedBy).toEqual(["roundDocs"]);
    expect([...MUTANTS["M-hands"]!.killedBy].sort()).toEqual(["cards", "internals", "othersData"]);
    expect([...MUTANTS["M-order"]!.killedBy].sort()).toEqual(["N2", "order"]);
    expect([...MUTANTS["M-time"]!.killedBy].sort()).toEqual(["N2", "time"]);
    expect([...MUTANTS["M-power"]!.killedBy].sort()).toEqual(["N3", "othersData"]);
    expect([...MUTANTS["M-writein"]!.killedBy].sort()).toEqual(["N6", "writeInMarker"]);
  });
});

describe("test of the test: the matrix depends on the generator, and a kill replays", () => {
  test("M-writein survives the marker walk when the generator never injects a write-in (the injector is what kills it, and H3 counts it); N6 needs no injection, it plants the marker itself", () => {
    const m = MUTANTS["M-writein"]!;
    expect(() => runAnonymitySuite(m.impl, { seed: m.seed, numRuns: m.numRuns, detectors: ["writeInMarker"], weaken: ["noInjection"] })).not.toThrow();
    expect(() => runAnonymitySuite(m.impl, { seed: m.seed, numRuns: m.numRuns, detectors: ["writeInMarker"] })).toThrow(AnonymityViolation);
    expect(() => runAnonymitySuite(m.impl, { seed: m.seed, numRuns: m.numRuns, detectors: ["N6"], weaken: ["noInjection"] })).toThrow(AnonymityViolation);
  });

  test("the same mutant at the same seed fails with the same message, twice", () => {
    const m = MUTANTS["M-order"]!;
    const run = (): string => { try { runAnonymitySuite(m.impl, { seed: m.seed, numRuns: m.numRuns }); return "survived"; } catch (e) { return e instanceof Error ? e.message : String(e); } };
    expect(run()).toBe(run());
    expect(run()).toMatch(/anonymity violation \[(order|N2)\] seed \d+/);
  });
});
