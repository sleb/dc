// #31: writes the 43 view fixtures to packages/contracts/fixtures/views (LLD 7 section 11.1, OQ11). Deterministic: fixed
// `generatedAt`, no clock, `VIEW_REGION_FIELDS` key order, `JSON.stringify(doc, null, 2)` plus a newline. Stale fixture-shaped
// `.json` files are pruned, so a renamed cell cannot leave a ghost fixture behind; any other file, including a `.json` that is
// not `{state}__{viewer}.json`, is left alone. Run with `bun run fixtures:views`; CI runs it immediately before
// `git diff --exit-code`. `argv[2]` overrides the target directory for the temp-dir test in `fixture-views.test.ts`.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VIEW_FIXTURES_DIR, fixtureViews } from "./fixture-views";

export interface WriteResult { written: string[]; pruned: string[] }

/** The only names the writer owns: `{cell state}__{cell viewer}.json`, uppercase cell letters included. */
export const FIXTURE_FILE_NAME = /^[A-Za-z0-9-]+__[A-Za-z0-9-]+\.json$/;

/** Write every fixture into `dir`, create it if absent, and remove fixture-shaped files that are not in the set. */
export function writeViewFixtures(dir: string): WriteResult {
  const fixtures = fixtureViews();
  const expected = new Set(fixtures.map((f) => f.fileName));
  mkdirSync(dir, { recursive: true });
  const pruned: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!FIXTURE_FILE_NAME.test(entry) || expected.has(entry)) continue;
    rmSync(join(dir, entry));
    pruned.push(entry);
  }
  for (const f of fixtures) writeFileSync(join(dir, f.fileName), `${JSON.stringify(f.doc, null, 2)}\n`);
  return { written: fixtures.map((f) => f.fileName), pruned };
}

if (import.meta.main) {
  const target = process.argv[2] ?? VIEW_FIXTURES_DIR;
  try {
    const { written, pruned } = writeViewFixtures(target);
    const removed = pruned.length === 0 ? "" : `; pruned ${pruned.join(", ")}`;
    console.log(`fixtures:views wrote ${written.length} files to ${target}${removed}`);
  } catch (error) {
    console.error(`fixtures:views: cannot write to ${target}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
