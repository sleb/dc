// #23 (1.6): membership mid-game through the real REGISTRY (LLD 1 sections 7.1, 7.2, 8.5, 9.4): the widened join, leave and removePlayer, the late-join requirement
// (V1 to V3, X7) and evictPlayer (V4, V5, E17). The stall commands, the settle slots and endGame are in stalls.test.ts.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Command } from "@dc/contracts";
import { decide } from "../src/decide";
import * as membership from "../src/rules/membership";
import * as playability from "../src/rules/playability";
import type { Accepted, Actor, Ctx, DomainEvent, Game, Phase, Rejection } from "../src/types";
import { checkAll } from "./support/checks";
import { GAME_ID, HOST_UID, addCard, cid, ctxFor, deepFreeze, gameWithDeck, makeGame, makePlayer, pid, recordingRng, scriptedRng, seatUidOf, userActor } from "./support/factories";
import { assertProperty } from "./support/fc";
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
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const player = (g: Game, i: number) => g.players[i] as Game["players"][number];

describe("V1 join, leave and removePlayer by phase (7.1)", () => {
  const PHASES: Phase[] = ["LOBBY", "WRITING", "PLAYING", "FINISHED", "ENDED"];
  const inPhase = (phase: Phase): Game => makeGame({ phase, target: 8, writeCounts: { red: 10, green: 8 }, players: [0, 1, 2].map((i) => makePlayer(i, { status: phase === "LOBBY" ? "writing" : "active" })) });
  const cases: [string, object, Actor][] = [
    ["join", { type: "join", playerId: pid(5), name: "Newcomer" }, seat(5)],
    ["leave", { type: "leave" }, seat(1)],
    ["removePlayer", { type: "removePlayer", playerId: pid(1) }, host],
  ];
  for (const [type, c, actor] of cases) {
    for (const phase of PHASES) {
      const ok = phase === "LOBBY" || phase === "WRITING" || phase === "PLAYING";
      test(`${type} in ${phase}: ${ok ? "accepted" : "WRONG_PHASE"}`, () => {
        if (ok) expect(run(inPhase(phase), c, actor).ok).toBe(true);
        else expect(rejected(inPhase(phase), c, actor)).toStrictEqual({ code: "WRONG_PHASE" });
      });
    }
  }
});

describe("V2 join in WRITING and PLAYING (7.2, 9.4)", () => {
  // The 9.4 worked example: four players in play on a new deck, 40 red and 32 green (hands 28, deck 12; green deck 31 and the round's card).
  const play4 = (extra: Partial<Game> = {}, redDeck = 12): Game => roundGame({ n: 4, judge: 1, redDeck, extra: { writeCounts: { red: 10, green: 8 }, ...extra } });
  const joinAs = (n: number, name = `Late ${n}`) => ({ type: "join", playerId: pid(n), name });

  test("a fifth player joining a PLAYING game: status writing, no cards, writeTarget = lateJoinerRequirement = 10 red and 8 green, the only event PlayerJoined", () => {
    const g = play4();
    expect(playability.totals(g)).toEqual({ red: 40, green: 32 });
    const v = accepted(g, joinAs(5), seat(5));
    const p = v.state.players[4] as Game["players"][number];
    expect(p).toMatchObject({ id: pid(5), uid: seatUidOf(GAME_ID, pid(5)), name: "Late 5", status: "writing", hand: [], scorePile: [], writeTarget: { red: 10, green: 8 }, writeProgress: { red: 0, green: 0 } });
    expect(v.events).toEqual([{ t: "PlayerJoined", playerId: pid(5) }]);
    expect(v.state.totalJoins).toBe(g.totalJoins + 1);
    expect(v.state.round).toEqual(g.round); // the round is untouched: they sit out
    expect(v.state.waitingOn).toContain(pid(5)); // a writer is waited on
  });

  test("a sixth player joining while the fifth still writes is asked for 10 and 8 again (the fifth's obligation is projected)", () => {
    const five = accepted(play4(), joinAs(5), seat(5)).state;
    const v = accepted(five, joinAs(6), seat(6));
    expect(player(v.state, 5).writeTarget).toEqual({ red: 10, green: 8 });
  });

  test("the requirement is the deficit when it exceeds the configured counts, and the configured counts when it does not", () => {
    // Red 36, green 32 at n = 4; a fifth needs R_min(5) = 45 and G_min(5) = 40: deficits 9 and 8 beat a configured {2, 1}.
    const short = play4({ writeCounts: { red: 2, green: 1 } }, 8);
    expect(accepted(short, joinAs(5), seat(5)).state.players[4]?.writeTarget).toEqual({ red: 9, green: 8 });
    // Plenty of cards: the deficit is 0 and the configured counts stand.
    const plenty = roundGame({ n: 4, judge: 1, redDeck: 40, greenDeck: 60, extra: { writeCounts: { red: 3, green: 2 } } });
    expect(accepted(plenty, joinAs(5), seat(5)).state.players[4]?.writeTarget).toEqual({ red: 3, green: 2 });
  });

  test("a join in WRITING is asked for the same requirement, joinOrder is past every order and totalJoins, and the game stays WRITING", () => {
    const g = gameWithDeck(4, 0, 0, { phase: "WRITING", target: 8, writeCounts: { red: 10, green: 8 }, totalJoins: 6, version: 3 });
    const withWriters: Game = { ...g, players: g.players.map((p) => ({ ...p, writeTarget: { red: 10, green: 8 } })) };
    const v = accepted(withWriters, joinAs(5), seat(5));
    expect(v.state.phase).toBe("WRITING");
    expect(player(v.state, 4)).toMatchObject({ joinOrder: 7, status: "writing", writeTarget: { red: 10, green: 8 } });
    expect(v.state.waitingOn).toContain(pid(5));
  });

  test("ROOM_FULL at ten seated (no detail) and at the join cap (detail join_cap), NAME_TAKEN first, a departed seat does not count; FINISHED is WRONG_PHASE", () => {
    const full = gameWithDeck(10, 60, 40, { phase: "WRITING", target: 4, writeCounts: { red: 10, green: 4 } });
    expect(rejected(full, joinAs(11, "Fresh"), seat(11))).toStrictEqual({ code: "ROOM_FULL" });
    expect(rejected(full, joinAs(11, "player 3"), seat(11))).toStrictEqual({ code: "NAME_TAKEN" });
    const nine = { ...full, players: full.players.map((p, i) => (i === 9 ? { ...p, status: "left" as const } : p)) };
    expect(run(nine, joinAs(11, "Fresh"), seat(11)).ok).toBe(true);
    const capped = { ...roundGame({ extra: { writeCounts: { red: 10, green: 8 } } }), totalJoins: 50 };
    expect(rejected(capped, joinAs(11, "Fresh"), seat(11))).toStrictEqual({ code: "ROOM_FULL", detail: "join_cap" });
    expect(rejected({ ...capped, phase: "FINISHED", round: null }, joinAs(11, "Fresh"), seat(11))).toStrictEqual({ code: "WRONG_PHASE" });
  });
});

describe("V3 lateJoinerRequirement (9.4) against an independent implementation", () => {
  /** Written from the formula's rationale, not from the production code: count the cards, add every pending writer's obligation, take the larger of the configured count and the deficit. */
  const expected = (g: Game, nAfter: number): { red: number; green: number } => {
    const cards = Object.values(g.cards);
    let red = cards.filter((c) => c.kind === "red").length;
    let green = cards.filter((c) => c.kind === "green").length;
    for (const p of g.players) {
      if (p.status === "writing" && p.writeTarget !== null) { red += p.writeTarget.red; green += p.writeTarget.green; }
    }
    const t = g.target ?? 0;
    const cfg = g.writeCounts ?? { red: 0, green: 0 };
    const rNeed = 7 * nAfter + Math.max(2 * nAfter, 7);
    const gNeed = nAfter * t;
    return { red: Math.max(cfg.red, rNeed - red, 0), green: Math.max(cfg.green, gNeed - green, 0) };
  };

  test("random tables, pending writers and configured counts", () => {
    const arbStatus = fc.constantFrom("writing", "ready", "active", "left");
    assertProperty(fc.property(
      fc.integer({ min: 0, max: 120 }), fc.integer({ min: 0, max: 120 }), fc.integer({ min: 2, max: 10 }),
      fc.record({ red: fc.integer({ min: 0, max: 10 }), green: fc.integer({ min: 0, max: 10 }) }),
      fc.array(fc.record({ status: arbStatus, red: fc.integer({ min: 0, max: 10 }), green: fc.integer({ min: 0, max: 10 }) }), { minLength: 3, maxLength: 9 }),
      (reds, greens, target, cfg, who) => {
        let g = makeGame({
          phase: "PLAYING", target, writeCounts: cfg,
          players: who.map((w, i) => makePlayer(i, { status: w.status, writeTarget: w.status === "writing" ? { red: w.red, green: w.green } : null })),
        });
        for (let k = 0; k < reds; k++) g = addCard(g, cid(k), "red", "redDeck");
        for (let k = 0; k < greens; k++) g = addCard(g, cid(1000 + k), "green", "greenDeck");
        const n = who.filter((w) => w.status !== "left").length + 1;
        expect(playability.lateJoinerRequirement(g, n)).toEqual(expected(g, n));
      },
    ));
  });

  test("X7: after any run of joins to a new-deck game, once every pending writer has finished (their targets pooled) the minimums hold at the final seat count", () => {
    assertProperty(fc.property(fc.integer({ min: 3, max: 8 }), fc.integer({ min: 0, max: 7 }), (n, joins) => {
      const t = playability.defaultTarget(n);
      let g = roundGame({ n, judge: 0, target: t, redDeck: playability.NEW_DECK_RED * n - 7 * n, extra: { writeCounts: { red: playability.NEW_DECK_RED, green: t } } });
      expect(playability.meetsMinimums(playability.totals(g), n, t)).toBe(true);
      for (let j = 0; j < Math.min(joins, 10 - n); j++) {
        g = accepted(g, { type: "join", playerId: pid(20 + j), name: `Late ${j}` }, seat(20 + j)).state;
        const seated = g.players.filter((p) => p.status !== "left" && p.status !== "removed").length;
        const owed = g.players.filter((p) => p.status === "writing").reduce((s, p) => ({ red: s.red + (p.writeTarget?.red ?? 0), green: s.green + (p.writeTarget?.green ?? 0) }), { red: 0, green: 0 });
        const now = playability.totals(g);
        expect(playability.meetsMinimums({ red: now.red + owed.red, green: now.green + owed.green }, seated, t)).toBe(true);
      }
    }));
  });

  test("the requirement never exceeds what one player can write for a new deck (10 red, the target in green) at the room cap", () => {
    const g = roundGame({ n: 9, judge: 0, target: 4, redDeck: 90 - 63, extra: { writeCounts: { red: 10, green: 4 } } });
    expect(playability.lateJoinerRequirement(g, 10)).toEqual({ red: 10, green: 4 });
  });
});

describe("V4 evictPlayer: the order of the zones and the rng (8.5)", () => {
  const zeros = () => scriptedRng(Array.from({ length: 200 }, () => 0));
  /** p2 holds 6 cards, a submission, and a pile of two; the red deck holds 20 and the green deck 29. */
  const table = (): Game => roundGame({ n: 4, judge: 1, submitted: [2], scores: [0, 0, 2, 0] });
  const evict = (g: Game, rng: ReturnType<typeof recordingRng> | ReturnType<typeof zeros>, status: "left" | "removed" = "left", id = pid(2)) => membership.evictPlayer(g, id, status, rng);

  test("hand then submission go to the end of the red deck, which is reshuffled, then the pile goes to the green deck, which is reshuffled: red before green, each once", () => {
    const g = table();
    const rng = recordingRng("evict");
    const out = evict(g, rng);
    expect(rng.log).toEqual([["shuffle", g.pools.redDeck.length + 6 + 1], ["shuffle", g.pools.greenDeck.length + 2]]);
    expect(sorted(out.state.pools.redDeck)).toEqual(sorted([...g.pools.redDeck, ...player(g, 2).hand, cid(206)]));
    expect(sorted(out.state.pools.greenDeck)).toEqual(sorted([...g.pools.greenDeck, cid(8020), cid(8021)]));
  });

  test("the pre-shuffle order is the old deck, then the hand in order, then the submission card; the green deck takes the pile in order", () => {
    const g = table();
    const out = evict(g, zeros());
    expect(out.state.pools.redDeck).toEqual(zeros().shuffle([...g.pools.redDeck, ...player(g, 2).hand, cid(206)]));
    expect(out.state.pools.greenDeck).toEqual(zeros().shuffle([...g.pools.greenDeck, cid(8020), cid(8021)]));
  });

  test("status is set, hand and pile are emptied, the submission leaves the round, and no draft changes for an active player", () => {
    const out = evict(table(), recordingRng("x"), "removed");
    expect(out.state.players[2]).toMatchObject({ status: "removed", hand: [], scorePile: [] });
    expect(out.state.round?.submissions).toEqual([]);
    expect(out.draftChanges).toEqual([]);
    expect(out.events).toEqual([]); // not the judge: no JudgeChanged
  });

  test("a hand-played submission appended to the red deck still shuffles it even when the hand is empty; with nothing to release there is no draw at all", () => {
    const g = park(table(), 2, "ready"); // hand and pile released already, but the submission stays
    const bare = { ...g, players: g.players.map((p, i) => (i === 2 ? { ...p, hand: [] } : p)) };
    const rng = recordingRng("a");
    evict(bare, rng);
    expect(rng.log).toEqual([["shuffle", bare.pools.redDeck.length + 1]]);
    const idle = park(roundGame({ n: 4, judge: 1 }), 3, "ready");
    const quiet = recordingRng("b");
    const out = evict(idle, quiet, "left", pid(3));
    expect(quiet.log).toEqual([]);
    expect(out.state.pools).toEqual(idle.pools);
  });

  test("only a pile: only the green deck is reshuffled", () => {
    const base = park(roundGame({ n: 4, judge: 1 }), 2, "ready");
    const pile = base.pools.greenDeck.slice(0, 2);
    const g: Game = { ...base, players: base.players.map((p, i) => (i === 2 ? { ...p, scorePile: pile } : p)), pools: { ...base.pools, greenDeck: base.pools.greenDeck.slice(2) } };
    const rng = recordingRng("p");
    evict(g, rng);
    expect(rng.log).toEqual([["shuffle", g.pools.greenDeck.length + 2]]);
  });

  test("a write-in submission goes to redDiscard (never to the deck), the hand is released to the deck and shuffled, and an empty hand shuffles nothing (Q3)", () => {
    let g = roundGame({ n: 4, judge: 1 });
    g = addCard(g, cid(6500), "red", "redDiscard");
    g = { ...g, pools: { ...g.pools, redDiscard: [] }, round: { ...(g.round as NonNullable<Game["round"]>), submissions: [{ playerId: pid(2), cardId: cid(6500), writeIn: true }] } };
    const rng = recordingRng("w");
    const out = evict(g, rng);
    expect(rng.log).toEqual([["shuffle", g.pools.redDeck.length + 7]]);
    expect(out.state.pools.redDiscard).toEqual([cid(6500)]);
    expect(out.state.round?.submissions).toEqual([]);
    const handless = { ...g, players: g.players.map((p, i) => (i === 2 ? { ...p, hand: [] } : p)), pools: { ...g.pools, redDeck: [...g.pools.redDeck, ...player(g, 2).hand] } };
    const quiet = recordingRng("w2");
    const out2 = evict(handless, quiet);
    expect(quiet.log).toEqual([]);
    expect(out2.state.pools.redDiscard).toEqual([cid(6500)]);
  });

  test("a writer's draft is deleted (draftChanges null); a ready or active seat has no draft to delete (Q7)", () => {
    const g = gameWithDeck(4, 0, 0, { phase: "WRITING", target: 8, writeCounts: { red: 10, green: 8 } });
    const w = evict(g, recordingRng("d"), "left", pid(1));
    expect(w.draftChanges).toEqual([{ playerId: pid(1), draft: null }]);
    const ready = { ...g, players: g.players.map((p, i) => (i === 1 ? { ...p, status: "ready" as const } : p)) };
    expect(evict(ready, recordingRng("d"), "left", pid(1)).draftChanges).toEqual([]);
  });

  test("evictPlayer does not mutate its input", () => {
    const g = table();
    const before = structuredClone(g);
    evict(deepFreeze(g), recordingRng("m"));
    expect(g).toEqual(before);
  });
});

describe("V5 leave and removePlayer mid-game: the scenarios of E17 (8.5)", () => {
  test("the judge leaves in SUBMITTING: the next judge takes over, their hand-played card returns to their hand, JudgeChanged left, a new episode", () => {
    const g = roundGame({ judge: 1, submitted: [2] });
    const v = accepted(g, { type: "leave" }, seat(1));
    expect(types(v.events)).toEqual(["PlayerLeft", "JudgeChanged"]);
    expect(v.events[1]).toEqual({ t: "JudgeChanged", round: 1, from: pid(1), to: pid(2), reason: "left" });
    expect(v.state.round).toMatchObject({ judgeId: pid(2), judgeReassigned: true, submissions: [], phase: "SUBMITTING", changedAtVersion: 10, revealOrder: null });
    expect(v.state.judgeCursor).toBe(2);
    expect(player(v.state, 2).hand).toEqual([cid(200), cid(201), cid(202), cid(203), cid(204), cid(205), cid(206)]);
    expect(player(v.state, 1)).toMatchObject({ status: "left", hand: [] });
    expect(v.state.waitingOn).toEqual([pid(0), pid(3)]);
    expect(v.state.paused).toBe(false);
    expect(v.state.episodeGen).toBe(1);
    expect(v.state.version).toBe(10);
  });

  test("the judge is removed in JUDGING: the next judge's own card leaves submissions and revealOrder (the rest keep their order) and the round stays JUDGING", () => {
    const g = roundGame({ judge: 1, submitted: [2, 3], phase: "JUDGING" });
    expect(g.round?.revealOrder).toEqual([cid(306), cid(206)]);
    const v = accepted(g, { type: "removePlayer", playerId: pid(1) });
    expect(v.events).toEqual([{ t: "PlayerRemoved", playerId: pid(1) }, { t: "JudgeChanged", round: 1, from: pid(1), to: pid(2), reason: "removed" }]);
    expect(v.state.round).toMatchObject({ judgeId: pid(2), phase: "JUDGING", revealOrder: [cid(306)], submissions: [{ playerId: pid(3), cardId: cid(306) }] });
    expect(player(v.state, 2).hand).toHaveLength(7);
    expect(v.state.waitingOn).toEqual([pid(2)]);
  });

  test("a submitter with an unrevealed submission leaves: the card and the hand go back to the red deck, the round carries on and changedAtVersion is not bumped", () => {
    const g = roundGame({ judge: 1, submitted: [2] });
    const v = accepted(g, { type: "leave" }, seat(2));
    expect(v.events).toEqual([{ t: "PlayerLeft", playerId: pid(2) }]);
    expect(v.state.round).toMatchObject({ judgeId: pid(1), submissions: [], changedAtVersion: 5, phase: "SUBMITTING" });
    expect(sorted(v.state.pools.redDeck)).toEqual(sorted([...g.pools.redDeck, ...player(g, 2).hand, cid(206)]));
    expect(v.state.waitingOn).toEqual([pid(0), pid(3)]);
  });

  test("a revealed submitter leaves in JUDGING: their card leaves submissions and revealOrder, and changedAtVersion is not bumped (Q6)", () => {
    const g = roundGame({ judge: 1, submitted: [2, 3], phase: "JUDGING" });
    const v = accepted(g, { type: "leave" }, seat(2));
    expect(v.state.round).toMatchObject({ phase: "JUDGING", revealOrder: [cid(306)], submissions: [{ playerId: pid(3), cardId: cid(306) }], changedAtVersion: 5 });
    expect(v.events).toEqual([{ t: "PlayerLeft", playerId: pid(2) }]);
  });

  test("the only revealed submitter leaves: the round is voided, its green card goes to the bottom of the deck, and the judge rotates because nothing was reassigned", () => {
    const g = roundGame({ judge: 1, submitted: [2], phase: "JUDGING" });
    const v = accepted(g, { type: "leave" }, seat(2));
    expect(types(v.events)).toEqual(["PlayerLeft", "RoundVoided", "RoundOpened"]);
    expect(v.events[1]).toEqual({ t: "RoundVoided", round: 1, reason: "no_submissions" });
    expect(v.events[2]).toMatchObject({ t: "RoundOpened", round: 1, judgeId: pid(3), greenCardId: g.pools.greenDeck[0] });
    expect(v.state.pools.greenDeck.at(-1)).toBe(cid(900));
    expect(v.state.round).toMatchObject({ judgeId: pid(3), judgeReassigned: false, phase: "SUBMITTING", submissions: [] });
  });

  test("a player with a score pile leaves: the pile returns to the green deck, the points leave with them (U2)", () => {
    const g = roundGame({ judge: 1, scores: [0, 0, 2, 0] });
    const v = accepted(g, { type: "removePlayer", playerId: pid(2) });
    expect(player(v.state, 2).scorePile).toEqual([]);
    expect(sorted(v.state.pools.greenDeck)).toEqual(sorted([...g.pools.greenDeck, cid(8020), cid(8021)]));
  });

  test("the last unfinished writer leaves WRITING: their draft is deleted and play begins in the same command", () => {
    const g = buildGame({ n: 4, phase: "WRITING", ready: [true, true, true, false], handSize: 0, judge: 0, submitted: [], paused: false });
    const v = accepted(g, { type: "removePlayer", playerId: pid(3) });
    expect(v.draftChanges).toEqual([{ playerId: pid(3), draft: null }]);
    expect(types(v.events)).toEqual(["PlayerRemoved", "PlayStarted", "PlayerActivated", "PlayerActivated", "PlayerActivated", "RoundOpened"]);
    expect(v.state).toMatchObject({ phase: "PLAYING", paused: false });
  });

  test("the second-to-last active player leaves: the game pauses (PausedChanged true), the judge stays", () => {
    const g = roundGame({ n: 3, judge: 0 });
    const v = accepted(g, { type: "leave" }, seat(2));
    expect(v.events).toEqual([{ t: "PlayerLeft", playerId: pid(2) }, { t: "PausedChanged", paused: true }]);
    expect(v.state).toMatchObject({ paused: true, round: { judgeId: pid(0) } });
    expect(v.state.episode).toBeNull();
  });

  test("the judge is the last active player and leaves while paused: judgeId is null, no JudgeChanged, changedAtVersion is bumped, the cursor is kept", () => {
    let g = roundGame({ n: 4, judge: 0 });
    g = park(park(park(g, 1, "ready"), 2, "ready"), 3, "left");
    g = { ...g, paused: true, round: { ...(g.round as NonNullable<Game["round"]>), roster: [pid(0)] } };
    const v = accepted(g, { type: "leave" }, host);
    expect(v.events).toEqual([{ t: "PlayerLeft", playerId: pid(0) }]);
    expect(v.state.round).toMatchObject({ judgeId: null, changedAtVersion: 10, judgeReassigned: false });
    expect(v.state.judgeCursor).toBe(0);
    expect(v.state.paused).toBe(true);
    expect(v.state.waitingOn).toEqual([]);
  });

  test("the host removes their own seat: the seat is gone, the host's powers rest on hostId", () => {
    const g = roundGame({ judge: 1 });
    const v = accepted(g, { type: "removePlayer", playerId: pid(0) });
    expect(player(v.state, 0).status).toBe("removed");
    expect(v.state.hostId).toBe(HOST_UID);
    expect(accepted(v.state, { type: "endGame" }).state.phase).toBe("ENDED");
  });

  test("leave and removePlayer are rejected for a seat that is gone or not seated", () => {
    const g = roundGame({ judge: 1 });
    const left = accepted(g, { type: "leave" }, seat(3)).state;
    expect(rejected(left, { type: "leave" }, seat(3))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(left, { type: "removePlayer", playerId: pid(3) })).toStrictEqual({ code: "NOT_FOUND" });
  });

  test("in LOBBY the record is deleted instead of evicted, as before", () => {
    const lobby = makeGame({ players: [0, 1, 2].map((i) => makePlayer(i)) });
    const v = accepted(lobby, { type: "leave" }, seat(1));
    expect(v.state.players.map((p) => p.id)).toEqual([pid(0), pid(2)]);
    expect(v.events).toEqual([{ t: "PlayerLeft", playerId: pid(1) }]);
  });
});

describe("review: a departed id cannot come back mid-game", () => {
  test("leave, rejoin attempt with the same playerId (INVALID_ARGUMENT, no second record), then the live seat's second leave still works for others", () => {
    const g = roundGame({ judge: 1, extra: { writeCounts: { red: 10, green: 8 } } });
    const left = accepted(g, { type: "leave" }, seat(3)).state;
    expect(rejected(left, { type: "join", playerId: pid(3), name: "Back Again" }, seat(3))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    const removed = accepted(g, { type: "removePlayer", playerId: pid(3) }).state;
    expect(rejected(removed, { type: "join", playerId: pid(3), name: "Back Again" }, seat(3))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(left.players.filter((p) => p.id === pid(3))).toHaveLength(1);
  });

  test("evictPlayer looks up a seated record only: a departed id is an invariant error and never rewrites the stale record", () => {
    const g = park(roundGame({ judge: 1 }), 3, "left");
    expect(() => membership.evictPlayer(g, pid(3), "removed", recordingRng("s"))).toThrow(/no seated player/);
    const dup: Game = { ...g, players: [...g.players, { ...player(g, 3), status: "active", hand: [cid(1)] }] };
    const out = membership.evictPlayer(dup, pid(3), "left", recordingRng("s"));
    expect(out.state.players[3]?.status).toBe("left");
    expect(out.state.players[4]).toMatchObject({ status: "left", hand: [] });
  });

  test("the judge is evicted and two actives remain (paused): the next judge is still picked, with JudgeChanged, as LLD 8.3 says (null only with no candidate)", () => {
    const g = roundGame({ n: 3, judge: 0 });
    const v = accepted(g, { type: "leave" }, host);
    expect(v.state.paused).toBe(true);
    expect(v.events.map((e) => e.t)).toEqual(["PlayerLeft", "JudgeChanged", "PausedChanged"]);
    expect(v.state.round?.judgeId).toBe(pid(1));
  });
});
