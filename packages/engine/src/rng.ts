import { EngineInvariantError } from "./errors";
import type { Rng } from "./types";

const U32 = 2 ** 32;

/** Build an Rng over a raw uint32 source. `makeRng` seeds it with xmur3 and sfc32; tests inject scripted sources to pin the sampling rules. */
export function rngFromRaw(seed: string, nextU32: () => number): Rng {
  const int = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > U32) throw new EngineInvariantError(`Rng.int: invalid maximum ${String(maxExclusive)}`);
    if (maxExclusive === 1) return 0; // consumes no draw
    const limit = U32 - (U32 % maxExclusive); // reject the biased tail
    for (;;) {
      const x = nextU32();
      if (x < limit) return x % maxExclusive;
    }
  };
  return {
    seed,
    int,
    shuffle<T>(xs: readonly T[]): T[] {
      const a = [...xs];
      for (let i = a.length - 1; i >= 1; i--) {
        const j = int(i + 1); // draw order is part of the contract (LLD 1 section 5.2)
        [a[i], a[j]] = [a[j] as T, a[i] as T];
      }
      return a;
    },
  };
}

/** Pure; no globals. Seeds are stored in EventDocs, so this stream must never change. */
function sfc32FromSeed(seed: string): () => number {
  let h = 1779033703 ^ seed.length; // xmur3
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

export function makeRng(seed: string): Rng {
  return rngFromRaw(seed, sfc32FromSeed(seed));
}
