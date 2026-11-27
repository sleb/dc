import { beforeAll, expect, test } from "bun:test";
import { clear, db, load } from "./support/harness";
import { createdGame, seedGame } from "./support/seed";

// The emulator-only harness (#33, ruling 1) is reachable in the Functions emulator and answers `load` for a seeded game.
beforeAll(clear);

test("H3 the storeHarness callable loads a seeded game through the Node bundle", async () => {
  const game = createdGame();
  await seedGame(db, game);
  const loaded = await load(game.id);
  expect(loaded?.game.id).toBe(game.id);
  expect(loaded?.game.version).toBe(game.version);
  expect(loaded?.store["viewsRev"]).toBeGreaterThan(0);
  expect(Object.hasOwn(loaded?.game ?? {}, "store")).toBe(false);
});

test("H3 load of a missing game is null", async () => {
  expect(await load("missingmissingmissin")).toBeNull();
});
