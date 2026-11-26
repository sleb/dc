// #29: P1 and P2 (purity, strict parse and invariants), F1 to F9 (the fan-out algorithm), D1 (the draft region), X1 (speed). LLD 2 PJ1, PJ2, 8.1, 8.4.
// castVote is unregistered until M7, so vote-driven skip cases are hand-built states.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { VIEW_SCHEMA, ViewDocSchema } from "@dc/contracts";
import type { GameView, ViewDoc } from "@dc/contracts";
import { EngineInvariantError } from "../../src/errors";
import { DRAFT_REGION_FIELDS, VIEW_REGION_FIELDS, assertViewDoc, draftRegion, fanOut, fanOutWith, sameContent } from "../../src/project/fanout";
import type { ViewWrite } from "../../src/project/fanout";
import { makeProjector, project, viewersOf } from "../../src/project";
import type { Viewer } from "../../src/project";
import { PROJECTOR_REV } from "../../src/project/rev";
import type { Game } from "../../src/types";
import { HOST_UID, deepFreeze, makePlayer, pid } from "../support/factories";
import { assertProperty } from "../support/fc";
import { park } from "../support/round-fixtures";
import { CELLS } from "./cells";
import { FIXTURES, must, settings, submitting, judging, lobby, paused, uidOf, unseatHost, writing } from "./fixtures";
import { maximalJudging } from "./maximal";
import { stepsOf } from "./scenarios";

const NOW = 1_700_000_000_000;
const on = { now: NOW, storedRev: PROJECTOR_REV } as const;
const off = { now: NOW, storedRev: 0 } as const;
const ids = (ws: readonly ViewWrite[]): string[] => ws.map((w) => w.docId);
const bump = (g: Game): Game => ({ ...g, version: g.version + 1 });
const reverseKeys = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).reverse()) as T;
const real = { project: makeProjector, rev: PROJECTOR_REV };

describe("P1 fanOut is pure and byte-deterministic (PJ1)", () => {
  test("equal inputs, frozen inputs and a different insertion order of the card registry give equal bytes", () => {
    for (const [name, make] of Object.entries(FIXTURES)) {
      const g = make();
      const a = JSON.stringify(fanOut(null, g, off));
      expect(JSON.stringify(fanOut(null, deepFreeze(structuredClone(g)), off)), name).toBe(a);
      expect(JSON.stringify(fanOut(null, { ...g, cards: reverseKeys(g.cards) }, off)), `${name} reordered`).toBe(a);
      const h = unseatHost(g);
      expect(JSON.stringify(fanOut(g, deepFreeze(structuredClone(h)), on)), `${name} hostless`).toBe(JSON.stringify(fanOut(structuredClone(g), h, on)));
    }
  });
  test("property: over every step of real games, twice and over frozen clones", () => {
    assertProperty(fc.property(fc.integer({ min: 3, max: 6 }), fc.integer(), fc.boolean(), (n, seed, churn) => {
      for (const { prev, next } of stepsOf(seed, n, churn, true, 80)) {
        const a = JSON.stringify(fanOut(prev, next, on));
        expect(JSON.stringify(fanOut(deepFreeze(structuredClone(prev)), deepFreeze(structuredClone(next)), on))).toBe(a);
      }
    }), { ...process.env, FC_NUM_RUNS: "30" });
  });
});

const spectatorDoc = (): ViewDoc => {
  const g = judging();
  return { schema: VIEW_SCHEMA, viewsRev: PROJECTOR_REV, gameId: g.id, enabled: true, version: g.version, generatedAt: 5, view: project(g, { kind: "spectator", uid: null, isHost: false }) };
};
const ctx = { gameId: judging().id, viewsRev: PROJECTOR_REV };

describe("P2a assertViewDoc rejects what the strict schema or the envelope invariants cannot allow (PJ2)", () => {
  test("a good doc passes, as does a disabled spectator doc", () => {
    expect(() => assertViewDoc(spectatorDoc(), ctx)).not.toThrow();
    expect(() => assertViewDoc({ ...spectatorDoc(), enabled: false, view: null }, ctx)).not.toThrow();
  });
  const live = (): Extract<GameView, { kind: "live" }> => { const v = spectatorDoc().view; if (v === null || v.kind !== "live") throw new Error("fixture"); return v; };
  const cases: [string, () => unknown][] = [
    ["an unknown top-level key", () => ({ ...spectatorDoc(), extra: 1 })],
    ["an unknown key inside the view", () => ({ ...spectatorDoc(), view: { ...live(), owner: "p_x" } })],
    ["a missing key", () => { const { generatedAt: _g, ...rest } = spectatorDoc(); return rest; }],
    ["an enum outside its set", () => ({ ...spectatorDoc(), view: { ...live(), phase: "NOPE" } })],
    ["draft present", () => ({ ...spectatorDoc(), draft: null })],
    ["draftSeq present", () => ({ ...spectatorDoc(), draftSeq: 1 })],
    ["enabled false with a view", () => ({ ...spectatorDoc(), enabled: false })],
    ["enabled true with no view", () => ({ ...spectatorDoc(), view: null })],
    ["doc.version differing from view.version", () => ({ ...spectatorDoc(), version: spectatorDoc().version + 1 })],
    ["the wrong gameId on the doc and the view", () => ({ ...spectatorDoc(), gameId: "gamebbbbbbbbbbbbbbbb", view: { ...live(), gameId: "gamebbbbbbbbbbbbbbbb" } })],
    ["the wrong gameId on the view only", () => ({ ...spectatorDoc(), view: { ...live(), gameId: "gamebbbbbbbbbbbbbbbb" } })],
    ["the wrong viewsRev", () => ({ ...spectatorDoc(), viewsRev: PROJECTOR_REV + 1 })],
    ["a wrong schema number", () => ({ ...spectatorDoc(), schema: 2 })],
  ];
  for (const [name, make] of cases) test(`${name} throws EngineInvariantError`, () => expect(() => assertViewDoc(make(), ctx)).toThrow(EngineInvariantError));
});

describe("P2b a leaky projector cannot reach a write", () => {
  const leaky = (g: Game) => {
    const at = makeProjector(g);
    return (v: Viewer): GameView => {
      const view = at(v);
      if (view.kind !== "live" || view.round?.reveal == null) return view;
      return { ...view, round: { ...view.round, reveal: view.round.reveal.map((c, i) => (i === 0 ? { ...c, owner: "SECRETOWNER" } : c)) } } as GameView;
    };
  };
  test("an extra owner on a reveal card throws, and the message holds issue paths and codes only", () => {
    let message = "";
    try { fanOutWith({ project: leaky, rev: PROJECTOR_REV }, null, judging(), off); } catch (e) {
      expect(e).toBeInstanceOf(EngineInvariantError);
      message = (e as Error).message;
    }
    expect(message).toContain("unrecognized_keys");
    expect(message).toContain("round");
    expect(message).toContain("reveal");
    expect(message).not.toContain("SECRETOWNER");
    expect(message).not.toMatch(/CARD|PITCH|Name\d/); // no card text, pitch or player name
  });
});

describe("P2c what fanOut returns is valid, and is the built object, not the parse clone", () => {
  test("every doc over the 43 goldens' states parses strictly, for the plain and the disabled-spectator variant", () => {
    for (const c of CELLS) {
      const g = c.game();
      for (const variant of [g, { ...g, settings: { ...g.settings, spectators: { ...g.settings.spectators, enabled: false } } }]) {
        for (const w of fanOut(null, variant, off)) expect(ViewDocSchema.safeParse(w.doc).success, `${c.name} ${w.docId}`).toBe(true);
      }
    }
  });
  test("property: every doc of every step of real games parses strictly", () => {
    assertProperty(fc.property(fc.integer({ min: 3, max: 6 }), fc.integer(), fc.boolean(), (n, seed, churn) => {
      for (const { prev, next } of stepsOf(seed, n, churn, true, 80)) {
        for (const w of [...fanOut(prev, next, on), ...fanOut(null, next, off)]) expect(ViewDocSchema.safeParse(w.doc).success).toBe(true);
      }
    }), { ...process.env, FC_NUM_RUNS: "30" });
  });
  test("the view in a write is the very object the projector returned", () => {
    const g = judging();
    const built = new Map<string, GameView>();
    const spy = (game: Game) => {
      const at = makeProjector(game);
      return (v: Viewer): GameView => { const view = at(v); built.set(JSON.stringify(v), view); return view; };
    };
    const writes = fanOutWith({ project: spy, rev: PROJECTOR_REV }, null, g, off);
    const targets = viewersOf(g);
    expect(writes.length).toBe(targets.length);
    targets.forEach((t, i) => expect(writes[i]?.doc.view).toBe(built.get(JSON.stringify(t.viewer))));
  });
});

describe("F1 what is written, in what order", () => {
  test("prev null writes every target in viewersOf order", () => {
    for (const make of Object.values(FIXTURES)) {
      const g = make();
      expect(ids(fanOut(null, g, on))).toEqual(viewersOf(g).map((t) => t.docId));
    }
  });
  test("fanOut(g, g, skip) is empty, and fanOut(null, g) equals fanOut(g, g, skip off)", () => {
    for (const make of Object.values(FIXTURES)) {
      const g = make();
      expect(fanOut(g, g, on)).toEqual([]);
      expect(fanOut(null, g, on)).toStrictEqual(fanOut(g, g, off));
    }
  });
});

describe("F2 only what a viewer can see counts as a change", () => {
  test("a change visible to one viewer rewrites only that doc (a card in player 4's hand), with the version bumped too", () => {
    const g = submitting();
    const next = bump({ ...g, cards: { ...g.cards, [must(g.players[4]?.hand[0])]: { kind: "red", text: "CHANGED TEXT" } } });
    expect(ids(fanOut(g, next, on))).toEqual([uidOf(4)]);
  });
  test("a public change rewrites every doc (paused flips)", () => {
    const g = submitting();
    expect(ids(fanOut(g, { ...g, paused: true }, on))).toEqual(viewersOf(g).map((t) => t.docId));
  });
  test("a version bump alone writes nothing", () => {
    for (const make of Object.values(FIXTURES)) { const g = make(); expect(fanOut(g, bump(g), on)).toEqual([]); }
  });
  test("skipping needs the stored docs at the running rev: any other stored rev rewrites every doc, so no doc can keep an older viewsRev", () => {
    for (const make of Object.values(FIXTURES)) {
      const g = make();
      const next = bump(g); // no visible change: the skip case
      expect(fanOut(g, next, { now: NOW, storedRev: PROJECTOR_REV })).toEqual([]);
      for (const storedRev of [0, PROJECTOR_REV - 1, PROJECTOR_REV + 1]) {
        if (storedRev === PROJECTOR_REV) continue;
        expect(ids(fanOut(g, next, { now: NOW, storedRev })), `storedRev ${storedRev}`).toEqual(viewersOf(next).map((t) => t.docId));
      }
    }
  });
  test("a vote changes only the voter's own myVotes (hand-built)", () => {
    const g = { ...lobby(), settings: settings({ peoplesChoice: true }) };
    const next = { ...g, votes: [{ round: 1, voter: `p:${pid(1)}`, cardId: "c_0000000001" }] };
    expect(ids(fanOut(g, next, on))).toEqual([uidOf(1)]);
  });
});

describe("F3 membership: new docs and tombstones", () => {
  test("a join adds a doc", () => {
    const g = lobby();
    const next = bump({ ...g, players: [...g.players, makePlayer(3, { status: "writing", name: "Name3" })] });
    const writes = fanOut(g, next, on);
    expect(ids(writes)).toContain(uidOf(3));
    expect(writes.find((w) => w.docId === uidOf(3))?.doc.view?.audience).toBe("player");
  });
  test("a LOBBY leave deletes the record: a gone tombstone at the new version, written after the live docs", () => {
    const g = lobby();
    const next = bump({ ...g, players: g.players.filter((p) => p.id !== pid(2)) });
    const writes = fanOut(g, next, on);
    const last = writes[writes.length - 1];
    expect(last?.docId).toBe(uidOf(2));
    expect(last?.doc.view).toStrictEqual({ kind: "departed", audience: "departed", gameId: g.id, version: next.version, reason: "gone" });
    expect(last?.doc.version).toBe(next.version);
    expect(last?.doc.enabled).toBe(true);
    expect(writes.filter((w) => w.docId === uidOf(2))).toHaveLength(1);
  });
  test("a later leave or removal is a departed doc in viewersOf order, not a tombstone", () => {
    const g = submitting();
    for (const reason of ["left", "removed"] as const) {
      const next = bump(park(g, 3, reason));
      const w = fanOut(g, next, on).find((x) => x.docId === uidOf(3));
      expect(w?.doc.view).toMatchObject({ audience: "departed", reason });
    }
  });
  test("the host leaving the seat never gets a tombstone (PJ9): their doc is the unseated-host view", () => {
    const g = submitting();
    const next = bump(unseatHost(g));
    const writes = fanOut(g, next, on);
    const host = writes.filter((w) => w.docId === HOST_UID);
    expect(host).toHaveLength(1);
    expect(host[0]?.doc.view).toMatchObject({ audience: "host" });
    expect(writes.some((w) => w.doc.view?.kind === "departed" && w.doc.view.reason === "gone")).toBe(false);
  });
});

describe("F4 clearDraft", () => {
  const flagged = (g: Game, next: Game): string[] => fanOut(g, next, on).filter((w) => w.clearDraft === true).map((w) => w.docId);
  test("exactly when the previous viewer was a player and the next is not: left, removed, gone, the host's seat", () => {
    const g = submitting();
    expect(flagged(g, bump(park(g, 3, "left")))).toEqual([uidOf(3)]);
    expect(flagged(g, bump(park(g, 3, "removed")))).toEqual([uidOf(3)]);
    expect(flagged(g, bump(unseatHost(g)))).toEqual([HOST_UID]);
    const l = lobby();
    expect(flagged(l, bump({ ...l, players: l.players.filter((p) => p.id !== pid(2)) }))).toEqual([uidOf(2)]);
  });
  test("never on a rebuild, a first write, a join, or an unchanged player", () => {
    for (const make of Object.values(FIXTURES)) {
      const g = make();
      expect(fanOut(g, g, off).some((w) => "clearDraft" in w)).toBe(false);
      expect(fanOut(null, g, off).some((w) => "clearDraft" in w)).toBe(false);
    }
    const g = lobby();
    expect(flagged(g, bump({ ...g, players: [...g.players, makePlayer(3, { status: "writing" })] }))).toEqual([]);
  });
  test("a departed viewer who is already departed is not flagged again", () => {
    const g = park(submitting(), 3, "left");
    expect(flagged(g, bump(park(g, 2, "left")))).toEqual([uidOf(2)]);
  });
});

describe("F5 the spectator doc when spectators are off", () => {
  const off0 = (): Game => ({ ...lobby(), settings: settings({ spectators: false }) });
  test("it is enabled false with a null view at the game's version", () => {
    const g = off0();
    const w = fanOut(null, g, on).find((x) => x.docId === "spectator");
    expect(w?.doc).toStrictEqual({ schema: VIEW_SCHEMA, viewsRev: PROJECTOR_REV, gameId: g.id, enabled: false, version: g.version, generatedAt: NOW, view: null });
  });
  test("toggling writes it both ways, and an unchanged disabled doc is skipped", () => {
    const g = off0();
    const enabled = { ...g, settings: settings({ spectators: true }) };
    expect(fanOut(g, bump(enabled), on).find((x) => x.docId === "spectator")?.doc).toMatchObject({ enabled: true, version: bump(enabled).version });
    expect(fanOut(enabled, bump(g), on).find((x) => x.docId === "spectator")?.doc).toMatchObject({ enabled: false, view: null });
    expect(fanOut(g, bump(g), on)).toEqual([]);
  });
});

describe("F6 the envelope", () => {
  test("every write: schema, viewsRev, gameId, version, generatedAt, and no draft keys", () => {
    for (const make of Object.values(FIXTURES)) {
      const g = make();
      for (const w of [...fanOut(null, g, off), ...fanOut(g, bump(park(g, 2, "left")), on)]) {
        expect(w.doc.schema).toBe(1);
        expect(w.doc.viewsRev).toBe(PROJECTOR_REV);
        expect(w.doc.gameId).toBe(g.id);
        expect(w.doc.generatedAt).toBe(NOW);
        expect(w.doc.enabled).toBe(w.doc.view !== null);
        if (w.doc.view !== null) expect(w.doc.version).toBe(w.doc.view.version);
        expect("draft" in w.doc || "draftSeq" in w.doc).toBe(false);
      }
    }
  });
  test("the doc's version is the new state's version, departed docs included", () => {
    const g = submitting();
    const next = bump(park(g, 3, "left"));
    for (const w of fanOut(g, next, on)) expect(w.doc.version).toBe(next.version);
  });
});

describe("F7 duplicate docIds", () => {
  test("a seat uid shared by a seated and a departed player throws rather than write one doc twice", () => {
    const g = submitting();
    const dup = { ...g, players: [...g.players, makePlayer(6, { status: "left", uid: uidOf(2) })] };
    expect(viewersOf(dup).filter((t) => t.docId === uidOf(2)).length).toBeGreaterThan(1);
    expect(() => fanOut(null, dup, off)).toThrow(EngineInvariantError);
  });
});

describe("F8 sameContent", () => {
  const doc = (g: Game): ViewDoc => ({ schema: VIEW_SCHEMA, viewsRev: PROJECTOR_REV, gameId: g.id, enabled: true, version: g.version, generatedAt: 1, view: project(g, { kind: "spectator", uid: null, isHost: false }) });
  test("it ignores the version, and only the version", () => {
    const g = submitting();
    expect(sameContent(doc(g), doc(bump(g)))).toBe(true);
    const later: ViewDoc = { ...doc(g), generatedAt: 99 };
    expect(sameContent(doc(g), later)).toBe(true);
    expect(sameContent(doc(g), doc({ ...g, paused: true }))).toBe(false);
    expect(sameContent(doc(g), doc(writing()))).toBe(false);
    expect(sameContent(doc(g), { ...doc(g), enabled: false, view: null })).toBe(false);
    expect(sameContent({ ...doc(g), enabled: false, view: null }, { ...doc(g), enabled: false, view: null })).toBe(true);
    expect(sameContent(doc(g), { ...doc(g), enabled: false })).toBe(false); // the flag alone counts, whatever the view
  });
});

describe("F9 an unchanged state writes nothing", () => {
  test("rejoin and reissue leave the state as it was: a structurally equal clone writes nothing, version and all", () => {
    for (const make of Object.values(FIXTURES)) { const g = make(); expect(fanOut(g, structuredClone(g), on)).toEqual([]); }
  });
});

describe("D1 the draft region and the region field lists", () => {
  test("draftRegion returns a fresh draft and the sequence number; null stays null", () => {
    const d = { red: ["a"], green: ["b"] };
    const r = draftRegion(d, 3);
    expect(r).toStrictEqual({ draftSeq: 3, draft: { red: ["a"], green: ["b"] } });
    r.draft?.red.push("x");
    expect(d.red).toEqual(["a"]);
    expect(draftRegion(null, 0)).toStrictEqual({ draftSeq: 0, draft: null });
  });
  test("the two lists are disjoint and together are exactly the ViewDoc keys", () => {
    expect(VIEW_REGION_FIELDS.filter((f) => (DRAFT_REGION_FIELDS as readonly string[]).includes(f))).toEqual([]);
    expect([...VIEW_REGION_FIELDS, ...DRAFT_REGION_FIELDS].map(String).sort()).toEqual(Object.keys(ViewDocSchema.shape).sort());
  });
  test("the view-region list is the key set of a write's doc, in that order", () => {
    const w = must(fanOut(null, lobby(), off)[0]);
    expect(Object.keys(w.doc)).toEqual([...VIEW_REGION_FIELDS]);
  });
  test("ViewWrite.doc cannot carry a draft region (compile time)", () => {
    const w = must(fanOut(null, lobby(), off)[0]);
    // @ts-expect-error draft is not part of a write's doc
    const bad: ViewWrite = { docId: "x", doc: { ...w.doc, draft: null } };
    expect(bad.docId).toBe("x");
  });
});

describe("X1 speed (loose)", () => {
  test("fanOut with skip over the worst-case fixture has a p95 under 25 ms in 200 runs", () => {
    const g = maximalJudging();
    const next = bump({ ...g, paused: true });
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      fanOut(g, next, on);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)] ?? Infinity).toBeLessThan(25);
  });
  test("paused is a public change in this fixture, so every doc was really written", () => {
    expect(fanOut(paused(), bump({ ...paused(), paused: false }), on)).not.toEqual([]);
  });
});

describe("the real projector is the default", () => {
  test("fanOut equals fanOutWith over makeProjector and PROJECTOR_REV", () => {
    const g = judging();
    expect(fanOut(null, g, off)).toStrictEqual(fanOutWith(real, null, g, off));
  });
});
