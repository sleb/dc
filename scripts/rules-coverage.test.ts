import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LLD_PRINCIPALS, ROWS, collectionPathOf } from "../rules-test/matrix";

// P10 (LLD 0) and ST7 (LLD 3), #32: the rules denial matrix covers every collection anyone names. Pure, so it runs in
// `bun run test` (the CI verify job) without an emulator; the emulator suite `rules-test/store.rules.test.ts` runs the
// matrix itself. Three name sets are compared, each normalized to a collection path (`games/{}/views`):
//   C1  every collection a `match` in `firestore.rules` names is exercised by a matrix row;
//   C2  the LLD 3 section 2.1 collection map equals the set the matrix exercises (row 19's unlisted paths aside);
//   C3  the tech-stack section 5 list equals the section 2.1 set.
// A failure names the uncovered path. The docs checks at the end keep LLD 3 section 3.1 and 3.3 equal to what is built.

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => Bun.file(join(ROOT, path)).text();

/** The text under a markdown heading, up to the next heading of the same or a higher level. */
export function section(md: string, heading: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && (/^#+/.exec(l)?.[0].length ?? 0) <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

const firstCodeBlock = (text: string): string => {
  const m = /```[a-z]*\n([\s\S]*?)\n```/.exec(text);
  if (!m?.[1]) throw new Error("no code block in the section");
  return m[1];
};

/** A document path (`games/{gameId}/views/spectator`) to its collection path (`games/{}/views`). */
export function collectionOfDocPath(path: string): string {
  const segments = path.replace(/^\/+/, "").split("/");
  if (segments.length % 2 !== 0) throw new Error(`not a document path: ${path}`);
  return segments
    .slice(0, -1)
    .map((s, i) => (i % 2 === 1 ? "{}" : s))
    .join("/");
}

/** The document paths every `match` in a ruleset names, nested matches joined, wildcard-recursive ones dropped. */
export function rulesMatchPaths(rules: string): string[] {
  const text = rules.replace(/\/\/[^\n]*/g, "");
  const stack: (string | null)[] = [];
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    const m = /^match\s+(\S+)\s*\{/.exec(text.slice(i));
    if (m?.[1]) {
      stack.push(m[1]);
      const full = stack.filter((s): s is string => s !== null).join("");
      const path = full.replace(/^\/databases\/\{database\}\/documents/, "");
      if (path && !path.includes("=**")) out.push(path);
      i += m[0].length;
      continue;
    }
    const c = text[i];
    if (c === "{") stack.push(null);
    else if (c === "}") stack.pop();
    i += 1;
  }
  if (stack.length !== 0) throw new Error("unbalanced braces in firestore.rules");
  return out;
}

/** The section 2.1 collection-map table: the first backticked path of each row. */
export function collectionMapPaths(lld3: string): string[] {
  return section(lld3, "### 2.1 Collection map")
    .split("\n")
    .map((l) => /^\|\s*`([^`]+)`/.exec(l)?.[1])
    .filter((p): p is string => p !== undefined);
}

/** The tech-stack section 5 code block: the first token of each line. */
export function techStackPaths(techStack: string): string[] {
  return firstCodeBlock(section(techStack, "## 5. Firestore data model"))
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0] ?? "")
    .filter((p) => p !== "");
}

/** The collection paths the matrix exercises, row 19's deliberately unlisted paths and collection groups aside. */
export function matrixCollections(rows = ROWS): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (row.unlisted) continue;
    for (const t of row.targets) {
      const p = collectionPathOf(t);
      if (p !== null) out.add(p);
    }
  }
  return out;
}

const missingFrom = (want: Iterable<string>, have: Set<string>) => [...want].filter((p) => !have.has(p)).sort();

const [rules, lld3, techStack] = await Promise.all([read("firestore.rules"), read("docs/lld/03-game-store.md"), read("docs/tech-stack.md")]);
const rulesSet = new Set(rulesMatchPaths(rules).map(collectionOfDocPath));
const mapSet = new Set(collectionMapPaths(lld3).map(collectionOfDocPath));
const techSet = new Set(techStackPaths(techStack).map(collectionOfDocPath));
const matrixSet = matrixCollections();

describe("P10 rules coverage", () => {
  test("the parsers read something: the rules match at least the games collection, the 2.1 map has 17 rows", () => {
    expect(rulesSet.has("games")).toBe(true);
    expect(collectionMapPaths(lld3)).toHaveLength(17);
  });

  test("C1 every collection a match in firestore.rules names is exercised by a matrix row", () => {
    expect({ uncoveredRulesCollections: missingFrom(rulesSet, matrixSet) }).toEqual({ uncoveredRulesCollections: [] });
  });

  test("C2 the LLD 3 section 2.1 collection map equals the set the matrix exercises (ST7)", () => {
    expect({ inMapNotInMatrix: missingFrom(mapSet, matrixSet), inMatrixNotInMap: missingFrom(matrixSet, mapSet) }).toEqual({ inMapNotInMatrix: [], inMatrixNotInMap: [] });
  });

  test("C2 games/{}/idem and hosts/{}/idem stay distinct collections", () => {
    expect(matrixSet.has("games/{}/idem")).toBe(true);
    expect(matrixSet.has("hosts/{}/idem")).toBe(true);
  });

  test("C3 the tech-stack section 5 list equals the LLD 3 section 2.1 set", () => {
    expect({ inTechStackNotInMap: missingFrom(techSet, mapSet), inMapNotInTechStack: missingFrom(mapSet, techSet) }).toEqual({ inTechStackNotInMap: [], inMapNotInTechStack: [] });
  });
});

describe("the parsers, on planted input", () => {
  test("nested matches join, the database prefix and recursive wildcards drop, comments are ignored", () => {
    const planted = [
      "service cloud.firestore {",
      "  match /databases/{database}/documents {",
      "    function f() { return true; }",
      "    match /a/{x} { allow read: if f(); // match /commented/{y} {",
      "      match /b/{y} { allow read: if false; }",
      "    }",
      "    match /c/literal { allow read: if false; }",
      "    match /{document=**} { allow read: if false; }",
      "  }",
      "}",
    ].join("\n");
    expect(rulesMatchPaths(planted)).toEqual(["/a/{x}", "/a/{x}/b/{y}", "/c/literal"]);
    expect(rulesMatchPaths(planted).map(collectionOfDocPath)).toEqual(["a", "a/{}/b", "c"]);
  });

  test("a match block with no matrix row is reported by name", () => {
    const extra = new Set([...rulesSet, collectionOfDocPath("/foo/{x}")]);
    expect(missingFrom(extra, matrixSet)).toEqual(["foo"]);
  });
});

describe("docs current (LLD 3 sections 3.1 and 3.3)", () => {
  test("the LLD 3 section 3.1 ruleset is the file, verbatim", () => {
    expect(firstCodeBlock(section(lld3, "### 3.1 `firestore.rules`")).trim()).toBe(rules.trim());
  });

  const matrixSection = section(lld3, "### 3.3 Denial matrix (`rules-test/`, `@firebase/rules-unit-testing`)");

  test("the section 3.3 denial table has the matrix's rows, 1 to 21", () => {
    const numbers = matrixSection
      .split("\n")
      .map((l) => /^\|\s*(\d+)\s*\|/.exec(l)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    expect(numbers).toEqual(ROWS.map((r) => r.n));
  });

  test("the section 3.3 principals table defines the matrix's principals", () => {
    const ids = matrixSection
      .split("\n")
      .flatMap((l) => {
        const cell = /^\|\s*(`[^|]+)\|/.exec(l)?.[1] ?? "";
        return [...cell.matchAll(/`([A-Za-z0-9]+)`/g)].map((m) => m[1] ?? "");
      });
    expect(ids).toEqual([...LLD_PRINCIPALS]);
  });
});
