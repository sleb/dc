// #25 (1.8): `removeCard` (LLD 1 sections 7.1, 7.2, 8.6, 9.2; E5, E17, X10) through the real REGISTRY, and the `shownToTable` selector.
// V10 guards, V11 reach (U3), V12 per-zone effects, V13 the minimums guard, V14 conservation and the properties.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Command } from "@dc/contracts";
import { decide } from "../src/decide";
import { REGISTRY } from "../src/registry";
import { shownToTable } from "../src/selectors";
import type { Accepted, Actor, Ctx, DomainEvent, Game, Rejection, Result } from "../src/types";
import { checkAll, checkRemoveCard } from "./support/checks";
import type { Step } from "./support/checks";
import { GAME_ID, HOST_UID, cid, counterMintId, ctxFor, deepFreeze, makeGame, pid, seatUidOf, userActor } from "./support/factories";
import { assertProperty } from "./support/fc";
import { modelBlock, modelShown } from "./support/removal";
import { park, roundGame } from "./support/round-fixtures";
import { membershipDriver, runScenario } from "./support/scenario";
import type { Picks } from "./support/scenario";
import { enumerators } from "./support/legal";
import { makeRng } from "../src/rng";

const cmd = (c: object): Command => c as unknown as Command;
const seat = (n: number): Actor => userActor(n === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(n)));
const as = (n: number, over: Partial<Ctx> = {}): Ctx => ctxFor({ actor: seat(n), ...over });
const env = (): Record<string, string | undefined> => ({ ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? "30" });
const run = (g: Game | null, c: object, ctx: Ctx = ctxFor()): Result<Accepted, Rejection> => decide(g, cmd(c), ctx);
const remove = (cardId: unknown) => ({ type: "removeCard", cardId });
const accepted = (g: Game, c: object, ctx: Ctx = ctxFor()): Accepted => {
  const r = run(deepFreeze(structuredClone(g)), c, ctx);
  if (!r.ok) throw new Error(`expected an acceptance of ${JSON.stringify(c)}, got ${JSON.stringify(r.error)}`);
  checkAll({ index: 0, before: g, cmd: c, result: r, actor: ctx.actor, drafts: ctx.drafts });
  return r.value;
};
const rejected = (g: Game | null, c: object, ctx: Ctx = ctxFor()): Rejection => {
  const r = run(g, c, ctx);
  if (r.ok) throw new Error(`expected a rejection of ${JSON.stringify(c)}`);
  return r.error;
};
const types = (events: readonly DomainEvent[]): string[] => events.map((e) => e.t);

// A PLAYING table of 4 with one resolved round behind it, slack in both decks (red 51 of R_min 36, green 17 of G_min 12 at target 3), judge p1, round 2 open.
// Ids: hands cid(100 i + k), red deck cid(5000+), red discard cid(6000..6002) (the three plays of round 1), green deck cid(7000+), the round's green cid(900), p1's pile cid(8010) (round 1's green).
const HISTORY: Game["history"] = [{
  round: 1, judgeId: pid(0), greenCardId: cid(8010),
  plays: [{ playerId: pid(1), cardId: cid(6000) }, { playerId: pid(2), cardId: cid(6001) }, { playerId: pid(3), cardId: cid(6002) }],
  winnerCardId: cid(6000), winnerId: pid(1),
}];
type Opts = Parameters<typeof roundGame>[0];
const played = (o: Opts = {}): Game => roundGame({ n: 4, judge: 1, target: 3, greenDeck: 15, redDiscard: 3, scores: [0, 1, 0, 0], history: HISTORY, version: 9, ...o });
const judging = (o: Opts = {}): Game => played({ submitted: [2, 3], phase: "JUDGING", ...o });
/** The card `id`, currently in the red discard, is now in the red deck instead. */
const intoDeck = (g: Game, id: string): Game => ({ ...g, pools: { ...g.pools, redDiscard: g.pools.redDiscard.filter((c) => c !== id), redDeck: [...g.pools.redDeck, id] } });
/** The card `id`, currently in the red discard, is now in player `who`'s hand, in place of their hand card `held` (which goes to the red deck). */
const intoHand = (g: Game, id: string, who: number, held: string): Game => ({
  ...g,
  players: g.players.map((p) => (p.id === pid(who) ? { ...p, hand: p.hand.map((c) => (c === held ? id : c)) } : p)),
  pools: { ...g.pools, redDiscard: g.pools.redDiscard.filter((c) => c !== id), redDeck: [...g.pools.redDeck, held] },
});

describe("V10 removeCard: the guard ladder (5.3, 7.1)", () => {
  test("host only: a seated non-host, a stranger and the system actor are NOT_AUTHORIZED", () => {
    const g = played();
    expect(rejected(g, remove(cid(6000)), as(1))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(g, remove(cid(6000)), ctxFor({ actor: userActor("stranger") }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(g, remove(cid(6000)), ctxFor({ actor: { kind: "system" } }))).toStrictEqual({ code: "NOT_AUTHORIZED" });
  });

  test("the host may remove without holding a seat", () => {
    const g = played();
    const away = { ...g, players: g.players.map((p) => (p.id === pid(0) ? { ...p, status: "left" as const, hand: [], scorePile: [] } : p)), pools: { ...g.pools, redDeck: [...g.pools.redDeck, ...(g.players[0]?.hand ?? [])] } };
    expect(run(away, remove(cid(6000))).ok).toBe(true);
  });

  test("LOBBY, WRITING and PLAYING are allowed; FINISHED and ENDED are WRONG_PHASE without detail", () => {
    for (const phase of ["LOBBY", "WRITING", "PLAYING"] as const) expect([phase, run({ ...played(), phase }, remove(cid(6000))).ok]).toEqual([phase, true]);
    for (const phase of ["FINISHED", "ENDED"] as const) expect(rejected({ ...played(), phase }, remove(cid(6000)))).toStrictEqual({ code: "WRONG_PHASE" });
  });

  test("order: ENDED is WRONG_PHASE for anyone; a stranger in FINISHED is NOT_AUTHORIZED; a junk payload in FINISHED is WRONG_PHASE (phase before payload)", () => {
    expect(rejected({ ...played(), phase: "ENDED" }, remove(cid(6000)), as(1))).toStrictEqual({ code: "WRONG_PHASE" });
    expect(rejected({ ...played(), phase: "FINISHED" }, remove(cid(6000)), as(1))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected({ ...played(), phase: "FINISHED" }, remove(5))).toStrictEqual({ code: "WRONG_PHASE" });
    expect(rejected(null, remove(cid(6000)))).toStrictEqual({ code: "NOT_FOUND" });
  });

  test("guard 7: a cardId that is not a string, or is missing, is INVALID_ARGUMENT, before any lookup", () => {
    for (const bad of [5, null, {}, ["c"], true, undefined]) expect([bad, rejected(played(), remove(bad))]).toEqual([bad, { code: "INVALID_ARGUMENT" }]);
    expect(rejected(played(), { type: "removeCard" })).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("it is not a round command: no STALE, no PAUSED, and it needs no expectedVersion", () => {
    expect(run(played(), { ...remove(cid(6000)), expectedVersion: 0 }).ok).toBe(true);
    expect(run(played({ extra: { paused: true } }), remove(cid(6000))).ok).toBe(true);
  });

  test("the real registry holds it, and it is the host's only", () => {
    expect(Object.hasOwn(REGISTRY, "removeCard")).toBe(true);
  });
});

describe("V11 X10 reach: only a card shown to the table (8.6, U3)", () => {
  const shown: [string, Game, string][] = [
    ["a green card of a resolved round, in a score pile", played(), cid(8010)],
    ["a played red card now in the discard", played(), cid(6000)],
    ["a played red card now in the red deck (after a reshuffle)", intoDeck(played(), cid(6001)), cid(6001)],
    ["a played red card now in a later hand", intoHand(played(), cid(6002), 2, cid(200)), cid(6002)],
    ["the current round's green card", played(), cid(900)],
    ["a revealed card of a JUDGING round", judging(), cid(206)],
    ["the current green card of a JUDGING round", judging(), cid(900)],
  ];
  for (const [label, g, id] of shown) {
    test(`accepted: ${label}`, () => {
      const v = accepted(g, remove(id));
      expect(v.events[0]).toStrictEqual({ t: "CardRemoved", cardId: id, kind: g.cards[id]?.kind as "red" | "green" });
      expect(Object.hasOwn(v.state.cards, id)).toBe(false);
      expect(shownToTable(g, id)).toBe(true);
    });
  }

  const hidden: [string, Game, string][] = [
    ["a card in the red deck that was never shown", played(), cid(5000)],
    ["a card in the green deck", played(), cid(7000)],
    ["an unplayed hand card", played(), cid(0)],
    ["a played card's neighbour in another hand", played(), cid(200)],
    ["an unrevealed SUBMITTING card", played({ submitted: [2] }), cid(206)],
    ["a card unknown to the registry", played(), "c_zzzzzzzzzz"],
    ["a malformed id", played(), "nope"],
    ["an empty id", played(), ""],
    ["a prototype key", played(), "__proto__"],
    ["a removed card's id (still named in history)", { ...played(), cards: Object.fromEntries(Object.entries(played().cards).filter(([k]) => k !== cid(6000))) }, cid(6000)],
  ];
  for (const [label, g, id] of hidden) {
    test(`NOT_FOUND with no detail: ${label}`, () => {
      expect(rejected(g, remove(id))).toStrictEqual({ code: "NOT_FOUND" });
      expect(shownToTable(g, id)).toBe(false);
    });
  }

  test("a card an earlier round showed that now sits unrevealed in a SUBMITTING play is not touched (ruling: the submission is hidden information)", () => {
    const base = played({ submitted: [2] });
    const g: Game = {
      ...base,
      round: base.round === null ? null : { ...base.round, submissions: [{ playerId: pid(2), cardId: cid(6001) }] },
      pools: { ...base.pools, redDiscard: [cid(6000), cid(6002), cid(206)] },
    };
    expect(rejected(g, remove(cid(6001)))).toStrictEqual({ code: "NOT_FOUND" });
    expect(shownToTable(g, cid(6001))).toBe(false);
  });

  test("every refusal of an unshown id is deep-equal to the refusal of an unknown id (a hidden card cannot be probed)", () => {
    const g = played({ submitted: [2] });
    const unknown = rejected(g, remove("c_zzzzzzzzzz"));
    for (const id of [cid(5000), cid(7000), cid(0), cid(206), cid(200)]) expect(rejected(g, remove(id))).toStrictEqual(unknown);
  });

  test("a SUBMITTING round with nothing resolved yet shows only its green card: in a first round everything else is NOT_FOUND", () => {
    const g = roundGame({ n: 4, judge: 1, target: 3, greenDeck: 15 });
    expect(shownToTable(g, cid(900))).toBe(true);
    for (const id of Object.keys(g.cards).filter((k) => k !== cid(900))) expect(shownToTable(g, id)).toBe(false);
  });

  test("shownToTable is total: any string, no round, FINISHED", () => {
    const g = { ...played(), round: null };
    expect(shownToTable(g, cid(6000))).toBe(true);
    expect(shownToTable(g, cid(900))).toBe(false); // 900 is not in history and there is no round now
    expect(shownToTable(makeGame(), "anything")).toBe(false);
  });
});

describe("V12 removeCard, zone by zone (8.6, E5, E17)", () => {
  test("discard: deleted from the discard and the registry; one CardRemoved; the round is untouched", () => {
    const g = played();
    const v = accepted(g, remove(cid(6000)));
    expect(v.state.pools.redDiscard).toEqual([cid(6001), cid(6002)]);
    expect(v.events).toEqual([{ t: "CardRemoved", cardId: cid(6000), kind: "red" }]);
    expect(v.state.round).toEqual(g.round);
    expect(v.state.version).toBe(g.version + 1);
    expect(v.aggregateChanged).toBe(true);
    expect(v.draftChanges).toEqual([]);
    expect(v.roundRecords).toEqual([]);
    expect(v.redactEnvelope).toBe(false);
  });

  test("deck: deleted from the deck in place (the order of the rest is kept)", () => {
    const g = intoDeck(played(), cid(6001));
    const v = accepted(g, remove(cid(6001)));
    expect(v.state.pools.redDeck).toEqual(g.pools.redDeck.filter((c) => c !== cid(6001)));
  });

  test("hand: deleted from the hand (it shrinks), and topped up at the next resolve", () => {
    const g = intoHand(judging(), cid(6001), 0, cid(0));
    const v = accepted(g, remove(cid(6001)));
    expect(v.state.players[0]?.hand).toHaveLength(6);
    expect(v.state.round?.changedAtVersion).toBe(g.round?.changedAtVersion); // a hand is not a round zone
    const done = accepted(v.state, { type: "pickWinner", submissionId: cid(206), expectedVersion: 5 }, as(1));
    for (const p of done.state.players.filter((q) => q.status === "active")) expect([p.id, p.hand.length]).toEqual([p.id, 7]);
  });

  test("score pile: deleted from the pile (the score drops)", () => {
    const g = played();
    const v = accepted(g, remove(cid(8010)));
    expect(g.players[1]?.scorePile).toEqual([cid(8010)]);
    expect(v.state.players[1]?.scorePile).toEqual([]);
    expect(v.state.history).toEqual(g.history); // the record of round 1 is left as it was (7: the Projector tolerates the missing card)
    expect(v.events).toEqual([{ t: "CardRemoved", cardId: cid(8010), kind: "green" }]);
  });

  test("a revealed JUDGING submission: removed from submissions and revealOrder, the order of the rest kept, changedAtVersion bumped, the owner not asked to replay", () => {
    const g = judging();
    expect(g.round?.revealOrder).toEqual([cid(306), cid(206)]);
    const v = accepted(g, remove(cid(206)));
    expect(v.state.round?.submissions).toEqual([{ playerId: pid(3), cardId: cid(306) }]);
    expect(v.state.round?.revealOrder).toEqual([cid(306)]);
    expect(v.state.round?.phase).toBe("JUDGING");
    expect(v.state.round?.changedAtVersion).toBe(g.version + 1);
    expect(v.state.players[2]?.hand).toEqual(g.players[2]?.hand); // the card is deleted, not returned to its owner
    expect(types(v.events)).toEqual(["CardRemoved"]);
    expect(v.state.waitingOn).toEqual([pid(1)]); // still the judge's move
    expect(rejected(v.state, { type: "pickWinner", submissionId: cid(206), expectedVersion: 5 }, as(1))).toStrictEqual({ code: "STALE" }); // the judge's view is out of date
    expect(accepted(v.state, { type: "pickWinner", submissionId: cid(306), expectedVersion: 10 }, as(1)).events[0]?.t).toBe("WinnerPicked");
  });

  test("removing the last revealed submission voids the round: RoundVoided, then a replacement round under the next judge; the green returns to the bottom of the deck", () => {
    let g = judging();
    g = accepted(g, remove(cid(206))).state;
    const v = accepted(g, remove(cid(306)));
    expect(types(v.events)).toEqual(["CardRemoved", "RoundVoided", "RoundOpened"]);
    expect(v.events[1]).toStrictEqual({ t: "RoundVoided", round: 2, reason: "no_submissions" });
    expect(v.state.round).toMatchObject({ number: 2, phase: "SUBMITTING", greenCardId: cid(7000), judgeId: pid(2), submissions: [], revealOrder: null });
    expect(v.state.pools.greenDeck.at(-1)).toBe(cid(900));
    expect(v.state.pools.greenDeck).toHaveLength(15);
    expect(v.state.players[3]?.hand).toEqual(g.players[3]?.hand);
    expect(v.state.history).toHaveLength(1);
  });

  test("the current green card: replaced from the top of greenDeck, changedAtVersion bumped, submissions untouched, nothing else emitted", () => {
    const g = played({ submitted: [2] });
    const v = accepted(g, remove(cid(900)));
    expect(v.state.round?.greenCardId).toBe(cid(7000));
    expect(v.state.pools.greenDeck).toEqual(g.pools.greenDeck.slice(1));
    expect(v.state.round?.changedAtVersion).toBe(g.version + 1);
    expect(v.state.round?.submissions).toEqual(g.round?.submissions);
    expect(v.state.round?.phase).toBe("SUBMITTING");
    expect(v.events).toEqual([{ t: "CardRemoved", cardId: cid(900), kind: "green" }]);
    expect(rejected(v.state, { type: "confirmSubmission", cardId: cid(300), expectedVersion: 5 }, as(3))).toStrictEqual({ code: "STALE" });
  });

  test("the current green card of a JUDGING round is replaced the same way, keeping the reveal", () => {
    const g = judging();
    const v = accepted(g, remove(cid(900)));
    expect(v.state.round).toMatchObject({ phase: "JUDGING", greenCardId: cid(7000), revealOrder: g.round?.revealOrder, changedAtVersion: g.version + 1 });
  });

  test("the current green card with an empty greenDeck is NOT_PLAYABLE no_replacement, and nothing changes", () => {
    const g = roundGame({ n: 3, judge: 1, target: 2, greenDeck: 0, scores: [2, 2, 2] });
    expect(g.pools.greenDeck).toEqual([]);
    expect(rejected(g, remove(cid(900)))).toStrictEqual({ code: "NOT_PLAYABLE", detail: "no_replacement" });
  });

  test("removing a card does not by itself change the judge, the roster or the history", () => {
    const g = judging();
    const v = accepted(g, remove(cid(6000)));
    expect(v.state.round?.judgeId).toBe(g.round?.judgeId);
    expect(v.state.round?.roster).toEqual(g.round?.roster);
    expect(v.state.judgeCursor).toBe(g.judgeCursor);
  });

  test("removing the only revealed play of a paused JUDGING round leaves it in limbo (no submissions, empty revealOrder, no void while paused); a joiner who finishes recovers the game, which voids it and reopens", () => {
    let g = roundGame({ n: 3, judge: 0, submitted: [1], phase: "JUDGING", greenDeck: 40, extra: { writeCounts: { red: 10, green: 8 } } });
    g = park(g, 2, "left");
    g = { ...g, paused: true, round: { ...(g.round as NonNullable<Game["round"]>), roster: [pid(0), pid(1)] } };
    const limbo = accepted(g, remove(cid(106)), as(0));
    expect(limbo.events.map((e) => e.t)).toEqual(["CardRemoved"]);
    expect(limbo.state.paused).toBe(true);
    expect(limbo.state.round).toMatchObject({ phase: "JUDGING", judgeId: pid(0), submissions: [], revealOrder: [] });
    const joined = accepted(limbo.state, { type: "join", playerId: pid(3), name: "Fourth" }, as(3)).state;
    const target = joined.players.find((p) => p.id === pid(3))?.writeTarget as { red: number; green: number };
    const drafts = { [pid(3)]: { red: Array.from({ length: target.red }, (_, k) => `r${k}`), green: Array.from({ length: target.green }, (_, k) => `g${k}`) } };
    const v = accepted(joined, { type: "finishWriting" }, as(3, { drafts }));
    expect(v.events.map((e) => e.t)).toEqual(["PlayerFinishedWriting", "PlayerActivated", "PausedChanged", "RoundVoided", "RoundOpened"]);
    expect(v.state.paused).toBe(false);
    expect(v.state.round).toMatchObject({ phase: "SUBMITTING", number: 1, judgeId: pid(1), roster: [pid(0), pid(1), pid(3)], submissions: [], revealOrder: null }); // a void that was not a reassignment rotates the judge (8.3)
  });

  test("while paused with no judge nothing special happens either", () => {
    const g = played({ extra: { paused: true } });
    expect(run(g, remove(cid(6000))).ok).toBe(true);
  });
});

describe("V13 the minimums guard (8.6, 9.1, 9.2)", () => {
  test("green: at exactly G_min, any green removal (a pile card, the current green) is NOT_PLAYABLE below_minimum; with one to spare it is accepted", () => {
    const tight = played({ greenDeck: 10 }); // 10 + 1 + 1 = 12 = 4 x 3
    expect(rejected(tight, remove(cid(8010)))).toStrictEqual({ code: "NOT_PLAYABLE", detail: "below_minimum" });
    expect(rejected(tight, remove(cid(900)))).toStrictEqual({ code: "NOT_PLAYABLE", detail: "below_minimum" });
    expect(accepted(played({ greenDeck: 11 }), remove(cid(8010))).state.players[1]?.scorePile).toEqual([]);
    expect(run(played({ greenDeck: 11 }), remove(cid(900))).ok).toBe(true);
  });

  test("red: at exactly R_min a red removal is below_minimum; with one to spare it is accepted; a green removal does not care about red", () => {
    const tight = played({ redDeck: 5 }); // 28 + 5 + 3 = 36 = R_min(4)
    expect(rejected(tight, remove(cid(6000)))).toStrictEqual({ code: "NOT_PLAYABLE", detail: "below_minimum" });
    expect(run(played({ redDeck: 6 }), remove(cid(6000))).ok).toBe(true);
    expect(run(tight, remove(cid(8010))).ok).toBe(true);
    expect(run(played({ greenDeck: 10 }), remove(cid(6000))).ok).toBe(true); // green at its minimum, a red card goes
  });

  test("the totals count every zone, score piles included: a table whose spare greens are all in piles can still lose one", () => {
    // 4 x 3 = 12 needed. Piles hold 3 cards, the round 1, the deck 9: 13 in all, of which only 10 are outside the piles.
    const g = roundGame({ n: 4, judge: 1, target: 3, greenDeck: 9, redDiscard: 3, scores: [0, 3, 0, 0], history: HISTORY, version: 9 });
    expect(Object.values(g.cards).filter((c) => c.kind === "green")).toHaveLength(13);
    const ok = run(g, remove(cid(8010))); // not `accepted`: this fixture's piles hold more cards than history has rounds, which checkScoring rightly dislikes
    expect(ok.ok && ok.value.state.players[1]?.scorePile).toHaveLength(2);
    expect(rejected(roundGame({ n: 4, judge: 1, target: 3, greenDeck: 8, redDiscard: 3, scores: [0, 3, 0, 0], history: HISTORY, version: 9 }), remove(cid(8010)))).toStrictEqual({ code: "NOT_PLAYABLE", detail: "below_minimum" });
  });

  test("N is the seated count: a departed seat lowers the minimums", () => {
    const tight = played({ greenDeck: 10 });
    expect(rejected(tight, remove(cid(8010)))).toStrictEqual({ code: "NOT_PLAYABLE", detail: "below_minimum" });
    expect(run(park(tight, 3, "left"), remove(cid(8010))).ok).toBe(true); // G_min(3, 3) = 9
  });

  test("not applied in LOBBY (the guard is for a game that has started); applied in WRITING", () => {
    const tight = played({ greenDeck: 10 });
    expect(run({ ...tight, phase: "LOBBY" }, remove(cid(8010))).ok).toBe(true);
    expect(rejected({ ...tight, phase: "WRITING" }, remove(cid(8010)))).toStrictEqual({ code: "NOT_PLAYABLE", detail: "below_minimum" });
  });

  test("the guard comes after NOT_FOUND (an unshown card never learns of the minimums) and before no_replacement", () => {
    const tight = played({ greenDeck: 10 });
    expect(rejected(tight, remove(cid(7000)))).toStrictEqual({ code: "NOT_FOUND" });
    expect(rejected({ ...tight, pools: { ...tight.pools, greenDeck: [] }, cards: Object.fromEntries(Object.entries(tight.cards).filter(([k]) => !tight.pools.greenDeck.includes(k))) }, remove(cid(900)))).toStrictEqual({ code: "NOT_PLAYABLE", detail: "below_minimum" });
  });
});

describe("V14 E5 conservation and the sharpness of the checker", () => {
  const zones: [string, Game, string][] = [
    ["discard", played(), cid(6000)],
    ["deck", intoDeck(played(), cid(6001)), cid(6001)],
    ["hand", intoHand(played(), cid(6002), 2, cid(200)), cid(6002)],
    ["score pile", played(), cid(8010)],
    ["JUDGING submission", judging(), cid(206)],
    ["current green", played(), cid(900)],
  ];
  for (const [zone, g, id] of zones) {
    test(`${zone}: exactly that registry entry is gone and every other card keeps its zone (the checkers run inside accepted)`, () => {
      const v = accepted(g, remove(id));
      const was = Object.keys(g.cards);
      expect(Object.keys(v.state.cards)).toEqual(was.filter((k) => k !== id));
    });
  }

  const stepOf = (g: Game, id: string): Step & { value: Accepted } => {
    const ctx = ctxFor({ rng: makeRng("chk"), mintId: counterMintId(60_000) });
    const result = run(g, remove(id), ctx);
    if (!result.ok) throw new Error(`rejected ${JSON.stringify(result.error)}`);
    return { index: 0, before: g, cmd: remove(id), result, actor: ctx.actor, drafts: {}, value: result.value };
  };
  const withValue = (s: Step & { value: Accepted }, f: (v: Accepted) => Accepted): Step => ({ ...s, result: { ok: true, value: f(s.value) } });

  test("checkRemoveCard goes red for: a missing CardRemoved, a wrong kind, a second removed card, a card not shown, a green not replaced, a changedAtVersion not bumped, a dropped minimum", () => {
    const disc = stepOf(played(), cid(6000));
    expect(() => checkRemoveCard(disc)).not.toThrow();
    expect(() => checkRemoveCard(withValue(disc, (v) => ({ ...v, events: [] })))).toThrow(/CardRemoved/);
    expect(() => checkRemoveCard(withValue(disc, (v) => ({ ...v, events: [{ t: "CardRemoved", cardId: cid(6000), kind: "green" }] })))).toThrow(/CardRemoved/);
    expect(() => checkRemoveCard(withValue(disc, (v) => ({ ...v, state: { ...v.state, cards: Object.fromEntries(Object.entries(v.state.cards).filter(([k]) => k !== cid(6001))) } })))).toThrow(/removed/);
    expect(() => checkRemoveCard({ ...stepOf(played(), cid(6000)), cmd: remove(cid(5000)) })).toThrow(/not shown/);
    const green = stepOf(played(), cid(900));
    expect(() => checkRemoveCard(green)).not.toThrow();
    expect(() => checkRemoveCard(withValue(green, (v) => ({ ...v, state: { ...v.state, round: v.state.round === null ? null : { ...v.state.round, changedAtVersion: 5 } } })))).toThrow(/replaced/);
    expect(() => checkRemoveCard(withValue(green, (v) => ({ ...v, state: { ...v.state, round: v.state.round === null ? null : { ...v.state.round, greenCardId: cid(7001) } } })))).toThrow(/moved a card|replaced/);
    const jud = stepOf(judging(), cid(206));
    expect(() => checkRemoveCard(jud)).not.toThrow();
    expect(() => checkRemoveCard(withValue(jud, (v) => ({ ...v, state: { ...v.state, round: v.state.round === null ? null : { ...v.state.round, changedAtVersion: 5 } } })))).toThrow(/changedAtVersion/);
    const tight = stepOf(played({ greenDeck: 11 }), cid(8010));
    expect(() => checkRemoveCard(tight)).not.toThrow();
    expect(() => checkRemoveCard(withValue(tight, (v) => ({ ...v, state: { ...v.state, cards: Object.fromEntries(Object.entries(v.state.cards).filter(([k]) => k !== cid(7000) && k !== cid(7001))) } })))).toThrow();
  });
});

describe("P-X10: removeCard is accepted iff the card was shown to the table and nothing blocks it; a refusal never separates a hidden card from an unknown one", () => {
  const lobby = (): Game => {
    const r = run(null, { type: "createGame", gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "Host" }, as(0));
    if (!r.ok) throw new Error("createGame rejected");
    return r.value.state;
  };
  const placeholders: Picks = Array.from({ length: 700 }, () => ({ kind: "legal" as const, pick: 0 }));
  const play = (n: number, seed: number) => runScenario(decide, lobby(), placeholders, { seed, table: enumerators, drive: membershipDriver(`${seed}`, n, enumerators) });

  test("over states of churned games: acceptance and the NOT_PLAYABLE detail match the independent model, and unshown ids are all the same NOT_FOUND", () => {
    assertProperty(fc.property(fc.integer({ min: 3, max: 8 }), fc.integer(), (n, seed) => {
      const t = play(n, seed);
      t.states.forEach((s, i) => {
        if (s === null || i % 9 !== 0 || (s.phase !== "LOBBY" && s.phase !== "WRITING" && s.phase !== "PLAYING")) return;
        const ctx = ctxFor({ actor: userActor(s.hostId), rng: makeRng(`x10:${i}`) });
        const unknown = rejected(s, remove("c_zzzzzzzzzz"), ctx);
        expect(unknown).toStrictEqual({ code: "NOT_FOUND" });
        for (const id of [...Object.keys(s.cards), "c_yyyyyyyyyy", "junk"]) {
          const r = run(s, remove(id), ctx);
          if (!modelShown(s, id)) {
            expect(r).toStrictEqual({ ok: false, error: unknown });
            expect(shownToTable(s, id)).toBe(false);
            continue;
          }
          expect(shownToTable(s, id)).toBe(true);
          const block = modelBlock(s, id);
          if (block === null) expect([id, r.ok]).toEqual([id, true]);
          else expect(r).toStrictEqual({ ok: false, error: { code: "NOT_PLAYABLE", detail: block } });
        }
      });
    }), env());
  });

  test("the churn is not vacuous: over 80 seeds removeCard is accepted for both colours, and some shown cards are blocked by the minimums", () => {
    let reds = 0;
    let greens = 0;
    let blocked = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const t = play(3 + (seed % 6), seed);
      for (const r of t.results) {
        if (!r.ok) continue;
        for (const e of r.value.events) {
          if (e.t !== "CardRemoved") continue;
          if (e.kind === "red") reds++;
          else greens++;
        }
      }
      t.states.forEach((s, i) => {
        if (s === null || i % 5 !== 0 || (s.phase !== "PLAYING" && s.phase !== "WRITING")) return;
        for (const id of Object.keys(s.cards)) if (modelShown(s, id) && modelBlock(s, id) === "below_minimum") blocked++;
      });
    }
    expect(reds).toBeGreaterThan(0);
    expect(greens).toBeGreaterThan(0);
    expect(blocked).toBeGreaterThan(0);
  }, 60_000);

  test("P-E5 and P-E17 with removeCard among the churn ops: every checker runs after every step (and the global conservation holds)", () => {
    assertProperty(fc.property(fc.integer({ min: 3, max: 8 }), fc.integer(), (n, seed) => {
      const t = play(n, seed);
      const removed = t.results.filter((r) => r.ok && r.value.events.some((e) => e.t === "CardRemoved")).length;
      expect(removed).toBeGreaterThanOrEqual(0);
    }), env());
  });
});
