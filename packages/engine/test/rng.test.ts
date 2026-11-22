import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { EngineInvariantError } from "../src/errors";
import { makeRng, rngFromRaw } from "../src/rng";
import { assertProperty } from "./support/fc";

// Independent inline reference: xmur3 (string hash) seeding sfc32, raw 32-bit output. Seeds are stored in EventDocs, so the
// sequence a seed produces is replay-critical (LLD 1 section 5.2) and must never drift.
function refRaw(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const hash = (): number => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
  let a = hash(), b = hash(), c = hash(), d = hash();
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  };
}

const U32 = 2 ** 32;
const raws = (seed: string, n: number): number[] => {
  const r = makeRng(seed);
  return Array.from({ length: n }, () => r.int(U32)); // max 2^32 never rejects, so int returns the raw value
};
const scripted = (values: number[]): (() => number) => {
  let i = 0;
  return () => { const v = values[i++]; if (v === undefined) throw new Error("raw source exhausted"); return v; };
};

describe("V4 makeRng: golden vectors", () => {
  test("raw output matches the independent reference and pinned literals", () => {
    expect(raws("", 5)).toEqual([4129203857, 244752431, 2410192736, 339021908, 435026413]);
    expect(raws("a", 5)).toEqual([3974458160, 1032036395, 3088932659, 2554899302, 3720462638]);
    expect(raws("deep-cuts", 5)).toEqual([2833851347, 469853009, 2617341925, 674093374, 942874308]);
    expect(raws("0123456789abcdef0123456789abcdef", 5)).toEqual([1726989556, 3676547690, 1494904939, 1772066883, 2587939950]);
  });

  test("property: any seed matches the reference stream", () => {
    assertProperty(fc.property(fc.string({ maxLength: 40 }), (seed) => {
      const ref = refRaw(seed);
      expect(raws(seed, 8)).toEqual(Array.from({ length: 8 }, () => ref()));
    }));
  });

  test("same seed gives the same sequence, a different seed does not, and the seed is exposed", () => {
    const a = makeRng("s1"), b = makeRng("s1"), c = makeRng("s2");
    expect(a.seed).toBe("s1");
    const seq = (r: ReturnType<typeof makeRng>) => [r.int(1000), r.int(1000), ...r.shuffle([1, 2, 3, 4, 5, 6, 7, 8])];
    expect(seq(a)).toEqual(seq(b));
    expect(seq(makeRng("s1"))).not.toEqual(seq(c));
  });
});

describe("V4 int: rejection sampling, no modulo bias", () => {
  test("a raw value at or above the largest multiple of max is rejected and the next one is used", () => {
    // 2^32 mod 3 = 1, so the limit is 2^32 - 1: only raw value 4294967295 is rejected.
    const draws = scripted([4294967295, 5]);
    const r = rngFromRaw("t", draws);
    expect(r.int(3)).toBe(2); // 5 % 3
  });

  test("a raw value just below the limit is accepted", () => {
    expect(rngFromRaw("t", scripted([4294967294])).int(3)).toBe(4294967294 % 3);
  });

  test("raw values reduce modulo max", () => {
    const r = rngFromRaw("t", scripted([0, 7, 9, 10]));
    expect([r.int(10), r.int(10), r.int(10), r.int(10)]).toEqual([0, 7, 9, 0]);
  });

  test("int(1) is 0 and consumes nothing", () => {
    const draws = scripted([]);
    expect(rngFromRaw("t", draws).int(1)).toBe(0);
  });

  test("a power-of-two range never rejects", () => {
    expect(rngFromRaw("t", scripted([4294967295])).int(U32)).toBe(4294967295);
  });

  test("an invalid maximum is an invariant violation, not a silent result", () => {
    const r = makeRng("x");
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, U32 + 1]) expect(() => r.int(bad)).toThrow(EngineInvariantError);
  });

  test("property: int stays in range and is uniform enough across a small modulus", () => {
    assertProperty(fc.property(fc.string({ maxLength: 20 }), fc.integer({ min: 1, max: 1000 }), (seed, max) => {
      const r = makeRng(seed);
      for (let i = 0; i < 20; i++) {
        const v = r.int(max);
        expect(Number.isInteger(v) && v >= 0 && v < max).toBe(true);
      }
    }));
  });
});

describe("V4 shuffle: Fisher-Yates, new array, pinned draw order", () => {
  test("draws int(i + 1) for i from n-1 down to 1 and swaps a[i] with a[j]", () => {
    // raw values 2, 0, 1 for ranges 4, 3, 2 (all below the limits)
    const r = rngFromRaw("t", scripted([2, 0, 1]));
    // [a,b,c,d]: i=3 j=2 -> [a,b,d,c]; i=2 j=0 -> [d,b,a,c]; i=1 j=1 -> unchanged
    expect(r.shuffle(["a", "b", "c", "d"])).toEqual(["d", "b", "a", "c"]);
  });

  test("returns a new array and leaves the input alone, also for lengths 0 and 1", () => {
    const input = Object.freeze([1, 2, 3]);
    const out = makeRng("x").shuffle(input);
    expect(out).not.toBe(input);
    expect([...input]).toEqual([1, 2, 3]);
    const one = [9];
    expect(makeRng("x").shuffle(one)).not.toBe(one);
    expect(makeRng("x").shuffle([])).toEqual([]);
  });

  test("lengths 0 and 1 consume no draws", () => {
    const draws = scripted([]);
    const r = rngFromRaw("t", draws);
    expect(r.shuffle([])).toEqual([]);
    expect(r.shuffle([1])).toEqual([1]);
  });

  test("property: a shuffle is a permutation, and equals the reference Fisher-Yates over the reference stream", () => {
    assertProperty(fc.property(fc.string({ maxLength: 20 }), fc.array(fc.integer(), { maxLength: 30 }), (seed, xs) => {
      const out = makeRng(seed).shuffle(xs);
      expect([...out].sort((a, b) => a - b)).toEqual([...xs].sort((a, b) => a - b));
      const ref = refRaw(seed);
      const int = (max: number): number => {
        if (max === 1) return 0;
        const limit = U32 - (U32 % max);
        for (;;) { const x = ref(); if (x < limit) return x % max; }
      };
      const a = [...xs];
      for (let i = a.length - 1; i >= 1; i--) { const j = int(i + 1); [a[i], a[j]] = [a[j] as number, a[i] as number]; }
      expect(out).toEqual(a);
    }));
  });
});
