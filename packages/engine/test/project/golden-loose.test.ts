// #30 (cross-step review of 2.2 and 2.3): LLD 5 section 10.1 says every golden parses with the strict AND the loose schema. The 43 view goldens and the 7 envelope cells are checked here, strict and loose.
import { describe, expect, test } from "bun:test";
import { GameViewLooseSchema, GameViewSchema, ViewDocLooseSchema, ViewDocSchema } from "@dc/contracts";
import { CELLS, goldenOf } from "./cells";
import { ENVELOPE_CELLS } from "./envelope-cells";

describe("every golden view parses with the strict and the loose schema", () => {
  test("the 43 view cells", () => {
    expect(CELLS.length).toBe(43);
    for (const c of CELLS) {
      const g = goldenOf(c);
      expect(GameViewSchema.safeParse(g).success, `${c.name} strict`).toBe(true);
      expect(GameViewLooseSchema.safeParse(g).success, `${c.name} loose`).toBe(true);
    }
  });

  test("the 7 envelope cells (six docs as fanOut writes them, and the draft region merged into a player doc)", () => {
    expect(ENVELOPE_CELLS.length).toBe(7);
    const docs: { name: string; doc: unknown }[] = [];
    for (const c of ENVELOPE_CELLS) {
      const v = c.value();
      if (c.name === "draft region") continue;
      docs.push({ name: c.name, doc: (v as { doc: unknown }).doc });
    }
    const region = ENVELOPE_CELLS.find((c) => c.name === "draft region")?.value() as { draftSeq: number; draft: unknown }[];
    const player = docs[0]?.doc as Record<string, unknown>;
    for (const r of region) docs.push({ name: `draft region ${r.draftSeq}`, doc: { ...player, ...r } });
    expect(docs.length).toBe(8);
    for (const d of docs) {
      expect(ViewDocSchema.safeParse(d.doc).success, `${d.name} strict`).toBe(true);
      expect(ViewDocLooseSchema.safeParse(d.doc).success, `${d.name} loose`).toBe(true);
    }
  });
});
