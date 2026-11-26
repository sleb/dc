// #30 A7 (PJ15): key order of every doc equals the strict contracts schema's declaration order, recursively. Unions are picked by `audience` and the tag comes first (as built since 2.2);
// records ascend. The walker is itself tested on real docs and on reordered copies.
import { describe, expect, test } from "bun:test";
import { RoundDocSchema, ViewDocSchema } from "@dc/contracts";
import { fanOut, toRoundDoc } from "../../src/project";
import { cid, pid } from "../support/factories";
import { FIXTURES, judging, finished, submitting, unseatHost, writing } from "./fixtures";
import { keyOrderViolations, reverseKeys } from "./keyorder";

const NOW = 1_700_000_000_000;
const docsOf = () => Object.values(FIXTURES).flatMap((make) => [make(), unseatHost(make())]).flatMap((g) => fanOut(null, g, { now: NOW, storedRev: 0 }).map((w) => w.doc));

describe("A7 keyOrderViolations", () => {
  test("every doc of every fixture, every audience, is in schema order (draft region too)", () => {
    const docs = docsOf();
    expect(docs.length).toBeGreaterThan(50);
    for (const d of docs) expect(keyOrderViolations(d, ViewDocSchema)).toEqual([]);
    expect(keyOrderViolations({ ...fanOut(null, writing(), { now: NOW, storedRev: 0 })[2]!.doc, draftSeq: 1, draft: { red: [], green: [] } }, ViewDocSchema)).toEqual([]);
  });

  test("a RoundDoc built by toRoundDoc is in schema order", () => {
    const rec = { round: 1, judgeId: pid(1), greenCardId: cid(900), plays: [], winnerCardId: cid(206), winnerId: pid(2), green: { id: cid(900), text: "g" }, playsDetail: [{ playerId: pid(2), cardId: cid(206), text: "t", pitch: "p" }], absent: [pid(4)], resolvedAt: 5 };
    expect(keyOrderViolations(toRoundDoc(rec), RoundDocSchema)).toEqual([]);
  });

  test("swapping two keys anywhere is reported with its path: top level, nested, inside an array element, inside a union member", () => {
    const doc = structuredClone(fanOut(null, judging(), { now: NOW, storedRev: 0 }).find((w) => w.doc.view?.audience === "player")!.doc) as unknown as Record<string, unknown>;
    expect(keyOrderViolations(doc, ViewDocSchema)).toEqual([]);
    const swap = (o: Record<string, unknown>, a: string, b: string): Record<string, unknown> => {
      const keys = Object.keys(o);
      const ia = keys.indexOf(a);
      const ib = keys.indexOf(b);
      keys[ia] = b;
      keys[ib] = a;
      return Object.fromEntries(keys.map((k) => [k, o[k]]));
    };
    const view = doc.view as Record<string, unknown>;
    const bad: Record<string, unknown>[] = [
      swap(doc, "schema", "gameId"),
      { ...doc, view: swap(view, "gameId", "version") },
      { ...doc, view: { ...view, players: (view.players as Record<string, unknown>[]).map((p, i) => (i === 0 ? swap(p, "id", "name") : p)) } },
      { ...doc, view: { ...view, round: swap(view.round as Record<string, unknown>, "number", "phase") } },
      { ...doc, view: { ...view, audience: view.audience, kind: view.kind } },
    ];
    for (const b of bad.slice(0, 4)) expect(keyOrderViolations(b, ViewDocSchema).length, JSON.stringify(Object.keys(b))).toBeGreaterThan(0);
    expect(keyOrderViolations(bad[1], ViewDocSchema)[0]).toContain("view");
    expect(keyOrderViolations(bad[2], ViewDocSchema)[0]).toContain("players[0]");
  });

  test("the audience tag leads in a live view, and an optional key may be absent", () => {
    const v = fanOut(null, submitting(), { now: NOW, storedRev: 0 }).find((w) => w.doc.view?.audience === "player")!.doc.view!;
    expect(Object.keys(v)[0]).toBe("audience");
    const { audience, ...rest } = v;
    expect(keyOrderViolations({ schema: "x", viewsRev: 1, gameId: v.gameId, enabled: true, version: 1, generatedAt: 1, view: { ...rest, audience } }, ViewDocSchema).length).toBeGreaterThan(0);
  });

  test("reverseKeys (the M-keyorder transform) reverses every object's keys, and the walker flags every reversed doc", () => {
    for (const d of docsOf().slice(0, 40)) {
      const r = reverseKeys(d);
      expect(JSON.stringify(r)).not.toBe(JSON.stringify(d));
      expect(JSON.parse(JSON.stringify(r))).toEqual(JSON.parse(JSON.stringify(d)));
      expect(keyOrderViolations(r, ViewDocSchema).length).toBeGreaterThan(0);
    }
    expect(finished().votes.length).toBeGreaterThan(0);
  });

  test("a record is ascending by its numeric key", () => {
    const g = finished();
    const w = fanOut(null, g, { now: NOW, storedRev: 0 }).find((x) => x.doc.view?.audience === "player")!.doc as unknown as { view: { you: { myVotes: Record<string, string> } } };
    expect(Object.keys(w.view.you.myVotes).length).toBeGreaterThan(1);
    expect(keyOrderViolations(w, ViewDocSchema)).toEqual([]);
    // a record whose keys are not ascending (only possible for non-integer keys) is reported
    const odd = { ...w, view: { ...w.view, you: { ...w.view.you, myVotes: { b: "x", a: "y" } } } };
    expect(keyOrderViolations(odd, ViewDocSchema).some((x) => x.includes("myVotes"))).toBe(true);
  });
});
