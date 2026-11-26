// DoS guards at the edge; the Engine remains the semantic authority.
export const MAX_SEATED = 10;
export const MAX_TOTAL_JOINS = 50;
export const MAX_VOTES = 1500;
/** Code points; the Engine's semantic limits. */
export const TEXT_LIMITS = { name: 24, card: 80, pitch: 140 } as const;
/** UTF-16 units per card, name or pitch string at the edge; above every TEXT_LIMITS value. */
export const WIRE_TEXT_MAX = 400;
/** Strings per color in saveDraft. */
export const WIRE_DRAFT_MAX = 40;
/** Serialized bytes of one view document (JSON, UTF-8): the test budget at the worst case, and the runtime hard cap the Engine enforces before a write (LLD 2 PJ14). Firestore's own limit is 1 MiB. */
export const VIEW_DOC_BUDGET_BYTES = 64 * 1024;
export const VIEW_DOC_MAX_BYTES = 512 * 1024;
