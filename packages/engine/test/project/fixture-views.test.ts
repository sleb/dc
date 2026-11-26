// #31: the 43 committed view fixtures of LLD 7 section 11.1 and OQ11. One ViewDoc per golden cell, exported to
// packages/contracts/fixtures/views/{state}__{viewer}.json; the writer is deterministic and prunes a stale fixture-shaped file.
// 42 cells are proved byte-equal to their fanOut write; `departed/gone` is the one explicit doc (a gone player is not a viewer
// target, so fanOut writes the seated player's live view for that docId). The committed files are parsed strictly (the web-side
// loose parse is the contracts test's), and every one is scanned for leaked server-only keys and strings.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VIEW_SCHEMA, ViewDocSchema } from "@dc/contracts";
import { PROJECTOR_REV, VIEW_REGION_FIELDS, docIdOf, fanOut } from "../../src/project";
import type { ViewDocBody } from "../../src/project/fanout";
import { CELLS, goldenOf } from "./cells";
import { writeViewFixtures } from "./export-views";
import { EXPLICIT_ONLY_CELL, FIXED_NOW, VIEW_FIXTURES_DIR, fixtureFileName, fixtureViews, viewFixtureDoc } from "./fixture-views";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const fanOutProven = CELLS.filter((c) => c.name !== EXPLICIT_ONLY_CELL);
const explicit = CELLS.filter((c) => c.name === EXPLICIT_ONLY_CELL);
const expectedNames = (): string[] => fixtureViews().map((f) => f.fileName).sort();
const committed = (): string[] => (existsSync(VIEW_FIXTURES_DIR) ? readdirSync(VIEW_FIXTURES_DIR).sort() : []);
const bytesOf = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;

describe("#31 the exported view fixture set", () => {
  test("one fixture per cell: 43, no missing cell, no extra name", () => {
    const fixtures = fixtureViews();
    expect(CELLS.length).toBe(43);
    expect(fanOutProven.length).toBe(42);
    expect(explicit.map((c) => c.name)).toEqual([EXPLICIT_ONLY_CELL]);
    expect(fixtures.length).toBe(43);
    expect(fixtures.map((f) => f.name).sort()).toEqual(CELLS.map((c) => c.name).sort());
    expect(new Set(fixtures.map((f) => f.fileName)).size).toBe(43);
    expect(expectedNames()).toEqual(CELLS.map((c) => `${c.name.replaceAll("/", "__")}.json`).sort());
  });

  test("filenames are the cell name with `/` -> `__`, matching the documented shape", () => {
    for (const c of CELLS) expect(fixtureFileName(c)).toBe(`${c.name.replaceAll("/", "__")}.json`);
    // Uppercase is allowed because the binding rule is the cell name (`unseatedHost`, `host-precedence`), not a lower-cased slug.
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
  });
});

describe("#31 the envelope compared with what the Store writes", () => {
  test("every cell except departed/gone deep-equals the matching fanOut write, found by docIdOf", () => {
    for (const c of fanOutProven) {
      const game = c.game();
      const write = fanOut(null, game, { now: FIXED_NOW, storedRev: 0 }).find((w) => w.docId === docIdOf(c.viewer(game)));
      if (write === undefined) throw new Error(`${c.name}: fanOut wrote no doc for ${docIdOf(c.viewer(game))}`);
      expect(viewFixtureDoc(c)).toEqual(write.doc);
    }
  });

  test("departed/gone is the one explicit doc, with only generatedAt, viewsRev and enabled hand-set", () => {
    const c = explicit[0];
    if (c === undefined) throw new Error("fixture: departed/gone is missing");
    const game = c.game();
    expect([c.name, viewFixtureDoc(c)]).toEqual([c.name, {
      schema: VIEW_SCHEMA,
      viewsRev: PROJECTOR_REV,
      gameId: game.id,
      enabled: true,
      version: game.version,
      generatedAt: FIXED_NOW,
      view: goldenOf(c) as ViewDocBody["view"],
    }]);
    // Why it is explicit: the departed docId is a seated player's, so fanOut writes that player's live view and never the tombstone.
    const write = fanOut(null, game, { now: FIXED_NOW, storedRev: 0 }).find((w) => w.docId === docIdOf(c.viewer(game)));
    expect(write?.doc.view?.kind).toBe("live");
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

  test("no committed fixture has a uid key, an email-shaped string or the server-only sentinel", () => {
    const email = /[^\s@]+@[^\s@]+\.[^\s@]+/;
    const scan = (value: unknown, at: string): void => {
      if (typeof value === "string") {
        expect([at, email.test(value), value.includes("EPISODE-SECRET")]).toEqual([at, false, false]);
      } else if (Array.isArray(value)) {
        value.forEach((v, i) => scan(v, `${at}[${i}]`));
      } else if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          expect([`${at}.${k}`, k === "uid"]).toEqual([`${at}.${k}`, false]);
          scan(v, `${at}.${k}`);
        }
      }
    };
    const files = committed();
    expect(files.length).toBe(43);
    for (const f of files) scan(JSON.parse(readFileSync(join(VIEW_FIXTURES_DIR, f), "utf8")), f);
  });

  test("the writer is deterministic and prunes a stale fixture-shaped .json, leaving other files alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "dc-view-fixtures-"));
    try {
      const first = writeViewFixtures(dir);
      expect(first.written.sort()).toEqual(expectedNames());
      expect(first.pruned).toEqual([]);
      const before = new Map(expectedNames().map((n) => [n, readFileSync(join(dir, n), "utf8")]));
      writeFileSync(join(dir, "zzz__nobody.json"), "{}\n");
      writeFileSync(join(dir, "notes.txt"), "keep\n");
      writeFileSync(join(dir, "keep.json"), "{}\n");
      const second = writeViewFixtures(dir);
      expect(second.pruned).toEqual(["zzz__nobody.json"]);
      expect(readdirSync(dir).filter((f) => f.endsWith(".json")).sort()).toEqual([...expectedNames(), "keep.json"].sort());
      expect(readdirSync(dir)).toContain("notes.txt");
      for (const n of expectedNames()) expect([n, readFileSync(join(dir, n), "utf8")]).toEqual([n, before.get(n) ?? ""]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#31 the package script", () => {
  test("fixtures:views points at this exporter and the CLI writes 43 files into argv[2]", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["fixtures:views"]).toBe("bun packages/engine/test/project/export-views.ts");
    const dir = mkdtempSync(join(tmpdir(), "dc-view-cli-"));
    try {
      const run = spawnSync(process.execPath, [join(ROOT, "packages/engine/test/project/export-views.ts"), dir], { cwd: ROOT, encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("fixtures:views wrote 43 files");
      expect(readdirSync(dir).sort()).toEqual(expectedNames());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
