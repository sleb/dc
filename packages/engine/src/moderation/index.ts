// Moderation (LLD 1 section 12): the single place where text structure and the profanity filter are defined. Pure, deterministic, local (M4): no I/O, no clock, no third-party call.
import { TEXT_LIMITS } from "@dc/contracts";
import { collapseRuns, fold, normalize } from "./normalize";
import { WORDLIST } from "./wordlist";
import type { WordList } from "./wordlist";

export type { Term, WordList } from "./wordlist";
export { normalize } from "./normalize";
export type TextKind = "name" | "card" | "pitch";
export type CheckResult = { ok: true; text: string } | { ok: false; reason: "EMPTY" | "TOO_LONG" | "INVALID_CHARS" | "PROFANITY" };

/** Control characters other than whitespace, zero-width and bidi-control characters, the soft hyphen, and lone surrogates. */
const INVALID = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻\u{E0000}-\u{E007F}]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** NFC, trim, collapse every run of whitespace to one space. What is stored. */
export const clean = (text: string): string => text.normalize("NFC").trim().replace(/\s+/gu, " ");

/** The key `NAME_TAKEN` compares: the fold of the name with its whitespace removed (so "A b", "ab" and "ＡＢ" are one name). */
export const nameKey = (name: string): string => normalize(clean(name).replace(/\s+/gu, ""));

function matches(folded: string, list: WordList, collapsed: boolean): boolean {
  const allow = new Set(collapsed ? list.ALLOW.map(collapseRuns) : list.ALLOW);
  const tokens = folded.split(/[^\p{L}]+/u).filter((t) => t !== "" && !allow.has(t));
  // The collapsed pass compares the collapsed text with the terms collapsed the same way (and as written), so a doubled-letter term is caught when another letter is elongated.
  const form = (t: string): string[] => (collapsed ? [t, collapseRuns(t)] : [t]);
  const words = list.TERMS.filter((t) => t.match === "word").flatMap((t) => form(t.term));
  const subs = list.TERMS.filter((t) => t.match === "substring").flatMap((t) => form(t.term));
  if (tokens.some((t) => words.includes(t) || subs.some((s) => t.includes(s)))) return true; // (a) token pass, (b) substring pass
  const squash = tokens.join("");
  return subs.some((s) => s.length >= 5 && squash.includes(s)); // (c) squash pass: separators between letters do not hide a long term
}

const SYMBOL = /[^\p{L}\p{N}]/u;
const EDGE_TRIM = 3;

/** Each whitespace-delimited chunk with up to `lead` symbols taken off its front and `tail` off its back ("z0rbl@7!" to "z0rbl@7"), so punctuation around a leet-spelled term cannot turn into a leet letter and hide it. */
function trimEdges(text: string, lead: number, tail: number): string {
  return text.split(" ").map((chunk) => {
    const cs = Array.from(chunk);
    let a = 0;
    let b = cs.length;
    while (a < lead && a < b && SYMBOL.test(cs[a] as string)) a++;
    for (let t = 0; t < tail && b > a && SYMBOL.test(cs[b - 1] as string); t++) b--;
    return cs.slice(a, b).join("");
  }).join(" ");
}

/** The folds a text is matched in: leet, no leet (so a trailing "!" stays a separator), and leet with a few edge symbols trimmed; for each, also the form with letter runs reduced to one. */
function profane(text: string, list: WordList): boolean {
  const forms = [fold(text, false)];
  for (let lead = 0; lead <= EDGE_TRIM; lead++) for (let tail = 0; tail <= EDGE_TRIM; tail++) forms.push(fold(lead === 0 && tail === 0 ? text : trimEdges(text, lead, tail), true));
  return forms.some((f) => matches(f, list, false) || matches(collapseRuns(f), list, true));
}

/**
 * Check one text: `clean` it, then the structural rules in both modes (INVALID_CHARS, EMPTY, TOO_LONG by code points against `TEXT_LIMITS[kind]`), then, in mode `on`, the profanity filter
 * (a name is checked as one string and per token). `text` in the result is the cleaned form to store. The matched word is never returned.
 */
export function check(text: string, kind: TextKind, mode: "on" | "off", list: WordList = WORDLIST): CheckResult {
  if (INVALID.test(text)) return { ok: false, reason: "INVALID_CHARS" };
  const cleaned = clean(text);
  if (cleaned === "") return { ok: false, reason: "EMPTY" };
  if ([...cleaned].length > TEXT_LIMITS[kind]) return { ok: false, reason: "TOO_LONG" };
  if (mode === "on" && (profane(cleaned, list) || (kind === "name" && cleaned.split(" ").some((t) => profane(t, list))))) return { ok: false, reason: "PROFANITY" };
  return { ok: true, text: cleaned };
}
