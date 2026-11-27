import { expect, test } from "bun:test";
import type { RoundDoc } from "@dc/contracts";
import { redact, roundsContaining } from "./redact";
import { MemGame } from "./test-support";

// U5 (LLD 3 section 6.3, ST13).
const m = MemGame.playing(3);
m.playRound();
m.playRound();
const h = m.game.history;

test("U5 roundsContaining finds the rounds whose green or any play is the card, and no others", () => {
  const r1 = h[0];
  const r2 = h[1];
  if (r1 === undefined || r2 === undefined) throw new Error("rounds");
  expect(roundsContaining(m.game, r1.greenCardId)).toEqual([1]);
  expect(roundsContaining(m.game, r2.plays[0]?.cardId ?? "")).toEqual([2]);
  expect(roundsContaining(m.game, "c_zzzzzzzzzz")).toEqual([]);
  const twice = { ...m.game, history: [r1, { ...r2, plays: [...r2.plays, { playerId: r1.judgeId, cardId: r1.greenCardId }] }] };
  expect(roundsContaining(twice, r1.greenCardId)).toEqual([1, 2]);
});

const doc: RoundDoc = {
  schema: 1, round: 4, judgeId: "p_aaaaaaaa", winnerId: "p_aaaaaaab", winnerCardId: "c_0000000002",
  green: { id: "c_0000000009", text: "CARD-SENTINEL-green" },
  plays: [
    { playerId: "p_aaaaaaab", cardId: "c_0000000002", text: "CARD-SENTINEL-a", pitch: "CARD-SENTINEL-pitch" },
    { playerId: "p_aaaaaaac", cardId: "c_0000000003", text: "CARD-SENTINEL-b", pitch: null },
  ],
  absent: ["p_aaaaaaad"], resolvedAt: 77, redacted: false,
};

test("U5 redact nulls only the matching play's text and pitch and sets redacted; every other field is byte-equal", () => {
  const out = redact(doc, "c_0000000002");
  expect(out).toEqual({ ...doc, plays: [{ ...doc.plays[0], text: null, pitch: null } as RoundDoc["plays"][number], doc.plays[1] as RoundDoc["plays"][number]], redacted: true });
  expect(JSON.stringify(out.plays[1])).toBe(JSON.stringify(doc.plays[1]));
  expect(JSON.stringify(out.green)).toBe(JSON.stringify(doc.green));
});

test("U5 redact of the green card nulls the green text only", () => {
  const out = redact(doc, "c_0000000009");
  expect(out.green).toEqual({ id: "c_0000000009", text: null });
  expect(out.plays).toEqual(doc.plays);
  expect(out.redacted).toBe(true);
});

test("U5 redact does not mutate its input", () => {
  const before = JSON.stringify(doc);
  expect(redact(doc, "c_0000000002")).not.toEqual(doc);
  expect(JSON.stringify(doc)).toBe(before);
});
