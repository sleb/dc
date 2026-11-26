// #31: writes the 43 view fixtures to packages/contracts/fixtures/views (LLD 7 section 11.1, OQ11). Deterministic: fixed
// `generatedAt`, no clock, `VIEW_REGION_FIELDS` key order, `JSON.stringify(doc, null, 2)` plus a newline. Unknown `.json`
// files are pruned, so a renamed cell cannot leave a ghost fixture behind; anything else in the directory is left alone.
// Run with `bun run fixtures:views`; CI runs it immediately before `git diff --exit-code`.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VIEW_FIXTURES_DIR, fixtureViews } from "./fixture-views";

export interface WriteResult { written: string[]; pruned: string[] }

/** Write every fixture into `dir`, create it if absent, and remove `.json` files that are not in the set. */
export function writeViewFixtures(dir: string): WriteResult {
  const fixtures = fixtureViews();
  const expected = new Set(fixtures.map((f) => f.fileName));
  mkdirSync(dir, { recursive: true });
  const pruned: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json") || expected.has(entry)) continue;
    rmSync(join(dir, entry));
    pruned.push(entry);
  }
  for (const f of fixtures) writeFileSync(join(dir, f.fileName), `${JSON.stringify(f.doc, null, 2)}\n`);
  return { written: fixtures.map((f) => f.fileName), pruned };
}

if (import.meta.main) {
  const target = process.argv[2] ?? VIEW_FIXTURES_DIR;
  const { written, pruned } = writeViewFixtures(target);
  const removed = pruned.length === 0 ? "" : `; pruned ${pruned.join(", ")}`;
  console.log(`fixtures:views wrote ${written.length} files to ${target}${removed}`);
}
