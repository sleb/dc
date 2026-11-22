import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const srcDir = join(root, "src");
const sources = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, text: readFileSync(join(srcDir, f), "utf8") }));
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("C11 isolation", () => {
  test("dependencies are exactly zod, exact-pinned", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: unknown; peerDependencies?: unknown };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["zod"]);
    expect(pkg.dependencies?.["zod"]).toMatch(/^\d+\.\d+\.\d+$/); // exact pin, any version
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });
  test("there is source to scan", () => {
    expect(sources.map((s) => s.file)).toContain("index.ts");
  });
  test("imports only zod and relative modules", () => {
    for (const { file, text } of sources) {
      const specs = [...strip(text).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const s of specs) {
        const allowed = s === "zod" || s.startsWith("./") || s.startsWith("../");
        expect(allowed ? "" : `${file}: ${s}`).toBe("");
        expect(/^(node:|bun|firebase|@dc\/)/.test(s) ? `${file}: ${s}` : "").toBe("");
      }
    }
  });
  test("no Date, crypto or fetch", () => {
    for (const { file, text } of sources) {
      const code = strip(text);
      for (const re of [/\bDate\b/, /\bcrypto\b/, /\bfetch\b/]) {
        expect(re.test(code) ? `${file}: ${re}` : "").toBe("");
      }
    }
  });
  test("index.ts re-exports every other module", () => {
    const index = sources.find((s) => s.file === "index.ts")!.text;
    for (const { file } of sources) {
      if (file === "index.ts") continue;
      const name = file.replace(/\.ts$/, "");
      expect(new RegExp(`from\\s*["']\\./${name}(\\.ts)?["']`).test(index) ? "" : `index.ts misses ${name}`).toBe("");
    }
  });
});
