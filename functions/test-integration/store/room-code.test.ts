import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { MemGame } from "../../src/store/test-support";
import { Table } from "./support/drive";
import { clear, db } from "./support/harness";
import { newGameId, newRoomCode } from "./support/seed";

// I14 Room-code release at FINISHED and ENDED (ST8, part). findByRoomCode is #34; the newer-game check on deleteGame is #36.
beforeAll(clear);

/** A 3-player game built in Bun one pick before it finishes (the same deterministic run, stopped one round early). */
function nearlyFinished(): MemGame["game"] {
  const opts = { gameId: newGameId(), roomCode: newRoomCode() };
  const full = MemGame.playing(3, opts);
  let rounds = 0;
  while (full.game.phase === "PLAYING" && full.playRound()) rounds++;
  if (full.game.phase !== "FINISHED") throw new Error("did not finish");
  const m = MemGame.playing(3, opts);
  for (let k = 0; k < rounds - 1; k++) m.playRound();
  m.submitAll();
  return m.game;
}

test("I14 the pick that finishes the game deletes roomCodes/{code} in that commit", async () => {
  const game = nearlyFinished();
  const t = await Table.seed(game);
  const code = db.doc(`roomCodes/${game.roomCode}`);
  expect((await code.get()).get("gameId")).toBe(game.id);
  await t.pick();
  expect((await t.state()).phase).toBe("FINISHED");
  expect((await code.get()).exists).toBe(false);
}, 120_000);

test("I14 endGame deletes the room code; a refused command leaves it", async () => {
  const t = await Table.lobby(3);
  const g = await t.state();
  const code = db.doc(`roomCodes/${g.roomCode}`);
  const refused = await t.run({ kind: "user", uid: t.uidOf(1) }, { type: "endGame" } as Command);
  expect(refused.outcome.kind).toBe("rejected");
  expect((await code.get()).exists).toBe(true);
  await t.host({ type: "endGame" } as Command);
  expect((await code.get()).exists).toBe(false);
}, 120_000);
