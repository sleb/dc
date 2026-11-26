// #27 V6: a raw Game never parses as a view (LLD 2 11.6, LLD 5 2.5). The Projector (2.2) is the only way to a GameView.
import { expect, test } from "bun:test";
import { GameViewLooseSchema, GameViewSchema } from "@dc/contracts";
import { makeGame, pid } from "./support/factories";
import { roundGame } from "./support/round-fixtures";

const games = {
  lobby: makeGame(),
  playing: roundGame({ n: 4, submitted: [1, 2], scores: [1, 0, 2, 0] }),
  judging: roundGame({ n: 3, submitted: [1, 2], phase: "JUDGING" }),
};

for (const [name, game] of Object.entries(games)) {
  test(`V6 JSON.parse(JSON.stringify(${name} game)) fails the strict and the loose view schema`, () => {
    const raw: unknown = JSON.parse(JSON.stringify(game));
    expect(GameViewSchema.safeParse(raw).success).toBe(false);
    expect(GameViewLooseSchema.safeParse(raw).success).toBe(false);
  });
}

test("V6 the failure is the missing discriminator, not an accident of one field", () => {
  const raw: Record<string, unknown> = JSON.parse(JSON.stringify(games.playing));
  const withAudience = { ...raw, audience: "spectator", kind: "live" };
  const res = GameViewSchema.safeParse(withAudience);
  expect(res.success).toBe(false);
  // even with a valid discriminator, the Engine-only keys (uid, hostId, cards, pools) are unrecognized
  const keys = res.error?.issues.flatMap((i) => ("keys" in i ? (i.keys as string[]) : [])) ?? [];
  expect(keys).toEqual(expect.arrayContaining(["hostId", "cards", "pools"]));
  expect(pid(0)).toBe(games.playing.players[0]!.id);
});
