// #31: the 43 committed view fixtures of LLD 7 section 11.1 and OQ11. One ViewDoc per golden cell, exported to
// packages/contracts/fixtures/views/{state}__{viewer}.json; the writer is deterministic and prunes a stale file. The live
// cells are proved against fanOut, the four departed cells are the documented exceptions (fanOut only writes a departed
// view as a tombstone for a transition), and the committed files are parsed strictly (the web-side loose parse is the
// contracts test's).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VIEW_SCHEMA, ViewDocSchema } from "@dc/contracts";
import { PROJECTOR_REV, VIEW_REGION_FIELDS, docIdOf, fanOut } from "../../src/project";
import { CELLS, goldenOf } from "./cells";
import { writeViewFixtures } from "./export-views";
import { FIXED_NOW, VIEW_FIXTURES_DIR, fixtureFileName, fixtureViews, viewFixtureDoc } from "./fixture-views";

const live = CELLS.filter((c) => c.audience !== "departed");
const departed = CELLS.filter((c) => c.audience === "departed");
const expectedNames = (): string[] => fixtureViews().map((f) => f.fileName).sort();
const committed = (): string[] => (existsSync(VIEW_FIXTURES_DIR) ? readdirSync(VIEW_FIXTURES_DIR).sort() : []);
const bytesOf = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;

describe("#31 the exported view fixture set", () => {
  test("one fixture per cell: 43, no missing cell, no extra name", () => {
    const fixtures = fixtureViews();
    expect(CELLS.length).toBe(43);
    expect(live.length).toBe(39);
    expect(departed.length).toBe(4);
    expect(fixtures.length).toBe(43);
    expect(fixtures.map((f) => f.name).sort()).toEqual(CELLS.map((c) => c.name).sort());
    expect(new Set(fixtures.map((f) => f.fileName)).size).toBe(43);
    expect(expectedNames()).toEqual(CELLS.map((c) => `${c.name.replaceAll("/", "__")}.json`).sort());
  });

  test("filenames are the cell name with `/` -> `__`, matching the documented shape", () => {
    for (const c of CELLS) expect(fixtureFileName(c)).toBe(`${c.name.replaceAll("/", "__")}.json`);
    for (const n of expectedNames()) expect([n, /^[A-Za-z0-9-]+__[A-Za-z0-9-]+\.json$/.test(n)]).toEqual([n, true]);
  });

  test("each is a view-region ViewDoc: no draft region, VIEW_REGION_FIELDS order, the running viewsRev, strict parse", () => {
    for (const f of fixtureViews()) {
      expect([f.fileName, Object.keys(f.doc)]).toEqual([f.fileName, [...VIEW_REGION_FIELDS]]);
      expect([f.fileName, Object.hasOwn(f.doc, "draft")]).toEqual([f.fileName, false]);
      expect([f.fileName, Object.hasOwn(f.doc, "draftSeq")]).toEqual([f.fileName, false]);
      expect(f.doc.viewsRev).toBe(PROJECTOR_REV);
      expect(ViewDocSchema.safeParse(f.doc).success, f.fileName).toBe(true);
    }
    // P13/V11: the fixtures carry cell data only, never the server-only noise the fixtures put in the games.
    expect(fixtureViews().some((f) => JSON.stringify(f.doc).includes("EPISODE-SECRET"))).toBe(false);
  });
});

describe("#31 the envelope compared with what the Store writes", () => {
  test("every live cell's doc deep-equals the matching fanOut write, found by docIdOf", () => {
    for (const c of live) {
      const game = c.game();
      const write = fanOut(null, game, { now: FIXED_NOW, storedRev: 0 }).find((w) => w.docId === docIdOf(c.viewer(game)));
      expect(write, c.name).toBeDefined();
      expect([c.name, viewFixtureDoc(c)]).toEqual([c.name, write?.doc]);
    }
  });

  test("the four departed cells are explicit, with only generatedAt, viewsRev and enabled hand-set", () => {
    expect(departed.map((c) => c.name).sort()).toEqual(["departed/gone", "departed/host-precedence", "departed/left", "departed/removed"]);
    for (const c of departed) {
      const game = c.game();
      expect([c.name, viewFixtureDoc(c)]).toEqual([c.name, {
        schema: VIEW_SCHEMA,
        viewsRev: PROJECTOR_REV,
        gameId: game.id,
        enabled: true,
        version: game.version,
        generatedAt: FIXED_NOW,
        view: goldenOf(c),
      }]);
    }
  });
});

describe("#31 the committed files", () => {
  test("the directory is exactly the writer's 43 files, byte for byte, and each parses strictly", () => {
    expect(existsSync(VIEW_FIXTURES_DIR), `${VIEW_FIXTURES_DIR} is missing; run bun run fixtures:views`).toBe(true);
    expect(committed()).toEqual(expectedNames());
    for (const f of fixtureViews()) {
      const onDisk = readFileSync(join(VIEW_FIXTURES_DIR, f.fileName), "utf8");
      expect([f.fileName, onDisk]).toEqual([f.fileName, bytesOf(f.doc)]);
      expect(ViewDocSchema.safeParse(JSON.parse(onDisk)).success, f.fileName).toBe(true);
    }
  });

  test("the writer is deterministic and prunes a stale .json, leaving other files alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "dc-view-fixtures-"));
    try {
      const first = writeViewFixtures(dir);
      expect(first.written.sort()).toEqual(expectedNames());
      expect(first.pruned).toEqual([]);
      const before = new Map(expectedNames().map((n) => [n, readFileSync(join(dir, n), "utf8")]));
      writeFileSync(join(dir, "zzz__nobody.json"), "{}\n");
      writeFileSync(join(dir, "notes.txt"), "keep\n");
      const second = writeViewFixtures(dir);
      expect(second.pruned).toEqual(["zzz__nobody.json"]);
      expect(readdirSync(dir).filter((f) => f.endsWith(".json")).sort()).toEqual(expectedNames());
      expect(readdirSync(dir)).toContain("notes.txt");
      for (const n of expectedNames()) expect([n, readFileSync(join(dir, n), "utf8")]).toEqual([n, before.get(n) ?? ""]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
