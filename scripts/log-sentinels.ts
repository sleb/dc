import { readFile } from "node:fs/promises";

// The log half of LLD 0 R1 / P19: sentinel strings are planted in every user-supplied field of the integration
// requests; if one reaches a log line, the run fails. This is the detector. It reports where a sentinel is, never the
// line itself (the line is the thing that leaked).

/** The sentinel families (P19): display names, card text, an email. Keep in step with functions/test-integration/sentinels.test.ts (checked by log-sentinels.test.ts). */
export const SENTINELS: { kind: string; pattern: RegExp }[] = [
  { kind: "NAME-SENTINEL", pattern: /NAME-SENTINEL-\w+/ },
  { kind: "CARD-SENTINEL", pattern: /CARD-SENTINEL-\w+/ },
  { kind: "sentinel@example.test", pattern: /sentinel@example\.test/ },
];

export interface Hit {
  file: string;
  line: number;
  kind: string;
}

export function findSentinels(text: string, file = "<input>"): Hit[] {
  const hits: Hit[] = [];
  text.split("\n").forEach((line, i) => {
    for (const s of SENTINELS) if (s.pattern.test(line)) hits.push({ file, line: i + 1, kind: s.kind });
  });
  return hits;
}

/** Scans files that may not exist (a log the run did not write is not a finding). */
export async function scanFiles(paths: string[]): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    hits.push(...findSentinels(text, path));
  }
  return hits;
}

export const formatHit = (h: Hit): string => `sentinel: ${h.kind} at ${h.file}:${h.line}`;

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: bun scripts/log-sentinels.ts <log file>...");
    process.exit(2);
  }
  const hits = await scanFiles(files);
  for (const h of hits) console.error(formatHit(h));
  console.log(hits.length === 0 ? `log-sentinels: ok (${files.length} file(s), no sentinel)` : `log-sentinels: FAILED (${hits.length} hit(s))`);
  process.exit(hits.length === 0 ? 0 : 1);
}
