// #25 (1.8): the Moderation module of LLD 1 section 12, as a pure function: `normalize` (V1), `check` (V2), M4 (V3) and the reason codes (V9, M3).
// The placeholder wordlist holds obviously fake tokens only; real content is M7's (open question 11). fast-check 4 has no `fullUnicodeString`; `string({unit: "binary"})` is its full-Unicode generator.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEXT_LIMITS } from "@dc/contracts";
import { check, clean } from "../src/moderation";
import type { WordList } from "../src/moderation";
import { normalize } from "../src/moderation/normalize";
import { ALLOW, TERMS } from "../src/moderation/wordlist";
import { assertProperty } from "./support/fc";

const env = (): Record<string, string | undefined> => ({ ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? "100" });
const reason = (text: string, kind: "name" | "card" | "pitch" = "card", mode: "on" | "off" = "on"): string => {
  const r = check(text, kind, mode);
  return r.ok ? "ok" : r.reason;
};

describe("V1 normalize (12: the folding pipeline)", () => {
  test("NFKC folds full-width and compatibility forms; diacritics are stripped; case is folded", () => {
    expect(normalize("ＺＯＲＢＬＡＴ")).toBe("zorblat");
    expect(normalize("Zórblàt")).toBe("zorblat");
    expect(normalize("Zörblät")).toBe("zorblat");
    expect(normalize("zórblat")).toBe("zorblat");
    expect(normalize("ZORBLAT")).toBe("zorblat");
  });

  test("zero-width and soft-hyphen characters are stripped", () => {
    expect(normalize("zo​rb­lat")).toBe("zorblat");
    expect(normalize("z‍o⁠r﻿blat")).toBe("zorblat");
  });

  test("confusables fold to Latin (Cyrillic and Greek lookalikes)", () => {
    expect(normalize("zоrblаt")).toBe("zorblat"); // Cyrillic o, a
    expect(normalize("zοrblat")).toBe("zorblat"); // Greek omicron
    expect(normalize("ТНЕ")).toBe("the"); // Cyrillic capital Te, En, Ie
    expect(normalize("ραρ")).toBe("pap"); // Greek rho, alpha
  });

  test("leet folds only a character that sits next to a letter: 0 1 3 4 5 7 @ $ ! | +", () => {
    expect(normalize("z0rbl@t")).toBe("zorblat");
    expect(normalize("t3st")).toBe("test");
    expect(normalize("5ky")).toBe("sky");
    expect(normalize("b1t")).toBe("bit");
    expect(normalize("pa$$")).toBe("pass");
    expect(normalize("zorbla+")).toBe("zorblat");
    expect(normalize("zorblat!")).toBe("zorblati"); // a trailing "!" is next to a letter; check() also tests the un-leeted fold, so a term is still caught
    expect(normalize("a|b")).toBe("aib");
  });

  test('"2024" and friends are untouched', () => {
    for (const s of ["2024", "100%", "1 0 1", "room 101", "3 + 4", "1337", "a 7", "7 a", "x 1 y"]) expect(normalize(s)).toBe(s);
  });

  test("a leet run keeps folding while it stays attached to a letter", () => {
    expect(normalize("a1337")).toBe("aieet");
    expect(normalize("00a")).toBe("ooa");
  });

  test("a run of 3 or more identical letters collapses to 2; a run of 2 stays", () => {
    expect(normalize("zooooorblat")).toBe("zoorblat");
    expect(normalize("aaa")).toBe("aa");
    expect(normalize("aa")).toBe("aa");
    expect(normalize("looooool")).toBe("lool");
    expect(normalize("1111")).toBe("1111");
  });

  test("the empty string and a string of only stripped characters fold to the empty string", () => {
    expect(normalize("")).toBe("");
    expect(normalize("​­")).toBe("");
  });

  test("P: normalize is idempotent over arbitrary Unicode and over strings rich in leet, marks and look-alikes", () => {
    const rich = fc.string({ unit: fc.constantFrom(..."aeiostz013457@$!|+ _.-́​­аоοａéİẞ1"), maxLength: 24 });
    assertProperty(fc.property(fc.oneof(fc.string({ unit: "grapheme", maxLength: 12 }), fc.string({ unit: "binary", maxLength: 12 }), rich), (s) => normalize(normalize(s)) === normalize(s)), env());
    assertProperty(fc.property(fc.string({ unit: "grapheme-composite", maxLength: 12 }), (s) => normalize(normalize(s)) === normalize(s)), env());
    assertProperty(fc.property(fc.string({ unit: "binary", maxLength: 20 }), (s) => normalize(normalize(s)) === normalize(s)), env());
  });
});

describe("V2 check: structure (both modes) and profanity (mode on)", () => {
  test("clean text: NFC, trim, internal whitespace runs collapse to one space; the cleaned text is what is returned", () => {
    for (const mode of ["on", "off"] as const) {
      expect(check("  hello \t\n  world   !  ", "card", mode)).toStrictEqual({ ok: true, text: "hello world !" });
      expect(check("é", "name", mode)).toStrictEqual({ ok: true, text: "é" });
    }
    expect(clean("  a   b\n")).toBe("a b");
  });

  test("EMPTY: nothing, whitespace only", () => {
    for (const mode of ["on", "off"] as const) for (const kind of ["name", "card", "pitch"] as const) for (const t of ["", " ", "\n\t  "]) expect(reason(t, kind, mode)).toBe("EMPTY");
  });

  test("TOO_LONG counts code points of the cleaned text against TEXT_LIMITS (name 24, card 80, pitch 140), in both modes", () => {
    expect(TEXT_LIMITS).toEqual({ name: 24, card: 80, pitch: 140 });
    for (const mode of ["on", "off"] as const) {
      for (const kind of ["name", "card", "pitch"] as const) {
        const max = TEXT_LIMITS[kind];
        expect(reason("c".repeat(max), kind, mode)).toBe("ok");
        expect(reason(`  ${"c".repeat(max)}  `, kind, mode)).toBe("ok"); // the padding is trimmed away first
        expect(reason("c".repeat(max + 1), kind, mode)).toBe("TOO_LONG");
        expect(reason("\u{1F600}".repeat(max), kind, mode)).toBe("ok"); // astral characters count once, not twice
        expect(reason("\u{1F600}".repeat(max + 1), kind, mode)).toBe("TOO_LONG");
      }
      expect(reason(`${"c ".repeat(40)}c`, "card", mode)).toBe("TOO_LONG"); // 41 letters and 40 single spaces are 81 code points
    }
  });

  test("whitespace collapsing happens before the length test: a run of spaces counts once", () => {
    expect(reason(`${"c".repeat(39)}${" ".repeat(30)}${"c".repeat(40)}`, "card")).toBe("ok"); // 80 once the run of spaces is one space
    expect(reason(`${"c".repeat(40)}${" ".repeat(30)}${"c".repeat(40)}`, "card")).toBe("TOO_LONG"); // 81
  });

  test("INVALID_CHARS: control characters, zero-width characters, bidi controls and lone surrogates, in both modes, ahead of EMPTY and TOO_LONG", () => {
    const bad = ["a\u0000b", "a\u0007", "a\u001Fb", "a\u007Fb", "a\u0085b", "a​b", "a‌b", "a‍b", "a⁠b", "a﻿b", "a­b", "a‮b", "a⁦b", "a\uD800", "\uDC00b", "​", "\u0000", `${"c".repeat(200)}\u0000`];
    for (const mode of ["on", "off"] as const) for (const t of bad) expect([t, reason(t, "card", mode)]).toEqual([t, "INVALID_CHARS"]);
    expect(reason("a\tb\nc\rd\u000Be\u000Cf")).toBe("ok"); // tab, newline, carriage return, vertical tab and form feed are whitespace, not control rejects
  });

  test("mode off checks structure only; mode on adds profanity", () => {
    expect(reason("zorblat", "card", "on")).toBe("PROFANITY");
    expect(reason("zorblat", "card", "off")).toBe("ok");
    expect(check("  zorblat  ", "card", "off")).toStrictEqual({ ok: true, text: "zorblat" });
    expect(reason("zorblat", "pitch", "on")).toBe("PROFANITY");
    expect(reason("zorblat", "name", "on")).toBe("PROFANITY");
  });

  test("the order of reasons: INVALID_CHARS, then EMPTY, then TOO_LONG, then PROFANITY", () => {
    expect(reason(`${"zorblat ".repeat(20)}`)).toBe("TOO_LONG");
    expect(reason(`zorblat\u0000`)).toBe("INVALID_CHARS");
  });

  test("word entries match a whole token only; substring entries match inside a token; neither fires on a token that merely contains a word entry", () => {
    expect(reason("what a zorblat you are")).toBe("PROFANITY");
    expect(reason("Zorblat.")).toBe("PROFANITY");
    expect(reason("zorblatant")).toBe("ok"); // Scunthorpe: contains a word entry, is not one
    expect(reason("xzorblat zorblatx")).toBe("ok");
    expect(reason("xxquibnarfyy")).toBe("PROFANITY"); // substring entry inside a token
    expect(reason("quibnarfs")).toBe("PROFANITY");
  });

  test("ALLOW: a listed false positive passes in every pass, alone and in context", () => {
    for (const w of ALLOW) {
      expect([w, reason(w)]).toEqual([w, "ok"]);
      expect([w, reason(`hello ${w.toUpperCase()} world`)]).toEqual([w, "ok"]);
    }
    expect(reason("Quibnarfville is nice")).toBe("ok");
    expect(reason("quibnarfville quibnarf")).toBe("PROFANITY"); // the allowed token is skipped, the other one is not
  });

  test("squash pass: separators between letters do not hide a substring entry of 5 or more letters", () => {
    expect(reason("q.u.i.b.n.a.r.f")).toBe("PROFANITY");
    expect(reason("q u i b n a r f")).toBe("PROFANITY");
    expect(reason("q-u_i b*n.a r f")).toBe("PROFANITY");
    expect(reason("z o r b l a t")).toBe("ok"); // word entries are not squash-tested (so short words in ordinary text do not fire)
  });

  test("leet, diacritic, confusable, full-width and run variants are caught; a trailing punctuation mark does not hide a term", () => {
    for (const t of ["z0rbl4t", "zórblàt", "zоrblаt", "ＺＯＲＢＬＡＴ", "zooorblat", "zorrblat", "zorblaaaat", "ZoRbLaT", "zorblat!", "zorblat!!!", "zorbla+", "z0rbl@7!", "!z0rbl@7", "zorblat?!"]) {
      expect([t, reason(t)]).toEqual([t, "PROFANITY"]);
    }
    for (const t of ["qu1bn4rf", "quibbnarf", "quiiibnarf", "q.u.i.b.n.a.r.f", "qu1bn4rf!"]) expect([t, reason(t)]).toEqual([t, "PROFANITY"]);
  });

  test('ordinary text with digits and punctuation is not a hit: "2024", "Room 101", "100% fun", "MP3"', () => {
    for (const t of ["2024", "Room 101", "100% fun", "MP3 player", "Hello, world!", "C-3PO and R2-D2"]) expect([t, reason(t)]).toEqual([t, "ok"]);
  });

  test("a name is checked as one string and per token", () => {
    expect(reason("Sir Quibnarf", "name")).toBe("PROFANITY");
    expect(reason("Zorblat", "name")).toBe("PROFANITY");
    expect(reason("Zorblat Jones", "name")).toBe("PROFANITY");
    expect(reason("Q u i b n a r f", "name")).toBe("PROFANITY");
    expect(reason("Ann Marie", "name")).toBe("ok");
  });

  test("check takes an optional list: the given list is used, the checked-in list is the default", () => {
    const mine: WordList = { TERMS: [{ term: "hello", match: "word" }], ALLOW: [] };
    expect(check("well hello there", "card", "on", mine)).toStrictEqual({ ok: false, reason: "PROFANITY" });
    expect(check("zorblat", "card", "on", mine)).toStrictEqual({ ok: true, text: "zorblat" });
    expect(check("hello", "card", "off", mine)).toStrictEqual({ ok: true, text: "hello" });
    expect(check("zorblat", "card", "on")).toStrictEqual({ ok: false, reason: "PROFANITY" });
    expect(check("hello", "card", "on", { TERMS: [{ term: "hello", match: "word" }], ALLOW: ["hello"] })).toStrictEqual({ ok: true, text: "hello" });
  });
});

/** Variants of a term that a player might type, built independently of the engine's fold. */
const LEET: Record<string, string[]> = { o: ["0"], a: ["4", "@"], e: ["3"], i: ["1", "!", "|"], s: ["5", "$"], t: ["7", "+"] };
const CYR: Record<string, string> = { a: "а", e: "е", o: "о", p: "р", c: "с", x: "х", y: "у" };
const fullwidth = (c: string): string => String.fromCodePoint(c.codePointAt(0) as number - 0x61 + 0xff41);
const variantOf = (term: string, picks: number[]): string =>
  [...term].map((c, i) => {
    const p = picks[i % picks.length] ?? 0;
    switch (p % 6) {
      case 1: return c.toUpperCase();
      case 2: return `${c}́`; // a combining acute accent
      case 3: return LEET[c]?.[p % (LEET[c]?.length ?? 1)] ?? c;
      case 4: return CYR[c] ?? fullwidth(c);
      case 5: return c.repeat(2 + (p % 3));
      default: return c;
    }
  }).join("");

describe("V3 M4: pure, total, deterministic, local", () => {
  test("P-M4: check never throws and is deterministic over arbitrary Unicode, for every kind and mode", () => {
    assertProperty(fc.property(fc.string({ unit: "binary", maxLength: 200 }), fc.constantFrom("name", "card", "pitch"), fc.constantFrom("on", "off"), (s, kind, mode) => {
      const a = check(s, kind, mode);
      expect(check(s, kind, mode)).toStrictEqual(a);
      if (a.ok) {
        expect(a.text).toBe(clean(s));
        expect(a.text).toBe(a.text.trim());
        expect([...a.text].length).toBeLessThanOrEqual(TEXT_LIMITS[kind]);
        expect(a.text.length).toBeGreaterThan(0);
        expect(check(a.text, kind, mode)).toStrictEqual(a); // cleaning is idempotent: what is stored passes again unchanged
      } else {
        expect(Object.keys(a).sort()).toEqual(["ok", "reason"]);
      }
    }), env());
    assertProperty(fc.property(fc.string({ unit: "binary", maxLength: 300 }), (s) => { check(s, "card", "on"); return true; }), env());
  });

  test("P-M4: every listed term is caught in every variant (case, diacritics, leet, confusables, full-width, runs), alone and in a sentence", () => {
    const sentence = (t: string, i: number): string => [`${t}`, `I think ${t} is fine`, `${t}!`, `...${t}...`, `a ${t}, b`][i % 5] as string;
    assertProperty(fc.property(fc.constantFrom(...TERMS), fc.array(fc.nat(60), { minLength: 1, maxLength: 12 }), fc.nat(4), ({ term }, picks, i) => {
      const text = sentence(variantOf(term, picks), i);
      const r = check(text, "card", "on");
      expect([text, r]).toEqual([text, { ok: false, reason: "PROFANITY" }]);
      expect(check(text, "card", "off").ok).toBe(true);
    }), env());
  });

  test("P-M4: substring terms are also caught spaced out and inside a longer token", () => {
    assertProperty(fc.property(fc.constantFrom(...TERMS.filter((t) => t.match === "substring")), fc.constantFrom(" ", ".", "-", "_", "  "), fc.constantFrom("", "xx", "my", "zzq"), ({ term }, sep, pad) => {
      expect(reason([...term].join(sep))).toBe("PROFANITY");
      expect(reason(`${pad}${term}${pad}`)).toBe("PROFANITY");
    }), env());
  });

  test("P-M4: every ALLOW entry passes, in any case and inside a sentence", () => {
    assertProperty(fc.property(fc.constantFrom(...ALLOW), fc.constantFrom((s: string) => s, (s: string) => s.toUpperCase(), (s: string) => `well, ${s}.`, (s: string) => `${s} ${s}`), (w, f) => reason(f(w)) === "ok"), env());
  });

  test("the wordlist is the placeholder set of obviously fake tokens, lowercase letters only; substring entries have 5 or more letters; no ALLOW entry is a plain term", () => {
    expect(TERMS.map((t) => `${t.match}:${t.term}`).sort()).toEqual(["substring:quibnarf", "substring:zyxplode", "word:qwiblex", "word:zorblat"].sort());
    expect([...ALLOW].sort()).toEqual(["quibnarfville", "zyxplodeable"]);
    for (const t of TERMS) {
      expect(t.term).toMatch(/^[a-z]+$/);
      if (t.match === "substring") expect(t.term.length).toBeGreaterThanOrEqual(5);
      expect(t.term).not.toMatch(/(.)\1/); // no doubled letter, so a run collapse cannot break the term itself
    }
    for (const w of ALLOW) expect(TERMS.some((t) => t.match === "word" && t.term === w)).toBe(false);
  });

  test("moderation/ imports only from itself (and the contracts' TEXT_LIMITS): no I/O, no engine internals (M4; P5 covers the rest)", () => {
    const dir = join(import.meta.dir, "../src/moderation");
    const files = [...new Glob("**/*.ts").scanSync(dir)];
    expect(files.sort()).toEqual(["index.ts", "normalize.ts", "wordlist.ts"]);
    const bad: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(join(dir, f), "utf8").matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
        const spec = m[1] ?? "";
        if (!(spec.startsWith("./") && !spec.startsWith("../")) && spec !== "@dc/contracts") bad.push(`${f}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("V9 M3: every reason is produced by a crafted input and the rejection never carries the input", () => {
  const crafted: [string, string][] = [["", "EMPTY"], ["   ", "EMPTY"], ["x".repeat(500), "TOO_LONG"], ["bad\u0000text", "INVALID_CHARS"], ["you zorblat", "PROFANITY"]];
  test("each of the four reasons comes out of check", () => {
    for (const [t, want] of crafted) expect([t.slice(0, 12), reason(t)]).toEqual([t.slice(0, 12), want]);
    expect(new Set(crafted.map(([, r]) => r))).toEqual(new Set(["EMPTY", "TOO_LONG", "INVALID_CHARS", "PROFANITY"]));
  });

  test("P-M3: a failed check is exactly {ok: false, reason}, with the reason one of the four fixed strings, and the JSON holds no part of the input", () => {
    const fixed = new Set(["EMPTY", "TOO_LONG", "INVALID_CHARS", "PROFANITY"]);
    assertProperty(fc.property(fc.constantFrom(...TERMS), fc.array(fc.nat(60), { minLength: 1, maxLength: 8 }), fc.constantFrom("ab cd ", "the quick brown fox ", "mmm "), ({ term }, picks, pad) => {
      const text = `${pad}${variantOf(term, picks)} ${pad}`;
      const r = check(text, "card", "on");
      expect(r.ok).toBe(false);
      const json = JSON.stringify(r);
      expect(Object.keys(r).sort()).toEqual(["ok", "reason"]);
      expect(fixed.has((r as { reason: string }).reason)).toBe(true);
      expect(json).not.toContain(term);
      expect(json).not.toContain(text.trim());
    }), env());
  });
});

describe("review fixes (PR #74, step 1.8)", () => {
  test("a term with a doubled letter is caught when a different letter is elongated (terms are collapsed like the text)", () => {
    const list: WordList = { TERMS: [{ term: "hellfire", match: "substring" }, { term: "bass", match: "word" }], ALLOW: [] };
    const r = (t: string): string => { const c = check(t, "card", "on", list); return c.ok ? "ok" : c.reason; };
    for (const t of ["hellfire", "helllfire", "heellfire", "heeellfire", "baaass", "baass", "bass", "BAAASSS", "xx heeelllfire yy"]) expect([t, r(t)]).toEqual([t, "PROFANITY"]);
    for (const t of ["basso", "hello fire", "hel fire"]) expect([t, r(t)]).toEqual([t, "ok"]);
  });

  test("normalize is a true fixed point for long leet chains (the pass cap scales with the input)", () => {
    for (const s of ["a" + "@".repeat(30), "a" + "@".repeat(200), "1".repeat(100) + "a", "a" + "0|".repeat(80)]) expect(normalize(normalize(s))).toBe(normalize(s));
  });

  test("INVALID_CHARS covers the other invisible format characters, one per range", () => {
    for (const cp of [0x2061, 0x2063, 0x2064, 0x206a, 0x206f, 0x061c, 0x180e, 0xfff9, 0xfffb, 0xe0000, 0xe0001, 0xe007f]) {
      for (const mode of ["on", "off"] as const) expect([cp.toString(16), reason(`a${String.fromCodePoint(cp)}b`, "name", mode)]).toEqual([cp.toString(16), "INVALID_CHARS"]);
    }
  });
});
