// #30 N1 to N8: the strong form (LLD 2 11.3). A view is a function of only what its viewer may know: change what the viewer cannot see and the bytes must not move.
import { describe, expect, test } from "bun:test";
import type { project } from "../../src/project";
import type { Game, GameDrafts } from "../../src/types";
import { cid, pid } from "../support/factories";
import { REAL } from "./anonymity";
import type { ProjectorUnderTest } from "./anonymity";
import { DEP, HU, P, SPEC, finished, judging, submitting, unseatHost, writing } from "./fixtures";
import { decorate } from "./inject";
import { SENSITIVITY, TRANSFORMATIONS, firstDiff, nonInterference, renameCards, roundDocsAcrossToggle } from "./noninterference";
import type { NName } from "./noninterference";
import { allowedFor } from "./oracle";

const NONE: GameDrafts = {};
const ALL = new Set<NName>(["N1", "N2", "N3", "N4", "N5", "N6"]);
const viewJson = (impl: ProjectorUnderTest, g: Game, d: GameDrafts, v: Parameters<typeof project>[1]) => JSON.stringify(impl.project(g, v, d));
const byId = (id: string) => TRANSFORMATIONS.filter((t) => t.id === id);
/** Every transformation of one family, on one viewer, asserting that it moved something in the state and nothing in the view. */
function holds(id: NName, g: Game, d: GameDrafts, v: Parameters<typeof project>[1]): number {
  let applied = 0;
  for (const t of byId(id)) {
    const out = t.apply(g, d, v);
    if (out === null) continue;
    applied++;
    expect(JSON.stringify([out.game, out.drafts]), `${t.name} changed nothing`).not.toBe(JSON.stringify([g, d]));
    expect(viewJson(REAL, out.game, out.drafts, v), `${t.name} moved the view of ${v.kind}`).toBe(viewJson(REAL, g, d, v));
  }
  return applied;
}

describe("N1 re-mint ids and texts of every card outside allowed(t)", () => {
  test("the registry, zones, plays and votes follow one rename map; allowed cards keep their ids and texts; the view does not move", () => {
    const g = judging();
    for (const v of [P(5), P(3), P(1), SPEC, HU, P(0)]) {
      const viewer = v;
      expect(holds("N1", v === HU ? unseatHost(g) : g, NONE, viewer), "applied").toBe(1);
    }
    const out = byId("N1")[0]!.apply(g, NONE, P(5))!.game;
    const a = allowedFor(g, NONE, P(5));
    for (const id of a.ids) expect(out.cards[id]).toEqual(g.cards[id] as never);
    expect(Object.keys(out.cards).filter((id) => !a.ids.has(id)).every((id) => g.cards[id] === undefined)).toBe(true);
    expect(Object.keys(out.cards).length).toBe(Object.keys(g.cards).length);
    expect(new Set(Object.keys(out.cards)).size).toBe(Object.keys(g.cards).length);
  });

  test("renameCards is consistent across zones: every id in the aggregate is a registry key afterwards", () => {
    const g = finished();
    const m = new Map(Object.keys(g.cards).map((id, i) => [id, cid(50_000 + i)]));
    const r = renameCards(g, m, (t) => `X${t}`);
    const ids = [...r.pools.redDeck, ...r.pools.greenDeck, ...r.pools.redDiscard, ...r.pools.greenDiscard, ...r.players.flatMap((p) => [...p.hand, ...p.scorePile]), ...r.history.flatMap((h) => [h.greenCardId, h.winnerCardId, ...h.plays.map((p) => p.cardId)]), ...r.votes.map((v) => v.cardId)];
    expect(ids.length).toBeGreaterThan(20);
    // (the fixture's history names a few cards that were never registered; those stay as they are)
    for (const id of ids) if (m.has(id) || r.cards[id] !== undefined || g.cards[id] === undefined) expect(r.cards[id] !== undefined || g.cards[id] === undefined, id).toBe(true);
    expect(Object.keys(r.cards).every((id) => [...m.values()].includes(id))).toBe(true);
    expect(ids.filter((id) => g.cards[id] !== undefined).every((id) => [...m.values()].includes(id))).toBe(true);
  });
});

describe("N2 swap two pending submissions neither of which belongs to t: cards, owners, then whole positions", () => {
  test("the judge, the host, spectators and uninvolved players see the same bytes (JUDGING and SUBMITTING)", () => {
    for (const g of [judging(), submitting()]) {
      for (const v of [P(0), P(1), SPEC, HU, P(4), P(5), P(3)]) {
        if (v.kind === "player" && !g.players.some((p) => p.id === v.playerId)) continue;
        expect(holds("N2", v === HU ? unseatHost(g) : g, NONE, v)).toBeGreaterThanOrEqual(0);
      }
    }
    expect(holds("N2", judging(), NONE, P(5))).toBe(3); // a: cards, b: owners, c: positions
  });
  test("t's own submission is never touched", () => {
    const g = judging();
    for (const t of byId("N2")) {
      const out = t.apply(g, NONE, P(3))!.game;
      expect(out.round?.submissions.find((s) => s.playerId === pid(3))).toEqual(g.round?.submissions.find((s) => s.playerId === pid(3)) as never);
    }
  });
  test("not applicable with fewer than two other submissions", () => {
    const g = submitting(); // two plays (3 and 2)
    expect(byId("N2")[0]!.apply(g, NONE, P(3))).toBeNull();
  });
});

describe("N3 others' drafts, uids and powerUsage, the order of the pools", () => {
  test("t's uid and the host's uid are never rewritten; the view does not move", () => {
    const g = judging();
    const drafts: GameDrafts = { [pid(2)]: { red: ["R0001x"], green: [] }, [pid(5)]: { red: ["R0002x"], green: ["G0001x"] } };
    const out = byId("N3")[0]!.apply(g, drafts, P(3))!;
    expect(out.game.players.find((p) => p.id === pid(3))?.uid).toBe(g.players.find((p) => p.id === pid(3))?.uid as string);
    expect(out.game.players.find((p) => p.id === pid(0))?.uid).toBe(g.hostId);
    expect(out.game.players.find((p) => p.id === pid(2))?.uid).not.toBe(g.players.find((p) => p.id === pid(2))?.uid as string);
    expect(out.game.players.find((p) => p.id === pid(2))?.powerUsage).not.toEqual(g.players.find((p) => p.id === pid(2))?.powerUsage as never);
    expect(out.drafts[pid(5)]).not.toEqual(drafts[pid(5)] as never);
    expect(out.drafts[pid(3)]).toBeUndefined();
    for (const v of [P(3), P(0), P(1), SPEC]) expect(holds("N3", judging(), drafts, v)).toBe(1);
    expect(holds("N3", writing(), drafts, P(2))).toBe(1);
  });
});

describe("N4 server-internal times, episode and counters; never hostId", () => {
  test("changed, view unchanged, hostId untouched", () => {
    const g = submitting();
    const out = byId("N4")[0]!.apply(g, NONE, P(4))!.game;
    expect(out.hostId).toBe(g.hostId);
    expect(out.createdAt).not.toBe(g.createdAt);
    expect(out.round?.openedAt).not.toBe(g.round?.openedAt as number);
    expect(out.round?.changedAtVersion).not.toBe(g.round?.changedAtVersion as number);
    expect(out.episode).not.toBe(g.episode);
    for (const v of [P(0), P(1), P(4), SPEC, HU]) expect(holds("N4", v === HU ? unseatHost(g) : g, NONE, v)).toBe(1);
  });
});

describe("N5 other players' and spectators' votes while the game is not FINISHED or ENDED", () => {
  const withVotes = (): Game => ({ ...submitting(), votes: [{ round: 1, voter: `p:${pid(0)}`, cardId: cid(206) }, { round: 1, voter: "s:spec-uid", cardId: cid(206) }, { round: 1, voter: `p:${pid(4)}`, cardId: cid(306) }] });
  test("the view does not move; t's own votes stay put; not applicable once the game is over", () => {
    const g = withVotes();
    for (const v of [P(0), P(1), P(4), SPEC, HU]) expect(holds("N5", v === HU ? unseatHost(g) : g, NONE, v)).toBe(1);
    const out = byId("N5")[0]!.apply(g, NONE, P(4))!.game;
    expect(out.votes.find((x) => x.voter === `p:${pid(4)}`)).toEqual(g.votes[2] as never);
    expect(byId("N5")[0]!.apply(finished(), NONE, SPEC)).toBeNull();
  });
});

describe("N6 a non-t write-in submission becomes a hand-card one and back", () => {
  test("views of every other viewer are byte-equal; RoundDocs from a real pickWinner are byte-equal across the toggle", () => {
    const g = decorate(judging(), 1)!.game;
    expect(g.round?.submissions.some((s) => s.writeIn === true)).toBe(true);
    for (const v of [P(0), P(1), SPEC, P(5), P(3), P(2), P(4)]) expect(holds("N6", g, NONE, v), `${v.kind}`).toBeGreaterThanOrEqual(0);
    expect(holds("N6", g, NONE, P(5))).toBe(1);
    const toggled = byId("N6")[0]!.apply(g, NONE, P(5))!.game;
    // every submission not owned by t is flipped: the marked ones are plain now, the plain ones marked
    g.round?.submissions.forEach((s, i) => expect(toggled.round?.submissions[i]?.writeIn === true).toBe(s.writeIn !== true));
    const judge = g.players.find((p) => p.id === g.round?.judgeId);
    const docs = roundDocsAcrossToggle(REAL, g, toggled, { type: "pickWinner", submissionId: g.round?.revealOrder?.[0] as string, expectedVersion: g.round?.changedAtVersion as number } as never, judge?.uid as string);
    expect(docs).not.toBeNull();
    expect(JSON.stringify(docs?.a)).toBe(JSON.stringify(docs?.b));
    expect((docs?.a.length ?? 0)).toBe(1);
  });
  test("the reverse direction: a hand-card submission marked as a write-in", () => {
    const g = judging();
    const toggled = byId("N6")[0]!.apply(g, NONE, P(5))!.game;
    expect(toggled.round?.submissions.every((s) => s.writeIn === true)).toBe(true);
    expect(viewJson(REAL, toggled, NONE, P(5))).toBe(viewJson(REAL, g, NONE, P(5)));
  });
});

describe("N7 sensitivity: what t can observe does change the view", () => {
  test("own hand text, the green card's text, the reveal order and own powerUsage each move the view", () => {
    expect(SENSITIVITY.map((s) => s.name).sort()).toEqual(["green text", "own hand text", "own powerUsage", "reveal order"]);
    for (const s of SENSITIVITY) {
      const [g, v] = s.name === "own hand text" || s.name === "own powerUsage" ? [judging(), P(5)] : [judging(), SPEC];
      const out = s.apply(g, NONE, v);
      expect(out, s.name).not.toBeNull();
      expect(viewJson(REAL, out!.game, out!.drafts, v), s.name).not.toBe(viewJson(REAL, g, NONE, v));
    }
  });
});

describe("N8 a failure prints the minimal transformation and the diff path", () => {
  const bySubmissionOrder: ProjectorUnderTest = { ...REAL, project: (g, v, d) => {
    const view = REAL.project(g, v, d);
    if (view.kind !== "live" || view.round?.reveal == null || g.round === null) return view;
    const order = g.round.submissions.map((s) => s.cardId);
    return { ...view, round: { ...view.round, reveal: [...view.round.reveal].sort((a, b) => order.indexOf(a.submissionId) - order.indexOf(b.submissionId)) } };
  } };
  test("firstDiff names the first differing JSON path", () => {
    expect(firstDiff({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe("a[1].b");
    expect(firstDiff({ a: 1 }, { a: 1, b: 2 })).toBe("b");
    expect(firstDiff({ a: 1 }, { a: 1 })).toBeNull();
    expect(firstDiff([1, 2], [1, 2, 3])).toBe("[2]");
  });
  test("a projector that reveals in submission order is reported with the transformation and the path", () => {
    const r = nonInterference(bySubmissionOrder, judging(), NONE, P(5), new Set<NName>(["N2"]));
    expect(r).not.toBeNull();
    expect(r?.id).toBe("N2");
    expect(r?.name).toMatch(/^N2/);
    expect(r?.path).toMatch(/^round\.reveal\[\d\]/);
    expect(nonInterference(REAL, judging(), NONE, P(5), ALL)).toBeNull();
  });
  test("departed viewers and a spectator-off doc have nothing to compare", () => {
    expect(nonInterference(REAL, judging(), NONE, DEP(3, "left"), ALL)).toBeNull();
  });
});
