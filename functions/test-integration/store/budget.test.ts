import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { viewersOf } from "@dc/engine";
import type { Game } from "@dc/engine";
import { estimateBytes } from "../../src/store/size";
import { Table } from "./support/drive";
import { FIXTURE_IDS, fixtureHostId, lowerViewsRev, seedFixture } from "./support/fixtures";
import { clear, db, runError } from "./support/harness";
import { diff, snapshot, touched } from "./support/inspect";
import { createdGame, newKey } from "./support/seed";

// I7 Write budget and size (LLD 3 sections 2.5 and 5.7, ST6). `departed40` is a built fixture (#37); the oversize aggregate is a
// crafted state the production path cannot produce.
beforeAll(async () => {
  await clear();
  await seedFixture("departed40");
});

test("I7 on 10 seated and 40 departed, the harness write count equals an independent document diff and stays within section 5.7", async () => {
  const t = Table.attach(FIXTURE_IDS.departed40, fixtureHostId("departed40"));
  const g = await t.state();
  expect(viewersOf(g)).toHaveLength(52);
  expect(await lowerViewsRev(t.gameId)).toBe(true); // stale: every one of the 52 views must be rewritten
  const extra = [`roomCodes/${g.roomCode}`];
  const b1 = await snapshot(t.gameId, extra);
  const r1 = await t.host({ type: "updateSettings", patch: { profanity: "off" } } as Command);
  const d1 = diff(b1, await snapshot(t.gameId, extra));
  expect(touched(d1)).toBe(r1.writes);
  expect(d1.changed.filter((p) => p.includes("/views/"))).toHaveLength(52); // stale: every view
  expect(r1.writes).toBe(55); // aggregate, events, ledger, 52 views
  expect(r1.writes).toBeLessThanOrEqual(75);

  // The leaver holds a drafts doc, so its delete is visible to the diff (deleting a doc that does not exist is a write no diff can see).
  await t.as(50, { type: "saveDraft", red: ["CARD-SENTINEL-50"], green: [] } as Command);
  const b2 = await snapshot(t.gameId, extra);
  const r2 = await t.as(50, { type: "leave" } as Command);
  const d2 = diff(b2, await snapshot(t.gameId, extra));
  expect(touched(d2)).toBe(r2.writes);
  expect(r2.writes).toBeLessThanOrEqual(75);
  // The stored aggregate after both commands (store map included), read back from the emulator, not the Bun-built fixture.
  expect(estimateBytes((await db.doc(`games/${t.gameId}`).get()).data())).toBeLessThan(600 * 1024);
}, 120_000);

/** A LOBBY game padded with registry cards (imported-deck shape) to just over the 900 KiB estimate, under Firestore's 1 MiB. */
function oversized(): Game {
  const g = createdGame();
  const cards: Game["cards"] = {};
  const redDeck: string[] = [];
  for (let k = 0; estimateBytes({ ...g, cards, pools: { ...g.pools, redDeck } }) < 905 * 1024; k++) {
    const id = `c_${k.toString(36).padStart(10, "0")}`;
    cards[id] = { kind: "red", text: `CARD-SENTINEL-pad-${"x".repeat(60)}` };
    redDeck.push(id);
  }
  return { ...g, cards, pools: { ...g.pools, redDeck } };
}

test("I7 an oversize aggregate: a growing command fails AGGREGATE_TOO_LARGE with nothing written; endGame on it succeeds", async () => {
  const game = oversized();
  expect(estimateBytes(game)).toBeGreaterThan(900 * 1024);
  const t = await Table.seed(game);
  const extra = [`roomCodes/${game.roomCode}`];
  const before = await snapshot(t.gameId, extra);
  const err = await runError({ gameId: t.gameId, actor: { kind: "user", uid: t.uidOf(1) }, cmd: { type: "join", playerId: "p_aaaaaaab", name: "NAME-SENTINEL-big" } as Command, idemKey: newKey() });
  expect(err).toEqual({ code: "functions/resource-exhausted", kind: "AGGREGATE_TOO_LARGE" });
  expect(diff(before, await snapshot(t.gameId, extra))).toEqual({ created: [], changed: [], deleted: [] });
  const end = await t.host({ type: "endGame" } as Command);
  expect(end.outcome.kind).toBe("accepted");
  expect((await t.state()).phase).toBe("ENDED");
}, 120_000);
