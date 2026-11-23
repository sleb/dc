// #26 (1.9): the selectors of LLD 1 section 14 (all but `exportPools`, which is M9): total, pure, non-mutating, and the two that touch hidden state (`revealList`, `ownSubmission`) leak nothing they should not.
// SEL1 each selector is total and does not mutate over random games, SEL2 revealList (JUDGING only, revealOrder, no owner, V3/E9), SEL3 ownSubmission (the viewer's own play only),
// SEL4 awards and votesFor on fabricated votes (no vote exists before M7, so these are fixture-proven only; open question 8), SEL5 the public export list.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as engine from "../src/index";
import * as sel from "../src/selectors";
import { defaultTarget, gMin, meetsMinimums, rMin, totals } from "../src/rules/playability";
import type { Game, Vote } from "../src/types";
import { cid, deepFreeze, makeGame, makePlayer, pid } from "./support/factories";
import { assertProperty } from "./support/fc";
import { arbShape, buildGame } from "./support/scenario";
import { roundGame } from "./support/round-fixtures";

const env = (): Record<string, string | undefined> => ({ ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? "40" });
const withText = (g: Game): Game => ({ ...g, cards: Object.fromEntries(Object.entries(g.cards).map(([id, c]) => [id, { ...c, text: `text of ${id}` }])) });

/** Every selector of section 14 that takes a plain game (the player and card arguments come from the game itself). */
function everything(g: Game): Record<string, unknown> {
  const p = g.players[0]?.id ?? pid(0);
  const c = Object.keys(g.cards)[0] ?? cid(1);
  return {
    seated: sel.seated(g), activePlayers: sel.activePlayers(g), isPaused: sel.isPaused(g), effectiveTarget: sel.effectiveTarget(g),
    expectedSubmitters: sel.expectedSubmitters(g), waitingOn: sel.waitingOn(g), submittedBy: sel.submittedBy(g), cardText: sel.cardText(g, c), handOf: sel.handOf(g, p),
    revealList: sel.revealList(g), ownSubmission: sel.ownSubmission(g, p), submissionOwner: sel.submissionOwner(g, c), shownToTable: sel.shownToTable(g, c),
    cardsStillToWrite: sel.cardsStillToWrite(g, p), playabilityReport: sel.playabilityReport(g), awards: sel.awards(g), votesFor: sel.votesFor(g, 1, c),
  };
}

describe("SEL1 total, pure, non-mutating", () => {
  test("every selector returns for every shape of game, on a deep-frozen input (a mutation throws), and twice gives equal answers", () => {
    assertProperty(fc.property(arbShape, (shape) => {
      const g = deepFreeze(withText(buildGame(shape)));
      const a = everything(g);
      expect(JSON.stringify(everything(g))).toBe(JSON.stringify(a));
      expect(JSON.stringify(a)).not.toContain("undefined");
    }), env());
  });

  test("unknown ids and players are answered, not thrown: empty, null, zero", () => {
    const g = roundGame({ judge: 1, submitted: [2] });
    expect(sel.cardText(g, cid(777_777))).toBe("");
    expect(sel.handOf(g, pid(31))).toStrictEqual([]);
    expect(sel.ownSubmission(g, pid(31))).toBeNull();
    expect(sel.submissionOwner(g, cid(777_777))).toBeUndefined();
    expect(sel.cardsStillToWrite(g, pid(31))).toStrictEqual({ red: 0, green: 0 });
    expect(sel.votesFor(g, 9, cid(777_777))).toBe(0);
  });

  test("the simple reads: isPaused, effectiveTarget, expectedSubmitters, waitingOn, submittedBy, cardText, handOf", () => {
    const g = roundGame({ n: 4, judge: 1, submitted: [2] });
    expect(sel.isPaused(g)).toBe(false);
    expect(sel.isPaused({ ...g, paused: true })).toBe(true);
    expect(sel.expectedSubmitters(g)).toStrictEqual([pid(0), pid(2), pid(3)]);
    expect(sel.submittedBy(g)).toStrictEqual([pid(2)]);
    expect(sel.handOf(g, pid(0))).toStrictEqual(g.players[0]?.hand);
    expect(sel.handOf(g, pid(0))).not.toBe(g.players[0]?.hand); // a copy, so a caller cannot mutate the aggregate through it
    expect(sel.cardText(g, cid(900))).toBe("the green card");
    expect(sel.expectedSubmitters({ ...g, round: null })).toStrictEqual([]);
    expect(sel.submittedBy({ ...g, round: null })).toStrictEqual([]);
    // the target: the frozen one when set, else the override, else the default for the seated count
    expect(sel.effectiveTarget(g)).toBe(8);
    expect(sel.effectiveTarget({ ...g, target: null })).toBe(defaultTarget(4));
    expect(sel.effectiveTarget({ ...g, target: null, settings: { ...g.settings, targetOverride: 5 } })).toBe(5);
  });

  test("waitingOn is the settled scheduler field, as a copy", () => {
    const g = { ...roundGame({ judge: 1, submitted: [2] }), waitingOn: [pid(0), pid(3)] };
    expect(sel.waitingOn(g)).toStrictEqual([pid(0), pid(3)]);
    expect(sel.waitingOn(g)).not.toBe(g.waitingOn);
  });

  test("cardsStillToWrite: target minus saved progress, never negative, zero with no target", () => {
    const w = makeGame({ phase: "WRITING", players: [makePlayer(0, { writeTarget: { red: 10, green: 8 }, writeProgress: { red: 4, green: 8 } }), makePlayer(1, { writeTarget: { red: 2, green: 1 }, writeProgress: { red: 5, green: 0 } }), makePlayer(2)] });
    expect(sel.cardsStillToWrite(w, pid(0))).toStrictEqual({ red: 6, green: 0 });
    expect(sel.cardsStillToWrite(w, pid(1))).toStrictEqual({ red: 0, green: 1 });
    expect(sel.cardsStillToWrite(w, pid(2))).toStrictEqual({ red: 0, green: 0 });
  });

  test("playabilityReport: n, target, totals, the minimums and whether they are met", () => {
    const g = roundGame({ n: 4, judge: 1 });
    const t = totals(g);
    expect(sel.playabilityReport(g)).toStrictEqual({ n: 4, target: 8, totals: t, rMin: rMin(4), gMin: gMin(4, 8), meets: meetsMinimums(t, 4, 8) });
    expect(sel.playabilityReport(makeGame())).toMatchObject({ n: 1, target: defaultTarget(1), meets: false });
  });
});

describe("SEL2 revealList: JUDGING only, in revealOrder, no owner (V3, E9)", () => {
  const ownerIds = (g: Game): string[] => g.players.map((p) => p.id);

  test("in JUDGING it lists the revealOrder, in that order, with text and pitch (null when none)", () => {
    const base = roundGame({ n: 5, judge: 0, submitted: [1, 2, 3], phase: "JUDGING" });
    const g = withText({ ...base, round: { ...(base.round as NonNullable<Game["round"]>), submissions: (base.round?.submissions ?? []).map((s, i) => (i === 1 ? { ...s, pitch: "my pitch" } : s)) } });
    const order = g.round?.revealOrder ?? [];
    const list = sel.revealList(g);
    expect(list.map((r) => r.submissionId)).toStrictEqual(order);
    expect(list.map((r) => r.text)).toStrictEqual(order.map((id) => `text of ${id}`));
    expect(list.filter((r) => r.pitch !== null)).toStrictEqual([{ submissionId: cid(206), text: `text of ${cid(206)}`, pitch: "my pitch" }]);
  });

  test("outside JUDGING (SUBMITTING, no round, every other phase) it is empty", () => {
    expect(sel.revealList(roundGame({ judge: 0, submitted: [1, 2] }))).toStrictEqual([]);
    expect(sel.revealList({ ...roundGame({ judge: 0, submitted: [1], phase: "JUDGING" }), round: null })).toStrictEqual([]);
    expect(sel.revealList(makeGame())).toStrictEqual([]);
  });

  test("over random JUDGING games the answer holds exactly the keys submissionId, text, pitch, and a deep scan finds no player id", () => {
    let judging = 0;
    assertProperty(fc.property(arbShape, (shape) => {
      const g = deepFreeze(withText(buildGame({ ...shape, phase: "JUDGING" })));
      const list = sel.revealList(g);
      judging++;
      expect(list.map((r) => r.submissionId)).toStrictEqual(g.round?.revealOrder ?? []);
      for (const r of list) expect(Object.keys(r).sort()).toStrictEqual(["pitch", "submissionId", "text"]);
      const text = JSON.stringify(list);
      for (const id of ownerIds(g)) expect(text.includes(id)).toBe(false);
    }), env());
    expect(judging).toBeGreaterThan(0);
  });

  test("the scan is sharp: a list that carried an owner would be caught", () => {
    const g = withText(roundGame({ judge: 0, submitted: [1, 2], phase: "JUDGING" }));
    const leaky = JSON.stringify(sel.revealList(g).map((r) => ({ ...r, owner: pid(1) })));
    expect(ownerIds(g).some((id) => leaky.includes(id))).toBe(true);
  });
});

describe("SEL3 ownSubmission: the viewer's own play, nothing of anyone else's", () => {
  test("a submitter sees their card, text and pitch; a judge, a non-submitter and a stranger see null; in SUBMITTING and in JUDGING", () => {
    for (const phase of ["SUBMITTING", "JUDGING"] as const) {
      const base = roundGame({ n: 4, judge: 0, submitted: [1, 2], phase });
      const g = withText({ ...base, round: { ...(base.round as NonNullable<Game["round"]>), submissions: (base.round?.submissions ?? []).map((s) => (s.playerId === pid(2) ? { ...s, pitch: "p2 pitch" } : s)) } });
      expect(sel.ownSubmission(g, pid(1))).toStrictEqual({ cardId: cid(106), text: `text of ${cid(106)}`, pitch: null });
      expect(sel.ownSubmission(g, pid(2))).toStrictEqual({ cardId: cid(206), text: `text of ${cid(206)}`, pitch: "p2 pitch" });
      for (const who of [pid(0), pid(3), pid(30)]) expect(sel.ownSubmission(g, who)).toBeNull();
    }
  });

  test("over random games the answer is the viewer's own submission or null, and the other players' cards and pitches never appear in it", () => {
    assertProperty(fc.property(arbShape, (shape) => {
      const g = deepFreeze(withText(buildGame(shape)));
      for (const p of g.players) {
        const got = sel.ownSubmission(g, p.id);
        const mine = g.round?.submissions.find((s) => s.playerId === p.id);
        if (mine === undefined) expect(got).toBeNull();
        else expect(got).toStrictEqual({ cardId: mine.cardId, text: `text of ${mine.cardId}`, pitch: mine.pitch ?? null });
        const text = JSON.stringify(got);
        for (const other of g.round?.submissions ?? []) if (other.playerId !== p.id) expect(text.includes(other.cardId)).toBe(false);
      }
    }), env());
  });

  test("submissionOwner finds the owner of a card in the open round or in history (server-only), undefined otherwise", () => {
    const g = roundGame({ judge: 0, submitted: [1, 2] });
    expect(sel.submissionOwner(g, cid(106))).toBe(pid(1));
    expect(sel.submissionOwner(g, cid(206))).toBe(pid(2));
    expect(sel.submissionOwner(g, cid(0))).toBeUndefined();
    const done = roundGame({ judge: 0, history: [{ round: 1, judgeId: pid(0), greenCardId: cid(900), plays: [{ playerId: pid(3), cardId: cid(5001) }], winnerCardId: cid(5001), winnerId: pid(3) }] });
    expect(sel.submissionOwner(done, cid(5001))).toBe(pid(3));
  });
});

describe("SEL4 awards and votesFor on fabricated votes (fixture-proven only: castVote is M7, OQ 8 tie-breaks)", () => {
  const summary = (round: number, plays: [number, number][], winner: number) => ({ round, judgeId: pid(0), greenCardId: cid(900 + round), plays: plays.map(([p, c]) => ({ playerId: pid(p), cardId: cid(c) })), winnerCardId: cid(plays[winner]?.[1] ?? 0), winnerId: pid(plays[winner]?.[0] ?? 0) });
  const history = [summary(1, [[1, 11], [2, 12], [3, 13]], 0), summary(2, [[1, 21], [2, 22], [3, 23]], 1), summary(3, [[1, 31], [2, 32], [3, 33]], 2)];
  const vote = (round: number, voter: string, c: number): Vote => ({ round, voter, cardId: cid(c) });
  const game = (votes: Vote[], peoplesChoice = true): Game => ({ ...roundGame({ n: 4, judge: 0, history }), settings: { ...roundGame().settings, variants: { pitch: false, writeIn: false, redraw: false, peoplesChoice } }, votes });

  test("votesFor counts the votes for one card in one round", () => {
    const g = game([vote(1, "p:a", 11), vote(1, "p:b", 11), vote(1, "p:c", 12), vote(2, "p:a", 11)]);
    expect([sel.votesFor(g, 1, cid(11)), sel.votesFor(g, 1, cid(12)), sel.votesFor(g, 2, cid(11)), sel.votesFor(g, 1, cid(13))]).toStrictEqual([2, 1, 1, 0]);
  });

  test("awards is null with the variant off; with it on and no votes it is empty", () => {
    expect(sel.awards(game([vote(1, "p:a", 11)], false))).toBeNull();
    expect(sel.awards(game([]))).toStrictEqual({ peoplesChoice: [], podium: [] });
  });

  test("People's Choice is the player with the most votes across all their plays (minimum one); a tie is co-winners", () => {
    // p1: 2 + 1 = 3; p2: 2; p3: 0
    const g = game([vote(1, "p:a", 11), vote(1, "p:b", 11), vote(2, "p:a", 21), vote(2, "p:b", 22), vote(2, "p:c", 22)]);
    expect(sel.awards(g)?.peoplesChoice).toStrictEqual([pid(1)]);
    const tie = game([vote(1, "p:a", 11), vote(2, "p:a", 22)]);
    expect(sel.awards(tie)?.peoplesChoice).toStrictEqual([pid(1), pid(2)]);
  });

  test("the podium is the top three plays by votes, then round, then play order in history; ranks 1 to 3 by position; plays with no votes are not on it", () => {
    const g = game([
      vote(1, "p:a", 12), vote(1, "p:b", 12), vote(1, "p:c", 12), // round 1 card 12 (p2): 3
      vote(2, "p:a", 21), vote(2, "p:b", 21), // round 2 card 21 (p1): 2
      vote(3, "p:a", 31), vote(3, "p:b", 31), // round 3 card 31 (p1): 2, later round: after round 2's
      vote(1, "p:a", 13), // round 1 card 13 (p3): 1, fourth, cut
    ]);
    expect(sel.awards(g)?.podium).toStrictEqual([
      { rank: 1, round: 1, cardId: cid(12), playerId: pid(2), votes: 3 },
      { rank: 2, round: 2, cardId: cid(21), playerId: pid(1), votes: 2 },
      { rank: 3, round: 3, cardId: cid(31), playerId: pid(1), votes: 2 },
    ]);
    const equalVotes = game([vote(1, "p:a", 13), vote(1, "p:b", 11)]);
    expect(sel.awards(equalVotes)?.podium.map((x) => x.cardId)).toStrictEqual([cid(11), cid(13)]); // same round: history play order, not vote order
  });

  test("votes for a card no history round holds, or for a round that does not exist, count for nobody", () => {
    const g = game([vote(1, "p:a", 999), vote(9, "p:a", 11)]);
    expect(sel.awards(g)).toStrictEqual({ peoplesChoice: [], podium: [] });
  });
});

describe("SEL5 the public export list is pinned; two selectors are server-only", () => {
  test("index exports every selector but exportPools (M9), and the server-only ones are named so in their doc comment", async () => {
    const names = Object.keys(engine);
    for (const n of ["seated", "activePlayers", "isPaused", "effectiveTarget", "expectedSubmitters", "waitingOn", "submittedBy", "cardText", "handOf", "revealList", "ownSubmission", "submissionOwner", "shownToTable", "cardsStillToWrite", "playabilityReport", "awards", "votesFor"]) expect(names).toContain(n);
    expect(names).not.toContain("exportPools");
    const src = await Bun.file(new URL("../src/selectors.ts", import.meta.url)).text();
    for (const n of ["submissionOwner", "shownToTable"]) {
      const at = src.indexOf(`export function ${n}`);
      expect(src.slice(Math.max(0, at - 700), at)).toMatch(/server-only/i);
    }
  });
});
