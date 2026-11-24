// #29: Q1 the store simulation (PJ10, PJ11), Q2 a simulated projector deploy, Q3 the test of the test: a stale projector must be caught. LLD 2 8.2, 11.7.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { fanOutWith } from "../../src/project/fanout";
import type { FanOutDeps } from "../../src/project/fanout";
import { makeProjector, viewersOf } from "../../src/project";
import type { Viewer } from "../../src/project";
import { PROJECTOR_REV } from "../../src/project/rev";
import type { Game } from "../../src/types";
import { assertProperty } from "../support/fc";
import { FIXTURES, judging, submitting, uidOf } from "./fixtures";
import { stepsOf } from "./scenarios";
import { SimStore, commit, divergence, vanished } from "./store-sim";

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
  for (const skip of [true, false]) {
    test(`skipUnchanged ${skip}`, () => {
      const seen = { steps: 0, skipped: 0, tombstones: 0 };
      assertProperty(fc.property(fc.integer({ min: 3, max: 7 }), fc.integer(), fc.boolean(), (n, seed, churn) => {
        const store = new SimStore();
        const gone = new Set<string>();
        let prev: Game | null = null;
        for (const { prev: p, next } of stepsOf(seed, n, churn, true)) {
          if (prev === null) {
            store.apply(fanOutWith(real, null, p, { now: NOW, skipUnchanged: skip }));
            store.viewsRev = PROJECTOR_REV;
            expect(divergence(store, p, makeProjector, gone)).toEqual([]);
          }
          prev = p;
          for (const id of vanished(p, next)) gone.add(id);
          const before = new Map([...store.docs].map(([k, d]) => [k, JSON.stringify(d)]));
          const writes = fanOutWith(real, p, next, { now: NOW, skipUnchanged: skip });
          const written = new Set(writes.map((w) => w.docId));
          store.apply(writes);
          expect(divergence(store, next, makeProjector, gone)).toEqual([]);
          // nothing else changes
          for (const [id, json] of before) if (!written.has(id)) expect(JSON.stringify(store.docs.get(id))).toBe(json);
          // a skipped-on write is never a no-op, and every write is a target or a vanished id
          const live = new Set(viewersOf(next).map((t) => t.docId));
          for (const w of writes) expect(live.has(w.docId) || vanished(p, next).includes(w.docId)).toBe(true);
          if (skip && p !== next) for (const w of writes) { const old = JSON.parse(before.get(w.docId) ?? "null") as { view: unknown } | null; if (old !== null) expect(JSON.stringify(old.view)).not.toBe(JSON.stringify(w.doc.view)); }
          seen.steps++;
          seen.skipped += viewersOf(next).length - writes.filter((w) => live.has(w.docId)).length;
          seen.tombstones += writes.filter((w) => w.doc.view?.kind === "departed" && w.doc.view.reason === "gone").length;
        }
      }));
      expect(seen.steps).toBeGreaterThan(200);
      if (skip) expect(seen.skipped).toBeGreaterThan(0);
      else expect(seen.skipped).toBe(0); // with skip off every target is rewritten at every step
    }, 120_000);
  }
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
    s.apply(fanOutWith(real, null, bump(g), { now: NOW, skipUnchanged: false }));
    expect(() => s.apply(fanOutWith(real, null, g, { now: NOW, skipUnchanged: false }))).toThrow(/PJ10/);
  });
});

describe("Q3 test the test: a stale stored projection is flagged when skip is on across a deploy, and converges with skip off", () => {
  const g1 = submitting();
  // one change only player 4 can see: after the deploy every other doc would be skipped
  const g2 = bump({ ...g1, cards: { ...g1.cards, [g1.players[4]?.hand[0] ?? ""]: { kind: "red", text: "CHANGED" } } });
  const populate = (): SimStore => { const s = new SimStore(); s.apply(fanOutWith(real, null, g1, { now: NOW, skipUnchanged: false })); return s; };
  test("skip on across the deploy: the oracle sees stale docs", () => {
    const s = populate();
    s.apply(fanOutWith(v2, g1, g2, { now: NOW, skipUnchanged: true }));
    const bad = divergence(s, g2, v2Project, new Set());
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.some((b) => b.includes("differs from the projection"))).toBe(true);
    expect(s.docs.get(uidOf(4))?.view).not.toBeNull();
  });
  test("skip off (the rebuild rule) converges", () => {
    const s = populate();
    s.apply(fanOutWith(v2, g1, g2, { now: NOW, skipUnchanged: false }));
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
