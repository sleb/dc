import { readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

/** Gzip budgets (LLD 7 section 10.1, WC16). A KB is 1000 bytes. */
export const BUDGETS = { entry: 300_000, lazyChunk: 60_000, css: 20_000, serviceWorker: 40_000 } as const;

const kb = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`;
const gzipSize = (data: Buffer) => gzipSync(data, { level: 9 }).length;

/** The files `index.html` loads: module scripts, modulepreloads and stylesheets, as dist-relative paths. */
function entryRefs(html: string): string[] {
  const refs: string[] = [];
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
    const isScript = /^<script\b/i.test(tag);
    const rel = /\brel=["']?([\w-]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (!isScript && rel !== "modulepreload" && rel !== "stylesheet") continue;
    const url = /\s(?:src|href)=["']([^"']+)["']/i.exec(tag)?.[1]?.split(/[?#]/)[0];
    if (url && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) refs.push(posix.normalize(url).replace(/^\/+/, ""));
  }
  return refs;
}

/**
 * Checks `<dist>/` against the gzip budgets. Returns one message per problem; empty means within budget.
 * Entry = index.html plus every script, modulepreload and stylesheet it references (what /g/:id needs for first
 * paint). A lazy chunk is any other .js file; the service worker is `sw.js`. CSS is checked per file.
 */
export async function checkWebSize(dist: string): Promise<string[]> {
  const problems: string[] = [];
  let html: Buffer;
  try {
    html = await readFile(join(dist, "index.html"));
  } catch {
    return [`${join(dist, "index.html")} is missing (run \`bun run build:web\` first)`];
  }

  let entry = gzipSize(html);
  const inEntry = new Set<string>(["index.html"]);
  for (const ref of entryRefs(html.toString("utf8"))) {
    if (inEntry.has(ref)) continue;
    inEntry.add(ref);
    try {
      entry += gzipSize(await readFile(join(dist, ref)));
    } catch {
      problems.push(`index.html references ${ref}, which is not in dist`);
    }
  }
  if (entry > BUDGETS.entry) problems.push(`entry is ${kb(entry)} gzip, over the ${kb(BUDGETS.entry)} budget`);

  const files = (await readdir(dist, { recursive: true, withFileTypes: true })).filter((f) => f.isFile());
  for (const f of files) {
    const rel = relative(dist, join(f.parentPath, f.name)).split(sep).join("/");
    const size = () => readFile(join(dist, rel)).then(gzipSize);
    if (rel === "sw.js") {
      const s = await size();
      if (s > BUDGETS.serviceWorker) problems.push(`service worker ${rel} is ${kb(s)} gzip, over the ${kb(BUDGETS.serviceWorker)} budget`);
    } else if (rel.endsWith(".css")) {
      const s = await size();
      if (s > BUDGETS.css) problems.push(`CSS ${rel} is ${kb(s)} gzip, over the ${kb(BUDGETS.css)} budget`);
    } else if (rel.endsWith(".js") && !inEntry.has(rel)) {
      const s = await size();
      if (s > BUDGETS.lazyChunk) problems.push(`lazy chunk ${rel} is ${kb(s)} gzip, over the ${kb(BUDGETS.lazyChunk)} budget`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const dist = process.argv[2] ?? join(import.meta.dir, "../apps/web/dist");
  const problems = await checkWebSize(dist);
  if (problems.length > 0) {
    console.error(`check-web-size failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("check-web-size: ok");
}
