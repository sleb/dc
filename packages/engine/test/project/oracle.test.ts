// #30 O1 to O4: the forbidden-values oracle is tested before it is trusted (LLD 2 11.2). Each forbidden class must flag a planted leak; the real projector's docs must raise nothing.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { RoundDoc } from "@dc/contracts";
import { PROJECTOR_REV, project, toRoundDoc, viewersOf } from "../../src/project";
import type { Game, GameDrafts } from "../../src/types";
import { cid, pid } from "../support/factories";
import { CELLS } from "./cells";
import { DEP, FIXTURES, HU, P, SPEC, finished, judging, submitting, unseatHost, writing } from "./fixtures";
import { maximalFinished, maximalJudging } from "./maximal";
import { allowedFor, checkDoc, checkRoundDoc, forbiddenFor } from "./oracle";
import type { Detector, OracleViewer } from "./oracle";
import { storedDoc } from "./stored";

const range = (i: number, a: number, b: number) => Array.from({ length: b - a }, (_, k) => cid(100 * i + a + k));
const sorted = (s: ReadonlySet<string>) => [...s].sort();
const NONE: GameDrafts = {};

describe("O1 allowed(t) equals the 11.2 table, per audience and phase", () => {
  test("JUDGING: a submitter gets own hand, own play, the green card and the reveal list; the judge, a non-submitter likewise; the spectator and the unseated host the public part only; a departed viewer nothing", () => {
    const g = judging(); // judge 1, plays by 4, 2, 3 (cards 406, 206, 306), revealOrder 306, 206, 406, green 900
    const reveal = [cid(306), cid(206), cid(406)];
    expect(sorted(allowedFor(g, NONE, P(3)).ids)).toEqual(sorted(new Set([...range(3, 0, 6), cid(306), cid(900), ...reveal])));
    expect(sorted(allowedFor(g, NONE, P(5)).ids)).toEqual(sorted(new Set([...range(5, 0, 7), cid(900), ...reveal])));
    expect(sorted(allowedFor(g, NONE, P(1)).ids)).toEqual(sorted(new Set([...range(1, 0, 7), cid(900), ...reveal])));
    expect(sorted(allowedFor(g, NONE, SPEC).ids)).toEqual(sorted(new Set([cid(900), ...reveal])));
    expect(sorted(allowedFor(unseatHost(g), NONE, HU).ids)).toEqual(sorted(new Set([cid(900), ...reveal])));
    expect(allowedFor(g, NONE, DEP(3, "left")).ids.size).toBe(0);
    // every allowed id carries its text with it
    expect(allowedFor(g, NONE, SPEC).texts.has(g.cards[cid(206)]?.text as string)).toBe(true);
  });

  test("SUBMITTING: only the green card is public; a submitter also has the own play; nobody sees a reveal list", () => {
    const g = submitting(); // judge 1, plays by 3 then 2
    expect(sorted(allowedFor(g, NONE, SPEC).ids)).toEqual([cid(900)]);
    expect(sorted(allowedFor(g, NONE, P(2)).ids)).toEqual(sorted(new Set([...range(2, 0, 6), cid(206), cid(900)])));
    expect(allowedFor(g, NONE, P(2)).ids.has(cid(306))).toBe(false);
    expect(allowedFor(g, NONE, P(2)).pitches.has("PITCH-P2")).toBe(true);
    expect(allowedFor(g, NONE, P(4)).pitches.size).toBe(0);
  });

  test("LOBBY and WRITING: nothing public; the own draft texts are allowed to their author only", () => {
    const g = writing();
    const drafts: GameDrafts = { [pid(0)]: { red: ["R0001x", "R0002x"], green: ["G0001x"] }, [pid(2)]: { red: ["R0003x"], green: [] } };
    expect([...allowedFor(g, drafts, P(0)).texts].sort()).toEqual(["G0001x", "R0001x", "R0002x"]);
    expect([...allowedFor(g, drafts, P(2)).texts]).toEqual(["R0003x"]);
    expect(allowedFor(g, drafts, SPEC).texts.size).toBe(0);
    const f = forbiddenFor(g, drafts, P(2));
    expect(f.draftTexts.has("R0001x")).toBe(true); // another player's draft
    expect(f.draftTexts.has("R0003x")).toBe(false);
    expect(f.texts.has("R0003x")).toBe(false);
    expect(f.texts.has("POOLRED00")).toBe(true);
    expect(f.ids.has(cid(2000))).toBe(true);
  });

  test("FINISHED: the podium is id only, recomputed here from the votes (most votes, then earlier round, then play order); texts stay forbidden", () => {
    const g = finished();
    const a = allowedFor(g, NONE, SPEC);
    expect(sorted(a.idOnly)).toEqual(sorted(new Set([cid(206), cid(207), cid(1)])));
    expect(a.ids.has(cid(206))).toBe(false);
    expect(forbiddenFor(g, NONE, SPEC).texts.has(g.cards[cid(206)]?.text as string)).toBe(true);
    expect(forbiddenFor(g, NONE, SPEC).ids.has(cid(206))).toBe(false);
    expect(sorted(allowedFor(g, NONE, P(3)).ids)).toEqual(sorted(new Set(finished().players[3]?.hand)));
  });
});

type Doc = { view: Record<string, unknown> | null } & Record<string, unknown>;
const live = (g: Game, viewer: OracleViewer & Parameters<typeof project>[1], drafts: GameDrafts = NONE): Doc => storedDoc(g, drafts, viewer, project(g, viewer)) as Doc;
const kinds = (fs: { detector: Detector }[]) => [...new Set(fs.map((f) => f.detector))].sort();

describe("O2 each forbidden class flags a planted leak in a golden-doc copy", () => {
  const g = judging();
  const v = P(5); // a non-submitter
  const plant = (mutate: (d: Doc) => void, game: Game = g, drafts: GameDrafts = NONE, viewer = v): string[] => {
    const d = structuredClone(live(game, viewer, drafts));
    mutate(d);
    return kinds(checkDoc(game, drafts, viewer, d));
  };
  const view = (d: Doc) => d.view as { players: Record<string, unknown>[]; round: { reveal: Record<string, unknown>[] } & Record<string, unknown>; settings: { variants: Record<string, unknown> }; you: Record<string, unknown> } & Record<string, unknown>;

  test("the unmodified doc raises nothing (the planted tests mean something)", () => {
    expect(checkDoc(g, NONE, v, live(g, v))).toEqual([]);
  });

  test("cards: another player's hand card text or id, a pool card, a card outside the allowlist", () => {
    expect(plant((d) => { view(d).players[0]!.name = g.cards[cid(100)]!.text; })).toContain("cards");
    expect(plant((d) => { view(d).players[0]!.name = cid(101); })).toContain("cards");
    expect(plant((d) => { view(d).players[0]!.name = cid(5003); })).toContain("cards");
  });

  test("drafts: another player's draft text, including a player whose draft is the only copy", () => {
    const w = writing();
    const drafts: GameDrafts = { [pid(0)]: { red: ["R0001x"], green: [] } };
    expect(plant((d) => { view(d).players[1]!.name = "R0001x"; }, w, drafts, P(2))).toContain("drafts");
    expect(plant((d) => { d.draft = { red: ["R0001x"], green: [] }; }, w, drafts, P(2))).toContain("othersData"); // a draft region that is not the viewer's own
  });

  test("pending ownership: a pending card id beside a playerId (as a key, as a value), or at a path off the whitelist", () => {
    expect(plant((d) => { view(d).round.reveal[0]!.playerId = pid(2); })).toContain("ownership");
    expect(plant((d) => { view(d).round.reveal[0]!.owner = pid(2); })).toContain("ownership");
    expect(plant((d) => { view(d).players[0]!.pending = cid(206); })).toContain("ownership");
  });

  test("identity: a uid, the host's uid, the seat prefix, a token marker, and the room code in a doc that has none", () => {
    expect(plant((d) => { view(d).players[0]!.name = "host-uid"; })).toContain("identity");
    expect(plant((d) => { view(d).players[0]!.name = `seat:${g.id}:${pid(3)}`; })).toContain("identity");
    expect(plant((d) => { view(d).players[0]!.name = "https://x/#k=abc"; })).toContain("identity");
    expect(plant((d) => { view(d).players[0]!.name = "a token"; })).toContain("identity");
    expect(plant((d) => { view(d).players[0]!.name = "a secret"; })).toContain("identity");
    expect(plant((d) => { view(d).players[0]!.name = g.roomCode; })).toEqual([]); // a seated player's doc carries it in `you`
    expect(plant((d) => { view(d).players[0]!.name = g.roomCode; }, g, NONE, SPEC)).toContain("identity");
    expect(plant((d) => { view(d).players[0]!.name = g.roomCode; }, g, NONE, P(0))).toEqual([]); // the host panel may carry it
  });

  test("internals: each internal key name anywhere in the tree", () => {
    for (const k of ["uid", "hostId", "seed", "episode", "waitingSince", "reminderDueAt", "changedAtVersion", "openedAt", "submissions", "revealOrder", "pools", "cards", "scorePile"]) {
      expect(plant((d) => { view(d).round[k] = 1; }), k).toContain("internals");
      expect(plant((d) => { view(d)[k] = 1; }), k).toContain("internals");
    }
  });

  test("votes: the aggregate's vote list and a voter string anywhere in a view, but not a podium's vote count", () => {
    const f = finished();
    const viewer = P(0);
    const doc = (m: (d: Doc) => void): string[] => { const d = structuredClone(live(f, viewer)); m(d); return kinds(checkDoc(f, NONE, viewer, d)); };
    expect(doc(() => undefined)).toEqual([]); // awards.podium[n].votes is a public count
    expect(doc((d) => { (d.view as Record<string, unknown>).votes = [{ voter: "x" }]; })).toContain("internals");
    expect(doc((d) => { (d.view as { players: Record<string, unknown>[] }).players[0]!.voter = "x"; })).toContain("internals");
    expect(doc((d) => { (d.view as { players: Record<string, unknown>[] }).players[0]!.name = `p:${pid(1)}`; })).toContain("identity");
    expect(doc((d) => { (d.view as { players: Record<string, unknown>[] }).players[0]!.name = "s:spectator-uid-1"; })).toContain("identity");
  });

  test("unknown shape: a key outside the strict schema", () => {
    expect(plant((d) => { view(d).mystery = 1; })).toContain("strictParse");
    expect(plant((d) => { delete view(d).phase; })).toContain("strictParse");
  });

  test("others' data: powerUsage, myVotes, hand, writeTarget under players[]; a you block for a viewer who has none", () => {
    for (const k of ["powerUsage", "myVotes", "hand", "writeTarget"]) expect(plant((d) => { view(d).players[0]![k] = {}; }), k).toContain("othersData");
    expect(plant((d) => { view(d).you.powerUsage = { writeIn: true, redraw: false }; })).toContain("othersData"); // not this player's own value
    expect(plant((d) => { view(d).you = { playerId: pid(1) }; }, g, NONE, SPEC)).toContain("othersData");
  });

  test("write-in markers: off the whitelist in a view, and in a RoundDoc; the two whitelisted paths are not flagged", () => {
    for (const k of ["variant", "writeIn", "isWriteIn", "writtenIn"]) expect(plant((d) => { view(d).round.reveal[0]![k] = true; }), k).toContain("writeInMarker");
    expect(plant((d) => { view(d).settings.variants.writeIn = true; })).toEqual([]);
    expect(plant((d) => { (view(d).you.powerUsage as Record<string, unknown>).writeIn = false; })).toEqual([]);
    const rec = { round: 1, judgeId: pid(1), greenCardId: cid(900), plays: [], winnerCardId: cid(206), winnerId: pid(2), green: { id: cid(900), text: "the green card" }, playsDetail: [{ playerId: pid(2), cardId: cid(206), text: g.cards[cid(206)]!.text }, { playerId: pid(3), cardId: cid(306), text: g.cards[cid(306)]!.text }], absent: [], resolvedAt: 5 };
    const doc = structuredClone(toRoundDoc(rec)) as RoundDoc & { plays: Record<string, unknown>[] };
    expect(checkRoundDoc(g, rec, doc)).toEqual([]);
    for (const k of ["variant", "writeIn", "isWriteIn", "writtenIn"]) {
      const bad = structuredClone(doc);
      bad.plays[0]![k] = true;
      expect(kinds(checkRoundDoc(g, rec, bad)), k).toContain("writeInMarker");
    }
  });

  test("RoundDoc: votes, hands, drafts, another round's card, an owner of a pending card", () => {
    const rec = { round: 1, judgeId: pid(1), greenCardId: cid(900), plays: [], winnerCardId: cid(206), winnerId: pid(2), green: { id: cid(900), text: "the green card" }, playsDetail: [{ playerId: pid(2), cardId: cid(206), text: g.cards[cid(206)]!.text }], absent: [], resolvedAt: 5 };
    const base = toRoundDoc(rec);
    const bad = (m: (d: Record<string, unknown>) => void): string[] => { const d = structuredClone(base) as unknown as Record<string, unknown>; m(d); return kinds(checkRoundDoc(g, rec, d as unknown as RoundDoc)); };
    expect(bad((d) => { d.votes = []; })).toContain("internals");
    expect(bad((d) => { d.hand = []; })).toContain("othersData");
    expect(bad((d) => { (d.plays as Record<string, unknown>[])[0]!.text = g.cards[cid(100)]!.text; })).toContain("cards");
    expect(bad((d) => { (d.plays as Record<string, unknown>[])[0]!.pitch = "PITCH-P3"; })).toContain("cards");
    expect(bad((d) => { d.owner = pid(3); (d.plays as Record<string, unknown>[])[0]!.cardId = cid(306); })).toContain("ownership");
  });
});

describe("O3 no false positives on the real projector", () => {
  test("every fixture, every viewer of viewersOf, with and without drafts", () => {
    const drafts: GameDrafts = { [pid(0)]: { red: ["R0001x"], green: ["G0001x"] }, [pid(2)]: { red: ["R0002x"], green: [] } };
    let docs = 0;
    for (const [name, make] of Object.entries(FIXTURES)) {
      const g = make();
      for (const variant of [g, unseatHost(g)]) {
        for (const t of viewersOf(variant)) {
          for (const d of [NONE, drafts]) {
            const doc = storedDoc(variant, d, t.viewer, project(variant, t.viewer));
            expect(checkDoc(variant, d, t.viewer, doc), `${name} ${t.docId}`).toEqual([]);
            docs++;
          }
        }
      }
    }
    expect(docs).toBeGreaterThan(100);
  });

  test("the 43 golden cells", () => {
    expect(CELLS.length).toBe(43);
    for (const c of CELLS) {
      const g = c.game();
      const viewer = c.viewer(g);
      expect(checkDoc(g, NONE, viewer, storedDoc(g, NONE, viewer, project(g, viewer))), c.name).toEqual([]);
    }
  });

  test("the maximal fixtures (4-byte texts, a full hand, nine reveals, 1500 votes)", () => {
    for (const g of [maximalJudging(), maximalFinished()]) for (const t of viewersOf(g)) expect(checkDoc(g, NONE, t.viewer, storedDoc(g, NONE, t.viewer, project(g, t.viewer))), t.docId).toEqual([]);
  });

  test("the stored doc is the envelope the Store writes: view region plus the viewer's own draft region only", () => {
    const w = writing();
    const drafts: GameDrafts = { [pid(2)]: { red: ["R0003x"], green: [] } };
    expect((storedDoc(w, drafts, P(2), project(w, P(2))) as { draft: unknown }).draft).toEqual({ red: ["R0003x"], green: [] });
    expect(Object.hasOwn(storedDoc(w, drafts, SPEC, project(w, SPEC)) as object, "draft")).toBe(false);
    expect((storedDoc(w, drafts, P(1), project(w, P(1))) as { draft: unknown }).draft).toBeNull();
    expect((storedDoc(w, drafts, P(1), project(w, P(1))) as { viewsRev: number }).viewsRev).toBe(PROJECTOR_REV);
  });
});

describe("O4 the oracle is independent of the code it checks", () => {
  test("oracle.ts imports nothing from src/selectors, src/project or src/rules", () => {
    const src = readFileSync(new URL("./oracle.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1] as string);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i, i).not.toMatch(/src\/(selectors|project|rules)|\.\.\/selectors|\.\.\/rules/);
  });
});
