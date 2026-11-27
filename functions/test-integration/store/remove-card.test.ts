import { beforeAll, expect, test } from "bun:test";
import type { Command, RoundDoc } from "@dc/contracts";
import { Table } from "./support/drive";
import { clear, db } from "./support/harness";
import { diff, snapshot } from "./support/inspect";

// I8 removeCard redaction (LLD 3 section 6.3, ST13). The recycled-card budget case is proved on the planner (plan.test.ts P5).
beforeAll(clear);
const round = async (g: string, n: number) => (await db.doc(`games/${g}/rounds/${n}`).get()).data() as RoundDoc;

test("I8 removing a played card and a green card of resolved rounds redacts exactly those texts; other fields are byte-equal", async () => {
  const t = await Table.playing(4);
  await t.playRound();
  await t.playRound();
  // A leaver makes room under the minimums (4 x the target of green cards were written).
  const g0 = await t.state();
  const leaver = g0.players.find((p) => p.status === "active" && p.id !== g0.round?.judgeId && p.uid !== g0.hostId);
  await t.as(t.indexOf(leaver?.id ?? ""), { type: "leave" } as Command);
  const r1 = await round(t.gameId, 1);
  const r2 = await round(t.gameId, 2);
  const played = r1.plays[0];
  if (played === undefined) throw new Error("no play");

  const before = await snapshot(t.gameId);
  await t.host({ type: "removeCard", cardId: played.cardId } as Command);
  const after1 = await round(t.gameId, 1);
  expect(after1).toEqual({ ...r1, plays: r1.plays.map((p) => (p.cardId === played.cardId ? { ...p, text: null, pitch: null } : p)), redacted: true });
  expect(JSON.stringify(after1.green)).toBe(JSON.stringify(r1.green));
  expect(diff(before, await snapshot(t.gameId)).changed).toContain(`games/${t.gameId}/rounds/1`);
  expect(diff(before, await snapshot(t.gameId)).changed).not.toContain(`games/${t.gameId}/rounds/2`);

  await t.host({ type: "removeCard", cardId: r2.green.id } as Command);
  const after2 = await round(t.gameId, 2);
  expect(after2).toEqual({ ...r2, green: { ...r2.green, text: null }, redacted: true });
}, 300_000);

test("I8 a hand card and a removal below the minimums are refused and write nothing", async () => {
  const t = await Table.playing(3);
  await t.playRound();
  const g = await t.state();
  const hand = g.players.find((p) => p.hand.length > 0)?.hand[0] ?? "";
  const r1 = await round(t.gameId, 1);
  const before = await snapshot(t.gameId);
  const h = await t.run({ kind: "user", uid: t.hostId }, { type: "removeCard", cardId: hand } as Command);
  expect(h.outcome).toMatchObject({ kind: "rejected", rejection: { code: "NOT_FOUND" } });
  const b = await t.run({ kind: "user", uid: t.hostId }, { type: "removeCard", cardId: r1.green.id } as Command);
  expect(b.outcome).toMatchObject({ kind: "rejected", rejection: { code: "NOT_PLAYABLE", detail: "below_minimum" } });
  expect(diff(before, await snapshot(t.gameId))).toEqual({ created: [], changed: [], deleted: [] });
}, 300_000);
