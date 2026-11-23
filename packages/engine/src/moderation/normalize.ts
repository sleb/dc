// The folding pipeline of LLD 1 section 12, used only for matching (never for what is stored). Pure and total.

/** Lookalikes folded to Latin: Cyrillic and Greek letters that read as a Latin letter. Keys are lowercase (the fold lowercases first). */
const CONFUSABLES: Readonly<Record<string, string>> = {
  "а": "a", "в": "b", "с": "c", "е": "e", "н": "h", "і": "i", "ј": "j", "к": "k", "м": "m", "о": "o",
  "р": "p", "ѕ": "s", "т": "t", "у": "y", "х": "x", "ԁ": "d", "ԛ": "q", "ԝ": "w",
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w",
};

const LEET: Readonly<Record<string, string>> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i", "|": "i", "+": "t" };

const MARKS = /\p{M}/gu;
/** Zero-width, soft hyphen, bidi and other format characters: dropped for matching. */
const FORMAT = /\p{Cf}/gu;
const LETTER = /\p{L}/u;
const RUN3 = /(\p{L})\1{2,}/gu;
const RUN2 = /(\p{L})\1+/gu;
/** Every pass can enable another (a leet character that becomes a letter makes its neighbour "next to a letter"; a lowercase can add a mark), so the pipeline runs to a fixed point. A long leet chain needs about one pass per character, so the cap scales with the input: each changing pass converts a symbol to a letter or settles a bounded transform, so it terminates well inside `16 + 2 * length`. */
const BASE_PASSES = 16;

function pass(text: string, leet: boolean): string {
  // 1 NFKC, then NFD and strip combining marks, then NFC so a Hangul syllable made of jamo is stable.
  let s = text.normalize("NFKC").normalize("NFD").replace(MARKS, "").normalize("NFC");
  // 2 lowercase, strip zero-width and soft-hyphen (format) characters.
  s = s.toLowerCase().replace(FORMAT, "");
  // 3 confusable fold.
  s = Array.from(s, (c) => CONFUSABLES[c] ?? c).join("");
  // 4 leet fold, only for a character that sits next to a letter.
  if (leet) {
    const cs = Array.from(s);
    s = cs.map((c, i) => {
      const to = LEET[c];
      if (to === undefined) return c;
      const prev = cs[i - 1];
      const next = cs[i + 1];
      return (prev !== undefined && LETTER.test(prev)) || (next !== undefined && LETTER.test(next)) ? to : c;
    }).join("");
  }
  // 5 collapse any run of 3 or more identical letters to 2.
  return s.replace(RUN3, "$1$1");
}

/** The folded form, to a fixed point. `leet: false` skips step 4 (so a trailing "!" stays a separator). */
export function fold(text: string, leet: boolean): string {
  let cur = text;
  const max = BASE_PASSES + 2 * text.length;
  for (let i = 0; i < max; i++) {
    const next = pass(cur, leet);
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** `normalize(text)`: the full pipeline (steps 1 to 5), idempotent. */
export const normalize = (text: string): string => fold(text, true);

/** The same fold with every run of 2 or more identical letters reduced to 1 ("fuuuuck" and "fuuck" to "fuck"). Used as a second matching form, never stored. */
export const collapseRuns = (folded: string): string => folded.replace(RUN2, "$1");
