// #29: S1 the UTF-8 counter, S2 the size budget at the worst case, S3 the hard cap (LLD 2 PJ14, 8.3).
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { VIEW_DOC_BUDGET_BYTES, VIEW_DOC_MAX_BYTES, VIEW_SCHEMA } from "@dc/contracts";
import type { GameView, ViewDoc } from "@dc/contracts";
import { EngineInvariantError } from "../../src/errors";
import { draftRegion, assertViewDoc, fanOut, fanOutWith } from "../../src/project/fanout";
import { makeProjector, viewersOf } from "../../src/project";
import { PROJECTOR_REV } from "../../src/project/rev";
import { utf8Length } from "../../src/project/size";
import { assertProperty } from "../support/fc";
import { judging } from "./fixtures";
import { maximalFinished, maximalJudging, text80 } from "./maximal";

const encoder = new TextEncoder();

describe("S1 utf8Length equals TextEncoder's length", () => {
  test("fixed cases: ASCII, 2 and 3 byte characters, a surrogate pair, lone surrogates (3 bytes, as U+FFFD)", () => {
    for (const s of ["", "abc", "é", "€", "\u{1F600}", "a\u{1F600}b", "\ud800", "\udc00", "\ud800a", "a\udc00", "\udc00\ud800", "\u{10FFFF}", "\u0000", "\u007f\u0080߿ࠀ￿"]) {
      expect(utf8Length(s), JSON.stringify(s)).toBe(encoder.encode(s).length);
    }
  });
  test("property: any sequence of UTF-16 units, surrogates over-represented", () => {
    const unit = fc.oneof(fc.integer({ min: 0, max: 0x7f }), fc.integer({ min: 0x80, max: 0x7ff }), fc.integer({ min: 0x800, max: 0xffff }), fc.integer({ min: 0xd800, max: 0xdfff }), fc.integer({ min: 0xd800, max: 0xdbff }));
    assertProperty(fc.property(fc.array(unit, { maxLength: 60 }), (units) => {
      const s = String.fromCharCode(...units);
      expect(utf8Length(s)).toBe(encoder.encode(s).length);
    }));
  });
});

describe("S2 every doc of the maximal fixtures stays within the 64 KiB budget", () => {
  const worstDraft = { red: Array.from({ length: 10 }, (_, i) => text80(`r${i}`)), green: Array.from({ length: 8 }, (_, i) => text80(`g${i}`)) };
  for (const [name, make] of [["JUDGING, ten seated, nine reveal cards with pitches", maximalJudging], ["FINISHED, 1500 own votes", maximalFinished]] as const) {
    test(name, () => {
      const g = make();
      expect(viewersOf(g).length).toBeGreaterThanOrEqual(11);
      const writes = fanOut(null, g, { now: 1_700_000_000_000, storedRev: 0 });
      expect(writes.length).toBe(viewersOf(g).length);
      let largest = 0;
      for (const w of writes) {
        const withDraft = { ...w.doc, ...draftRegion(worstDraft, 999_999) };
        const bytes = utf8Length(JSON.stringify(withDraft));
        largest = Math.max(largest, bytes);
        expect(bytes, w.docId).toBeLessThanOrEqual(VIEW_DOC_BUDGET_BYTES);
      }
      expect(largest).toBeGreaterThan(8 * 1024); // the fixture really is large; a shrunk fixture must not pass silently
    });
  }
  test("the 1500 votes are really in the host's doc", () => {
    const g = maximalFinished();
    const host = fanOut(null, g, { now: 1, storedRev: 0 }).find((w) => w.doc.view?.audience === "player" && w.doc.view.you.isHost);
    const view = host?.doc.view;
    expect(view?.audience === "player" ? Object.keys(view.you.myVotes).length : 0).toBe(1500);
  });
});

describe("S3 the 512 KiB hard cap", () => {
  const g = judging();
  const spectator = (): ViewDoc => {
    const view = makeProjector(g)({ kind: "spectator", uid: null, isHost: false });
    return { schema: VIEW_SCHEMA, viewsRev: PROJECTOR_REV, gameId: g.id, enabled: true, version: g.version, generatedAt: 5, view };
  };
  const padTo = (doc: ViewDoc, bytes: number): ViewDoc => {
    const view = doc.view as Extract<GameView, { audience: "spectator" }>;
    const base = utf8Length(JSON.stringify(doc));
    // 4-byte characters first (two UTF-16 units each), ASCII for the remainder: JSON.length and the byte count differ by a lot, so a counter that measures units cannot pass.
    const rest = bytes - base;
    const pad = "\u{1F600}".repeat(Math.floor(rest / 4)) + "x".repeat(rest % 4);
    const players = view.players.map((p, i) => (i === 0 ? { ...p, name: p.name + pad } : p));
    return { ...doc, view: { ...view, players } };
  };
  const ctx = { gameId: g.id, viewsRev: PROJECTOR_REV };
  test("a doc of exactly the cap passes and one byte over throws EngineInvariantError", () => {
    const at = padTo(spectator(), VIEW_DOC_MAX_BYTES);
    expect(utf8Length(JSON.stringify(at))).toBe(VIEW_DOC_MAX_BYTES);
    expect(JSON.stringify(at).length).toBeLessThan(VIEW_DOC_MAX_BYTES - 100_000); // the padding really is multi-byte
    expect(() => assertViewDoc(at, ctx)).not.toThrow();
    const over = padTo(spectator(), VIEW_DOC_MAX_BYTES + 1);
    expect(() => assertViewDoc(over, ctx)).toThrow(EngineInvariantError);
  });
  test("an inflated projector through fanOut throws at the cap, and the message carries no payload text", () => {
    const inflate = (game: Parameters<typeof makeProjector>[0]) => {
      const at = makeProjector(game);
      return (v: Parameters<ReturnType<typeof makeProjector>>[0]): GameView => {
        const view = at(v);
        if (view.kind !== "live") return view;
        return { ...view, players: view.players.map((p, i) => (i === 0 ? { ...p, name: "CARDSECRET".repeat(70_000) } : p)) };
      };
    };
    let message = "";
    try {
      fanOutWith({ project: inflate, rev: PROJECTOR_REV }, null, g, { now: 1, storedRev: 0 });
    } catch (e) {
      expect(e).toBeInstanceOf(EngineInvariantError);
      message = (e as Error).message;
    }
    expect(message).toContain("hard cap");
    expect(message).not.toContain("CARDSECRET");
  });
});
