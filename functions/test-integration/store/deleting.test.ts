import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { Table } from "./support/drive";
import { clear, db } from "./support/harness";
import { diff, snapshot } from "./support/inspect";
import { craftedGame } from "./support/crafted";

// I15 a game with store.deleting set (test-local; deleteGame phase 0 is #36) rejects every command NOT_FOUND and writes nothing.
beforeAll(clear);

test("I15 store.deleting gives rejected NOT_FOUND with no writes", async () => {
  const t = await Table.seed(craftedGame());
  await db.doc(`games/${t.gameId}`).update({ "store.deleting": { at: 1, by: t.hostId } });
  const before = await snapshot(t.gameId);
  for (const cmd of [{ type: "updateSettings", patch: { profanity: "off" } }, { type: "endGame" }] as Command[]) {
    const r = await t.run({ kind: "user", uid: t.hostId }, cmd);
    expect(r.outcome).toEqual({ kind: "rejected", rejection: { code: "NOT_FOUND" }, version: 0 });
    expect(r.writes).toBe(0);
  }
  expect(diff(before, await snapshot(t.gameId))).toEqual({ created: [], changed: [], deleted: [] });
}, 60_000);
