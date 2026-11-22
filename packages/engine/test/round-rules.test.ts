// #22: the round helpers (LLD 1 section 8.3, 8.4, 8.8) and settle slot 4 (section 8.2), as pure functions over fixture states.
// The command rows over them are in round-commands.test.ts.
import { describe, expect, test } from "bun:test";
import { EngineInvariantError } from "../src/errors";
import { makeRng } from "../src/rng";
import * as rounds from "../src/rules/rounds";
import { SETTLE_SLOTS, settle } from "../src/settle";
import type { DomainEvent, Game, PlayerId } from "../src/types";
import { cid, deepFreeze, makePlayer, makeRound, pid, recordingRng, scriptedRng } from "./support/factories";
import { ids, roundGame } from "./support/round-fixtures";
import type { RoundGameOptions } from "./support/round-fixtures";

const types = (events: readonly DomainEvent[]): string[] => events.map((e) => e.t);

const sorted = <T>(xs: readonly T[]): T[] => [...xs].sort();

describe("C1 closeRound (8.3, E10)", () => {
  test("shuffles the submissions' card ids once with rng, moves to JUDGING, bumps changedAtVersion and emits SubmissionsClosed", () => {
    const g = roundGame({ submitted: [1, 2, 3] });
    const rng = recordingRng("close");
    const out = rounds.closeRound(g, rng, "closed");
    expect(rng.log).toEqual([["shuffle", 3]]);
    const ref = makeRng("close").shuffle([cid(106), cid(206), cid(306)]);
    expect(out.state.round).toEqual({ ...(g.round as NonNullable<Game["round"]>), phase: "JUDGING", revealOrder: ref, changedAtVersion: 10 });
    expect(out.events).toEqual([{ t: "SubmissionsClosed", round: 1, judgeId: pid(0), reason: "closed" }]);
  });

  test("the reason is carried through: allIn and closed", () => {
    const g = roundGame({ submitted: [1] });
    for (const reason of ["allIn", "closed"] as const) {
      expect(rounds.closeRound(g, scriptedRng([]), reason).events).toEqual([{ t: "SubmissionsClosed", round: 1, judgeId: pid(0), reason }]);
    }
  });

  test("a scripted rng gives a known order, not the confirm order (E10)", () => {
    const g = roundGame({ submitted: [1, 2, 3] });
    const out = rounds.closeRound(g, scriptedRng([0, 0]), "closed"); // Fisher-Yates with j = 0 twice: [a, b, c] -> [c, b, a] -> [b, c, a]
    expect(out.state.round?.revealOrder).toEqual([cid(206), cid(306), cid(106)]);
  });

  test("revealOrder is the same card set as the submissions and its order varies with the seed, independent of the confirm order", () => {
    const g = roundGame({ n: 6, submitted: [1, 2, 3, 4, 5] });
    const confirm = g.round?.submissions.map((s) => s.cardId) ?? [];
    const orders = new Set<string>();
    for (let s = 0; s < 30; s++) {
      const order = rounds.closeRound(g, makeRng(`seed-${s}`), "allIn").state.round?.revealOrder ?? [];
      expect(sorted(order)).toEqual(sorted(confirm));
      orders.add(order.join());
    }
    expect(orders.size).toBeGreaterThan(10);
  });

  test("hands, pools, scores and the round's other fields are untouched; the version is the caller's", () => {
    const g = roundGame({ submitted: [1, 2] });
    const out = rounds.closeRound(g, makeRng("x"), "closed");
    expect({ ...out.state, round: null }).toEqual({ ...g, round: null });
    expect(out.state.round).toMatchObject({ judgeId: pid(0), roster: g.round?.roster, submissions: g.round?.submissions, openedAt: g.round?.openedAt });
  });

  test("a round that is not SUBMITTING, has no submissions or has no judge is an invariant violation", () => {
    expect(() => rounds.closeRound(roundGame({ submitted: [1], phase: "JUDGING" }), scriptedRng([]), "closed")).toThrow(EngineInvariantError);
    expect(() => rounds.closeRound(roundGame({ submitted: [] }), scriptedRng([]), "closed")).toThrow(EngineInvariantError);
    const noJudge = roundGame({ submitted: [1] });
    expect(() => rounds.closeRound({ ...noJudge, round: { ...(noJudge.round as NonNullable<Game["round"]>), judgeId: null } }, scriptedRng([]), "closed")).toThrow(EngineInvariantError);
    expect(() => rounds.closeRound({ ...roundGame(), round: null }, scriptedRng([]), "closed")).toThrow(EngineInvariantError);
  });

  test("does not mutate its input", () => {
    const g = roundGame({ submitted: [1, 2] });
    const before = structuredClone(g);
    rounds.closeRound(deepFreeze(g), makeRng("x"), "closed");
    expect(g).toEqual(before);
  });
});

describe("R5 resolveRound (8.3 steps 1 to 5, E5, E6, E14)", () => {
  // Round 1, judge p0, p1 and p2 submitted (p3 absent), JUDGING, 20 cards in the red deck.
  const judging = (o: RoundGameOptions = {}): Game => roundGame({ submitted: [1, 2], phase: "JUDGING", ...o });
  const won = cid(206); // p2's card

  test("step 1: the winner is the card's owner and takes the green card into their score pile; the judge's pile is unchanged", () => {
    const out = rounds.resolveRound(judging({ scores: [1, 0, 2, 0] }), won, scriptedRng([]), 40);
    const piles = out.state.players.map((p) => p.scorePile);
    expect(piles[2]).toEqual([cid(8020), cid(8021), cid(900)]);
    expect(piles[0]).toEqual([cid(8000)]);
    expect(piles[1]).toEqual([]);
  });

  test("step 2: a summary joins history and a RoundRecord is returned, plays in revealOrder order with text, absent players and the time", () => {
    const g = judging();
    const out = rounds.resolveRound(g, won, scriptedRng([]), 4242);
    const summary = { round: 1, judgeId: pid(0), greenCardId: cid(900), plays: [{ playerId: pid(2), cardId: cid(206) }, { playerId: pid(1), cardId: cid(106) }], winnerCardId: cid(206), winnerId: pid(2) };
    expect(out.state.history).toEqual([summary]);
    expect(out.roundRecords).toEqual([{
      ...summary,
      green: { id: cid(900), text: "the green card" },
      playsDetail: [{ playerId: pid(2), cardId: cid(206), text: `card ${cid(206)}` }, { playerId: pid(1), cardId: cid(106), text: `card ${cid(106)}` }],
      absent: [pid(3)],
      resolvedAt: 4242,
    }]);
  });

  test("a pitch is copied into playsDetail and nowhere in history", () => {
    const g = judging();
    const withPitch = { ...g, round: { ...(g.round as NonNullable<Game["round"]>), submissions: (g.round?.submissions ?? []).map((s) => (s.playerId === pid(1) ? { ...s, pitch: "bold" } : s)) } };
    const out = rounds.resolveRound(withPitch, won, scriptedRng([]), 1);
    expect(out.roundRecords[0]?.playsDetail.find((p) => p.playerId === pid(1))).toEqual({ playerId: pid(1), cardId: cid(106), text: `card ${cid(106)}`, pitch: "bold" });
    expect(out.roundRecords[0]?.playsDetail.find((p) => p.playerId === pid(2))).not.toHaveProperty("pitch");
    expect(JSON.stringify(out.state.history)).not.toContain("bold");
  });

  test("step 3 then 4: submitted cards go to the red discard, then every active player is topped up to 7 in joinOrder from the deck", () => {
    const g = judging();
    const out = rounds.resolveRound(g, won, scriptedRng([]), 1);
    expect(out.state.pools.redDiscard).toEqual([cid(206), cid(106)]); // revealOrder order
    expect(out.state.players.map((p) => p.hand.length)).toEqual([7, 7, 7, 7]);
    expect(out.state.players[1]?.hand.slice(6)).toEqual([cid(5000)]); // joinOrder: p1 draws first
    expect(out.state.players[2]?.hand.slice(6)).toEqual([cid(5001)]);
    expect(out.state.pools.redDeck).toEqual(ids(5002, 18));
  });

  test("step 4 reshuffles the discard once, only when the deck is dry, and consumes nothing else for the next judge", () => {
    const g = judging({ redDeck: 1, redDiscard: 4 }); // needs 2 draws: one from the deck, then a reshuffle of discard + submissions (6 cards)
    const rng = recordingRng("dry");
    const out = rounds.resolveRound(g, won, rng, 1);
    expect(rng.log).toEqual([["shuffle", 6]]);
    expect(out.state.players.every((p) => p.hand.length === 7)).toBe(true);
    expect(out.state.players[1]?.hand[6]).toBe(cid(5000));
    expect(out.state.pools.redDiscard).toEqual([]);
    expect(out.state.pools.redDeck).toHaveLength(5); // 6 reshuffled, 1 drawn by p2
  });

  test("a minimum-size deck (nothing in the deck or the discard before the round) forces the reshuffle and still tops every hand up to 7 (E6)", () => {
    const g = roundGame({ n: 3, submitted: [1, 2], phase: "JUDGING", redDeck: 0, redDiscard: 0 });
    const rng = recordingRng("min");
    const out = rounds.resolveRound(g, cid(206), rng, 1);
    expect(rng.log).toEqual([["shuffle", 2]]); // the two played cards are all there is
    expect(out.state.players.map((p) => p.hand.length)).toEqual([7, 7, 7]);
    expect(sorted([...(out.state.players[1]?.hand.slice(6) ?? []), ...(out.state.players[2]?.hand.slice(6) ?? [])])).toEqual([cid(106), cid(206)]);
    expect(out.state.pools.redDeck).toEqual([]);
    expect(out.state.pools.redDiscard).toEqual([]);
  });

  test("step 5, not at target: round becomes null then the next round opens with the next judge by the cursor, number history + 1, events WinnerPicked then RoundOpened", () => {
    const out = rounds.resolveRound(judging(), won, scriptedRng([]), 5);
    expect(out.state.phase).toBe("PLAYING");
    expect(out.state.round).toMatchObject({ number: 2, judgeId: pid(1), phase: "SUBMITTING", submissions: [], revealOrder: null, greenCardId: cid(7000), changedAtVersion: 10, judgeReassigned: false });
    expect(out.state.judgeCursor).toBe(1);
    expect(out.events).toEqual([
      { t: "WinnerPicked", round: 1, judgeId: pid(0), winnerId: pid(2), winnerCardId: cid(206) },
      { t: "RoundOpened", round: 2, judgeId: pid(1), greenCardId: cid(7000), expected: [pid(0), pid(2), pid(3)] },
    ]);
  });

  test("a ready player is activated at the boundary after the top-up draws, so the top-up gets first call on the deck", () => {
    const g = judging({ redDeck: 3, redDiscard: 10 });
    const withReady = { ...g, players: [...g.players, makePlayer(4, { status: "ready", joinOrder: 4 })] };
    const rng = recordingRng("act");
    const out = rounds.resolveRound(withReady, won, rng, 1);
    expect(rng.log).toEqual([["shuffle", 12]]); // the deal runs the deck dry after the top-up took 2 and the deal 1: one reshuffle of 10 + 2 played cards
    expect(out.state.players[1]?.hand[6]).toBe(cid(5000));
    expect(out.state.players[2]?.hand[6]).toBe(cid(5001));
    expect(out.state.players[4]?.hand).toHaveLength(7);
    expect(out.state.players[4]?.hand[0]).toBe(cid(5002));
    expect(types(out.events)).toEqual(["WinnerPicked", "PlayerActivated", "RoundOpened"]);
  });

  test("step 5, at target: FINISHED, winnerId, round null, paused false; events WinnerPicked then GameFinished; no round opens and the green deck is untouched", () => {
    const g = judging({ target: 3, scores: [0, 0, 2, 0], extra: { paused: true } });
    const out = rounds.resolveRound(g, won, scriptedRng([]), 1);
    expect(out.state).toMatchObject({ phase: "FINISHED", winnerId: pid(2), round: null, paused: false });
    expect(out.state.players[2]?.scorePile).toHaveLength(3);
    expect(out.state.pools.greenDeck).toEqual(g.pools.greenDeck);
    expect(out.events).toEqual([
      { t: "WinnerPicked", round: 1, judgeId: pid(0), winnerId: pid(2), winnerCardId: cid(206) },
      { t: "GameFinished", winnerId: pid(2) },
    ]);
    expect(out.state.players.every((p) => p.hand.length === 7)).toBe(true); // the top-up ran before the target check
    expect(out.roundRecords).toHaveLength(1);
  });

  test("a card that is not a submission of this JUDGING round, a round in SUBMITTING, or no round, is an invariant violation", () => {
    expect(() => rounds.resolveRound(judging(), cid(9999), scriptedRng([]), 1)).toThrow(EngineInvariantError);
    expect(() => rounds.resolveRound(roundGame({ submitted: [1, 2] }), won, scriptedRng([]), 1)).toThrow(EngineInvariantError);
    expect(() => rounds.resolveRound({ ...judging(), round: null }, won, scriptedRng([]), 1)).toThrow(EngineInvariantError);
    expect(() => rounds.resolveRound({ ...judging(), target: null }, won, scriptedRng([]), 1)).toThrow(EngineInvariantError);
  });

  test("an empty green deck when the next round must open is an invariant violation, not a silent state", () => {
    expect(() => rounds.resolveRound(judging({ greenDeck: 0 }), won, scriptedRng([]), 1)).toThrow(EngineInvariantError);
  });

  test("does not mutate its input", () => {
    const g = judging();
    const before = structuredClone(g);
    rounds.resolveRound(deepFreeze(g), won, makeRng("x"), 1);
    expect(g).toEqual(before);
  });
});

describe("E12 rotation (8.3)", () => {
  /** Resolve `count` rounds in a row from `g`, the judge always picking the first revealed card; returns each round's judge. */
  const judgesOver = (g: Game, count: number): PlayerId[] => {
    const out: PlayerId[] = [];
    let state = g;
    for (let k = 0; k < count; k++) {
      const r = state.round as NonNullable<Game["round"]>;
      out.push(r.judgeId as PlayerId);
      const subs = r.roster.filter((id) => id !== r.judgeId).map((id) => ({ playerId: id, cardId: state.players.find((p) => p.id === id)?.hand[0] as string }));
      const asked = { ...state, players: state.players.map((p) => ({ ...p, hand: p.hand.filter((c) => !subs.some((s) => s.cardId === c)) })), round: { ...r, phase: "JUDGING" as const, submissions: subs, revealOrder: subs.map((s) => s.cardId) } };
      state = rounds.resolveRound(asked, subs[0]?.cardId as string, makeRng(`rot-${k}`), 1).state;
    }
    return out;
  };

  test("rotation follows joinOrder across a wrap", () => {
    const g = roundGame({ n: 3, judge: 1, target: 10, greenDeck: 30, redDeck: 60 });
    expect(judgesOver(g, 5)).toEqual([pid(1), pid(2), pid(0), pid(1), pid(2)]);
  });

  test("a gap in joinOrder (the previous judge departed) rotates to the next higher joinOrder, not the next list position", () => {
    // p0 (joinOrder 0) departed; actives p1 (1), p2 (2), p3 (5); the departed judge's cursor was 0.
    const base = roundGame({ n: 4, judge: 0, target: 10, greenDeck: 30, redDeck: 60 });
    const players = base.players.map((p, i) => (i === 0 ? { ...p, status: "left" as const, hand: [], joinOrder: 0 } : i === 3 ? { ...p, joinOrder: 5 } : p));
    const g = { ...base, players, round: { ...(base.round as NonNullable<Game["round"]>), judgeId: pid(2), roster: [pid(1), pid(2), pid(3)] }, judgeCursor: 2 };
    expect(judgesOver(g, 4)).toEqual([pid(2), pid(3), pid(1), pid(2)]);
  });

  test("a late joiner (a later joinOrder) takes a turn after the existing players", () => {
    const base = roundGame({ n: 3, judge: 2, target: 10, greenDeck: 30, redDeck: 60 });
    const late = makePlayer(7, { status: "ready", joinOrder: 9 });
    const g = { ...base, players: [...base.players, late] };
    expect(judgesOver(g, 4)).toEqual([pid(2), pid(7), pid(0), pid(1)]);
  });

  test("the judge is never among the submitters and their score does not move in their own round", () => {
    const g = roundGame({ n: 4, judge: 2, submitted: [0, 1, 3], phase: "JUDGING", scores: [0, 0, 3, 0] });
    expect(g.round?.submissions.some((s) => s.playerId === pid(2))).toBe(false);
    const out = rounds.resolveRound(g, cid(6), scriptedRng([]), 1);
    expect(out.state.players[2]?.scorePile).toHaveLength(3);
  });
});

describe("V1 voidRound (8.3)", () => {
  const empty = (o: RoundGameOptions = {}): Game => roundGame({ greenDeck: 5, ...o });

  test("the green card goes to the bottom of the green deck, RoundVoided then RoundOpened, the number stays history + 1, the judge rotates from the cursor", () => {
    const g = empty({ judge: 1 });
    const out = rounds.voidRound(g, scriptedRng([]), 8, "no_submissions");
    expect(out.state.pools.greenDeck).toEqual([...ids(7001, 4), cid(900)]);
    expect(out.state.round).toMatchObject({ number: 1, judgeId: pid(2), greenCardId: cid(7000), phase: "SUBMITTING", submissions: [], revealOrder: null, changedAtVersion: 10, openedAt: 8, judgeReassigned: false });
    expect(out.events).toEqual([
      { t: "RoundVoided", round: 1, reason: "no_submissions" },
      { t: "RoundOpened", round: 1, judgeId: pid(2), greenCardId: cid(7000), expected: [pid(0), pid(1), pid(3)] },
    ]);
  });

  test("the number follows history after earlier rounds resolved", () => {
    const h = [{ round: 1, judgeId: pid(0), greenCardId: cid(1), plays: [], winnerCardId: cid(2), winnerId: pid(1) }];
    expect(rounds.voidRound(empty({ history: h }), scriptedRng([]), 1, "no_submissions").state.round?.number).toBe(2);
  });

  test("a judge who came from a pass or leave (judgeReassigned) and is still active judges the replacement round", () => {
    const g = empty({ judge: 1 });
    const reassigned = { ...g, round: { ...(g.round as NonNullable<Game["round"]>), judgeReassigned: true } };
    const out = rounds.voidRound(reassigned, scriptedRng([]), 1, "no_submissions");
    expect(out.state.round).toMatchObject({ judgeId: pid(1), judgeReassigned: false });
    expect(out.state.judgeCursor).toBe(1);
  });

  test("a reassigned judge who is no longer active is not kept: rotation is normal", () => {
    const g = empty({ judge: 1 });
    const gone = { ...g, players: g.players.map((p, i) => (i === 1 ? { ...p, status: "left" as const } : p)), round: { ...(g.round as NonNullable<Game["round"]>), judgeReassigned: true } };
    expect(rounds.voidRound(gone, scriptedRng([]), 1, "no_submissions").state.round?.judgeId).toBe(pid(2));
  });

  test("works from a JUDGING round with nothing left to judge, and consumes no rng", () => {
    const g = empty({ phase: "JUDGING" });
    const rng = scriptedRng([]);
    expect(rounds.voidRound({ ...g, round: { ...(g.round as NonNullable<Game["round"]>), revealOrder: [] } }, rng, 1, "no_submissions").state.round?.phase).toBe("SUBMITTING");
    expect(rng.drawn).toBe(0);
  });

  test("a round that still holds submissions, or no round, is an invariant violation", () => {
    expect(() => rounds.voidRound(roundGame({ submitted: [1] }), scriptedRng([]), 1, "no_submissions")).toThrow(EngineInvariantError);
    expect(() => rounds.voidRound({ ...empty(), round: null }, scriptedRng([]), 1, "no_submissions")).toThrow(EngineInvariantError);
  });

  test("does not mutate its input", () => {
    const g = empty();
    const before = structuredClone(g);
    rounds.voidRound(deepFreeze(g), scriptedRng([]), 1, "no_submissions");
    expect(g).toEqual(before);
  });
});

describe("S4 settle slot 4: auto-advance (8.2)", () => {
  const run = (g: Game, seed = "slot4") => { const rng = recordingRng(seed); return { out: settle(g, rng, 77, false), rng }; };

  test("the slots are still 1, 2, 3, 3a, 4, 5 in that order; 3 and 3a stay no-ops (#23)", () => {
    expect(SETTLE_SLOTS.map((s) => s.id)).toEqual(["1", "2", "3", "3a", "4", "5"]);
    const g = roundGame({ submitted: [1] });
    for (const id of ["3", "3a"] as const) {
      const step = SETTLE_SLOTS.find((s) => s.id === id)?.run(g, { rng: scriptedRng([]), now: 1, episodeStarted: false });
      expect(step?.state).toBe(g);
      expect(step?.events).toEqual([]);
    }
  });

  test("SUBMITTING with every expected player in and at least one submission closes with reason allIn: one shuffle, JUDGING, a new episode", () => {
    const { out, rng } = run(roundGame({ submitted: [1, 2, 3] }));
    expect(rng.log).toEqual([["shuffle", 3]]);
    expect(out.events).toEqual([{ t: "SubmissionsClosed", round: 1, judgeId: pid(0), reason: "allIn" }]);
    expect(out.state.round).toMatchObject({ phase: "JUDGING", changedAtVersion: 10 });
    expect(out.state.round?.revealOrder).toHaveLength(3);
    expect(out.state).toMatchObject({ episode: expect.stringMatching(/:JUDGING:/) as string, episodeGen: 1, waitingSince: 77 });
  });

  test("a player who left the roster's table does not hold the round open", () => {
    const g = roundGame({ submitted: [1, 2] });
    const left = { ...g, players: g.players.map((p, i) => (i === 3 ? { ...p, status: "left" as const, hand: [] } : p)) };
    expect(settle(left, scriptedRng([0]), 1, false).events.map((e) => e.t)).toEqual(["SubmissionsClosed"]);
  });

  test("an expected player still out keeps SUBMITTING: a no-op", () => {
    const g = roundGame({ submitted: [1, 2] });
    const { out, rng } = run(g);
    expect(out.events).toEqual([]);
    expect(rng.log).toEqual([]);
    expect(out.state.round).toEqual(g.round);
  });

  test("slot 4 leaves a paused round alone: the same closable round closes with paused false (control) and does nothing with paused true", () => {
    const closable = roundGame({ submitted: [1, 2, 3] });
    const env = () => ({ rng: scriptedRng([0, 0]), now: 1, episodeStarted: false });
    const slot = SETTLE_SLOTS.find((s) => s.id === "4");
    expect(types(slot?.run(closable, env()).events ?? [])).toEqual(["SubmissionsClosed"]);
    const paused = slot?.run({ ...closable, paused: true }, env());
    expect(paused?.events).toEqual([]);
    expect(paused?.state.round?.phase).toBe("SUBMITTING");
  });

  test("the auto-advance loop has an iteration cap: a step beyond it is an EngineInvariantError, not a hang", () => {
    const g = roundGame({ submitted: [1, 2, 3] }); // needs exactly one step
    const slot = SETTLE_SLOTS.find((s) => s.id === "4");
    const env = () => ({ rng: recordingRng("cap"), now: 1, episodeStarted: false });
    expect(() => slot?.run(g, { ...env(), maxAdvanceSteps: 0 })).toThrow(EngineInvariantError);
    expect(slot?.run(g, { ...env(), maxAdvanceSteps: 1 }).events).toHaveLength(1);
  });

  test("void branch (fixture only: it needs a roster with nobody expected): nobody expected and nothing submitted voids the round and opens a replacement", () => {
    const g = roundGame({ n: 4, greenDeck: 5 });
    const thin = { ...g, round: { ...(g.round as NonNullable<Game["round"]>), roster: [pid(0)] } };
    const { out } = run(thin);
    expect(out.events.map((e) => e.t)).toEqual(["RoundVoided", "RoundOpened"]);
    expect(out.state.round).toMatchObject({ number: 1, phase: "SUBMITTING", greenCardId: cid(7000), judgeId: pid(1) });
    expect(out.state.round?.roster).toHaveLength(4);
    expect(out.state.pools.greenDeck.at(-1)).toBe(cid(900));
    expect(out.state.episodeGen).toBe(1);
  });

  test("void branch: a JUDGING round with an empty revealOrder voids", () => {
    const g = roundGame({ phase: "JUDGING", greenDeck: 5 });
    const hollow = { ...g, round: { ...(g.round as NonNullable<Game["round"]>), revealOrder: [] } };
    expect(settle(hollow, scriptedRng([]), 1, false).events.map((e) => e.t)).toEqual(["RoundVoided", "RoundOpened"]);
  });

  test("a JUDGING round with something to judge, and a null judge, are left alone", () => {
    const j = roundGame({ submitted: [1], phase: "JUDGING" });
    expect(settle(j, scriptedRng([]), 1, false).events).toEqual([]);
    const nobody = { ...roundGame({ submitted: [1, 2, 3] }) };
    const headless = { ...nobody, round: { ...(nobody.round as NonNullable<Game["round"]>), judgeId: null } };
    expect(settle(headless, scriptedRng([]), 1, false).events).toEqual([]);
  });

  test("settle on a game with no round, or outside PLAYING, changes nothing here", () => {
    expect(settle({ ...roundGame(), round: null }, scriptedRng([]), 1, false).events).toEqual([]);
    expect(settle({ ...roundGame({ submitted: [1, 2, 3] }), phase: "FINISHED", round: null }, scriptedRng([]), 1, false).events).toEqual([]);
  });
});
