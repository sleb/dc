import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { MAX_SEATED, MAX_TOTAL_JOINS } from "@dc/contracts";
import type { Command } from "@dc/contracts";
import { decide } from "../src/decide";
import { REGISTRY } from "../src/registry";
import type { Accepted, Actor, Ctx, DomainEvent, Game, Phase, Rejection } from "../src/types";
import { DEFAULT_SETTINGS, GAME_ID, HOST_UID, addCard, cid, ctxFor, deepFreeze, makeGame, makePlayer, pid, seatUidOf, userActor } from "./support/factories";
import { assertProperty } from "./support/fc";

// L1 to L6 and X9 (LLD 1 sections 5.3, 7.1, 7.2, 8.5, 15.2) over the real REGISTRY, through the public `decide`.
const LOBBY_TYPES = ["createGame", "join", "leave", "removePlayer", "updateSettings"];
const cmd = (c: object): Command => c as unknown as Command;
const host: Actor = userActor(HOST_UID);
const seat = (n: number): Actor => userActor(seatUidOf(GAME_ID, pid(n)));
const stranger: Actor = userActor("stranger-uid");
const system: Actor = { kind: "system" };

const run = (state: Game | null, c: object, actor: Actor = host, ctx: Partial<Ctx> = {}) =>
  decide(state === null ? null : deepFreeze(structuredClone(state)), cmd(c), ctxFor({ actor, ...ctx }));
const rejected = (state: Game | null, c: object, actor: Actor = host): Rejection => {
  const r = run(state, c, actor);
  if (r.ok) throw new Error(`expected a rejection, got an acceptance of ${JSON.stringify(c)}`);
  return r.error;
};
const accepted = (state: Game | null, c: object, actor: Actor = host, ctx: Partial<Ctx> = {}): Accepted => {
  const r = run(state, c, actor, ctx);
  if (!r.ok) throw new Error(`expected an acceptance of ${JSON.stringify(c)}, got ${JSON.stringify(r.error)}`);
  return r.value;
};

/** A game of `n` seated players (0 = host) with totalJoins consistent with the joins that built it. */
const game = (n: number, over: Partial<Game> = {}): Game =>
  makeGame({ totalJoins: Math.max(0, n - 1), players: Array.from({ length: n }, (_, i) => makePlayer(i)), ...over });
const inPhase = (phase: Phase): Game =>
  game(3, { phase, players: [0, 1, 2].map((i) => makePlayer(i, { status: phase === "LOBBY" ? "writing" : "active" })) });
const CREATE = { type: "createGame", gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "Host" };
const JOIN = { type: "join", playerId: pid(5), name: "Newcomer" };
const patch = (p: unknown) => ({ type: "updateSettings", patch: p });
const VARIANTS = { pitch: true, writeIn: true, redraw: false, peoplesChoice: true };

describe("the real registry holds the lobby, writing and round commands", () => {
  test("keys are the five lobby types, the three writing types (#21) and the three round types (#22); the rest are #23 and later", () => {
    expect(Object.keys(REGISTRY).sort()).toEqual([...LOBBY_TYPES, "finishWriting", "saveDraft", "startGame", "confirmSubmission", "closeSubmissions", "pickWinner"].sort());
  });
});

describe("L1 command x phase (5.3 guard 4, 7.1)", () => {
  const PHASES: Phase[] = ["LOBBY", "WRITING", "PLAYING", "FINISHED", "ENDED"];
  const lobbyOnly: [string, object, Actor][] = [
    ["join", JOIN, seat(5)],
    ["leave", { type: "leave" }, seat(1)],
    ["removePlayer", { type: "removePlayer", playerId: pid(1) }, host],
  ];
  for (const [type, c, actor] of lobbyOnly) {
    for (const phase of PHASES) {
      test(`${type} in ${phase}: ${phase === "LOBBY" ? "accepted" : "WRONG_PHASE"}`, () => {
        if (phase === "LOBBY") expect(run(inPhase(phase), c, actor).ok).toBe(true);
        else expect(rejected(inPhase(phase), c, actor)).toStrictEqual({ code: "WRONG_PHASE" });
      });
    }
  }

  test("updateSettings: any key in LOBBY; profanity only in WRITING and PLAYING; nothing in FINISHED or ENDED", () => {
    const all = patch({ targetOverride: 5, variants: VARIANTS });
    const profanity = patch({ profanity: "off" });
    expect(run(inPhase("LOBBY"), all).ok).toBe(true);
    for (const phase of ["WRITING", "PLAYING"] as const) {
      expect(rejected(inPhase(phase), all)).toStrictEqual({ code: "WRONG_PHASE" });
      expect(accepted(inPhase(phase), profanity).state.settings.profanity).toBe("off");
    }
    for (const phase of ["FINISHED", "ENDED"] as const) {
      expect(rejected(inPhase(phase), profanity)).toStrictEqual({ code: "WRONG_PHASE" });
      expect(rejected(inPhase(phase), all)).toStrictEqual({ code: "WRONG_PHASE" });
    }
  });

  test("ENDED accepts only deleteGame, which is not a lobby command: an empty patch is WRONG_PHASE there too", () => {
    expect(rejected(inPhase("ENDED"), patch({}))).toStrictEqual({ code: "WRONG_PHASE" });
  });

  test("createGame on any existing state is WRONG_PHASE with no detail", () => {
    for (const phase of PHASES) expect(rejected(inPhase(phase), CREATE)).toStrictEqual({ code: "WRONG_PHASE" });
  });
});

describe("L2 command x role (guard 2)", () => {
  test("updateSettings and removePlayer: a seated non-host, a stranger and the system are NOT_AUTHORIZED", () => {
    for (const c of [patch({}), { type: "removePlayer", playerId: pid(2) }]) {
      for (const actor of [seat(1), stranger, system]) expect(rejected(inPhase("LOBBY"), c, actor)).toStrictEqual({ code: "NOT_AUTHORIZED" });
    }
  });

  test("leave: a stranger, the system and a seat that is not in the game are NOT_AUTHORIZED; the host's seat may leave", () => {
    for (const actor of [stranger, system, seat(7)]) expect(rejected(inPhase("LOBBY"), { type: "leave" }, actor)).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(run(inPhase("LOBBY"), { type: "leave" }, host).ok).toBe(true);
  });

  test("leave: a departed seat does not count as a member", () => {
    const g = game(3, { players: [makePlayer(0), makePlayer(1, { status: "left" }), makePlayer(2)] });
    expect(rejected(g, { type: "leave" }, seat(1))).toStrictEqual({ code: "NOT_AUTHORIZED" });
  });

  test("join needs actor.uid === seatUid(gameId, playerId): a different seat, the host, a stranger and the system are refused", () => {
    for (const actor of [seat(4), host, stranger, system]) expect(rejected(inPhase("LOBBY"), JOIN, actor)).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(run(inPhase("LOBBY"), JOIN, seat(5)).ok).toBe(true);
  });

  test("createGame needs a user actor whose uid is the hostId", () => {
    for (const actor of [stranger, system, seat(0)]) expect(rejected(null, CREATE, actor)).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(run(null, CREATE, host).ok).toBe(true);
  });
});

describe("E1 guard order, pinned with combined failures", () => {
  test("a non-member who is also in the wrong phase with a bad payload gets NOT_AUTHORIZED", () => {
    expect(rejected(inPhase("PLAYING"), patch({ targetOverride: 99 }), stranger)).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(inPhase("PLAYING"), { type: "leave" }, stranger)).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(inPhase("PLAYING"), { ...JOIN, name: 5 }, stranger)).toStrictEqual({ code: "NOT_AUTHORIZED" });
  });

  test("the host in the wrong phase with an invalid payload gets WRONG_PHASE (phase before payload)", () => {
    expect(rejected(inPhase("WRITING"), patch({ targetOverride: 99, variants: VARIANTS }))).toStrictEqual({ code: "WRONG_PHASE" });
  });

  test("an invalid payload beats a state precondition: a bad override range with no deck is INVALID_ARGUMENT", () => {
    expect(rejected(inPhase("LOBBY"), patch({ writeCountsOverride: { red: 99, green: 1 } }))).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("createGame: existing state beats a bad actor, which beats a bad payload", () => {
    expect(rejected(inPhase("LOBBY"), { ...CREATE, settings: { targetOverride: 99 } }, stranger)).toStrictEqual({ code: "WRONG_PHASE" });
    expect(rejected(null, { ...CREATE, settings: { targetOverride: 99 } }, stranger)).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(null, { ...CREATE, settings: { targetOverride: 99 } })).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("a null state is NOT_FOUND for every non-creating lobby command, ahead of the actor", () => {
    for (const c of [JOIN, { type: "leave" }, { type: "removePlayer", playerId: pid(1) }, patch({})]) {
      expect(rejected(null, c, stranger)).toStrictEqual({ code: "NOT_FOUND" });
    }
  });
});

describe("L3 createGame (7.2)", () => {
  test("builds the LOBBY aggregate: version 1, host seat 0 writing with the host's uid, defaults, createdAt = ctx.now, GameCreated", () => {
    const a = accepted(null, { ...CREATE, hostName: "  Hostess  " }, host, { now: 4242 });
    expect(a.state).toEqual(makeGame({ createdAt: 4242, version: 1, totalJoins: 0, players: [makePlayer(0, { name: "Hostess" })] }));
    expect(a.events).toEqual([{ t: "GameCreated", hostPlayerId: pid(0) }]);
    expect(a.aggregateChanged).toBe(true);
    expect(a.deleteGame).toBeUndefined();
    expect(a.state.players[0]?.writeTarget).toBeNull();
  });

  test("settings default and merge: provided keys win, absent keys keep their defaults, nested objects are whole", () => {
    const s = accepted(null, { ...CREATE, settings: { profanity: "off", targetOverride: 4, spectators: { enabled: true, vote: false } } }).state.settings;
    expect(s).toEqual({ ...DEFAULT_SETTINGS, profanity: "off", targetOverride: 4, spectators: { enabled: true, vote: false } });
  });

  test("two created games do not share nested settings objects", () => {
    const a = accepted(null, CREATE).state.settings;
    const b = accepted(null, CREATE).state.settings;
    expect(a.variants).not.toBe(b.variants);
    expect(a.spectators).not.toBe(b.spectators);
    (a.variants as { pitch: boolean }).pitch = true;
    (a.spectators as { enabled: boolean }).enabled = true;
    expect(b.variants.pitch).toBe(false);
    expect(b.spectators.enabled).toBe(false);
    expect(accepted(null, CREATE).state.settings).toEqual(DEFAULT_SETTINGS);
  });

  test("settings out of range, malformed or with an override and no deck are INVALID_ARGUMENT", () => {
    for (const settings of [{ targetOverride: 1 }, { targetOverride: 11 }, { targetOverride: 2.5 }, { profanity: "maybe" }, { variants: { pitch: true } }, { spectators: null }, { writeCountsOverride: { red: 1, green: 1 } }, "x", 5, []]) {
      expect(rejected(null, { ...CREATE, settings })).toStrictEqual({ code: "INVALID_ARGUMENT" });
    }
  });

  test("malformed identity fields are INVALID_ARGUMENT", () => {
    for (const over of [{ gameId: "short" }, { hostPlayerId: "p_x" }, { hostName: 5 }, { roomCode: "ZZZZ1" }, { roomCode: 7 }]) {
      expect(rejected(null, { ...CREATE, ...over })).toStrictEqual({ code: "INVALID_ARGUMENT" });
    }
  });

  test("the host is the only seat; no draft changes, round records or envelope redaction", () => {
    const a = accepted(null, CREATE);
    expect([a.state.players.length, a.draftChanges, a.roundRecords, a.redactEnvelope]).toEqual([1, [], [], false]);
  });
});

describe("L4 updateSettings (7.1, 7.2)", () => {
  test("LOBBY: any key applies; SettingsUpdated lists the keys in settings order", () => {
    const a = accepted(game(3), patch({ writeCountsOverride: null, spectators: { enabled: true, vote: true }, variants: VARIANTS, profanity: "off", targetOverride: 6 }));
    expect(a.state.settings).toEqual({ targetOverride: 6, profanity: "off", variants: VARIANTS, spectators: { enabled: true, vote: true }, writeCountsOverride: null });
    expect(a.events).toEqual<DomainEvent[]>([{ t: "SettingsUpdated", keys: ["targetOverride", "profanity", "variants", "spectators", "writeCountsOverride"] }]);
    expect(a.state.version).toBe(2);
  });

  test("variants and spectators are replaced wholesale, never merged; a partial nested object is INVALID_ARGUMENT", () => {
    const g = game(3, { settings: { ...DEFAULT_SETTINGS, variants: VARIANTS } });
    const next = accepted(g, patch({ variants: { pitch: false, writeIn: false, redraw: true, peoplesChoice: false } })).state.settings.variants;
    expect(next).toEqual({ pitch: false, writeIn: false, redraw: true, peoplesChoice: false });
    expect(rejected(g, patch({ variants: { pitch: false } }))).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("a null target clears it; keys not in the patch keep their values", () => {
    const g = game(3, { settings: { ...DEFAULT_SETTINGS, targetOverride: 5, profanity: "off" } });
    expect(accepted(g, patch({ targetOverride: null })).state.settings).toEqual({ ...DEFAULT_SETTINGS, targetOverride: null, profanity: "off" });
  });

  test("ranges: target 2..10 whole numbers, profanity on or off; a patch that is not an object or is missing is INVALID_ARGUMENT", () => {
    for (const p of [{ targetOverride: 1 }, { targetOverride: 11 }, { targetOverride: 3.5 }, { targetOverride: "5" }, { profanity: "ON" }, { spectators: { enabled: "yes", vote: false } }, { writeCountsOverride: { red: 11, green: 0 } }, "nope", null, 7, []]) {
      expect(rejected(game(3), patch(p))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    }
    expect(rejected(game(3), { type: "updateSettings" })).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(accepted(game(3), patch({ targetOverride: 2 })).state.settings.targetOverride).toBe(2);
    expect(accepted(game(3), patch({ targetOverride: 10 })).state.settings.targetOverride).toBe(10);
  });

  test("writeCountsOverride needs an imported deck (cards non-empty); with cards it applies; clearing it never needs one", () => {
    const o = { red: 3, green: 2 };
    expect(rejected(game(3), patch({ writeCountsOverride: o }))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    const withCards = addCard(game(3), cid(1), "red", "redDeck");
    expect(accepted(withCards, patch({ writeCountsOverride: o })).state.settings.writeCountsOverride).toEqual(o);
    expect(accepted(game(3), patch({ writeCountsOverride: null })).state.settings.writeCountsOverride).toBeNull();
  });

  test("WRITING and PLAYING accept a profanity-only patch and nothing else; an empty patch is accepted as keys []", () => {
    for (const phase of ["WRITING", "PLAYING"] as const) {
      for (const bad of [{ targetOverride: 5 }, { variants: VARIANTS }, { spectators: { enabled: true, vote: true } }, { writeCountsOverride: null }, { profanity: "off", targetOverride: 5 }]) {
        expect(rejected(inPhase(phase), patch(bad))).toStrictEqual({ code: "WRONG_PHASE" });
      }
      expect(accepted(inPhase(phase), patch({ profanity: "off" })).events).toEqual([{ t: "SettingsUpdated", keys: ["profanity"] }]);
      expect(accepted(inPhase(phase), patch({})).events).toEqual([{ t: "SettingsUpdated", keys: [] }]);
    }
  });

  test("the result differs from the input only in settings and version", () => {
    const g = game(4);
    const a = accepted(g, patch({ profanity: "off" }));
    expect({ ...a.state, settings: g.settings, version: g.version }).toEqual(g);
  });
});

describe("L5 join (7.1, 5.3 guard 9)", () => {
  const nth = (n: number, name = `Guest ${n}`) => ({ type: "join", playerId: pid(n), name });

  test("appends the player: seat uid, status writing, no write target, joinOrder after every earlier one, totalJoins + 1, PlayerJoined", () => {
    const g = game(3, { totalJoins: 2 });
    const a = accepted(g, { type: "join", playerId: pid(7), name: "  Seven  " }, seat(7));
    expect(a.state.players).toEqual([...g.players, makePlayer(7, { name: "Seven", joinOrder: 3 })]);
    expect(a.state.totalJoins).toBe(3);
    expect(a.state.version).toBe(2);
    expect(a.events).toEqual([{ t: "PlayerJoined", playerId: pid(7) }]);
  });

  test("NAME_TAKEN ignores case and whitespace, and counts the host's name", () => {
    const g = game(3, { players: [makePlayer(0, { name: "The Host" }), makePlayer(1, { name: "Ann Marie" }), makePlayer(2)] });
    for (const name of ["the host", "THEHOST", "  t h e   h o s t ", "ann\tmarie", "AnnMarie"]) {
      expect(rejected(g, nth(5, name), seat(5))).toStrictEqual({ code: "NAME_TAKEN" });
    }
    expect(run(g, nth(5, "Ann Maria"), seat(5)).ok).toBe(true);
  });

  test("a departed player's name is free again", () => {
    const g = game(3, { players: [makePlayer(0), makePlayer(1, { name: "Ann", status: "left" }), makePlayer(2)] });
    expect(run(g, nth(5, "ann"), seat(5)).ok).toBe(true);
  });

  test("seated >= 10 is ROOM_FULL with no detail; 9 seated still has room", () => {
    expect(rejected(game(MAX_SEATED), nth(20), seat(20))).toStrictEqual({ code: "ROOM_FULL" });
    expect(run(game(MAX_SEATED - 1), nth(20), seat(20)).ok).toBe(true);
  });

  test("guard 9 order pinned: NAME_TAKEN, then ROOM_FULL, then ROOM_FULL join_cap", () => {
    const full = game(MAX_SEATED, { totalJoins: MAX_TOTAL_JOINS });
    expect(rejected(full, nth(20, "player 1"), seat(20))).toStrictEqual({ code: "NAME_TAKEN" });
    expect(rejected(full, nth(20, "Fresh"), seat(20))).toStrictEqual({ code: "ROOM_FULL" });
    const capped = game(3, { totalJoins: MAX_TOTAL_JOINS });
    expect(rejected(capped, nth(20, "Fresh"), seat(20))).toStrictEqual({ code: "ROOM_FULL", detail: "join_cap" });
    expect(rejected(capped, nth(20, "player 1"), seat(20))).toStrictEqual({ code: "NAME_TAKEN" });
  });

  test("a playerId already seated, a malformed id, a non-string name and a missing name are INVALID_ARGUMENT", () => {
    const g = game(3);
    expect(rejected(g, { ...nth(1), name: "Fresh" }, seat(1))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(g, { type: "join", playerId: "nope", name: "Fresh" }, userActor(seatUidOf(GAME_ID, "nope")))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(g, { ...nth(5), name: 5 }, seat(5))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(g, { type: "join", playerId: pid(5) }, seat(5))).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("the engine does not moderate (that is #25): an empty name is stored, not CONTENT_REJECTED", () => {
    expect(run(game(3), nth(5, "   "), seat(5)).ok).toBe(true);
  });
});

describe("L6 leave and removePlayer in LOBBY (7.1, 8.5)", () => {
  test("leave deletes the record, emits PlayerLeft, keeps totalJoins, bumps the version", () => {
    const g = game(4, { totalJoins: 3 });
    const a = accepted(g, { type: "leave" }, seat(2));
    expect(a.state.players.map((p) => p.id)).toEqual([pid(0), pid(1), pid(3)]);
    expect(a.events).toEqual([{ t: "PlayerLeft", playerId: pid(2) }]);
    expect(a.state.totalJoins).toBe(3);
    expect(a.state.version).toBe(2);
    expect(a.draftChanges).toEqual([]);
  });

  test("removePlayer deletes the target's record and emits PlayerRemoved", () => {
    const a = accepted(game(4), { type: "removePlayer", playerId: pid(3) });
    expect(a.state.players.map((p) => p.id)).toEqual([pid(0), pid(1), pid(2)]);
    expect(a.events).toEqual([{ t: "PlayerRemoved", playerId: pid(3) }]);
  });

  test("removePlayer: an unknown or already departed target is NOT_FOUND; a missing or non-string target is INVALID_ARGUMENT", () => {
    const g = game(3, { players: [makePlayer(0), makePlayer(1, { status: "removed" }), makePlayer(2)] });
    expect(rejected(g, { type: "removePlayer", playerId: pid(9) })).toStrictEqual({ code: "NOT_FOUND" });
    expect(rejected(g, { type: "removePlayer", playerId: pid(1) })).toStrictEqual({ code: "NOT_FOUND" });
    expect(rejected(g, { type: "removePlayer", playerId: 5 })).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(g, { type: "removePlayer" })).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("the host may leave and may remove their own seat; host powers rest on hostId, not on a seat", () => {
    const left = accepted(game(3), { type: "leave" }, host).state;
    expect(left.players.map((p) => p.id)).toEqual([pid(1), pid(2)]);
    expect(left.hostId).toBe(HOST_UID);
    expect(accepted(left, patch({ profanity: "off" }), host).state.settings.profanity).toBe("off");
    expect(accepted(game(3), { type: "removePlayer", playerId: pid(0) }, host).state.players.map((p) => p.id)).toEqual([pid(1), pid(2)]);
  });

  test("joinOrder is never reused after a leave", () => {
    let s = accepted(null, CREATE).state;
    s = accepted(s, { type: "join", playerId: pid(1), name: "One" }, seat(1)).state;
    s = accepted(s, { type: "join", playerId: pid(2), name: "Two" }, seat(2)).state;
    s = accepted(s, { type: "leave" }, seat(2)).state;
    s = accepted(s, { type: "join", playerId: pid(3), name: "Three" }, seat(3)).state;
    expect(s.players.map((p) => [p.id, p.joinOrder])).toEqual([[pid(0), 0], [pid(1), 1], [pid(3), 3]]);
  });
});

describe("X9 join cap (7.1, 15.2)", () => {
  test("totalJoins at the cap is ROOM_FULL join_cap with two seated; one below it is accepted", () => {
    const j = { type: "join", playerId: pid(9), name: "X" };
    expect(rejected(game(2, { totalJoins: MAX_TOTAL_JOINS }), j, seat(9))).toStrictEqual({ code: "ROOM_FULL", detail: "join_cap" });
    expect(run(game(2, { totalJoins: MAX_TOTAL_JOINS - 1 }), j, seat(9)).ok).toBe(true);
  });

  test("50 join and leave cycles end refused: the 51st join is join_cap, and totalJoins stays 50", () => {
    let s = accepted(null, CREATE).state;
    for (let k = 1; k <= MAX_TOTAL_JOINS; k++) {
      s = accepted(s, { type: "join", playerId: pid(k), name: `P${k}` }, seat(k)).state;
      expect(s.totalJoins).toBe(k);
      s = accepted(s, { type: "leave" }, seat(k)).state;
    }
    expect(s.players.map((p) => p.id)).toEqual([pid(0)]);
    expect(rejected(s, { type: "join", playerId: pid(60), name: "Late" }, seat(60))).toStrictEqual({ code: "ROOM_FULL", detail: "join_cap" });
    expect(s.totalJoins).toBe(MAX_TOTAL_JOINS);
  });

  test("property: totalJoins never decreases and equals the number of accepted joins over any join and leave sequence", () => {
    const arbOps = fc.array(fc.record({ join: fc.boolean(), pick: fc.nat(100) }), { maxLength: 130 });
    assertProperty(fc.property(arbOps, (ops) => {
      let s: Game = accepted(null, CREATE).state;
      let acceptedJoins = 0;
      let next = 1;
      for (const op of ops) {
        const before = s.totalJoins;
        if (op.join) {
          const id = pid(next++);
          const r = run(s, { type: "join", playerId: id, name: `N${next}` }, userActor(seatUidOf(GAME_ID, id)));
          if (r.ok) { acceptedJoins++; s = r.value.state; }
        } else {
          const others = s.players.filter((p) => p.id !== pid(0));
          const p = others[op.pick % Math.max(1, others.length)];
          if (p !== undefined) s = accepted(s, { type: "leave" }, userActor(p.uid)).state;
        }
        expect(s.totalJoins).toBeGreaterThanOrEqual(before);
        expect(s.totalJoins).toBe(acceptedJoins);
        expect(s.players.length).toBeLessThanOrEqual(MAX_SEATED);
      }
    }));
  });
});
