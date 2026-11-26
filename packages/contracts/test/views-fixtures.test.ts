// #31: packages/contracts ships the web's view fixtures (LLD 7 section 11.1 and OQ11). The engine exports one ViewDoc per
// golden cell; this package reads them with the loose schema, the same parser the web uses, so a schema drift fails here.
// Contracts cannot import the engine (LLD 0 P5), so the files are the only coupling.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ViewDocLooseSchema } from "@dc/contracts";

const dir = join(import.meta.dir, "..", "fixtures", "views");
const files = (): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []);

describe("#31 the exported view fixtures parse with the web (loose) schema", () => {
  test("the directory exists and holds the 43 cells", () => {
    expect(existsSync(dir), "packages/contracts/fixtures/views is missing; run bun run fixtures:views").toBe(true);
    expect(files().length).toBe(43);
  });

  test("every committed fixture parses with ViewDocLooseSchema", () => {
    for (const f of files()) {
      const doc: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const parsed = ViewDocLooseSchema.safeParse(doc);
      expect(parsed.success ? "" : `${f}: ${parsed.error.issues.map((i) => `${i.path.map(String).join(".")} ${i.code}`).join("; ")}`).toBe("");
    }
  });
});
