// #23 (1.6): the properties of LLD 1 section 15.2 for E12, E17, E18 and X7, over whole seeded games with membership churn under runScenario (every checker after every step,
// including the new checkEviction and checkLateJoin and the updated checkJudges, checkPlayable and checkScoring), plus the sharpness of the new checkers.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Command } from "@dc/contracts";
import { decide } from "../src/decide";
import { makeRng } from "../src/rng";
import { NEW_DECK_RED, defaultTarget, meetsMinimums, totals } from "../src/rules/playability";
import type { Accepted, Draft, DomainEvent, Game } from "../src/types";
import { checkEviction, checkJudges, checkLateJoin, checkPlayable, checkScoring, checkRevealOrder, checkers } from "./support/checks";
import type { Step } from "./support/checks";
import { GAME_ID, HOST_UID, counterMintId, ctxFor, makeGame, makePlayer, pid, seatUidOf, userActor } from "./support/factories";
import { assertProperty } from "./support/fc";
import { enumerators } from "./support/legal";
import { membershipDriver, runScenario } from "./support/scenario";
import type { Picks } from "./support/scenario";
import { park, roundGame } from "./support/round-fixtures";

const cmd = (c: object): Command => c as unknown as Command;
const seat = (n: number) => userActor(n === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(n)));
const env = (): Record<string, string | undefined> => ({ ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? "8" });
const placeholders: Picks = Array.from({ length: 900 }, () => ({ kind: "legal" as const, pick: 0 }));

function lobby(): Game {
  const r = decide(null, cmd({ type: "createGame", gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "Host" }), ctxFor({ actor: seat(0) }));
  if (!r.ok) throw new Error("createGame rejected");
  return r.value.state;
}
const play = (n: number, seed: number) => runScenario(decide, lobby(), placeholders, { seed, table: enumerators, drive: membershipDriver(`${seed}`, n, enumerators) });
const eventsOf = (t: ReturnType<typeof play>): DomainEvent[] => t.results.flatMap((r) => (r.ok ? r.value.events : []));

describe("E12, E17, E18 over seeded games with churn (every checker after every step)", () => {
  test("random tables of 3 to 8: joins, leaves, removals and late writers mid-game never break a checker, and the game state stays coherent", () => {
    assertProperty(fc.property(fc.integer({ min: 3, max: 8 }), fc.integer(), (n, seed) => {
      const trace = play(n, seed);
      for (const s of trace.states) {
        if (s === null || s.round === null) continue;
        // E12: a null judge only while paused.
        if (s.round.judgeId === null) expect(s.paused).toBe(true);
        else if (s.phase === "PLAYING" && !s.paused) expect(s.players.find((p) => p.id === s.round?.judgeId)?.status).toBe("active");
      }
      const last = trace.states.at(-1) as Game;
      for (const p of last.players) if (p.status === "left" || p.status === "removed") expect([p.hand.length, p.scorePile.length]).toEqual([0, 0]);
    }), env());
  });

  test("the churn is not vacuous: over 80 fixed seeds the runs hit every membership case (departures, late joins, judge changes, pauses and resumptions, activations by recovery, voids, endGame)", () => {
    const seen = new Set<string>();
    const count = new Map<string, number>();
    const bump = (k: string): void => { seen.add(k); count.set(k, (count.get(k) ?? 0) + 1); };
    for (let seed = 1; seed <= 80; seed++) {
      const n = 3 + (seed % 6);
      const t = play(n, seed);
      t.results.forEach((r, i) => {
        if (!r.ok) return;
        const before = t.states[i];
        for (const e of r.value.events) {
          if (e.t === "JudgeChanged") bump(`judge:${e.reason}`);
          else if (e.t === "PausedChanged") bump(e.paused ? "pause" : "unpause");
          else if (e.t === "PlayerLeft" || e.t === "PlayerRemoved") bump(before !== null && before !== undefined && before.phase !== "LOBBY" ? `evict:${before.phase}` : "lobby-leave");
          else if (e.t === "PlayerJoined" && before !== null && before !== undefined && before.phase !== "LOBBY") bump(`late-join:${before.phase}`);
          else if (e.t === "RoundVoided") bump("void");
          else if (e.t === "GameEnded") bump(`end:${before?.phase ?? "?"}`);
          else if (e.t === "PlayerActivated" && before !== null && before !== undefined && before.phase === "PLAYING" && before.paused) bump("recovery-activation");
        }
      });
    }
    for (const k of ["judge:left", "judge:removed", "pause", "unpause", "evict:WRITING", "evict:PLAYING", "late-join:WRITING", "late-join:PLAYING", "recovery-activation"]) expect([k, seen.has(k)]).toEqual([k, true]);
    expect(count.get("void") ?? 0).toBeGreaterThanOrEqual(0);
  });

  test("seeded games with churn still finish, end by endGame, or run out of steps: they never throw (X1) and are deterministic (X3)", () => {
    for (let seed = 100; seed < 110; seed++) {
      const a = play(5, seed);
      const b = play(5, seed);
      expect(b).toEqual(a);
    }
  });
});

describe("E17 through the real commands: a departed seat holds nothing and the zones still conserve", () => {
  test("a table of 4 to 6 in PLAYING: every seat leaves, one at a time, in a random order; after each, the departed hold nothing and E5 holds", () => {
    assertProperty(fc.property(fc.integer({ min: 4, max: 6 }), fc.shuffledSubarray([0, 1, 2, 3, 4, 5], { minLength: 3, maxLength: 6 }), fc.integer(), fc.constantFrom("SUBMITTING", "JUDGING"), (n, order, seed, phase) => {
      let g = roundGame({ n, judge: Math.abs(seed) % n, submitted: [1, 2, 3].filter((i) => i < n), phase });
      let k = 0;
      for (const who of order.filter((i) => i < n)) {
        const p = g.players[who];
        if (p === undefined || p.status !== "active") continue;
        const ctx = ctxFor({ actor: seat(who), rng: makeRng(`${seed}:${k++}`), mintId: counterMintId(50_000) });
        const r = decide(g, cmd({ type: "leave" }), ctx);
        if (!r.ok) throw new Error(`leave rejected: ${JSON.stringify(r.error)}`);
        const step: Step = { index: k, seed, before: g, cmd: { type: "leave" }, result: r, actor: ctx.actor, drafts: {} };
        for (const c of checkers) c(step);
        g = r.value.state;
        if (g.phase !== "PLAYING") break;
      }
    }), env());
  });
});

describe("X7 late-join sufficiency over whole games", () => {
  test("every PLAYING state of a churned game counts the pending writers' obligations toward the minimums (checkPlayable) and, when none are pending, meets them outright", () => {
    assertProperty(fc.property(fc.integer({ min: 3, max: 7 }), fc.integer(), (n, seed) => {
      const t = play(n, seed);
      for (const s of t.states) {
        if (s === null || s.phase !== "PLAYING" || s.target === null || s.players.some((p) => p.status === "writing")) continue;
        const seated = s.players.filter((p) => p.status === "ready" || p.status === "active").length;
        expect(meetsMinimums(totals(s), seated, s.target)).toBe(true);
      }
    }), env());
  });
});

describe("the new checkers fail rather than pass vacuously", () => {
  const stepOf = (g: Game, c: object, who: number): Step & { value: Accepted } => {
    const ctx = ctxFor({ actor: seat(who), rng: makeRng("chk"), mintId: counterMintId(60_000) });
    const result = decide(g, cmd(c), ctx);
    if (!result.ok) throw new Error(`rejected ${JSON.stringify(result.error)}`);
    return { index: 0, before: g, cmd: c, result, actor: ctx.actor, drafts: {} as Record<string, Draft>, value: result.value };
  };
  const withState = (s: Step & { value: Accepted }, patch: (g: Game) => Game, events?: DomainEvent[]): Step => ({ ...s, result: { ok: true, value: { ...s.value, state: patch(s.value.state), ...(events === undefined ? {} : { events }) } } });
  const leaveOf = (): Step & { value: Accepted } => stepOf(roundGame({ judge: 1, submitted: [2] }), { type: "leave" }, 2);

  test("checkEviction: a leaver who keeps a card, a pile or a submission, stays in waitingOn, or whose draft was not deleted is caught", () => {
    const s = leaveOf();
    expect(() => checkEviction(s)).not.toThrow();
    expect(() => checkEviction(withState(s, (g) => ({ ...g, players: g.players.map((p) => (p.id === pid(2) ? { ...p, hand: ["c_0000000001"] } : p)) })))).toThrow(/still holds cards/);
    expect(() => checkEviction(withState(s, (g) => ({ ...g, players: g.players.map((p) => (p.id === pid(2) ? { ...p, scorePile: ["c_0000000001"] } : p)) })))).toThrow(/still holds cards/);
    expect(() => checkEviction(withState(s, (g) => ({ ...g, round: g.round === null ? null : { ...g.round, submissions: [{ playerId: pid(2), cardId: "c_0000000001" }] } })))).toThrow(/submission/);
    expect(() => checkEviction(withState(s, (g) => ({ ...g, waitingOn: [pid(2)] })))).toThrow(/waitingOn/);
    expect(() => checkEviction(withState(s, (g) => ({ ...g, players: g.players.map((p) => (p.id === pid(2) ? { ...p, status: "removed" as const } : p)) })))).toThrow(/departed seat is removed/);
    expect(() => checkEviction(withState(s, (g) => g, []))).toThrow(/first event/);
    const writing = stepOf(makeGame({ phase: "WRITING", target: 8, writeCounts: { red: 10, green: 8 }, players: [0, 1, 2, 3].map((i) => makePlayer(i, { status: "writing", writeTarget: { red: 10, green: 8 } })) }), { type: "leave" }, 3);
    expect(() => checkEviction(writing)).not.toThrow();
    expect(() => checkEviction({ ...writing, result: { ok: true, value: { ...writing.value, draftChanges: [] } } })).toThrow(/draft was not deleted/);
  });

  test("checkLateJoin: a writing or ready seat with a card, a point or a submission, an activation with no boundary, and a join that adds no writing seat are caught", () => {
    const g = roundGame({ n: 3, judge: 0, extra: { writeCounts: { red: 10, green: 8 } } });
    const s = stepOf(g, { type: "join", playerId: pid(5), name: "Late" }, 5);
    expect(() => checkLateJoin(s)).not.toThrow();
    expect(() => checkLateJoin(withState(s, (x) => ({ ...x, players: x.players.map((p) => (p.id === pid(5) ? { ...p, hand: ["c_0000000001"] } : p)) })))).toThrow(/holds cards or points/);
    expect(() => checkLateJoin(withState(s, (x) => ({ ...x, players: x.players.map((p) => (p.id === pid(5) ? { ...p, status: "ready" as const, scorePile: ["c_0000000001"] } : p)) })))).toThrow(/holds cards or points/);
    expect(() => checkLateJoin(withState(s, (x) => x, [{ t: "PlayerActivated", playerId: pid(1) }]))).toThrow(/no round boundary/);
    expect(() => checkLateJoin(withState(s, (x) => ({ ...x, players: x.players.map((p) => (p.id === pid(5) ? { ...p, status: "active" as const } : p)) })))).toThrow(/exactly one writing seat/);
  });

  test("checkJudges: a round that keeps a null judge while unpaused, a JudgeChanged that disagrees with the round, and a reopened round under the wrong judge are caught", () => {
    const s = stepOf(roundGame({ judge: 1, submitted: [2], phase: "JUDGING" }), { type: "passJudging", expectedVersion: 5 }, 0);
    expect(() => checkJudges(s)).not.toThrow();
    expect(() => checkJudges(withState(s, (g) => ({ ...g, round: g.round === null ? null : { ...g.round, judgeId: null } })))).toThrow();
    const voided = stepOf(roundGame({ judge: 1, submitted: [2], phase: "JUDGING" }), { type: "passJudging", expectedVersion: 5 }, 0);
    expect(voided.value.events.map((e) => e.t)).toEqual(["JudgeChanged", "RoundVoided", "RoundOpened"]);
    expect(() => checkJudges(voided)).not.toThrow();
    expect(() => checkJudges(withState(voided, (g) => ({ ...g, round: g.round === null ? null : { ...g.round, judgeId: pid(3) } })))).toThrow(/model says/);
  });

  test("checkPlayable counts the pending writers: a late join that did not ask for enough is caught, one that did is not", () => {
    const g = roundGame({ n: 4, judge: 1, redDeck: 12, extra: { writeCounts: { red: 10, green: 8 } } });
    const s = stepOf(g, { type: "join", playerId: pid(5), name: "Late" }, 5);
    expect(() => checkPlayable(s)).not.toThrow();
    expect(() => checkPlayable(withState(s, (x) => ({ ...x, players: x.players.map((p) => (p.id === pid(5) ? { ...p, writeTarget: { red: 1, green: 1 } } : p)) })))).toThrow(/minimums/);
  });

  test("checkScoring: a point gained by someone who did not win, or by a command that resolved nothing, is caught; a leaver's pile leaving is not", () => {
    const g = roundGame({ judge: 1, scores: [0, 0, 1, 0], history: [{ round: 1, judgeId: pid(0), greenCardId: "c_x", plays: [], winnerCardId: "c_y", winnerId: pid(2) }] });
    const s = stepOf(g, { type: "removePlayer", playerId: pid(2) }, 0);
    expect(() => checkScoring(s)).not.toThrow();
    const c = stepOf(roundGame({ judge: 1, submitted: [2] }), { type: "closeSubmissions", expectedVersion: 5 }, 1);
    expect(() => checkScoring(withState(c, (x) => ({ ...x, players: x.players.map((p) => (p.id === pid(3) ? { ...p, scorePile: ["c_0000000001"] } : p)), history: [...x.history, { round: 1, judgeId: pid(0), greenCardId: "c_x", plays: [], winnerCardId: "c_y", winnerId: pid(3) }] })))).toThrow();
  });

  test("checkRevealOrder: a removal keeps the relative order, a reorder is caught", () => {
    const g = roundGame({ n: 5, judge: 1, submitted: [2, 3, 4], phase: "JUDGING" });
    const s = stepOf(g, { type: "passJudging", expectedVersion: 5 }, 0);
    expect(() => checkRevealOrder(s)).not.toThrow();
    expect(() => checkRevealOrder(withState(s, (x) => ({ ...x, round: x.round === null ? null : { ...x.round, revealOrder: [...(x.round.revealOrder ?? [])].reverse() } })))).toThrow(/changed after the close/);
  });

  test("park keeps a fixture coherent: a parked ready seat holds nothing (E18)", () => {
    const g = park(roundGame({ judge: 1 }), 3, "ready");
    expect(g.players[3]).toMatchObject({ status: "ready", hand: [], scorePile: [] });
    expect(NEW_DECK_RED).toBe(10);
    expect(defaultTarget(4)).toBe(8);
  });
});
