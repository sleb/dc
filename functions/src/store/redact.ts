import type { RoundDoc } from "@dc/contracts";
import type { Game } from "@dc/engine";
export function roundsContaining(_g: Game, _cardId: string): number[] { return []; }
export function redact(doc: RoundDoc, _cardId: string): RoundDoc { return doc; }
