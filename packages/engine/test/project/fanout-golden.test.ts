// #29: G1 the goldens of 2.3: the ViewDoc envelope per audience, the draft region and the 10-player size table. Bun snapshots, hand-reviewed against LLD 2 4.1 before they were frozen;
// `CI=1` refuses to write a new one. The 43 view goldens of 2.2 are pinned by rev-pins.json (rev.test.ts).
import { describe, expect, test } from "bun:test";
import { draftRegion, fanOut } from "../../src/project/fanout";
import { utf8Length } from "../../src/project/size";
import type { Game } from "../../src/types";
import { park } from "../support/round-fixtures";
import { judging, lobby, settings, submitting, uidOf, unseatHost } from "./fixtures";
import { maximalFinished, maximalJudging } from "./maximal";

const NOW = 1_700_000_000_000;
const doc = (g: Game, docId: string) => fanOut(null, g, { now: NOW, skipUnchanged: false }).find((w) => w.docId === docId);

describe("G1 envelope goldens", () => {
  test("player (a non-host in SUBMITTING)", () => expect(doc(submitting(), uidOf(2))).toMatchSnapshot());
  test("unseated host", () => expect(doc(unseatHost(judging()), uidOf(0))).toMatchSnapshot());
  test("enabled spectator", () => expect(doc(judging(), "spectator")).toMatchSnapshot());
  test("disabled spectator", () => expect(doc({ ...lobby(), settings: settings({ spectators: false }) }, "spectator")).toMatchSnapshot());
  test("departed (left)", () => expect(doc(park(submitting(), 3, "left"), uidOf(3))).toMatchSnapshot());
  test("gone tombstone with clearDraft", () => {
    const g = lobby();
    const next = { ...g, version: g.version + 1, players: g.players.filter((p) => p.id !== g.players[2]?.id) };
    expect(fanOut(g, next, { now: NOW, skipUnchanged: true }).find((w) => w.docId === uidOf(2))).toMatchSnapshot();
  });
});

describe("G1 the draft region", () => {
  test("with a draft and with none", () => expect([draftRegion({ red: ["R1", "R2"], green: ["G1"] }, 4), draftRegion(null, 0)]).toMatchSnapshot());
});

describe("G1 the size table: serialized bytes of every doc of the 10-player maximal fixtures", () => {
  test("by docId order", () => {
    const table = (g: Game) => fanOut(null, g, { now: NOW, skipUnchanged: false }).map((w) => [w.docId, w.doc.view?.audience ?? "disabled", utf8Length(JSON.stringify(w.doc))]);
    expect({ judging: table(maximalJudging()), finished: table(maximalFinished()) }).toMatchSnapshot();
  });
});
