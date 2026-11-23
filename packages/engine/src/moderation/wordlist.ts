// The checked-in word list (LLD 1 section 12). PLACEHOLDER CONTENT: obviously fake tokens only, so the mechanism can be tested without real offensive words in the repository.
// The real list, whether any "hard" list applies with the filter off, and the language scope are a content decision for M7 (open question 11).
// Entries are folded form: lowercase Latin letters, no diacritics, no digits. A `word` entry matches a whole token; a `substring` entry (5 or more letters, unambiguous) matches inside a token and through a squash.

export interface Term { readonly term: string; readonly match: "word" | "substring" }
export interface WordList { readonly TERMS: readonly Term[]; readonly ALLOW: readonly string[] }

export const TERMS: readonly Term[] = [
  { term: "zorblat", match: "word" },
  { term: "qwiblex", match: "word" },
  { term: "quibnarf", match: "substring" },
  { term: "zyxplode", match: "substring" },
];

/** Known false positives: a token listed here is skipped in every pass. The two entries are traps for the substring entries above. */
export const ALLOW: readonly string[] = ["quibnarfville", "zyxplodeable"];

export const WORDLIST: WordList = { TERMS, ALLOW };
