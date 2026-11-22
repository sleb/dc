import { describe, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { makeDecide } from "../src/decide";
import { EngineInvariantError } from "../src/errors";
import type { Ctx, Game, Rejection } from "../src/types";
import { fixtureRegistry } from "./support/fixtures";
import { GAME_ID, HOST_UID, ctxFor, deepFreeze, makeGame, makePlayer, makeRound, pid, seatUidOf, userActor } from "./support/factories";

const decide = makeDecide(fixtureRegistry);
const cmd = (c: object): Command => c as unknown as Command;
const rejected = (state: Game | null, c: unknown, ctx: Ctx = ctxFor()): Rejection => {
  const r = decide(state, c as Command, ctx);
  if (r.ok) throw new Error(`expected a rejection, got an acceptance of ${JSON.stringify(c)}`);
  return r.error;
};

/** PLAYING, version 6, round opened at version 5; players 0 (host, judge), 1, 2. Everything fxOrder needs to fail late. */
const playing = (over: Partial<Game> = {}, round: Parameters<typeof makeRound>[0] = {}): Game =>
  makeGame({
    phase: "PLAYING",
    version: 6,
    paused: false,
    players: [makePlayer(0, { status: "active" }), makePlayer(1, { status: "active" }), makePlayer(2, { status: "active" })],
    round: makeRound({ judgeId: pid(0), roster: [pid(0), pid(1), pid(2)], changedAtVersion: 5, ...round }),
    ...over,
  });
const seat1 = ctxFor({ actor: userActor(seatUidOf(GAME_ID, pid(1))) });
const ALL_FAIL = { type: "fxOrder", failRole: true, failPayload: true, failModeration: true, failPrecond: true };

describe("V1 guard order (LLD 1 section 5.3)", () => {
  test("step 0: a non-object cmd or an unknown type is INVALID_ARGUMENT, before NOT_FOUND and before everything else", () => {
    for (const bad of [null, undefined, 5, "fxHost", true, [], {}, { type: 5 }, { type: "nope" }, { type: "__proto__" }, { type: "toString" }, { type: "constructor" }, { type: "hasOwnProperty" }]) {
      expect(rejected(null, bad)).toStrictEqual({ code: "INVALID_ARGUMENT" });
      expect(rejected(playing({ phase: "ENDED" }), bad)).toStrictEqual({ code: "INVALID_ARGUMENT" });
    }
  });

  test("step 1: null state is NOT_FOUND, ahead of an unauthorized actor", () => {
    expect(rejected(null, cmd(ALL_FAIL), seat1)).toStrictEqual({ code: "NOT_FOUND" });
  });

  test("step 1: ENDED rejects everything but deleteGame with WRONG_PHASE and no detail, ahead of the actor check", () => {
    const ended = playing({ phase: "ENDED" });
    expect(rejected(ended, cmd(ALL_FAIL), ctxFor({ actor: userActor("stranger") }))).toStrictEqual({ code: "WRONG_PHASE" });
    expect(rejected(ended, cmd({ type: "fxHost" }))).toStrictEqual({ code: "WRONG_PHASE" });
    expect(decide(ended, cmd({ type: "deleteGame" }), ctxFor()).ok).toBe(true);
  });

  test("step 2: a non-member gets NOT_AUTHORIZED even when the command is also stale, in the wrong phase, paused and failing every later check", () => {
    const g = playing({ paused: true }, { phase: "JUDGING", changedAtVersion: 5 });
    const stranger = ctxFor({ actor: userActor("stranger") });
    expect(rejected(g, cmd({ ...ALL_FAIL, expectedVersion: 0 }), stranger)).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(g, cmd({ ...ALL_FAIL, expectedVersion: 0 }), ctxFor({ actor: { kind: "system" } }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
  });

  test("step 2: host-only commands reject a seated non-host with NOT_AUTHORIZED", () => {
    expect(rejected(playing(), cmd({ type: "fxHost" }), seat1)).toStrictEqual({ code: "NOT_AUTHORIZED" });
  });

  test("step 3: STALE beats a wrong phase, PAUSED and every later failure", () => {
    const g = playing({ paused: true }, { phase: "JUDGING" });
    expect(rejected(g, cmd({ ...ALL_FAIL, expectedVersion: 4 }), seat1)).toStrictEqual({ code: "STALE" });
  });

  test("step 3: STALE also beats the phase list itself (a stale command in a phase the command does not allow)", () => {
    expect(rejected(playing({ phase: "FINISHED" }, { changedAtVersion: 5 }), cmd({ ...ALL_FAIL, expectedVersion: 4 }), seat1)).toStrictEqual({ code: "STALE" });
  });

  test("step 4: WRONG_PHASE beats PAUSED and every later failure (list of phases, then the round-phase predicate)", () => {
    expect(rejected(playing({ paused: true }, { phase: "JUDGING" }), cmd({ ...ALL_FAIL, expectedVersion: 5 }), seat1)).toStrictEqual({ code: "WRONG_PHASE" });
    expect(rejected(playing({ phase: "LOBBY", paused: true, round: null }), cmd(ALL_FAIL), seat1)).toStrictEqual({ code: "WRONG_PHASE" });
  });

  test("step 5: PAUSED beats the role, payload, moderation and precondition failures", () => {
    expect(rejected(playing({ paused: true }), cmd(ALL_FAIL), seat1)).toStrictEqual({ code: "PAUSED" });
  });

  test("step 5: PAUSED applies only to needsPlay commands, and only while PLAYING", () => {
    expect(decide(playing({ paused: true }), cmd({ type: "fxHost" }), ctxFor()).ok).toBe(true);
  });

  test("step 6: the fine role beats payload, moderation and preconditions", () => {
    expect(rejected(playing(), cmd(ALL_FAIL), seat1)).toStrictEqual({ code: "NOT_AUTHORIZED", detail: "sitting_out" });
  });

  test("step 7: INVALID_ARGUMENT beats moderation and preconditions", () => {
    expect(rejected(playing(), cmd({ ...ALL_FAIL, failRole: false }), seat1)).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("step 8: CONTENT_REJECTED beats preconditions and carries only the enum detail", () => {
    expect(rejected(playing(), cmd({ type: "fxOrder", failModeration: true, failPrecond: true }), seat1)).toStrictEqual({ code: "CONTENT_REJECTED", detail: "PROFANITY" });
  });

  test("step 9: preconditions come last", () => {
    expect(rejected(playing(), cmd({ type: "fxOrder", failPrecond: true }), seat1)).toStrictEqual({ code: "NOT_IN_HAND" });
  });

  test("with no failure the command is accepted", () => {
    expect(decide(playing(), cmd({ type: "fxOrder", expectedVersion: 5 }), seat1).ok).toBe(true);
  });

  test("createGame on existing state is WRONG_PHASE with no detail, ahead of the actor check", () => {
    const create = { type: "createGame", gameId: GAME_ID, hostId: "other-uid", hostName: "badword" };
    expect(rejected(makeGame(), cmd(create))).toStrictEqual({ code: "WRONG_PHASE" });
    expect(rejected(playing({ phase: "ENDED" }), cmd(create))).toStrictEqual({ code: "WRONG_PHASE" });
  });

  test("createGame with null state runs steps 2, 7 and 8 in order", () => {
    const create = { type: "createGame", gameId: GAME_ID, hostId: HOST_UID, hostName: "Host" };
    const as = (uid: string) => ctxFor({ actor: userActor(uid) });
    expect(rejected(null, cmd({ ...create, gameId: 5, hostName: "badword" }), as("stranger"))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(null, cmd({ ...create, gameId: 5, hostName: "badword" }), as(HOST_UID))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(null, cmd({ ...create, hostName: "badword" }), as(HOST_UID))).toStrictEqual({ code: "CONTENT_REJECTED", detail: "PROFANITY" });
    const ok = decide(null, cmd(create), ctxFor({ now: 42 }));
    expect(ok.ok && [ok.value.state.version, ok.value.state.createdAt, ok.value.state.id]).toEqual([1, 42, GAME_ID]);
  });
});

describe("V2 staleness", () => {
  const g = playing();
  const play = (expectedVersion: unknown) => decide(g, cmd({ type: "fxOrder", expectedVersion }), seat1);

  test("expectedVersion below round.changedAtVersion is STALE; equal or above is not", () => {
    expect(play(4).ok).toBe(false);
    expect(play(5).ok).toBe(true);
    expect(play(6).ok).toBe(true);
    expect(play(0).ok).toBe(false);
  });

  test("a bare version bump (state.version ahead of expectedVersion) does not make a command stale", () => {
    expect(decide(playing({ version: 99 }), cmd({ type: "fxOrder", expectedVersion: 5 }), seat1).ok).toBe(true);
  });

  test("a non-number or absent expectedVersion is skipped", () => {
    for (const v of ["0", null, undefined, Number.NaN, {}, [], false]) expect(play(v).ok).toBe(true);
    expect(decide(g, cmd({ type: "fxOrder" }), seat1).ok).toBe(true);
  });

  test("only commands marked as round commands are stale-checked", () => {
    expect(decide(g, cmd({ type: "fxHost", expectedVersion: 0 }), ctxFor()).ok).toBe(true);
  });

  test("no round, no staleness", () => {
    const lobby = makeGame({ phase: "PLAYING", players: g.players, round: null });
    expect(decide(lobby, cmd({ type: "fxOrder", expectedVersion: 0 }), seat1).ok).toBe(false); // fails on phase, not on STALE
    const r = rejected(lobby, cmd({ type: "fxOrder", expectedVersion: 0 }), seat1);
    expect(r.code).toBe("WRONG_PHASE");
  });
});

describe("V3 decide never catches", () => {
  test("a handler's EngineInvariantError propagates unchanged; so does any other throw (no catch-all)", () => {
    const g = makeGame();
    expect(() => decide(g, cmd({ type: "fxInvariant" }), ctxFor())).toThrow(EngineInvariantError);
    expect(() => decide(g, cmd({ type: "fxBug" }), ctxFor())).toThrow(TypeError);
  });
});

describe("decide: result shape and the settle/version step", () => {
  test("an accepted command returns state, events, side effects and seed together; version is old + 1; settle runs first", () => {
    const g = makeGame({ phase: "WRITING", version: 3, players: [makePlayer(0), makePlayer(1), makePlayer(2)] });
    const ctx = ctxFor({ now: 4242 });
    const r = decide(g, cmd({ type: "fxHost" }), ctx);
    if (!r.ok) throw new Error("expected acceptance");
    expect(r.value.state.version).toBe(4);
    expect(r.value.aggregateChanged).toBe(true);
    expect(r.value.events).toEqual([{ t: "SettingsUpdated", keys: [] }]); // handler events first
    expect(r.value.seed).toBe(ctx.rng.seed);
    expect(r.value.draftChanges).toEqual([]);
    expect(r.value.roundRecords).toEqual([]);
    expect(r.value.redactEnvelope).toBe(false);
    expect(r.value.deleteGame).toBeUndefined();
    expect(r.value.state).toMatchObject({ episode: "writing", episodeGen: 1, waitingSince: 4242, reminderDueAt: 4242 + 86_400_000 }); // settle step 5 ran
  });

  test("settle events follow the handler's events", () => {
    const g = makeGame({ phase: "WRITING", version: 3, players: [makePlayer(0), makePlayer(1)] }); // 2 seated: settle pauses
    const r = decide(g, cmd({ type: "fxHost" }), ctxFor());
    expect(r.ok && r.value.events).toEqual([{ t: "SettingsUpdated", keys: [] }, { t: "PausedChanged", paused: true }]);
  });

  test("aggregateChanged: false skips settle and the version bump and carries the draft change", () => {
    const g = makeGame({ phase: "WRITING", version: 3, players: [makePlayer(0), makePlayer(1, { status: "writing" }), makePlayer(2)] });
    const r = decide(g, cmd({ type: "fxDraft" }), ctxFor({ actor: userActor(seatUidOf(GAME_ID, pid(1))) }));
    if (!r.ok) throw new Error("expected acceptance");
    expect(r.value.aggregateChanged).toBe(false);
    expect(r.value.state).toBe(g);
    expect(r.value.draftChanges).toEqual([{ playerId: pid(1), draft: { red: [], green: [] } }]);
  });

  test("redactEnvelope and deleteGame come from the handler", () => {
    const g = makeGame({ phase: "WRITING", players: [makePlayer(0), makePlayer(1), makePlayer(2)] });
    const shuffled = decide(g, cmd({ type: "fxShuffle" }), ctxFor());
    expect(shuffled.ok && shuffled.value.redactEnvelope).toBe(true);
    const del = decide(g, cmd({ type: "deleteGame" }), ctxFor());
    expect(del.ok && del.value.deleteGame).toBe(true);
  });

  test("a rejection carries nothing but the error", () => {
    const r = decide(makeGame(), cmd({ type: "fxHost" }), seat1);
    expect(r).toStrictEqual({ ok: false, error: { code: "NOT_AUTHORIZED" } });
  });

  test("never reads or writes its inputs: deep-frozen state, cmd and ctx work", () => {
    const g = deepFreeze(makeGame({ phase: "WRITING", players: [makePlayer(0), makePlayer(1), makePlayer(2)] }));
    expect(decide(g, deepFreeze(cmd({ type: "fxShuffle" })), deepFreeze(ctxFor())).ok).toBe(true);
  });
});
