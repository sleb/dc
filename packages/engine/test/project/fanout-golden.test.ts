// #29: G1 the goldens of 2.3: the ViewDoc envelope per audience, the draft region and the 10-player size table. Bun snapshots, hand-reviewed against LLD 2 4.1 before they were frozen;
// `CI=1` refuses to write a new one. The envelope cells (envelope-cells.ts) and the 43 view goldens of 2.2 are both in the PROJECTOR_REV fingerprint pinned by rev-pins.json (rev.test.ts).
import { describe, expect, test } from "bun:test";
import { fanOut } from "../../src/project/fanout";
import { utf8Length } from "../../src/project/size";
import type { Game } from "../../src/types";
import { ENVELOPE_CELLS } from "./envelope-cells";
import { maximalFinished, maximalJudging } from "./maximal";

const NOW = 1_700_000_000_000;

describe("G1 envelope goldens", () => {
  for (const c of ENVELOPE_CELLS.filter((x) => x.name !== "draft region")) test(c.name, () => expect(c.value()).toMatchSnapshot());
});

describe("G1 the draft region", () => {
  test("with a draft and with none", () => expect(ENVELOPE_CELLS.find((c) => c.name === "draft region")?.value()).toMatchSnapshot());
});

describe("G1 the size table: serialized bytes of every doc of the 10-player maximal fixtures", () => {
  test("by docId order", () => {
    const table = (g: Game) => fanOut(null, g, { now: NOW, skipUnchanged: false }).map((w) => [w.docId, w.doc.view?.audience ?? "disabled", utf8Length(JSON.stringify(w.doc))]);
    expect({ judging: table(maximalJudging()), finished: table(maximalFinished()) }).toMatchSnapshot();
  });
});
