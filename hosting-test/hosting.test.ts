import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Runs under `bun run test:hosting`: the Hosting emulator serves apps/web/dist (built with --mode emulator) per firebase.json.
const BASE = "http://127.0.0.1:5002";
const DIST = join(import.meta.dir, "../apps/web/dist");

const get = (path: string) => fetch(`${BASE}${path}`, { redirect: "manual" });

async function builtAsset(): Promise<string> {
  const html = await readFile(join(DIST, "index.html"), "utf8");
  const m = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(html);
  if (!m?.[1]) throw new Error("no /assets/*.js in dist/index.html (run `bun run build:web` first)");
  return m[1];
}

describe("hosting", () => {
  test("V7 serves Referrer-Policy: no-referrer on the app, an asset and an unknown path", async () => {
    for (const path of ["/", await builtAsset(), "/g/abc123"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  test("V7 index.html and sw.js are no-cache", async () => {
    for (const path of ["/index.html", "/sw.js"]) {
      expect((await get(path)).headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("V7 hashed assets are immutable", async () => {
    expect((await get(await builtAsset())).headers.get("cache-control")).toBe("public,max-age=31536000,immutable");
  });

  test("V7 an unknown path rewrites to the SPA", async () => {
    const res = await get("/g/abc123");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  test("V7 /__/ is not swallowed by the SPA rewrite", async () => {
    const res = await get("/__/firebase/init.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["projectId"]).toBe("demo-deepcuts");
  });
});
