import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { Table } from "./support/drive";
import { clear, db } from "./support/harness";

// I11 E8 event log (LLD 3 section 9, ST15). importDeck is M9; writeIn and K-A are M7.
beforeAll(clear);

test("I11 the raw finishWriting event doc has neither seed nor actorPlayerId; the startGame (shuffle) doc has both", async () => {
  const t = await Table.lobby(3);
  const s = await t.host({ type: "startGame" } as Command);
  await t.as(1, { type: "saveDraft", ...(await t.fullDraft(1)) } as Command);
  const f = await t.as(1, { type: "finishWriting" } as Command);
  const ev = async (r: typeof s) => (await db.doc(`games/${t.gameId}/events/${r.outcome.kind === "accepted" ? r.outcome.version : -1}`).get()).data() ?? {};
  const start = await ev(s);
  expect(start["commandType"]).toBe("startGame");
  expect(typeof start["seed"]).toBe("string");
  expect(start["actorPlayerId"]).toBe("p_aaaaaaaa");
  const finish = await ev(f);
  expect(finish["commandType"]).toBe("finishWriting");
  expect(Object.keys(finish).sort()).toEqual(["at", "commandType", "events", "version"]);
  expect(JSON.stringify(finish)).not.toContain("SENTINEL");
}, 120_000);
