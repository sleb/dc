import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { Table } from "./support/drive";
import { clear, db, load } from "./support/harness";

// I16 Aggregate-only load (S4): every subcollection of a mid-game game deleted, the game continues from the aggregate alone.
beforeAll(clear);

test("I16 with every subcollection deleted, load and a command through the harness continue the game", async () => {
  const t = await Table.playing(3);
  await t.playRound();
  const root = db.doc(`games/${t.gameId}`);
  for (const c of await root.listCollections()) for (const d of (await c.get()).docs) await d.ref.delete();
  expect((await root.listCollections()).length).toBe(0);
  const loaded = await load(t.gameId);
  expect(loaded?.game.version).toBe((await t.state()).version);
  expect(loaded?.game.round?.number).toBe(2);
  await t.submitAll();
  const r = await t.pick();
  expect(r.outcome.kind).toBe("accepted");
  expect((await t.state()).history).toHaveLength(2);
}, 120_000);
