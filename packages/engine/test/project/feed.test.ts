// #29: T1 toRoundDoc, T2 projectFeed, T3 records from real games (LLD 2 section 7, PJ13 pure half, PJ1). The Store parses and writes round docs (LLD 3, M3).
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { RoundDocSchema } from "@dc/contracts";
import { decide } from "../../src/decide";
import { EngineInvariantError } from "../../src/errors";
import { projectFeed, toRoundDoc } from "../../src/project/feed";
import type { RoundRecord } from "../../src/types";
import { cid, deepFreeze, pid } from "../support/factories";
import { assertProperty } from "../support/fc";
import { enumerators } from "../support/legal";
import { progressDriver, runScenario } from "../support/scenario";
import { created } from "./scenarios";

const rec = (round: number, over: Partial<RoundRecord> = {}): RoundRecord => ({
  round, judgeId: pid(1), greenCardId: cid(800 + round),
  plays: [{ playerId: pid(2), cardId: cid(206) }, { playerId: pid(3), cardId: cid(306) }],
  winnerCardId: cid(206), winnerId: pid(2),
  green: { id: cid(800 + round), text: "GREEN TEXT" },
  playsDetail: [{ playerId: pid(3), cardId: cid(306), text: "THREE", pitch: "PITCH THREE" }, { playerId: pid(2), cardId: cid(206), text: "TWO" }],
  absent: [pid(4)], resolvedAt: 1_700_000_000_000, ...over,
});

describe("T1 toRoundDoc maps field by field", () => {
  test("a record with and without a pitch, written out by hand first", () => {
    const doc = toRoundDoc(rec(3));
    expect(doc).toStrictEqual({
      schema: 1, round: 3, judgeId: pid(1), winnerId: pid(2), winnerCardId: cid(206),
      green: { id: cid(803), text: "GREEN TEXT" },
      plays: [{ playerId: pid(3), cardId: cid(306), text: "THREE", pitch: "PITCH THREE" }, { playerId: pid(2), cardId: cid(206), text: "TWO", pitch: null }],
      absent: [pid(4)], resolvedAt: 1_700_000_000_000, redacted: false,
    });
    expect(Object.keys(doc)).toEqual(["schema", "round", "judgeId", "winnerId", "winnerCardId", "green", "plays", "absent", "resolvedAt", "redacted"]);
    expect(Object.keys(doc.plays[0] ?? {})).toEqual(["playerId", "cardId", "text", "pitch"]);
    expect(RoundDocSchema.safeParse(doc).success).toBe(true);
  });
  test("an empty pitch stays an empty string (null only for a missing one), and there is no write-in marker or id-only plays field", () => {
    const doc = toRoundDoc(rec(1, { playsDetail: [{ playerId: pid(2), cardId: cid(206), text: "T", pitch: "" }] }));
    expect(doc.plays[0]?.pitch).toBe("");
    expect(JSON.stringify(doc)).not.toMatch(/writeIn|write_in|redraw|voter|vote|hand|draft|uid/i);
  });
  test("it builds fresh arrays and does not alias or mutate the record", () => {
    const r = deepFreeze(rec(2));
    const doc = toRoundDoc(r);
    expect(doc.absent).not.toBe(r.absent);
    expect(doc.plays).not.toBe(r.playsDetail);
    expect(toRoundDoc(structuredClone(r))).toStrictEqual(doc);
  });
  test("it takes the record and nothing else (no viewer input)", () => expect(toRoundDoc.length).toBe(1));
  test("golden", () => expect({ withPitch: toRoundDoc(rec(3)), noPlays: toRoundDoc(rec(1, { playsDetail: [], absent: [] })) }).toMatchSnapshot());
});

describe("T2 projectFeed", () => {
  const shuffled = [rec(10), rec(2), rec(1), rec(3)];
  test("rounds above sinceRound, numerically ascending (10 after 2), default 0", () => {
    expect(projectFeed(shuffled).map((d) => d.round)).toEqual([1, 2, 3, 10]);
    expect(projectFeed(shuffled, 2).map((d) => d.round)).toEqual([3, 10]);
    expect(projectFeed(shuffled, 10)).toEqual([]);
    expect(projectFeed([], 0)).toEqual([]);
  });
  test("it does not mutate its input, and each element is toRoundDoc of its record", () => {
    const frozen = deepFreeze(structuredClone(shuffled));
    expect(projectFeed(frozen)).toStrictEqual([1, 2, 3, 10].map((n) => toRoundDoc(shuffled.find((r) => r.round === n) as RoundRecord)));
  });
  test("a duplicate round throws EngineInvariantError, naming the round and no text", () => {
    expect(() => projectFeed([rec(1), rec(2), rec(2)])).toThrow(EngineInvariantError);
    try { projectFeed([rec(2), rec(2)]); } catch (e) { expect((e as Error).message).toContain("2"); expect((e as Error).message).not.toContain("GREEN TEXT"); }
  });
  test("a duplicate at or below sinceRound is not in the result and does not throw", () => {
    expect(projectFeed([rec(1), rec(1), rec(2)], 1).map((d) => d.round)).toEqual([2]);
  });
});

describe("T3 records from real games (pickWinner)", () => {
  test("property: every record of a whole game maps to a strict-valid doc with no viewer, vote, hand or draft data, and is the same for every reader", () => {
    let docs = 0;
    assertProperty(fc.property(fc.integer({ min: 3, max: 6 }), fc.integer(), fc.boolean(), (n, seed, pitch) => {
      const drive = progressDriver(`${seed}`, n, enumerators, true);
      const trace = runScenario(decide, created(pitch), Array.from({ length: 300 }, () => ({ kind: "legal" as const, pick: 0 })), { seed, table: enumerators, drive });
      const records = trace.results.flatMap((r) => (r.ok ? r.value.roundRecords : []));
      const rounds = projectFeed(records);
      expect(rounds.map((d) => d.round)).toEqual(records.map((r) => r.round).sort((a, b) => a - b));
      for (const r of records) {
        const doc = toRoundDoc(r);
        docs++;
        expect(RoundDocSchema.safeParse(doc).success).toBe(true);
        expect(toRoundDoc(structuredClone(r))).toStrictEqual(doc);
        expect(JSON.stringify(doc)).not.toMatch(/"(voter|votes|hand|draft|uid|hostId|powerUsage)"/);
        expect(doc.plays.map((p) => p.cardId).sort()).toEqual(r.playsDetail.map((p) => p.cardId).sort());
        for (const p of doc.plays) expect(p.pitch === null || pitch).toBe(true);
      }
    }));
    expect(docs).toBeGreaterThan(50);
  });
});
