import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmp } from "../functions/scripts/fixtures";
import { checkWebSize } from "./check-web-size";

const noise = (bytes: number) => randomBytes(bytes); // incompressible, so gzip size is about the raw size

const HTML = `<!doctype html><html><head><meta name="referrer" content="no-referrer">
<script type="module" crossorigin src="/assets/index-a1.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-b2.js">
<link rel="stylesheet" crossorigin href="/assets/index-c3.css">
</head><body><div id="root"></div></body></html>`;

/** A dist with the given files (path -> content) layered over a small, valid one. */
async function dist(over: Record<string, Buffer | string | null> = {}): Promise<string> {
  const root = join(await tmp("size"), "dist");
  const files: Record<string, Buffer | string | null> = {
    "index.html": HTML,
    "assets/index-a1.js": noise(50_000),
    "assets/vendor-b2.js": noise(50_000),
    "assets/index-c3.css": noise(5_000),
    ...over,
  };
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe("check-web-size", () => {
  test("S1 passes on a dist under every budget", async () => {
    expect(await checkWebSize(await dist())).toEqual([]);
  });

  test("S2 fails when the entry graph (html, script, modulepreload, stylesheet) is over 300 KB gzip, though no file alone is", async () => {
    const problems = await checkWebSize(await dist({ "assets/index-a1.js": noise(160_000), "assets/vendor-b2.js": noise(160_000) }));
    expect(problems.join("\n")).toMatch(/entry.*300/i);
  });

  test("S3 fails on a lazy chunk (a js file outside the entry graph) over 60 KB gzip, and does not count it in the entry", async () => {
    const problems = await checkWebSize(await dist({ "assets/messaging-d4.js": noise(61_000) }));
    expect(problems.join("\n")).toMatch(/lazy chunk.*messaging-d4\.js.*60/i);
    expect(problems.join("\n")).not.toMatch(/entry/i);
  });

  test("S3 a lazy chunk exactly under the budget passes", async () => {
    expect(await checkWebSize(await dist({ "assets/messaging-d4.js": noise(55_000) }))).toEqual([]);
  });

  test("S4 fails on CSS over 20 KB gzip", async () => {
    const problems = await checkWebSize(await dist({ "assets/index-c3.css": noise(21_000) }));
    expect(problems.join("\n")).toMatch(/css.*20/i);
  });

  test("S5 fails on a service worker over 40 KB gzip, and passes when there is none yet", async () => {
    const problems = await checkWebSize(await dist({ "sw.js": noise(41_000) }));
    expect(problems.join("\n")).toMatch(/service worker.*40/i);
    expect(await checkWebSize(await dist({ "sw.js": noise(30_000) }))).toEqual([]);
  });

  test("S6 fails on a missing dist, and on a dist without index.html", async () => {
    const missing = await checkWebSize(join(await tmp("size"), "nope"));
    expect(missing.join("\n")).toMatch(/index\.html/);
    const noHtml = await checkWebSize(await dist({ "index.html": null }));
    expect(noHtml.join("\n")).toMatch(/index\.html/);
  });

  test("S7 fails when index.html references a file that is not in dist", async () => {
    const problems = await checkWebSize(await dist({ "assets/vendor-b2.js": null }));
    expect(problems.join("\n")).toContain("vendor-b2.js");
  });

  test("S10 a file referenced twice counts once; query strings are stripped; data-src is ignored", async () => {
    const html = HTML.replace("</head>", '<link rel="modulepreload" href="/assets/index-a1.js?v=1"><script data-src="/assets/nope.js"></script></head>');
    const problems = await checkWebSize(await dist({ "index.html": html, "assets/index-a1.js": noise(150_000), "assets/vendor-b2.js": noise(120_000) }));
    expect(problems).toEqual([]);
  });

  test("S8 measures gzip, not raw bytes", async () => {
    expect(await checkWebSize(await dist({ "assets/index-a1.js": "a".repeat(2_000_000) }))).toEqual([]);
  });

  test("S9 reports every problem, not just the first", async () => {
    const problems = await checkWebSize(await dist({ "assets/index-c3.css": noise(21_000), "sw.js": noise(41_000) }));
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});
