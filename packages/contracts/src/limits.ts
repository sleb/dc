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
