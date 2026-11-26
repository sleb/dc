// #28: GD1 one golden per (state, viewer) of LLD 2 section 11.5, GD2 the coverage matrix. Bun object snapshots; key order is not pinned here (PJ15 is #30), and the draft-region goldens are #29's.
// Every cell is reviewed by hand against LLD 2 sections 5.1 to 5.3 before it is frozen; the explicit assertions of redaction.test.ts and turn.test.ts are the first oracle, never the snapshot.
import { describe, expect, test } from "bun:test";
import { GameViewSchema } from "@dc/contracts";
import { AUDIENCES, CELLS, NOT_APPLICABLE, PHASES, goldenOf } from "./cells";

describe("GD1 goldens", () => {
  for (const c of CELLS) {
    test(c.name, () => {
      const view = goldenOf(c);
      expect(GameViewSchema.safeParse(view).success).toBe(true);
      expect(view).toMatchSnapshot();
    });
  }
});

describe("GD2 the coverage matrix", () => {
  test("every applicable (phase, audience) pair has at least one golden", () => {
    const covered = new Set(CELLS.map((c) => `${c.phase}/${c.audience}`));
    const missing: string[] = [];
    for (const phase of PHASES) for (const audience of AUDIENCES) {
      if (NOT_APPLICABLE.some(([p, a]) => p === phase && a === audience)) continue;
      if (!covered.has(`${phase}/${audience}`)) missing.push(`${phase}/${audience}`);
    }
    expect(missing).toEqual([]);
  });
  test("the not-applicable cells really have no golden, so the list cannot hide a gap", () => {
    for (const [phase, audience] of NOT_APPLICABLE) expect(CELLS.some((c) => c.phase === phase && c.audience === audience)).toBe(false);
  });
  test("the three departed reasons and the host-precedence case each have a golden; names are unique", () => {
    expect(CELLS.filter((c) => c.audience === "departed").map((c) => c.name).sort()).toEqual(["departed/gone", "departed/host-precedence", "departed/left", "departed/removed"]);
    expect(new Set(CELLS.map((c) => c.name)).size).toBe(CELLS.length);
  });
  test("every golden has a snapshot entry, and no entry is orphaned", async () => {
    const text = await Bun.file(new URL("./__snapshots__/golden.test.ts.snap", import.meta.url)).text().catch(() => "");
    const names = [...text.matchAll(/^exports\[`GD1 goldens (.+?) 1`\]/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual(CELLS.map((c) => c.name).sort());
  });
});
