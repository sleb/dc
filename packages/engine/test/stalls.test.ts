// #23 (1.6): stalls and ending (LLD 1 sections 7.1, 7.2, 8.2, 8.3): reassignJudge, passJudging, settle slots 3 and 3a and the PausedChanged cancellation,
// slot 1's minimums-unmet case, abortRound and endGame (V1, V7 to V12, E10, E12, E15 accept half for endGame). Membership is in membership.test.ts.
import { describe, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { decide } from "../src/decide";
import * as rounds from "../src/rules/rounds";
import { makeRng } from "../src/rng";
import { SETTLE_SLOTS, settle } from "../src/settle";
import type { Accepted, Actor, Ctx, DomainEvent, Game, Phase, Rejection } from "../src/types";
import { checkAll } from "./support/checks";
import { GAME_ID, HOST_UID, addCard, cid, ctxFor, deepFreeze, gameWithDeck, makeGame, makePlayer, pid, recordingRng, scriptedRng, seatUidOf, userActor } from "./support/factories";
import { buildGame } from "./support/scenario";
import { park, roundGame } from "./support/round-fixtures";

const cmd = (c: object): Command => c as unknown as Command;
const seat = (n: number): Actor => userActor(n === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(n)));
const host = seat(0);
const run = (g: Game | null, c: object, actor: Actor = host, ctx: Partial<Ctx> = {}) => decide(g === null ? null : deepFreeze(structuredClone(g)), cmd(c), ctxFor({ actor, ...ctx }));
const accepted = (g: Game, c: object, actor: Actor = host, ctx: Partial<Ctx> = {}): Accepted => {
  const r = run(g, c, actor, ctx);
  if (!r.ok) throw new Error(`expected an acceptance of ${JSON.stringify(c)}, got ${JSON.stringify(r.error)}`);
  checkAll({ index: 0, before: g, cmd: c, result: r, actor, drafts: ctx.drafts ?? {} });
  return r.value;
};
const rejected = (g: Game, c: object, actor: Actor = host): Rejection => {
  const r = run(g, c, actor);
  if (r.ok) throw new Error(`expected a rejection of ${JSON.stringify(c)}`);
  return r.error;
};
const types = (events: readonly DomainEvent[]): string[] => events.map((e) => e.t);
const pass = { type: "passJudging", expectedVersion: 5 };
const player = (g: Game, i: number) => g.players[i] as Game["players"][number];
const round = (g: Game) => g.round as NonNullable<Game["round"]>;

describe("V1 passJudging and endGame guards (7.1, 5.3)", () => {
  const PHASES: Phase[] = ["LOBBY", "WRITING", "PLAYING", "FINISHED", "ENDED"];
  const inPhase = (phase: Phase): Game => (phase === "PLAYING" ? roundGame({ judge: 1, submitted: [2] }) : makeGame({ phase, target: 8, players: [0, 1, 2].map((i) => makePlayer(i, { status: phase === "LOBBY" ? "writing" : "active" })) }));

  test("passJudging: PLAYING only (WRONG_PHASE everywhere else), host only, in SUBMITTING and in JUDGING", () => {
    for (const phase of PHASES) {
      if (phase === "PLAYING") expect(run(inPhase(phase), pass).ok).toBe(true);
      else expect(rejected(inPhase(phase), pass)).toStrictEqual({ code: "WRONG_PHASE" });
    }
    expect(run(roundGame({ judge: 1, submitted: [2, 3], phase: "JUDGING" }), pass).ok).toBe(true);
  });

  test("passJudging is host only: the judge, another player, a stranger and the system are NOT_AUTHORIZED", () => {
    const g = roundGame({ judge: 1, submitted: [2] });
    for (const who of [seat(1), seat(2), userActor("stranger-uid"), { kind: "system" } as Actor]) expect(rejected(g, pass, who)).toStrictEqual({ code: "NOT_AUTHORIZED" });
  });

  test("passJudging needs play (PAUSED), is stale-checked against changedAtVersion (STALE below, accepted at) and requires an integer expectedVersion (INVALID_ARGUMENT)", () => {
    const g = roundGame({ judge: 1, submitted: [2] });
    expect(rejected({ ...g, paused: true }, pass)).toStrictEqual({ code: "PAUSED" });
    expect(rejected(g, { type: "passJudging", expectedVersion: 4 })).toStrictEqual({ code: "STALE" });
    expect(run(g, { type: "passJudging", expectedVersion: 6 }).ok).toBe(true);
    for (const bad of [undefined, 5.5, Number.NaN, "5", null]) expect(rejected(g, { type: "passJudging", expectedVersion: bad })).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("passJudging guard order: a stranger who is also stale gets NOT_AUTHORIZED; a stale host in a paused game gets STALE; a wrong phase beats a missing version", () => {
    const g = roundGame({ judge: 1, submitted: [2] });
    expect(rejected(g, { type: "passJudging", expectedVersion: 0 }, userActor("stranger-uid"))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected({ ...g, paused: true }, { type: "passJudging", expectedVersion: 0 })).toStrictEqual({ code: "STALE" });
    expect(rejected(inPhase("WRITING"), { type: "passJudging" })).toStrictEqual({ code: "WRONG_PHASE" });
  });

  test("endGame is host only and accepted in LOBBY, WRITING, PLAYING (paused too) and FINISHED; ENDED is WRONG_PHASE", () => {
    for (const phase of PHASES) {
      if (phase === "ENDED") expect(rejected(inPhase(phase), { type: "endGame" })).toStrictEqual({ code: "WRONG_PHASE" });
      else expect(accepted(inPhase(phase), { type: "endGame" }).state.phase).toBe("ENDED");
    }
    expect(run({ ...roundGame({ judge: 1 }), paused: true }, { type: "endGame" }).ok).toBe(true);
    for (const who of [seat(1), userActor("stranger-uid"), { kind: "system" } as Actor]) expect(rejected(inPhase("PLAYING"), { type: "endGame" }, who)).toStrictEqual({ code: "NOT_AUTHORIZED" });
  });
});

describe("V7 reassignJudge (8.3)", () => {
  const re = (g: Game, reason: "passed" | "left" | "removed" | "resumed" = "passed") => rounds.reassignJudge(deepFreeze(structuredClone(g)), reason, scriptedRng([]));

  test("passed, SUBMITTING: the next judge by joinOrder; their hand-played card returns to their hand; JudgeChanged; judgeReassigned; changedAtVersion = version + 1; the cursor follows; no rng", () => {
    const g = roundGame({ judge: 1, submitted: [2] });
    const out = re(g);
    expect(out.events).toEqual([{ t: "JudgeChanged", round: 1, from: pid(1), to: pid(2), reason: "passed" }]);
    expect(round(out.state)).toMatchObject({ judgeId: pid(2), judgeReassigned: true, submissions: [], changedAtVersion: 10, revealOrder: null });
    expect(out.state.judgeCursor).toBe(2);
    expect(player(out.state, 2).hand).toEqual([cid(200), cid(201), cid(202), cid(203), cid(204), cid(205), cid(206)]);
    expect(round(out.state).roster).toEqual(round(g).roster);
  });

  test("the outgoing judge, still active, is not a candidate; the order wraps past the highest joinOrder", () => {
    const g = roundGame({ judge: 3 });
    expect(round(re(g).state).judgeId).toBe(pid(0));
    const three = roundGame({ n: 3, judge: 2 });
    expect(round(re(three).state).judgeId).toBe(pid(0));
  });

  test("a departed outgoing judge (left, removed) is replaced the same way, with the reason recorded", () => {
    const g = park(roundGame({ judge: 1, submitted: [2] }), 1, "left");
    for (const reason of ["left", "removed"] as const) expect(re(g, reason).events).toEqual([{ t: "JudgeChanged", round: 1, from: pid(1), to: pid(2), reason }]);
  });

  test("JUDGING: the new judge's own entry leaves submissions and revealOrder, the rest keep their relative order (E10), nothing is reshuffled", () => {
    const g = roundGame({ n: 5, judge: 1, submitted: [2, 3, 4], phase: "JUDGING" });
    expect(round(g).revealOrder).toEqual([cid(406), cid(306), cid(206)]);
    const out = re(g);
    expect(round(out.state)).toMatchObject({ judgeId: pid(2), phase: "JUDGING", revealOrder: [cid(406), cid(306)] });
    expect(round(out.state).submissions.map((s) => s.playerId)).toEqual([pid(3), pid(4)]);
  });

  test("a write-in submission of the new judge goes to redDiscard and their hand is unchanged (Q3, P-E6)", () => {
    let g = roundGame({ judge: 1 });
    g = addCard(g, cid(6500), "red", "redDiscard");
    g = { ...g, pools: { ...g.pools, redDiscard: [] }, round: { ...round(g), submissions: [{ playerId: pid(2), cardId: cid(6500), writeIn: true }] } };
    const out = re(g);
    expect(out.state.pools.redDiscard).toEqual([cid(6500)]);
    expect(player(out.state, 2).hand).toEqual(player(g, 2).hand);
    expect(round(out.state).submissions).toEqual([]);
  });

  test("no candidate (the judge was the last active player): judgeId null, the cursor is kept, changedAtVersion bumps, judgeReassigned stays, no event", () => {
    let g = roundGame({ n: 4, judge: 0 });
    g = park(park(park(park(g, 0, "left"), 1, "ready"), 2, "ready"), 3, "ready");
    const out = re(g, "left");
    expect(out.events).toEqual([]);
    expect(round(out.state)).toMatchObject({ judgeId: null, changedAtVersion: 10, judgeReassigned: false });
    expect(out.state.judgeCursor).toBe(0);
  });

  test("resumed: from a null judge, nextJudge(active, cursor) with from null; a judge who is not on the roster (activated by recovery) joins the roster", () => {
    let g = roundGame({ n: 4, judge: 0 });
    g = { ...g, round: { ...round(g), judgeId: null, roster: [pid(0)] }, judgeCursor: 0 };
    g = park(g, 0, "left");
    const out = re(g, "resumed");
    expect(out.events).toEqual([{ t: "JudgeChanged", round: 1, from: null, to: pid(1), reason: "resumed" }]);
    expect(round(out.state)).toMatchObject({ judgeId: pid(1), judgeReassigned: true });
    expect(round(out.state).roster).toEqual([pid(0), pid(1)]);
    expect(out.state.judgeCursor).toBe(1);
  });

  test("reassignJudge does not mutate its input", () => {
    const g = roundGame({ judge: 1, submitted: [2] });
    const before = structuredClone(g);
    re(g);
    expect(g).toEqual(before);
  });
});

describe("V8 passJudging through the registry (7.2, gameplay 'Stalled judge')", () => {
  test("in SUBMITTING the old judge becomes an expected player and the passed-to player's own submission is taken back; a new episode starts", () => {
    const g = roundGame({ judge: 1, submitted: [2] });
    const v = accepted(g, pass);
    expect(v.events).toEqual([{ t: "JudgeChanged", round: 1, from: pid(1), to: pid(2), reason: "passed" }]);
    expect(round(v.state)).toMatchObject({ judgeId: pid(2), judgeReassigned: true, submissions: [], changedAtVersion: 10 });
    expect(v.state.waitingOn).toEqual([pid(0), pid(1), pid(3)]);
    expect(v.state.episodeGen).toBe(g.episodeGen + 1);
    expect(v.state.episode).toBe(`1:SUBMITTING:${pid(2)}`);
    expect(v.state.version).toBe(10);
  });

  test("in JUDGING the old judge sits out (not waited on), the passed-to judge's entry leaves revealOrder, and the stale version of the old judge's pick is STALE", () => {
    const g = roundGame({ judge: 1, submitted: [2, 3], phase: "JUDGING" });
    const v = accepted(g, pass);
    expect(round(v.state)).toMatchObject({ judgeId: pid(2), phase: "JUDGING", revealOrder: [cid(306)] });
    expect(v.state.waitingOn).toEqual([pid(2)]);
    expect(rejected(v.state, { type: "pickWinner", submissionId: cid(306), expectedVersion: 5 }, seat(2))).toStrictEqual({ code: "STALE" });
    expect(run(v.state, { type: "pickWinner", submissionId: cid(306), expectedVersion: 10 }, seat(2)).ok).toBe(true);
  });

  test("pass then void: the passed-to player's card was the only one, so the round voids and the replacement round keeps them as judge", () => {
    const g = roundGame({ judge: 1, submitted: [2], phase: "JUDGING" });
    const v = accepted(g, pass);
    expect(types(v.events)).toEqual(["JudgeChanged", "RoundVoided", "RoundOpened"]);
    expect(v.events[2]).toMatchObject({ t: "RoundOpened", round: 1, judgeId: pid(2) });
    expect(round(v.state)).toMatchObject({ judgeId: pid(2), judgeReassigned: false, phase: "SUBMITTING", submissions: [] });
    expect(v.state.pools.greenDeck.at(-1)).toBe(cid(900));
    expect(v.state.judgeCursor).toBe(2);
  });

  test("a judge who leaves, or is removed, before a void: the same, the passed-to player judges the replacement", () => {
    const g = roundGame({ judge: 1, submitted: [2], phase: "JUDGING" });
    for (const v of [accepted(g, { type: "leave" }, seat(1)), accepted(g, { type: "removePlayer", playerId: pid(1) })]) {
      expect(types(v.events)).toEqual([v.events[0]?.t as string, "JudgeChanged", "RoundVoided", "RoundOpened"]);
      expect(round(v.state).judgeId).toBe(pid(2));
    }
  });

  test("a void with no reassignment rotates normally from the cursor", () => {
    const v = accepted(roundGame({ judge: 1, submitted: [2], phase: "JUDGING" }), { type: "leave" }, seat(2));
    expect(round(v.state).judgeId).toBe(pid(3));
    expect(types(v.events)).toEqual(["PlayerLeft", "RoundVoided", "RoundOpened"]);
  });

  test("the passed-to judge can be a player activated by a paused recovery (not on the roster): they join the roster", () => {
    let g = roundGame({ n: 5, judge: 3 });
    g = { ...g, round: { ...round(g), roster: [pid(0), pid(1), pid(2), pid(3)] } }; // p4 was activated mid-round by recovery and sat out
    const v = accepted(g, pass);
    expect(round(v.state).judgeId).toBe(pid(4));
    expect(round(v.state).roster).toContain(pid(4));
  });
});

describe("V9 settle slots 3 and 3a (8.2)", () => {
  const slot = (id: "3" | "3a") => SETTLE_SLOTS.find((s) => s.id === id) as (typeof SETTLE_SLOTS)[number];
  const env = (rng = scriptedRng([])) => ({ rng, now: 1, episodeStarted: false });
  /** PLAYING, paused: p0 and p1 active, p2 ready (a late joiner who finished), nobody else. The round was opened by the original four. */
  const paused = (ready = 1, active = 2): Game => {
    let g = roundGame({ n: active + ready, judge: 0 });
    for (let i = active; i < active + ready; i++) g = park(g, i, "ready");
    return { ...g, paused: true, round: { ...round(g), roster: [pid(0), pid(1)] } };
  };

  test("slot 3: PLAYING, paused and active + ready >= 3: the ready players are dealt 7 in joinOrder, activated, and sit out; the pause is recomputed", () => {
    const g = paused();
    const out = slot("3").run(g, env());
    expect(out.state.players.map((p) => p.status)).toEqual(["active", "active", "active"]);
    expect(player(out.state, 2).hand).toHaveLength(7);
    expect(round(out.state).roster).toEqual([pid(0), pid(1)]);
    expect(out.state.paused).toBe(false);
    expect(out.events).toEqual([{ t: "PlayerActivated", playerId: pid(2) }, { t: "PausedChanged", paused: false }]);
  });

  test("slot 3 does nothing with active + ready below 3, when not paused, or outside PLAYING", () => {
    const short = slot("3").run(paused(1, 1), env());
    expect(short.state.players.map((p) => p.status)).toEqual(["active", "ready"]);
    expect(short.events).toEqual([]);
    const g = paused();
    expect(slot("3").run({ ...g, paused: false }, env()).events).toEqual([]);
    expect(slot("3").run({ ...g, phase: "WRITING" }, env()).events).toEqual([]);
  });

  test("slot 3 deals every ready player in joinOrder: with two ready, the lower joinOrder is dealt first from the deck", () => {
    const g = paused(2, 1);
    const out = slot("3").run(g, env());
    expect(player(out.state, 1).hand).toEqual(g.pools.redDeck.slice(0, 7));
    expect(player(out.state, 2).hand).toEqual(g.pools.redDeck.slice(7, 14));
  });

  test("slot 3a assigns the next judge when a null-judge round is not paused: JudgeChanged from null, resumed; and not while paused", () => {
    let g = roundGame({ n: 4, judge: 0 });
    g = { ...g, round: { ...round(g), judgeId: null }, judgeCursor: 0 };
    const out = slot("3a").run(g, env());
    expect(out.events).toEqual([{ t: "JudgeChanged", round: 1, from: null, to: pid(1), reason: "resumed" }]);
    expect(round(out.state)).toMatchObject({ judgeId: pid(1), judgeReassigned: true, changedAtVersion: 10 });
    expect(out.episodeStarted).toBe(true);
    expect(slot("3a").run({ ...g, paused: true }, env()).events).toEqual([]);
    expect(slot("3a").run(roundGame({ judge: 1 }), env()).events).toEqual([]);
  });

  test("real chain: the judge, the last active player, leaves while paused (null judge); a new player joins and finishes, recovery activates the three ready players, resumes, voids the empty round and reopens it under the resumed judge", () => {
    let g = roundGame({ n: 4, judge: 0, extra: { writeCounts: { red: 10, green: 8 } } });
    g = park(park(park(g, 1, "ready"), 2, "ready"), 3, "left");
    g = { ...g, paused: true, round: { ...round(g), roster: [pid(0)] } };
    const stalled = accepted(g, { type: "leave" }, host).state;
    expect(round(stalled).judgeId).toBeNull();
    const joined = accepted(stalled, { type: "join", playerId: pid(4), name: "Fifth" }, seat(4)).state;
    const target = player(joined, 4).writeTarget as { red: number; green: number };
    const drafts = { [pid(4)]: { red: Array.from({ length: target.red }, (_, k) => `r${k}`), green: Array.from({ length: target.green }, (_, k) => `g${k}`) } };
    const v = accepted(joined, { type: "finishWriting" }, seat(4), { drafts });
    expect(types(v.events)).toEqual(["PlayerFinishedWriting", "PlayerActivated", "PlayerActivated", "PlayerActivated", "PausedChanged", "JudgeChanged", "RoundVoided", "RoundOpened"]);
    expect(v.events.filter((e) => e.t === "PlayerActivated").map((e) => (e as { playerId: string }).playerId)).toEqual([pid(1), pid(2), pid(4)]);
    expect(v.events[5]).toEqual({ t: "JudgeChanged", round: 1, from: null, to: pid(1), reason: "resumed" });
    expect(v.events[7]).toMatchObject({ t: "RoundOpened", round: 1, judgeId: pid(1) });
    expect(v.state).toMatchObject({ paused: false });
    expect(round(v.state)).toMatchObject({ judgeId: pid(1), judgeReassigned: false, phase: "SUBMITTING" });
    expect(round(v.state).roster).toEqual([pid(1), pid(2), pid(4)]);
  });

  test("real chain: a late joiner's finishWriting un-pauses a paused game: PlayerActivated then PausedChanged false; they are not on the round's roster and cannot confirm (sitting_out)", () => {
    const g = roundGame({ n: 3, judge: 0, extra: { writeCounts: { red: 10, green: 8 } } });
    const paused2 = accepted(g, { type: "leave" }, seat(2)).state;
    expect(paused2.paused).toBe(true);
    const joined = accepted(paused2, { type: "join", playerId: pid(4), name: "Late" }, seat(4)).state;
    const target = player(joined, 3).writeTarget as { red: number; green: number };
    const drafts = { [pid(4)]: { red: Array.from({ length: target.red }, (_, k) => `r${k}`), green: Array.from({ length: target.green }, (_, k) => `g${k}`) } };
    const v = accepted(joined, { type: "finishWriting" }, seat(4), { drafts });
    expect(types(v.events)).toEqual(["PlayerFinishedWriting", "PlayerActivated", "PausedChanged"]);
    expect(v.state.paused).toBe(false);
    expect(player(v.state, 3)).toMatchObject({ status: "active", scorePile: [] });
    expect(player(v.state, 3).hand).toHaveLength(7);
    expect(round(v.state).roster).not.toContain(pid(4));
    expect(rejected(v.state, { type: "confirmSubmission", cardId: player(v.state, 3).hand[0], expectedVersion: 5 }, seat(4))).toStrictEqual({ code: "NOT_AUTHORIZED", detail: "sitting_out" });
  });
});

describe("V10 settle drops PausedChanged events that cancel (Q1)", () => {
  const rng = () => scriptedRng([]);
  /** The stored flag is `stored`; two active players, one ready (a finished late joiner), one more writing, so slot 2 and slot 3 disagree. */
  const table = (stored: boolean, active: number): Game => {
    let g = roundGame({ n: 3, judge: 0 });
    g = { ...g, paused: stored };
    for (let i = active; i < 3; i++) g = park(g, i, "ready");
    return g;
  };

  test("stored false, two active and one ready: slot 2 says paused, slot 3 recovers; the pair cancels, so no PausedChanged at all, and the ready player is activated", () => {
    const out = settle(table(false, 2), rng(), 1, false);
    expect(out.state.paused).toBe(false);
    expect(types(out.events)).toEqual(["PlayerActivated"]);
  });

  test("stored true and a true un-pause: exactly one PausedChanged false", () => {
    const out = settle(table(true, 2), rng(), 1, false);
    expect(types(out.events)).toEqual(["PlayerActivated", "PausedChanged"]);
    expect(out.events.at(-1)).toEqual({ t: "PausedChanged", paused: false });
  });

  test("a plain flip is still reported: stored false, two active and nobody ready: one PausedChanged true", () => {
    const g = park(roundGame({ n: 3, judge: 0 }), 2, "left");
    expect(types(settle(g, rng(), 1, false).events)).toEqual(["PausedChanged"]);
    expect(settle(g, rng(), 1, false).events[0]).toEqual({ t: "PausedChanged", paused: true });
  });

  test("the slot ids and their order are unchanged", () => {
    expect(SETTLE_SLOTS.map((s) => s.id)).toEqual(["1", "2", "3", "3a", "4", "5"]);
  });
});

describe("V11 slot 1 with the minimums unmet (8.2, 9.4)", () => {
  test("every seated player is ready, but the cards fall short of the minimums at the frozen target: the game stays WRITING, nothing is dealt, no event (passes against the old code too: the slot already tests it)", () => {
    const short = gameWithDeck(3, 20, 10, { phase: "WRITING", target: 8, writeCounts: { red: 10, green: 8 } }, "ready");
    const rng = recordingRng("s");
    const out = settle(short, rng, 1, false);
    expect(out.state.phase).toBe("WRITING");
    expect(out.events).toEqual([]);
    expect(rng.log).toEqual([]);
    expect(out.state.players.every((p) => p.status === "ready" && p.hand.length === 0)).toBe(true);
  });

  test("with exactly the minimums the same table begins play", () => {
    const ok = gameWithDeck(3, 28, 24, { phase: "WRITING", target: 8, writeCounts: { red: 10, green: 8 } }, "ready");
    expect(settle(ok, makeRng("s"), 1, false).state.phase).toBe("PLAYING");
  });
});

describe("V12 endGame and abortRound (7.2, 8.3)", () => {
  test("from LOBBY, WRITING and FINISHED: phase ENDED, GameEnded as the only event, waiting fields cleared, version + 1", () => {
    const lobby = makeGame({ players: [0, 1, 2].map((i) => makePlayer(i)) });
    const writing = buildGame({ n: 4, phase: "WRITING", ready: [true, false, false, false], handSize: 0, judge: 0, submitted: [], paused: false });
    const settled = settle(writing, scriptedRng([]), 5, true).state;
    expect(settled.waitingOn.length).toBeGreaterThan(0);
    for (const g of [lobby, settled, buildGame({ n: 4, phase: "FINISHED", ready: [], handSize: 2, judge: 0, submitted: [], paused: false })]) {
      const v = accepted(g, { type: "endGame" });
      expect(v.events).toEqual([{ t: "GameEnded" }]);
      expect(v.state).toMatchObject({ phase: "ENDED", round: null, paused: false, waitingOn: [], episode: null, waitingSince: null, reminderDueAt: null, version: g.version + 1 });
    }
  });

  test("in PLAYING: a hand-played card goes back to its owner's hand (at most 7), a write-in card to redDiscard, the green card to the bottom of the green deck, round null", () => {
    let g = roundGame({ judge: 0, submitted: [1, 2] });
    g = addCard(g, cid(6500), "red", "redDiscard");
    g = { ...g, pools: { ...g.pools, redDiscard: [] }, round: { ...round(g), submissions: [...round(g).submissions, { playerId: pid(3), cardId: cid(6500), writeIn: true }] } };
    const v = accepted(g, { type: "endGame" });
    expect(v.events).toEqual([{ t: "GameEnded" }]);
    expect(v.state.round).toBeNull();
    expect(player(v.state, 1).hand).toEqual([cid(100), cid(101), cid(102), cid(103), cid(104), cid(105), cid(106)]);
    expect(player(v.state, 2).hand).toHaveLength(7);
    expect(player(v.state, 3).hand).toHaveLength(7); // the write-in never was in the hand
    expect(v.state.pools.redDiscard).toEqual([cid(6500)]);
    expect(v.state.pools.greenDeck.at(-1)).toBe(cid(900));
    expect(v.state.players.every((p) => p.hand.length <= 7)).toBe(true);
  });

  test("in a paused PLAYING game: paused is cleared by the handler, so no PausedChanged is emitted (Q4); a JUDGING round aborts the same way", () => {
    const g = { ...roundGame({ judge: 0, submitted: [1, 2], phase: "JUDGING" as const }), paused: true };
    const v = accepted(g, { type: "endGame" });
    expect(types(v.events)).toEqual(["GameEnded"]);
    expect(v.state.paused).toBe(false);
    expect(player(v.state, 1).hand).toHaveLength(7);
  });

  test("after endGame every command is WRONG_PHASE (ENDED)", () => {
    const ended = accepted(roundGame({ judge: 0 }), { type: "endGame" }).state;
    for (const c of [{ type: "endGame" }, { type: "leave" }, { type: "passJudging", expectedVersion: 1 }]) expect(rejected(ended, c)).toStrictEqual({ code: "WRONG_PHASE" });
  });

  test("abortRound does not mutate its input and leaves a game with no round alone", () => {
    const g = roundGame({ judge: 0, submitted: [1] });
    const before = structuredClone(g);
    const out = rounds.abortRound(deepFreeze(g));
    expect(g).toEqual(before);
    expect(out.round).toBeNull();
    expect(rounds.abortRound(out)).toEqual(out);
  });
});

describe("V16 E15, the endGame part of the accept half", () => {
  test("a FINISHED game accepts endGame (checkFinished lets it through) and rejects the other commands the checker guards", () => {
    const fin = buildGame({ n: 4, phase: "FINISHED", ready: [], handSize: 2, judge: 0, submitted: [], paused: false });
    const v = accepted(fin, { type: "endGame" });
    expect(v.state.phase).toBe("ENDED");
    expect(rejected(fin, { type: "leave" }, seat(1))).toStrictEqual({ code: "WRONG_PHASE" });
  });
});
