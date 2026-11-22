import { describe, expect, test } from "bun:test";
import { actorRole, seatUid } from "../src/roles";
import { GAME_ID, HOST_UID, makeGame, makePlayer, makeRound, pid, seatUidOf, userActor } from "./support/factories";

const game = () => makeGame({
  phase: "PLAYING",
  players: [makePlayer(0, { status: "active" }), makePlayer(1, { status: "active" }), makePlayer(2, { status: "left" }), makePlayer(3, { status: "removed" }), makePlayer(4, { status: "ready" }), makePlayer(5, { status: "writing" })],
  round: makeRound({ judgeId: pid(1) }),
});

describe("V6 seatUid", () => {
  test("is seat:{gameId}:{playerId}", () => {
    expect(seatUid(GAME_ID, pid(3))).toBe(`seat:${GAME_ID}:${pid(3)}`);
    expect(seatUid(GAME_ID, pid(3))).toBe(seatUidOf(GAME_ID, pid(3)));
  });
});

describe("V6 actorRole", () => {
  const g = game();
  const role = (uid: string) => actorRole(g, userActor(uid));

  test("the host with a seat is host and player at once, never a spectator", () => {
    expect(role(HOST_UID)).toEqual({ host: true, playerId: pid(0), status: "active", judge: false, spectator: false });
  });

  test("the host without a seat is host and spectator", () => {
    const noSeat = makeGame({ players: [makePlayer(1, { status: "active" })] });
    expect(actorRole(noSeat, userActor(HOST_UID))).toEqual({ host: true, playerId: null, status: null, judge: false, spectator: true });
  });

  test("a seated player resolves by seat uid and reports status; the judge is flagged", () => {
    expect(role(seatUidOf(GAME_ID, pid(1)))).toEqual({ host: false, playerId: pid(1), status: "active", judge: true, spectator: false });
    expect(role(seatUidOf(GAME_ID, pid(4)))).toMatchObject({ playerId: pid(4), status: "ready", judge: false });
    expect(role(seatUidOf(GAME_ID, pid(5)))).toMatchObject({ playerId: pid(5), status: "writing" });
  });

  test("a left or removed player is a spectator with no player id", () => {
    for (const n of [2, 3]) expect(role(seatUidOf(GAME_ID, pid(n)))).toEqual({ host: false, playerId: null, status: null, judge: false, spectator: true });
  });

  test("an unknown uid is a spectator", () => {
    expect(role("anyone")).toEqual({ host: false, playerId: null, status: null, judge: false, spectator: true });
  });

  test("the system actor is no host, no seat and not a spectator", () => {
    expect(actorRole(g, { kind: "system" })).toEqual({ host: false, playerId: null, status: null, judge: false, spectator: false });
  });

  test("judge is false when there is no round or the judge is null", () => {
    expect(actorRole({ ...g, round: null }, userActor(seatUidOf(GAME_ID, pid(1)))).judge).toBe(false);
    expect(actorRole({ ...g, round: makeRound({ judgeId: null }) }, userActor(seatUidOf(GAME_ID, pid(1)))).judge).toBe(false);
  });

  test("resolution is by uid only: a departed seat does not shadow a seated one with the same uid", () => {
    const dup = makeGame({ players: [makePlayer(0), makePlayer(1, { status: "left", uid: "u" }), makePlayer(2, { status: "active", uid: "u" })] });
    expect(actorRole(dup, userActor("u")).playerId).toBe(pid(2));
  });
});
