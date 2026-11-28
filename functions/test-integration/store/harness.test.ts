import { beforeAll, expect, test } from "bun:test";
import { clear, create, db, load } from "./support/harness";
import { craftedGame, seedCraftedGame } from "./support/crafted";
import { HOST_NAME } from "./support/ids";

// The emulator-only harness (#33, ruling 1) is reachable in the Functions emulator and answers `load` for a seeded game.
// #37 adds the fixed-id create seam the fixture script needs.
beforeAll(clear);

test("H3 the storeHarness callable loads a seeded game through the Node bundle", async () => {
  const game = craftedGame();
  await seedCraftedGame(db, game);
  const loaded = await load(game.id);
  expect(loaded?.game.id).toBe(game.id);
  expect(loaded?.game.version).toBe(game.version);
  expect(loaded?.store["viewsRev"]).toBeGreaterThan(0);
  expect(Object.hasOwn(loaded?.game ?? {}, "store")).toBe(false);
});

test("H3 load of a missing game is null", async () => {
  expect(await load("missingmissingmissin")).toBeNull();
});

test("H3 a harness create with a fixed gameId lands under it", async () => {
  const gameId = "gFixHarness000000001";
  const r = await create({ gameId, hostId: "host-fixed-harness", hostName: HOST_NAME, idemKey: "fixed-harness-key" });
  expect(r.outcome).toMatchObject({ kind: "accepted", gameId, replay: false });
  expect((await load(gameId))?.game.id).toBe(gameId);
  expect((await db.doc(`games/${gameId}/views/spectator`).get()).exists).toBe(true);
});