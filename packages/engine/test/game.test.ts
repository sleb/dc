// #22: whole games through the real REGISTRY. S1 is the scripted 3-player game from createGame to a win (LLD 1 section 15.2, "Additional scripted scenario tests");
// the seeded runs play N = 3 to 10 with new decks and with minimum-size decks under `runScenario` (every global checker after every step), which is X6's redraw-free half.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Command } from "@dc/contracts";
import { decide } from "../src/decide";
import { gMin, rMin, defaultTarget } from "../src/rules/playability";
import type { Accepted, Actor, Draft, DomainEvent, Game, GameDrafts, Rng } from "../src/types";
import { checkAll } from "./support/checks";
import { GAME_ID, HOST_UID, counterMintId, ctxFor, gameWithDeck, pid, scriptedRng, seatUidOf, userActor } from "./support/factories";
import { assertProperty } from "./support/fc";
import { enumerators } from "./support/legal";
import { progressDriver, runScenario } from "./support/scenario";
import type { Picks } from "./support/scenario";

const cmd = (c: object): Command => c as unknown as Command;
const seat = (n: number): Actor => userActor(n === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(n)));
const zeros = (n: number): number[] => Array.from({ length: n }, () => 0);
const types = (events: readonly DomainEvent[]): string[] => events.map((e) => e.t);

/** Drives the real `decide` one command at a time, running every global checker, keeping the draft documents like the Store would. */
function table() {
  let state: Game | null = null;
  let drafts: Record<string, Draft> = {};
  const mint = counterMintId(20_000);
  let index = 0;
  const all: DomainEvent[] = [];
  const run = (actor: Actor, c: object, rng: Rng): Accepted => {
    const ctx = ctxFor({ now: 1_000 + index, rng, mintId: mint, actor, drafts: drafts as GameDrafts });
    const result = decide(state, cmd(c), ctx);
    if (!result.ok) throw new Error(`step ${index}: ${JSON.stringify(c)} was rejected: ${JSON.stringify(result.error)}`);
    checkAll({ index, before: state, cmd: c, result, actor, drafts });
    for (const d of result.value.draftChanges) {
      const { [d.playerId]: _gone, ...rest } = drafts;
      drafts = d.draft === null ? rest : { ...rest, [d.playerId]: d.draft };
    }
    state = result.value.state;
    all.push(...result.value.events);
    index++;
    return result.value;
  };
  return { run, get state() { return state as Game; }, get events() { return all; } };
}

describe("S1 the scripted 3-player game, from createGame to a win", () => {
  test("a new deck at N = 3 (24 green, exactly G_min), the first judge from a scripted int, rotation, every round resolved once, to a win at 8", () => {
    const t = table();
    t.run(seat(0), { type: "createGame", gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "Host" }, scriptedRng([]));
    t.run(seat(1), { type: "join", playerId: pid(1), name: "Ann" }, scriptedRng([]));
    t.run(seat(2), { type: "join", playerId: pid(2), name: "Bo" }, scriptedRng([]));
    const started = t.run(seat(0), { type: "startGame" }, scriptedRng([]));
    expect(started.events).toEqual([{ t: "WritingStarted", target: 8, writeCounts: { red: 10, green: 8 } }]);

    let lastFinish: ReturnType<typeof scriptedRng> | null = null;
    let finish: Accepted | null = null;
    for (const i of [0, 1, 2]) {
      const draft = { red: Array.from({ length: 10 }, (_, k) => `p${i} red ${k}`), green: Array.from({ length: 8 }, (_, k) => `p${i} green ${k}`) };
      t.run(seat(i), { type: "saveDraft", ...draft }, scriptedRng([]));
      // The last finish also begins play: shuffle red (30) and green (24) for the pooled cards, then again for beginPlay, then int(3) for the first judge.
      const rng = scriptedRng(i < 2 ? zeros(200) : [...zeros(29 + 23 + 29 + 23), 1]);
      finish = t.run(seat(i), { type: "finishWriting" }, rng);
      lastFinish = rng;
    }
    expect(lastFinish?.drawn).toBe(29 + 23 + 29 + 23 + 1); // shuffle red, shuffle green, shuffle red, shuffle green, int: the rng order of 8.7
    expect(types(finish?.events ?? [])).toEqual(["PlayerFinishedWriting", "PlayStarted", "PlayerActivated", "PlayerActivated", "PlayerActivated", "RoundOpened"]);
    expect(finish?.events[1]).toEqual({ t: "PlayStarted", playerIds: [pid(0), pid(1), pid(2)], firstJudgeId: pid(1) });
    expect(Object.values(t.state.cards).filter((c) => c.kind === "green")).toHaveLength(gMin(3, 8));

    // Rounds. Everyone plays their first card in joinOrder; the zero-script shuffle of two cards reverses them, so the second to confirm is revealed first, and the judge picks that.
    const judges: number[] = [];
    const winners: number[] = [];
    const roundEvents: string[][] = [];
    for (let guard = 0; t.state.phase === "PLAYING" && guard < 40; guard++) {
      const round = t.state.round;
      if (round === null || round.judgeId === null) throw new Error("no round");
      const judge = t.state.players.findIndex((p) => p.id === round.judgeId);
      judges.push(judge);
      const confirms: Accepted[] = [];
      const draws: number[] = [];
      for (const [k, p] of t.state.players.entries()) {
        if (k === judge) continue;
        const rng = scriptedRng(zeros(10));
        confirms.push(t.run(seat(k), { type: "confirmSubmission", cardId: p.hand[0], expectedVersion: round.changedAtVersion }, rng));
        draws.push(rng.drawn);
      }
      expect(draws).toEqual([0, 1]); // the second confirm closes the round with one shuffle of two cards
      expect(confirms.map((c) => types(c.events))).toEqual([["SubmissionConfirmed"], ["SubmissionConfirmed", "SubmissionsClosed"]]);
      expect(confirms[1]?.events[1]).toEqual({ t: "SubmissionsClosed", round: round.number, judgeId: round.judgeId, reason: "allIn" });
      const judging = t.state.round;
      const revealed = judging?.revealOrder?.[0] ?? "";
      const done = t.run(seat(judge), { type: "pickWinner", submissionId: revealed, expectedVersion: judging?.changedAtVersion }, scriptedRng(zeros(400)));
      const picked = done.events[0];
      if (picked?.t !== "WinnerPicked") throw new Error("no WinnerPicked");
      winners.push(t.state.players.findIndex((p) => p.id === picked.winnerId));
      roundEvents.push(types(done.events));
    }

    expect(judges).toEqual([1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0]);
    expect(winners).toEqual([2, 1, 2, 2, 1, 2, 2, 1, 2, 2, 1, 2]);
    expect(roundEvents.slice(0, -1).every((e) => e.join() === "WinnerPicked,RoundOpened")).toBe(true);
    expect(roundEvents.at(-1)).toEqual(["WinnerPicked", "GameFinished"]);
    const g = t.state;
    expect(g).toMatchObject({ phase: "FINISHED", winnerId: pid(2), round: null, paused: false });
    expect(g.players.map((p) => p.scorePile.length)).toEqual([0, 4, 8]);
    expect(g.history).toHaveLength(12);
    expect(g.history.map((h) => h.round)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(g.players.every((p) => p.hand.length === 7)).toBe(true);
    const events = types(t.events);
    expect(events.filter((e) => e === "GameFinished")).toHaveLength(1);
    expect(events.indexOf("GameFinished")).toBe(events.length - 1); // nothing after it, no RoundOpened
    // E15: terminal.
    expect(decide(g, cmd({ type: "pickWinner", submissionId: "x", expectedVersion: 1 }), ctxFor({ actor: seat(1) }))).toStrictEqual({ ok: false, error: { code: "WRONG_PHASE" } });
    expect(decide(g, cmd({ type: "confirmSubmission", cardId: "x", expectedVersion: 1 }), ctxFor({ actor: seat(0) }))).toStrictEqual({ ok: false, error: { code: "WRONG_PHASE" } });
  });
});

const env = (): Record<string, string | undefined> => ({ ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? "6" });
const placeholders: Picks = Array.from({ length: 1500 }, () => ({ kind: "legal" as const, pick: 0 }));

/** A LOBBY made by the real createGame, for the driver to fill and start. */
function lobby(): Game {
  const r = decide(null, cmd({ type: "createGame", gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "Host" }), ctxFor({ actor: seat(0) }));
  if (!r.ok) throw new Error("createGame rejected");
  return r.value.state;
}

describe("S2 seeded games to a win under runScenario (every checker after every step)", () => {
  test("new decks, N = 3 to 10, the host or the judge sometimes closing early: every game reaches FINISHED with the winner at the target", () => {
    assertProperty(fc.property(fc.integer({ min: 3, max: 10 }), fc.integer(), (n, seed) => {
      const trace = runScenario(decide, lobby(), placeholders, { seed, table: enumerators, drive: progressDriver(`${seed}`, n, enumerators, true) });
      const end = trace.states.at(-1) as Game;
      expect(end.phase).toBe("FINISHED");
      expect(end.target).toBe(defaultTarget(n));
      const winner = end.players.find((p) => p.id === end.winnerId);
      expect(winner?.scorePile.length).toBe(end.target ?? -1);
      expect(end.players.filter((p) => p.scorePile.length >= (end.target ?? 99))).toHaveLength(1);
    }), env());
  });
});

describe("X6 red supply never short, redraw-free half: minimum-size decks, N = 3 and N = 10", () => {
  const minimum = (n: number): Game => {
    const t = defaultTarget(n);
    return gameWithDeck(n, rMin(n), gMin(n, t), { phase: "WRITING", version: 9, target: t, writeCounts: { red: 10, green: t } }, "ready");
  };

  test.each([3, 10])("N = %i: exactly R_min red and G_min green; every resolve tops every hand to 7 (checkTopUp) and the game ends in a win", (n) => {
    assertProperty(fc.property(fc.integer(), (seed) => {
      const trace = runScenario(decide, minimum(n), placeholders, { seed, table: enumerators, drive: progressDriver(`${seed}`, n, enumerators, true) });
      const end = trace.states.at(-1) as Game;
      expect(end.phase).toBe("FINISHED");
      const reds = Object.values(end.cards).filter((c) => c.kind === "red").length;
      expect(reds).toBe(rMin(n));
      expect(trace.results.filter((r) => r.ok && r.value.events.some((e) => e.t === "WinnerPicked")).length).toBe(end.history.length);
    }), env());
  });

  test("the minimum deck really does reshuffle: some resolve at N = 3 draws from a reshuffled discard (the deck is shorter than the top-up)", () => {
    const trace = runScenario(decide, minimum(3), placeholders, { seed: 1, table: enumerators, drive: progressDriver("1", 3, enumerators) });
    const shuffled = trace.states.some((s, i) => {
      const prev = trace.states[i - 1];
      return s !== null && prev !== null && prev !== undefined && prev.history.length < s.history.length && s.pools.redDiscard.length === 0 && prev.pools.redDiscard.length + (prev.round?.submissions.length ?? 0) > 0 && prev.pools.redDeck.length < 2;
    });
    expect(shuffled).toBe(true);
  });
});
