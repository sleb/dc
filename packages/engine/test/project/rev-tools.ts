// #29: the PROJECTOR_REV pin (LLD 2 8.2). The golden view corpus is fingerprinted (sha256 of the canonical, sorted-key JSON) and `rev-pins.json` maps each revision to the
// fingerprint it was frozen with. A content change without a bump, or a bump without a new pin, is a problem. Test-side only: nothing here ships.
import { createHash } from "node:crypto";
import { CELLS, goldenOf } from "./cells";

/** JSON with object keys sorted at every depth, so key order never moves the fingerprint. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 over `[name, value]` entries, sorted by name. */
export function fingerprint(entries: readonly (readonly [string, unknown])[]): string {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash("sha256").update(canonicalJson(sorted)).digest("hex");
}

/** The fingerprint of the golden view corpus of 2.2 (43 cells). */
export const corpusFingerprint = (): string => fingerprint(CELLS.map((c) => [c.name, goldenOf(c)] as const));

/** What is wrong with `pins` for this `rev` and corpus `fp`; empty when nothing is. */
export function checkRevPins(rev: number, pins: Readonly<Record<string, string>>, fp: string): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(rev) || rev < 1) return [`PROJECTOR_REV ${rev} is not a positive integer`];
  const revs = Object.keys(pins).map(Number).sort((a, b) => a - b);
  const newest = revs[revs.length - 1] ?? 0;
  for (let r = 1; r <= newest; r++) if (pins[String(r)] === undefined) problems.push(`gap: no pin for rev ${r}`);
  if (rev > newest) problems.push(`PROJECTOR_REV ${rev} was bumped without a pin for it`);
  else if (rev < newest) problems.push(`PROJECTOR_REV ${rev} is below the newest pin ${newest}`);
  else if (pins[String(rev)] !== fp) problems.push(`the golden corpus changed without a bump of PROJECTOR_REV ${rev}`);
  return problems;
}
