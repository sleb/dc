import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { Table } from "./support/drive";
import { clear, db } from "./support/harness";
import { diff, snapshot, touched } from "./support/inspect";
import { pid } from "./support/seed";

// I10 WriteSet merge (LLD 3 section 5.2a, ST14).
beforeAll(clear);
const seqOf = async (t: Table, k: number) => (await db.doc(`games/${t.gameId}/views/${t.uidOf(k)}`).get()).get("draftSeq") as number;

test("I10 removePlayer of a writer with a draft: one write to the view doc, draftSeq +1 (not +2)", async () => {
  const t = await Table.lobby(4);
  await t.host({ type: "startGame" } as Command);
  await t.as(2, { type: "saveDraft", ...(await t.fullDraft(2)) } as Command);
  await t.as(2, { type: "saveDraft", ...(await t.fullDraft(2, " b")) } as Command);
  expect(await seqOf(t, 2)).toBe(2);
  const before = await snapshot(t.gameId);
  const r = await t.host({ type: "removePlayer", playerId: pid(2) } as Command);
  const d = diff(before, await snapshot(t.gameId));
  expect(touched(d)).toBe(r.writes); // one write per document
  expect(d.deleted).toContain(`games/${t.gameId}/drafts/${pid(2)}`);
  const doc = (await db.doc(`games/${t.gameId}/views/${t.uidOf(2)}`).get()).data();
  expect(doc?.["draftSeq"]).toBe(3);
  expect(doc?.["draft"]).toBeNull();
  expect((doc?.["view"] as { kind: string }).kind).toBe("departed");
}, 120_000);

test("I10 a writer at draftSeq 7 who leaves (no draft read) is stored at 8, never 1", async () => {
  const t = await Table.lobby(4);
  await t.host({ type: "startGame" } as Command);
  for (let i = 0; i < 7; i++) await t.as(1, { type: "saveDraft", ...(await t.fullDraft(1, ` ${i}`)) } as Command);
  expect(await seqOf(t, 1)).toBe(7);
  await t.as(1, { type: "leave" } as Command);
  expect(await seqOf(t, 1)).toBe(8);
}, 120_000);
