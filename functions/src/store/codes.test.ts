import { describe, expect, test } from "bun:test";
import { PlayerIdSchema, RoomCodeSchema } from "@dc/contracts";
import { ROOM_CODE_ALPHABET, playerIdFromSeed, roomCodeFromSeed } from "./codes";

// U1-U3 (LLD 3 sections 2.4 and 6.1, ST8): the two pure generators the createGame attempt loop draws from.
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

describe("U1 roomCodeFromSeed", () => {
  test("returns 4 letters of BCDFGHJKLMNPQRSTVWXZ and RoomCodeSchema accepts every output", () => {
    expect(ROOM_CODE_ALPHABET).toBe(CODE_ALPHABET);
    for (let i = 0; i < 2_000; i++) {
      const code = roomCodeFromSeed(`u1-${i}`);
      expect(code).toHaveLength(4);
      expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
      expect(RoomCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  test("the same seed gives the same code; different seeds mostly differ", () => {
    expect(roomCodeFromSeed("same")).toBe(roomCodeFromSeed("same"));
    const seen = new Set(Array.from({ length: 500 }, (_, i) => roomCodeFromSeed(`differ-${i}`)));
    expect(seen.size).toBeGreaterThan(490);
  });

  test("rejection sampling skips an all-255 block, pulls the next block and terminates", () => {
    const calls: number[] = [];
    const bytes = (count: number): Uint8Array => {
      calls.push(count);
      return calls.length === 1 ? new Uint8Array(count).fill(255) : new Uint8Array([0, 1, 2, 3]);
    };
    expect(roomCodeFromSeed("ignored", bytes)).toBe("BCDF");
    expect(calls.length).toBe(2);
  });
});

describe("U2 no modulo bias", () => {
  test("over 100,000 seeds every letter appears at every position within ±15% of 5,000 and the chi-square stays under the 0.1% bound", () => {
    const counts = [new Map<string, number>(), new Map<string, number>(), new Map<string, number>(), new Map<string, number>()];
    const codes = new Set<string>();
    for (let i = 0; i < 100_000; i++) {
      const code = roomCodeFromSeed(`u2-${i}`);
      codes.add(code);
      for (let pos = 0; pos < 4; pos++) {
        const c = code[pos] as string;
        counts[pos]?.set(c, (counts[pos]?.get(c) ?? 0) + 1);
      }
    }
    const expected = 100_000 / CODE_ALPHABET.length;
    for (const position of counts) {
      expect(position.size).toBe(CODE_ALPHABET.length);
      for (const letter of CODE_ALPHABET) {
        const n = position.get(letter) ?? 0;
        expect(n).toBeGreaterThanOrEqual(4_250);
        expect(n).toBeLessThanOrEqual(5_750);
      }
      // The ±15% band cannot see a 20-value modulo bias: at 5,000 expected it moves 16 letters from 4.69% to 5.08% (8.3% relative), still inside the
      // band. A chi-square over the same counts does: unbiased counts have mean 19 (19 df), and the 0.1% bound is 43.8. At 20,000 seeds the `% 20`
      // mutation measured 27.7–55.9 per position, so two of four positions slipped under the bound and the test could pass on a lucky seed. At
      // 100,000 seeds the unbiased statistic measured 19.0–25.1 and the same mutation 94.1–169.7, far above the bound, so it is decisive here.
      const chiSquare = CODE_ALPHABET.split("").reduce((sum, letter) => sum + ((position.get(letter) ?? 0) - expected) ** 2 / expected, 0);
      expect(chiSquare).toBeLessThan(43.8);
    }
    // Expected collisions at 100,000 draws over 160,000 codes are about 25,600; well under 26,500 means no shrunken space.
    expect(100_000 - codes.size).toBeLessThan(26_500);
  });
});

describe("U3 playerIdFromSeed", () => {
  test("is p_ + 8 of [a-z2-7], PlayerIdSchema-valid, deterministic and distinct across seeds", () => {
    for (let i = 0; i < 1_000; i++) {
      const id = playerIdFromSeed(`u3-${i}`);
      expect(id).toMatch(/^p_[a-z2-7]{8}$/);
      expect(PlayerIdSchema.safeParse(id).success).toBe(true);
      expect(playerIdFromSeed(`u3-${i}`)).toBe(id);
    }
    expect(playerIdFromSeed("a")).not.toBe(playerIdFromSeed("b"));
    expect(new Set(Array.from({ length: 10_000 }, (_, i) => playerIdFromSeed(`spread-${i}`))).size).toBe(10_000);
  });
});
