// #29: Q1 the store simulation (PJ10, PJ11), Q2 a simulated projector deploy, Q3 the test of the test: a stale projector must be caught. LLD 2 8.2, 11.7.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { ViewDoc } from "@dc/contracts";
import { fanOutWith, sameContent } from "../../src/project/fanout";
import type { FanOutDeps } from "../../src/project/fanout";
import { makeProjector, viewersOf } from "../../src/project";
import type { Viewer } from "../../src/project";
import { PROJECTOR_REV } from "../../src/project/rev";
import type { Game } from "../../src/types";
import { assertProperty } from "../support/fc";
import { FIXTURES, judging, submitting, uidOf } from "./fixtures";
import { stepsOf } from "./scenarios";
import { SimRounds, SimStore, commit, divergence, vanished } from "./store-sim";
import { decide } from "../../src/decide";
import { toRoundDoc } from "../../src/project";
import { ctxFor } from "../support/factories";

const NOW = 1_700_000_000_000;
const real: FanOutDeps = { project: makeProjector, rev: PROJECTOR_REV };
/** A projector deploy: same schema, different content (every player name upper-cased), and a higher revision. */
const v2Project = (g: Game) => {
  const at = makeProjector(g);
  return (v: Viewer) => {
    const view = at(v);
    return view.kind === "live" ? { ...view, players: view.players.map((p) => ({ ...p, name: p.name.toUpperCase() })) } : view;
  };
};
const v2: FanOutDeps = { project: v2Project, rev: PROJECTOR_REV + 1 };
const bump = (g: Game): Game => ({ ...g, version: g.version + 1 });

describe("Q1 the in-memory store, driven by fanOut over real games, equals a full rewrite after every step (PJ10, PJ11)", () => {
  // Both stored revisions run over the same generated games: generating a game is most of the cost, so each is generated once (it was twice, one property per revision).
  test(`storedRev ${PROJECTOR_REV} (skipping) and storedRev 0 (every target rewritten), over the same games`, () => {
    const revs = [PROJECTOR_REV, 0] as const;
    const seenBy = new Map(revs.map((r) => [r, { steps: 0, skipped: 0, tombstones: 0 }]));
    assertProperty(fc.property(fc.integer({ min: 3, max: 7 }), fc.integer(), fc.boolean(), (n, seed, churn) => {
      const steps = stepsOf(seed, n, churn, true);
      for (const storedRev of revs) {
        const seen = seenBy.get(storedRev)!;
        const store = new SimStore();
        const gone = new Set<string>();
        let prev: Game | null = null;
        for (const { prev: p, next } of steps) {
          if (prev === null) {
            store.apply(fanOutWith(real, null, p, { now: NOW, storedRev }));
            store.viewsRev = PROJECTOR_REV;
            expect(divergence(store, p, makeProjector, gone)).toEqual([]);
          }
          prev = p;
          for (const id of vanished(p, next)) gone.add(id);
          const before = new Map([...store.docs].map(([k, d]) => [k, JSON.stringify(d)]));
          const writes = fanOutWith(real, p, next, { now: NOW, storedRev });
          const written = new Set(writes.map((w) => w.docId));
          store.apply(writes);
          expect(divergence(store, next, makeProjector, gone)).toEqual([]);
          // nothing else changes
          for (const [id, json] of before) if (!written.has(id)) expect(JSON.stringify(store.docs.get(id))).toBe(json);
          // a skipped-on write is never a no-op, and every write is a target or a vanished id
          const live = new Set(viewersOf(next).map((t) => t.docId));
          for (const w of writes) expect(live.has(w.docId) || vanished(p, next).includes(w.docId)).toBe(true);
          // skipping, every write to an existing doc changes what its reader sees (the version alone does not count)
          if (storedRev === PROJECTOR_REV) for (const w of writes) { const old = JSON.parse(before.get(w.docId) ?? "null") as ViewDoc | null; if (old !== null) expect(sameContent(old, w.doc), `${w.docId} rewritten with the same content`).toBe(false); }
          seen.steps++;
          seen.skipped += viewersOf(next).length - writes.filter((w) => live.has(w.docId)).length;
          seen.tombstones += writes.filter((w) => w.doc.view?.kind === "departed" && w.doc.view.reason === "gone").length;
        }
      }
    }));
    for (const storedRev of revs) {
      const seen = seenBy.get(storedRev)!;
      expect(seen.steps, `storedRev ${storedRev}`).toBeGreaterThan(200);
      if (storedRev === PROJECTOR_REV) expect(seen.skipped, `storedRev ${storedRev}`).toBeGreaterThan(0);
      else expect(seen.skipped, `storedRev ${storedRev}`).toBe(0); // with every doc stored at another rev, every target is rewritten at every step
    }
  }, 600_000);
});

describe("Q2 a projector deploy (viewsRev behind)", () => {
  const stored = (g: Game): SimStore => { const s = new SimStore(); commit(s, { project: makeProjector, rev: PROJECTOR_REV - 1 > 0 ? PROJECTOR_REV - 1 : 0 }, null, g, { aggregateChanged: true, now: NOW - 1 }); return s; };
  test("the first command after the deploy rewrites every doc at the same version with the new viewsRev, a draft-only one included", () => {
    for (const make of [submitting, judging, ...Object.values(FIXTURES)]) {
      const g = make();
      const s = stored(g);
      expect(s.viewsRev).toBe(PROJECTOR_REV - 1);
      const writes = commit(s, real, g, g, { aggregateChanged: false, now: NOW });
      expect(writes.map((w) => w.docId)).toEqual(viewersOf(g).map((t) => t.docId));
      for (const d of s.docs.values()) { expect([d.version, d.viewsRev]).toEqual([g.version, PROJECTOR_REV]); expect(d.generatedAt).toBe(NOW); }
      expect(s.viewsRev).toBe(PROJECTOR_REV);
      expect(commit(s, real, g, g, { aggregateChanged: false, now: NOW + 1 })).toEqual([]); // draft-only again: nothing
    }
  });
  test("a rollback (store.viewsRev above the running PROJECTOR_REV) never skips: every doc is rewritten and viewsRev is set back (LLD 3 rule, fail safe)", () => {
    const g = submitting();
    const s = new SimStore();
    s.apply(fanOutWith(real, null, g, { now: NOW - 1, storedRev: 0 }));
    s.viewsRev = PROJECTOR_REV + 1;
    const next = bump(g); // no visible change: skip-unchanged would write nothing
    expect(fanOutWith(real, g, next, { now: NOW, storedRev: PROJECTOR_REV })).toEqual([]);
    const writes = commit(s, real, g, next, { aggregateChanged: true, now: NOW });
    expect(writes.map((w) => w.docId)).toEqual(viewersOf(next).map((t) => t.docId));
    expect(s.viewsRev).toBe(PROJECTOR_REV);
    expect(commit(s, real, next, bump(next), { aggregateChanged: true, now: NOW })).toEqual([]); // equal again: skipping resumes
  });
  test("an aggregate-changing first command rewrites everything too, including views whose content did not change", () => {
    const g = submitting();
    const s = stored(g);
    const next = bump(g);
    expect(commit(s, real, g, next, { aggregateChanged: true, now: NOW })).toHaveLength(viewersOf(next).length);
    expect(divergence(s, next, makeProjector, new Set())).toEqual([]);
  });
  test("the old doc's (version, viewsRev) never exceeds the rewrite's", () => {
    const g = judging();
    const s = stored(g);
    const before = [...s.docs.values()].map((d) => [d.version, d.viewsRev]);
    commit(s, real, g, g, { aggregateChanged: false, now: NOW });
    [...s.docs.values()].forEach((d, i) => { const b = before[i] ?? [0, 0]; expect(d.version > (b[0] ?? 0) || (d.version === b[0] && d.viewsRev >= (b[1] ?? 0))).toBe(true); });
  });
  test("SimStore refuses a write that would lower (version, viewsRev)", () => {
    const g = judging();
    const s = new SimStore();
    s.apply(fanOutWith(real, null, bump(g), { now: NOW, storedRev: 0 }));
    expect(() => s.apply(fanOutWith(real, null, g, { now: NOW, storedRev: 0 }))).toThrow(/PJ10/);
  });
});

describe("Q3 test the test: a stale stored projection is flagged, and the Store contract converges", () => {
  const g1 = submitting();
  // one change only player 4 can see: after the deploy every other doc would be skipped
  const g2 = bump({ ...g1, cards: { ...g1.cards, [g1.players[4]?.hand[0] ?? ""]: { kind: "red", text: "CHANGED" } } });
  const populate = (): SimStore => { const s = new SimStore(); s.apply(fanOutWith(real, null, g1, { now: NOW, storedRev: 0 })); return s; };
  test("a store that kept the old docs across the deploy is flagged (the bug the storedRev check rules out)", () => {
    const s = populate();
    // `fanOut` refuses to skip while the stored rev is behind, so a skipping store is hand-built here: only the doc whose content changed.
    s.apply(fanOutWith(v2, g1, g2, { now: NOW, storedRev: PROJECTOR_REV }).filter((w) => w.docId === uidOf(4)));
    const bad = divergence(s, g2, v2Project, new Set());
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.some((b) => b.includes("differs from the projection"))).toBe(true);
    expect(s.docs.get(uidOf(4))?.view).not.toBeNull();
  });
  test("skip off (the rebuild rule) converges", () => {
    const s = populate();
    s.apply(fanOutWith(v2, g1, g2, { now: NOW, storedRev: 0 }));
    expect(divergence(s, g2, v2Project, new Set())).toEqual([]);
  });
  test("the Store contract (commit) converges, because viewsRev is behind", () => {
    const s = populate();
    s.viewsRev = PROJECTOR_REV;
    commit(s, v2, g1, g2, { aggregateChanged: true, now: NOW });
    expect(divergence(s, g2, v2Project, new Set())).toEqual([]);
    expect(s.viewsRev).toBe(v2.rev);
  });
  test("the oracle also flags a missing doc, a doc that should not exist, and a wrong tombstone", () => {
    const s = populate();
    s.docs.delete("spectator");
    expect(divergence(s, g1, makeProjector, new Set())).toEqual(["spectator: a missing doc"]);
    const t = populate();
    t.docs.set("ghost", structuredClone(t.docs.get("spectator")!));
    expect(divergence(t, g1, makeProjector, new Set())).toEqual(["ghost: a doc that should not exist"]);
    expect(divergence(t, g1, makeProjector, new Set(["ghost"]))).toEqual(["ghost: a vanished id without a gone tombstone"]);
  });
});

// #30 A6: the round-doc side of the store simulation (PJ13): written once, only for resolved rounds.
describe("SimRounds", () => {
  const resolved = (): { before: Game; after: Game; docs: ReturnType<typeof toRoundDoc>[] } => {
    const before = judging();
    const judge = before.players.find((p) => p.id === before.round?.judgeId);
    const r = decide(before, { type: "pickWinner", submissionId: before.round?.revealOrder?.[0] as string, expectedVersion: before.round?.changedAtVersion as number } as never, ctxFor({ actor: { kind: "user", uid: judge?.uid as string } }));
    if (!r.ok) throw new Error("pickWinner");
    return { before, after: r.value.state, docs: r.value.roundRecords.map(toRoundDoc) };
  };

  test("a doc is stored once, for a round that is in the resolved history", () => {
    const { after, docs } = resolved();
    expect(docs.length).toBe(1);
    const sim = new SimRounds();
    sim.apply(docs, after);
    expect([...sim.docs.keys()]).toEqual([1]);
    expect(sim.docs.get(1)).toEqual(docs[0] as never);
    expect(sim.applied).toBe(1);
  });

  test("a second write of the same round throws", () => {
    const { after, docs } = resolved();
    const sim = new SimRounds();
    sim.apply(docs, after);
    expect(() => sim.apply(docs, after)).toThrow("twice");
  });

  test("a round that is not resolved (still open in the state) throws", () => {
    const { before, docs } = resolved();
    const sim = new SimRounds();
    expect(() => sim.apply(docs, before)).toThrow("unresolved");
  });
});
