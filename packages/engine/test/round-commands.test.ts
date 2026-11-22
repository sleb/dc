// #22: confirmSubmission, closeSubmissions, pickWinner through the real REGISTRY (LLD 1 sections 5.3, 7.1, 7.2, 8.3): the guard ladder, the effects, the rng order,
// E9 to E15 and the pitch. The helpers under them are in round-rules.test.ts; the whole game is in game.test.ts.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Command } from "@dc/contracts";
import { decide } from "../src/decide";
import { REGISTRY } from "../src/registry";
import { makeRng } from "../src/rng";
import type { Accepted, Actor, Ctx, DomainEvent, Game, Rejection } from "../src/types";
import { checkAll } from "./support/checks";
import { GAME_ID, HOST_UID, cid, ctxFor, deepFreeze, makeGame, makePlayer, pid, recordingRng, scriptedRng, seatUidOf, userActor } from "./support/factories";
import { assertProperty } from "./support/fc";
import { junkCommands } from "./support/legal";
import { roundGame } from "./support/round-fixtures";

const cmd = (c: object): Command => c as unknown as Command;
const seat = (n: number): Actor => userActor(n === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(n)));
const as = (n: number, over: Partial<Ctx> = {}): Ctx => ctxFor({ actor: seat(n), ...over });
const accepted = (g: Game | null, c: object, ctx: Ctx = ctxFor()): Accepted => {
  const r = decide(g, cmd(c), ctx);
  if (!r.ok) throw new Error(`expected an acceptance of ${JSON.stringify(c)}, got ${JSON.stringify(r.error)}`);
  checkAll({ index: 0, before: g, cmd: c, result: r, actor: ctx.actor, drafts: ctx.drafts });
  return r.value;
};
const rejected = (g: Game | null, c: object, ctx: Ctx = ctxFor()): Rejection => {
  const r = decide(g, cmd(c), ctx);
  if (r.ok) throw new Error(`expected a rejection of ${JSON.stringify(c)}`);
  return r.error;
};
/** `g` without player `i`'s seat: the player leaves the table and their hand goes back to the red deck, so every card stays in exactly one zone. */
const unseat = (g: Game, i: number): Game => {
  const gone = g.players[i];
  return { ...g, players: g.players.filter((_, k) => k !== i), pools: { ...g.pools, redDeck: [...g.pools.redDeck, ...(gone?.hand ?? [])] } };
};
const types = (events: readonly DomainEvent[]): string[] => events.map((e) => e.t);
const PRIOR = [{ round: 1, judgeId: pid(0), greenCardId: cid(1), plays: [], winnerCardId: cid(2), winnerId: pid(2) }]; // one resolved round behind a score of 1
const V = 5; // roundGame's changedAtVersion
const confirm = (cardId: string, extra: object = {}) => ({ type: "confirmSubmission", cardId, expectedVersion: V, ...extra });
const close = { type: "closeSubmissions", expectedVersion: V };
const pick = (submissionId: string) => ({ type: "pickWinner", submissionId, expectedVersion: V });
// roundGame: judge p0 (the host's seat) unless stated; p1..p3 hold cid(100 i + k), k < 7; a submitter's card is cid(100 i + 6).
const submitting = (o: Parameters<typeof roundGame>[0] = {}): Game => roundGame({ judge: 1, ...o });
const judging = (o: Parameters<typeof roundGame>[0] = {}): Game => roundGame({ judge: 1, submitted: [2, 3], phase: "JUDGING", ...o });

describe("R1 confirmSubmission: effect (7.2)", () => {
  test("the card leaves the hand, one Submission is appended in confirm order, and the only event is SubmissionConfirmed{round, playerId}", () => {
    const g = submitting();
    const v = accepted(g, confirm(cid(200)), as(2));
    expect(v.state.players[2]?.hand).toEqual([cid(201), cid(202), cid(203), cid(204), cid(205), cid(206)]);
    expect(v.state.round?.submissions).toEqual([{ playerId: pid(2), cardId: cid(200) }]);
    expect(v.events).toEqual([{ t: "SubmissionConfirmed", round: 1, playerId: pid(2) }]);
    expect(v.aggregateChanged).toBe(true);
    expect(v.state.version).toBe(g.version + 1);
    expect(v.redactEnvelope).toBe(false);
    expect(v.roundRecords).toEqual([]);
  });

  test("a confirm that is not the last leaves the round SUBMITTING, changedAtVersion alone, and consumes no rng", () => {
    const g = submitting();
    const rng = scriptedRng([]);
    const v = accepted(g, confirm(cid(200)), as(2, { rng }));
    expect(v.state.round).toMatchObject({ phase: "SUBMITTING", revealOrder: null, changedAtVersion: V });
    expect(rng.drawn).toBe(0);
  });

  test("submissions keep confirm order and one player cannot hold two", () => {
    let g = submitting();
    g = accepted(g, confirm(cid(300)), as(3)).state;
    g = accepted(g, confirm(cid(200)), as(2)).state;
    expect(g.round?.submissions.map((s) => s.playerId)).toEqual([pid(3), pid(2)]);
  });
});

describe("R2 the last expected submitter closes the round in the same command (8.2 slot 4)", () => {
  // judge p1; p0 and p2 have played, p3 is the last one out.
  const lastOut = (): Game => submitting({ submitted: [0, 2] });

  test("SubmissionConfirmed then SubmissionsClosed{allIn}, exactly one shuffle, JUDGING, one version bump, changedAtVersion = version + 1", () => {
    const g = lastOut();
    const rng = recordingRng("allin");
    const v = accepted(g, confirm(cid(300)), as(3, { rng }));
    expect(rng.log).toEqual([["shuffle", 3]]);
    expect(v.events).toEqual([{ t: "SubmissionConfirmed", round: 1, playerId: pid(3) }, { t: "SubmissionsClosed", round: 1, judgeId: pid(1), reason: "allIn" }]);
    expect(v.state.round).toMatchObject({ phase: "JUDGING", changedAtVersion: g.version + 1 });
    expect(v.state.version).toBe(g.version + 1);
    const ref = makeRng("allin").shuffle([cid(6), cid(206), cid(300)]);
    expect(v.state.round?.revealOrder).toEqual(ref);
  });

  test("E10: the reveal order depends on the seed and not on who confirmed last: the same cards in a different confirm order give the same set, varied orders across seeds", () => {
    const orders = new Set<string>();
    for (let s = 0; s < 30; s++) {
      const v = accepted(lastOut(), confirm(cid(300)), as(3, { rng: makeRng(`o${s}`) }));
      orders.add((v.state.round?.revealOrder ?? []).join());
      expect([...(v.state.round?.revealOrder ?? [])].sort()).toEqual([cid(6), cid(206), cid(300)].sort());
    }
    expect(orders.size).toBeGreaterThan(3);
  });

  test("an expected player who has left no longer holds the round open", () => {
    const g = submitting({ submitted: [0, 2] });
    // p0 and p2 have played and p3 is gone (status left, hand back in the deck); the next aggregate change settles into the close
    const left = { ...unseat(g, 3), players: [...g.players.slice(0, 3), { ...(g.players[3] as Game["players"][number]), status: "left" as const, hand: [] }], pools: { ...g.pools, redDeck: [...g.pools.redDeck, ...(g.players[3]?.hand ?? [])] } };
    const v = accepted(left, { type: "updateSettings", patch: { profanity: "off" } }, as(0));
    expect(types(v.events)).toEqual(["SettingsUpdated", "SubmissionsClosed"]);
  });

  test("the pause flag stops the close: a paused game answers PAUSED to every round command", () => {
    const g = { ...lastOut(), paused: true };
    expect(rejected(g, confirm(cid(300)), as(3))).toStrictEqual({ code: "PAUSED" });
    expect(rejected({ ...g, round: { ...(g.round as NonNullable<Game["round"]>), submissions: [{ playerId: pid(0), cardId: cid(6) }] } }, close, as(1))).toStrictEqual({ code: "PAUSED" });
    expect(rejected({ ...judging(), paused: true }, pick(cid(306)), as(1))).toStrictEqual({ code: "PAUSED" });
  });
});

describe("R1 confirmSubmission: guard ladder (5.3, 7.1)", () => {
  test("guard 1 and 4: no game is NOT_FOUND, LOBBY, WRITING, FINISHED and ENDED are WRONG_PHASE, a JUDGING round is WRONG_PHASE", () => {
    expect(rejected(null, confirm(cid(200)), as(2))).toStrictEqual({ code: "NOT_FOUND" });
    for (const phase of ["LOBBY", "WRITING", "FINISHED", "ENDED"] as const) {
      const g = makeGame({ phase, players: [makePlayer(0), makePlayer(1), makePlayer(2)] });
      expect(rejected(g, confirm(cid(200)), as(2))).toStrictEqual({ code: "WRONG_PHASE" });
    }
    expect(rejected(judging(), confirm(cid(200)), as(2))).toStrictEqual({ code: "WRONG_PHASE" });
    expect(rejected({ ...submitting(), round: null }, confirm(cid(200)), as(2))).toStrictEqual({ code: "WRONG_PHASE" });
  });

  test("guard 2: a stranger, the system actor and an unseated host are NOT_AUTHORIZED, a departed seat too", () => {
    const g = submitting();
    expect(rejected(g, confirm(cid(200)), ctxFor({ actor: userActor("stranger") }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(g, confirm(cid(200)), ctxFor({ actor: { kind: "system" } }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    const unseated = { ...g, players: g.players.filter((p) => p.id !== pid(0)) };
    expect(rejected(unseated, confirm(cid(200)), as(0))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    const left = { ...g, players: g.players.map((p, i) => (i === 2 ? { ...p, status: "left" as const } : p)) };
    expect(rejected(left, confirm(cid(200)), as(2))).toStrictEqual({ code: "NOT_AUTHORIZED" });
  });

  test("guard 6: the judge is NOT_AUTHORIZED; a seated player not on the roster is NOT_AUTHORIZED sitting_out (a late joiner, ready or writing)", () => {
    const g = submitting();
    expect(rejected(g, confirm(cid(100)), as(1))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    const late = { ...g, players: [...g.players, makePlayer(4, { status: "ready", joinOrder: 4 }), makePlayer(5, { status: "writing", joinOrder: 5 })] };
    expect(rejected(late, confirm(cid(400)), as(4))).toStrictEqual({ code: "NOT_AUTHORIZED", detail: "sitting_out" });
    expect(rejected(late, confirm(cid(500)), as(5))).toStrictEqual({ code: "NOT_AUTHORIZED", detail: "sitting_out" });
  });

  test("guard 9: ALREADY_SUBMITTED, then NOT_IN_HAND (a card that is unknown, in another hand, in a deck or the round's green card gives one identical rejection), then VARIANT_UNAVAILABLE", () => {
    const g = submitting({ submitted: [2] });
    expect(rejected(g, confirm(cid(201)), as(2))).toStrictEqual({ code: "ALREADY_SUBMITTED" });
    expect(rejected(g, confirm(cid(9999), { pitch: "x" }), as(2))).toStrictEqual({ code: "ALREADY_SUBMITTED" });
    const inHand = [cid(9999), cid(100), cid(5000), cid(7000), cid(900), cid(206), "not-an-id", ""];
    for (const c of inHand) expect(rejected(g, confirm(c), as(3))).toStrictEqual({ code: "NOT_IN_HAND" });
    expect(rejected(g, confirm(cid(9999), { pitch: "x" }), as(3))).toStrictEqual({ code: "NOT_IN_HAND" });
    expect(rejected(g, confirm(cid(300), { pitch: "x" }), as(3))).toStrictEqual({ code: "VARIANT_UNAVAILABLE" });
  });

  test("guard order, combined failures: non-member and stale is NOT_AUTHORIZED; a stale judge is STALE; stale and wrong round phase is STALE; wrong phase and paused is WRONG_PHASE; paused and sitting out is PAUSED", () => {
    const g = submitting();
    const stale = { type: "confirmSubmission", cardId: cid(200), expectedVersion: V - 1 };
    expect(rejected(g, stale, ctxFor({ actor: userActor("stranger") }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(g, { ...stale, cardId: cid(100) }, as(1))).toStrictEqual({ code: "STALE" });
    expect(rejected(g, stale, as(2))).toStrictEqual({ code: "STALE" });
    expect(rejected(judging(), stale, as(2))).toStrictEqual({ code: "STALE" });
    expect(rejected({ ...judging(), paused: true }, confirm(cid(200)), as(2))).toStrictEqual({ code: "WRONG_PHASE" });
    const late = { ...g, paused: true, players: [...g.players, makePlayer(4, { status: "ready", joinOrder: 4 })] };
    expect(rejected(late, confirm(cid(400)), as(4))).toStrictEqual({ code: "PAUSED" });
    expect(accepted(g, { ...confirm(cid(200)), expectedVersion: V }, as(2)).events).toHaveLength(1); // not stale at equality
    expect(accepted(g, { ...confirm(cid(200)), expectedVersion: V + 100 }, as(2)).events).toHaveLength(1);
  });

  test("guard 7: expectedVersion is required for the stale-checked commands and must be a finite integer (the contracts schema requires a non-negative integer): absent, NaN, Infinity and a fraction are INVALID_ARGUMENT, never a skipped STALE", () => {
    const g = submitting({ submitted: [2] });
    const j = judging();
    const bad = [undefined, Number.NaN, Number.POSITIVE_INFINITY, V + 0.5];
    const without = (cmd: object) => Object.fromEntries(Object.entries(cmd).filter(([k]) => k !== "expectedVersion"));
    for (const v of bad) {
      const set = (cmd: object) => (v === undefined ? without(cmd) : { ...cmd, expectedVersion: v });
      expect(rejected(g, set(confirm(cid(200))), as(2))).toStrictEqual({ code: "INVALID_ARGUMENT" });
      expect(rejected(g, set(close), as(1))).toStrictEqual({ code: "INVALID_ARGUMENT" });
      expect(rejected(j, set(pick(cid(206))), as(1))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    }
    expect(rejected(g, without(confirm(cid(200))), ctxFor({ actor: userActor("stranger") }))).toStrictEqual({ code: "NOT_AUTHORIZED" }); // still only after guards 2 to 6
  });

  test("guard 7: a non-number expectedVersion is INVALID_ARGUMENT, after guards 2 to 6; a non-string cardId or pitch is INVALID_ARGUMENT; junk never reaches guard 9", () => {
    const g = submitting();
    for (const bad of ["7", null, {}, [], true]) expect(rejected(g, { ...confirm(cid(200)), expectedVersion: bad }, as(2))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(g, { ...confirm(cid(200)), expectedVersion: "7" }, ctxFor({ actor: userActor("stranger") }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(judging(), { ...confirm(cid(200)), expectedVersion: "7" }, as(2))).toStrictEqual({ code: "WRONG_PHASE" });
    expect(rejected(g, { ...confirm(cid(100)), expectedVersion: "7" }, as(1))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    for (const bad of [undefined, 5, null, {}, ["c"]]) expect(rejected(g, { type: "confirmSubmission", cardId: bad, expectedVersion: V }, as(2))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    for (const bad of [5, null, {}, ["p"]]) expect(rejected(g, confirm(cid(200), { pitch: bad }), as(2))).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });
});

describe("P1 the pitch (7.1, an interim until #25 wires Moderation)", () => {
  const withPitch = (on: boolean): Game => submitting({ extra: { settings: { ...makeGame().settings, variants: { pitch: on, writeIn: false, redraw: false, peoplesChoice: false } } } });

  test("variant off: a pitch is VARIANT_UNAVAILABLE; no pitch is fine", () => {
    expect(rejected(withPitch(false), confirm(cid(200), { pitch: "smooth" }), as(2))).toStrictEqual({ code: "VARIANT_UNAVAILABLE" });
    expect(accepted(withPitch(false), confirm(cid(200)), as(2)).state.round?.submissions[0]).toStrictEqual({ playerId: pid(2), cardId: cid(200) });
  });

  test("variant on: the pitch is stored trimmed on the Submission and is not in any event", () => {
    const v = accepted(withPitch(true), confirm(cid(200), { pitch: "  smooth operator  " }), as(2));
    expect(v.state.round?.submissions[0]).toStrictEqual({ playerId: pid(2), cardId: cid(200), pitch: "smooth operator" });
    expect(JSON.stringify(v.events)).not.toContain("smooth");
  });

  test("the limit is 140 characters after trimming: 140 is accepted, 141 is INVALID_ARGUMENT, even with the variant off (guard 7 precedes guard 9)", () => {
    expect(accepted(withPitch(true), confirm(cid(200), { pitch: `  ${"x".repeat(140)}  ` }), as(2)).state.round?.submissions[0]?.pitch).toHaveLength(140);
    expect(rejected(withPitch(true), confirm(cid(200), { pitch: "x".repeat(141) }), as(2))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(withPitch(false), confirm(cid(200), { pitch: "x".repeat(141) }), as(2))).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("the limit counts code points (TEXT_LIMITS, LLD 11), not UTF-16 units: 140 astral characters are accepted, 141 are INVALID_ARGUMENT", () => {
    const astral = (n: number) => "\u{1F600}".repeat(n); // 2 UTF-16 units each
    const ok = accepted(withPitch(true), confirm(cid(200), { pitch: ` ${astral(140)} ` }), as(2)).state.round?.submissions[0]?.pitch;
    expect([...(ok ?? "")]).toHaveLength(140);
    expect(rejected(withPitch(true), confirm(cid(200), { pitch: astral(141) }), as(2))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(withPitch(false), confirm(cid(200), { pitch: astral(141) }), as(2))).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("a blank pitch is no pitch: accepted with the variant off, and stored as no key", () => {
    for (const on of [false, true]) {
      const s = accepted(withPitch(on), confirm(cid(200), { pitch: "   " }), as(2)).state.round?.submissions[0];
      expect(s).toStrictEqual({ playerId: pid(2), cardId: cid(200) });
    }
  });

  test("the pitch reaches the RoundRecord (playsDetail) and not history, events or the next round", () => {
    let g = withPitch(true);
    g = accepted(g, confirm(cid(200), { pitch: "smooth" }), as(2)).state;
    g = accepted(g, confirm(cid(300)), as(3)).state;
    g = accepted(g, confirm(cid(6)), as(0)).state; // last expected: closes
    const winning = g.round?.revealOrder?.[0] ?? "";
    const v = accepted(g, { ...pick(winning), expectedVersion: g.round?.changedAtVersion }, as(1));
    const detail = v.roundRecords[0]?.playsDetail.find((p) => p.cardId === cid(200));
    expect(detail).toMatchObject({ playerId: pid(2), pitch: "smooth" });
    expect(JSON.stringify(v.events)).not.toContain("smooth");
    expect(JSON.stringify(v.state)).not.toContain("smooth");
  });
});

describe("R3 closeSubmissions (7.1, 8.3)", () => {
  test("the judge may close; so may the host who is not the judge, seated or not; reason closed; the absent players keep their hands", () => {
    const g = submitting({ submitted: [2] });
    for (const who of [1, 0]) {
      const v = accepted(g, close, as(who));
      expect(v.events).toEqual([{ t: "SubmissionsClosed", round: 1, judgeId: pid(1), reason: "closed" }]);
      expect(v.state.round).toMatchObject({ phase: "JUDGING", revealOrder: [cid(206)], changedAtVersion: g.version + 1 });
      expect(v.state.players[3]?.hand).toHaveLength(7);
      expect(v.state.players[0]?.hand).toHaveLength(7);
    }
    expect(accepted(unseat(g, 0), close, as(0)).state.round?.phase).toBe("JUDGING");
  });

  test("a shuffle of the played cards, once", () => {
    const g = submitting({ submitted: [0, 2] });
    const rng = recordingRng("c");
    accepted(g, close, as(1, { rng }));
    expect(rng.log).toEqual([["shuffle", 2]]);
  });

  test("zero submissions: NOT_PLAYABLE no_submissions (after the role checks)", () => {
    const g = submitting();
    expect(rejected(g, close, as(1))).toStrictEqual({ code: "NOT_PLAYABLE", detail: "no_submissions" });
    expect(rejected(g, close, as(0))).toStrictEqual({ code: "NOT_PLAYABLE", detail: "no_submissions" });
    expect(rejected(g, close, as(2))).toStrictEqual({ code: "NOT_AUTHORIZED" });
  });

  test("E1: a seated non-judge non-host, a stranger and the system actor are NOT_AUTHORIZED; JUDGING, LOBBY, WRITING, FINISHED, ENDED are WRONG_PHASE; stale is STALE", () => {
    const g = submitting({ submitted: [2] });
    expect(rejected(g, close, as(3))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(g, close, ctxFor({ actor: userActor("stranger") }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(g, close, ctxFor({ actor: { kind: "system" } }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(judging(), close, as(1))).toStrictEqual({ code: "WRONG_PHASE" });
    for (const phase of ["LOBBY", "WRITING", "FINISHED", "ENDED"] as const) expect(rejected(makeGame({ phase, players: [makePlayer(0), makePlayer(1), makePlayer(2)] }), close, as(0))).toStrictEqual({ code: "WRONG_PHASE" });
    expect(rejected(g, { type: "closeSubmissions", expectedVersion: V - 1 }, as(1))).toStrictEqual({ code: "STALE" });
    expect(rejected(g, { type: "closeSubmissions", expectedVersion: V - 1 }, ctxFor({ actor: userActor("stranger") }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(g, { type: "closeSubmissions", expectedVersion: "5" }, as(1))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected({ ...g, paused: true }, close, as(1))).toStrictEqual({ code: "PAUSED" });
  });

  test("closing twice: the second is WRONG_PHASE, or STALE when it still carries the old expectedVersion (the close changed the round, guard 3 first)", () => {
    const g = submitting({ submitted: [2] });
    const closed = accepted(g, close, as(1)).state;
    expect(rejected(closed, { type: "closeSubmissions" }, as(1))).toStrictEqual({ code: "WRONG_PHASE" });
    expect(rejected(closed, { type: "closeSubmissions", expectedVersion: closed.round?.changedAtVersion }, as(1))).toStrictEqual({ code: "WRONG_PHASE" });
    expect(rejected(closed, close, as(1))).toStrictEqual({ code: "STALE" });
  });
});

describe("R4 pickWinner (7.1, 8.3)", () => {
  test("the judge picks a revealed card: WinnerPicked, then RoundOpened; the winner is the owner; one version bump; a RoundRecord is returned", () => {
    const g = judging();
    const v = accepted(g, pick(cid(206)), as(1));
    expect(types(v.events)).toEqual(["WinnerPicked", "RoundOpened"]);
    expect(v.events[0]).toEqual({ t: "WinnerPicked", round: 1, judgeId: pid(1), winnerId: pid(2), winnerCardId: cid(206) });
    expect(v.state.players[2]?.scorePile).toEqual([cid(900)]);
    expect(v.state.history).toHaveLength(1);
    expect(v.state.round?.number).toBe(2);
    expect(v.state.version).toBe(g.version + 1);
    expect(v.roundRecords).toHaveLength(1);
  });

  test("E14: a second pickWinner of the resolved round is WRONG_PHASE (the next round is SUBMITTING); with the old expectedVersion it is STALE, guard 3 first", () => {
    const g = judging();
    const next = accepted(g, pick(cid(206)), as(1)).state;
    const again = (who: number, expectedVersion?: number) => rejected(next, { type: "pickWinner", submissionId: cid(206), ...(expectedVersion === undefined ? {} : { expectedVersion }) }, as(who));
    const judgeNow = next.players.findIndex((p) => p.id === next.round?.judgeId);
    expect(again(2)).toStrictEqual({ code: "WRONG_PHASE" }); // a non-judge of round 2 too: the phase (guard 4) comes before the role (guard 6)
    expect(again(judgeNow)).toStrictEqual({ code: "WRONG_PHASE" });
    expect(again(judgeNow, next.round?.changedAtVersion)).toStrictEqual({ code: "WRONG_PHASE" });
    expect(again(judgeNow, V)).toStrictEqual({ code: "STALE" });
  });

  test("E11: SUBMITTING is WRONG_PHASE; a non-judge seat is NOT_AUTHORIZED; a stranger and the host without a seat are NOT_AUTHORIZED; an unseated or non-judge host is NOT_AUTHORIZED", () => {
    expect(rejected(submitting({ submitted: [2] }), pick(cid(206)), as(1))).toStrictEqual({ code: "WRONG_PHASE" });
    const g = judging();
    expect(rejected(g, pick(cid(206)), as(2))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(g, pick(cid(206)), as(0))).toStrictEqual({ code: "NOT_AUTHORIZED" }); // the host who is not the judge
    expect(rejected(g, pick(cid(206)), ctxFor({ actor: userActor("stranger") }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    const unseated = { ...g, players: g.players.filter((p) => p.id !== pid(0)) };
    expect(rejected(unseated, pick(cid(206)), as(0))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    for (const phase of ["LOBBY", "WRITING", "FINISHED", "ENDED"] as const) expect(rejected(makeGame({ phase, players: [makePlayer(0), makePlayer(1), makePlayer(2)] }), pick(cid(206)), as(1))).toStrictEqual({ code: "WRONG_PHASE" });
  });

  test("E11: an unknown id, an id from another round, a card elsewhere and a malformed id give one identical NOT_FOUND with no detail", () => {
    const h = [{ round: 1, judgeId: pid(0), greenCardId: cid(1), plays: [{ playerId: pid(2), cardId: cid(555) }], winnerCardId: cid(555), winnerId: pid(2) }];
    const g = judging({ history: h });
    for (const id of [cid(9999), cid(555), cid(100), cid(5000), cid(900), "nope", ""]) expect(rejected(g, pick(id), as(1))).toStrictEqual({ code: "NOT_FOUND" });
    expect(rejected(g, { type: "pickWinner", submissionId: 5, expectedVersion: V }, as(1))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(g, { type: "pickWinner", expectedVersion: V }, as(1))).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("guard order: stale is STALE for the judge and NOT_AUTHORIZED for a stranger; a non-number version is INVALID_ARGUMENT only past guards 2 to 6", () => {
    const g = judging();
    expect(rejected(g, { ...pick(cid(206)), expectedVersion: V - 1 }, as(1))).toStrictEqual({ code: "STALE" });
    expect(rejected(g, { ...pick(cid(206)), expectedVersion: V - 1 }, ctxFor({ actor: userActor("stranger") }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(g, { ...pick(cid(206)), expectedVersion: "x" }, as(1))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(g, { ...pick(cid(206)), expectedVersion: "x" }, as(2))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected({ ...g, paused: true }, pick(cid(206)), as(2))).toStrictEqual({ code: "PAUSED" });
  });

  test("E11 property: for random JUDGING games every id in revealOrder is accepted by the judge and every other id is rejected with the identical NOT_FOUND", () => {
    const arb = fc.record({ n: fc.integer({ min: 3, max: 6 }), judge: fc.nat(5), submitted: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }), other: fc.oneof(fc.nat(9999).map(cid), fc.string()) });
    assertProperty(fc.property(arb, fc.integer(), ({ n, judge, submitted, other }, seed) => {
      const j = judge % n;
      const subs = Array.from({ length: n }, (_, i) => i).filter((i) => i !== j && submitted[i] === true);
      fc.pre(subs.length > 0);
      const g = roundGame({ n, judge: j, submitted: subs, phase: "JUDGING" });
      const reveal = g.round?.revealOrder ?? [];
      const judgeSeat = seat(j);
      for (const id of reveal) accepted(deepFreeze(structuredClone(g)), pick(id), ctxFor({ actor: judgeSeat, rng: makeRng(`${seed}`) }));
      if (!reveal.includes(other)) expect(rejected(g, pick(other), ctxFor({ actor: judgeSeat }))).toStrictEqual({ code: "NOT_FOUND" });
    }));
  });

  test("the rng order of one pickWinner: top-up reshuffle (if dry), activation draws; nothing for the next judge", () => {
    const g = judging({ redDeck: 1, redDiscard: 8 }); // two draws needed: one from the deck, then one reshuffle of the discard and the two played cards
    const rng = recordingRng("order");
    accepted(g, pick(cid(206)), as(1, { rng }));
    expect(rng.log).toEqual([["shuffle", 10]]);
    const wet = recordingRng("order");
    accepted(judging(), pick(cid(206)), as(1, { rng: wet }));
    expect(wet.log).toEqual([]);
  });

  test("reaching the target: GameFinished, FINISHED, no round; a pitch-less record", () => {
    const g = judging({ target: 2, scores: [0, 0, 1, 0], history: PRIOR });
    const v = accepted(g, pick(cid(206)), as(1));
    expect(types(v.events)).toEqual(["WinnerPicked", "GameFinished"]);
    expect(v.state).toMatchObject({ phase: "FINISHED", winnerId: pid(2), round: null, paused: false });
  });
});

describe("E15 FINISHED is terminal (8.8)", () => {
  test("every registered command is WRONG_PHASE in FINISHED for the host (who holds a seat), and the finished game stays as it was", () => {
    const g = roundGame({ target: 2, scores: [0, 0, 1, 0], history: PRIOR, judge: 1, submitted: [2, 3], phase: "JUDGING" });
    const finished = accepted(g, pick(cid(206)), as(1)).state;
    expect(finished.phase).toBe("FINISHED");
    const seen = new Set<string>();
    for (const { actor, cmd: c } of junkCommands(finished)) {
      if (actor.kind !== "user" || actor.uid !== HOST_UID || !Object.hasOwn(REGISTRY, c.type)) continue; // the host's entries: the host holds p0's seat
      seen.add(c.type);
      const who = c.type === "join" ? userActor(seatUidOf(GAME_ID, pid(9))) : actor; // join is for the seat uid of its playerId
      const r = decide(deepFreeze(structuredClone(finished)), c, ctxFor({ actor: who }));
      expect(r).toStrictEqual({ ok: false, error: { code: "WRONG_PHASE" } });
    }
    expect([...seen].sort()).toEqual(Object.keys(REGISTRY).sort());
  });
});

describe("E13 one submission per player, from the hand", () => {
  test("a player who has submitted gets ALREADY_SUBMITTED for the next confirm of any card, and the state is unchanged", () => {
    const g = submitting();
    const once = accepted(g, confirm(cid(200)), as(2)).state;
    const before = structuredClone(once);
    expect(rejected(once, confirm(cid(201)), as(2))).toStrictEqual({ code: "ALREADY_SUBMITTED" });
    expect(rejected(once, confirm(cid(200)), as(2))).toStrictEqual({ code: "ALREADY_SUBMITTED" });
    expect(once).toEqual(before);
  });

  test("property: confirming in any order, submitters are unique and every confirm consumed a card the player held", () => {
    const arb = fc.record({ n: fc.integer({ min: 3, max: 6 }), judge: fc.nat(5), order: fc.shuffledSubarray([0, 1, 2, 3, 4, 5], { minLength: 0 }), card: fc.array(fc.nat(6), { minLength: 6, maxLength: 6 }) });
    assertProperty(fc.property(arb, fc.integer(), ({ n, judge, order, card }, seed) => {
      let g = roundGame({ n, judge: judge % n });
      order.filter((i) => i < n && i !== judge % n).forEach((i, k) => {
        const held = g.players[i]?.hand ?? [];
        const pickCard = held[(card[i] ?? 0) % held.length] ?? "";
        const v = accepted(g, confirm(pickCard), as(i, { rng: makeRng(`${seed}:${k}`) }));
        expect(g.players[i]?.hand).toContain(pickCard);
        g = v.state;
        expect(new Set(g.round?.submissions.map((s) => s.playerId)).size).toBe(g.round?.submissions.length ?? -1);
        if (g.round?.phase === "JUDGING") expect(types(v.events)).toContain("SubmissionsClosed");
      });
    }));
  });
});
