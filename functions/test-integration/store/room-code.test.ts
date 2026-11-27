import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { roomCodeFromSeed } from "../../src/store";
import { MemGame } from "../../src/store/test-support";
import { Table } from "./support/drive";
import { clear, create, db, findRoomCode, load, run } from "./support/harness";
import { HOST_NAME, newGameId, newKey, newRoomCode } from "./support/seed";

// I14 Room-code release at FINISHED and ENDED (ST8, part). I21 findByRoomCode (#34). I30 the deleteGame ownership check (#36).
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

test("I21 findByRoomCode resolves a live code, normalizes case and whitespace, and rejects malformed codes", async () => {
  const t = await Table.lobby(3);
  const g = await t.state();
  const stored = await db.doc(`roomCodes/${g.roomCode}`).get();
  const doc = { gameId: stored.get("gameId") as string, createdAt: stored.get("createdAt") as number };
  expect(doc.gameId).toBe(t.gameId);
  expect(await findRoomCode(g.roomCode)).toEqual(doc);
  expect(await findRoomCode(g.roomCode.toLowerCase())).toEqual(doc);
  expect(await findRoomCode(`  ${g.roomCode.toLowerCase()}\t`)).toEqual(doc);
  expect(await findRoomCode("AAAA")).toBeNull(); // a vowel character is not in the alphabet
  expect(await findRoomCode("ZZZZ")).toBeNull(); // well formed, unknown
  expect(await findRoomCode("BCD1")).toBeNull();
  expect(await findRoomCode("BCD")).toBeNull();
}, 120_000);

test("I21 a finished or ended game releases its code; load still works", async () => {
  const finished = await Table.playing(3);
  let guard = 0;
  while ((await finished.state()).phase === "PLAYING" && guard++ < 50) await finished.playRound();
  const fg = await finished.state();
  expect(fg.phase).toBe("FINISHED");
  expect(await findRoomCode(fg.roomCode)).toBeNull();
  expect(await load(finished.gameId)).not.toBeNull();

  const ended = await Table.lobby(3);
  const eg = await ended.state();
  await ended.host({ type: "endGame" } as Command);
  expect(await findRoomCode(eg.roomCode)).toBeNull();
  expect(await load(ended.gameId)).not.toBeNull();
}, 180_000);

test("I21 a released code re-taken by a newer createGame resolves to the newer gameId", async () => {
  const codeSeed = "i21-reuse";
  const code = roomCodeFromSeed(codeSeed);
  const hostId = `host-${crypto.randomUUID()}`;
  const first = await create({ hostId, hostName: HOST_NAME, idemKey: newKey(), seeds: [codeSeed] });
  if (first.outcome.kind !== "accepted") throw new Error(`create rejected: ${JSON.stringify(first.outcome)}`);
  expect(first.outcome.roomCode).toBe(code);
  const ended = await run({ gameId: first.outcome.gameId, actor: { kind: "user", uid: hostId }, cmd: { type: "endGame" } as Command, idemKey: newKey() });
  expect(ended.outcome.kind).toBe("accepted");
  expect((await db.doc(`roomCodes/${code}`).get()).exists).toBe(false);

  const newer = await create({ hostId: `host-${crypto.randomUUID()}`, hostName: HOST_NAME, idemKey: newKey(), seeds: [codeSeed] });
  if (newer.outcome.kind !== "accepted") throw new Error(`create rejected: ${JSON.stringify(newer.outcome)}`);
  expect(newer.outcome.roomCode).toBe(code);
  expect(newer.outcome.gameId).not.toBe(first.outcome.gameId);
  const stored = await db.doc(`roomCodes/${code}`).get();
  expect(stored.get("gameId")).toBe(newer.outcome.gameId);
  expect(await findRoomCode(code)).toEqual({ gameId: newer.outcome.gameId, createdAt: stored.get("createdAt") as number });
}, 120_000);

test("I30 deleting a finished game leaves a newer game's re-taken roomCodes/{code} untouched", async () => {
  const codeSeed = "i30-reuse";
  const code = roomCodeFromSeed(codeSeed);
  const hostA = `host-${crypto.randomUUID()}`;
  const first = await create({ hostId: hostA, hostName: HOST_NAME, idemKey: newKey(), seeds: [codeSeed] });
  if (first.outcome.kind !== "accepted") throw new Error(`create rejected: ${JSON.stringify(first.outcome)}`);
  expect(first.outcome.roomCode).toBe(code);
  const ended = await run({ gameId: first.outcome.gameId, actor: { kind: "user", uid: hostA }, cmd: { type: "endGame" } as Command, idemKey: newKey() });
  expect(ended.outcome.kind).toBe("accepted");
  expect((await db.doc(`roomCodes/${code}`).get()).exists).toBe(false);

  const newer = await create({ hostId: `host-${crypto.randomUUID()}`, hostName: HOST_NAME, idemKey: newKey(), seeds: [codeSeed] });
  if (newer.outcome.kind !== "accepted") throw new Error(`create rejected: ${JSON.stringify(newer.outcome)}`);
  expect(newer.outcome.roomCode).toBe(code);

  const del = await run({ gameId: first.outcome.gameId, actor: { kind: "user", uid: hostA }, cmd: { type: "deleteGame" } as Command, idemKey: newKey() });
  expect(del.outcome).toEqual({ kind: "deleting" });
  expect(del.writes).toBe(2); // the aggregate update and the job; the code doc now names the newer game (ST8)
  expect((await db.doc(`roomCodes/${code}`).get()).get("gameId")).toBe(newer.outcome.gameId);
}, 120_000);

test("I30 deleting a LOBBY game removes its code and findByRoomCode returns null", async () => {
  const t = await Table.lobby(3);
  const g = await t.state();
  const del = await t.run({ kind: "user", uid: t.hostId }, { type: "deleteGame" } as Command, { idemKey: newKey() });
  expect(del.outcome).toEqual({ kind: "deleting" });
  expect(del.writes).toBe(3);
  expect((await db.doc(`roomCodes/${g.roomCode}`).get()).exists).toBe(false);
  expect(await findRoomCode(g.roomCode)).toBeNull();
}, 120_000);
