// The resolved-round feed (LLD 2 section 7): a `RoundRecord` becomes a `RoundDoc` by renaming and null-filling, with no viewer input, so one shape serves every reader (PJ13).
// No parse here: the Store parses what it writes (LLD 3). Built field by field in schema order.
import { VIEW_SCHEMA } from "@dc/contracts";
import type { RoundDoc } from "@dc/contracts";
import { EngineInvariantError } from "../errors";
import type { RoundRecord } from "../types";

export function toRoundDoc(rec: RoundRecord): RoundDoc {
  return {
    schema: VIEW_SCHEMA,
    round: rec.round,
    judgeId: rec.judgeId,
    winnerId: rec.winnerId,
    winnerCardId: rec.winnerCardId,
    green: { id: rec.green.id, text: rec.green.text },
    plays: rec.playsDetail.map((p) => ({ playerId: p.playerId, cardId: p.cardId, text: p.text, pitch: p.pitch ?? null })),
    absent: [...rec.absent],
    resolvedAt: rec.resolvedAt,
    redacted: false,
  };
}

/** The docs for the records after `sinceRound`, ascending by round (numerically). A round that appears twice among them is a bug in the caller. */
export function projectFeed(records: readonly RoundRecord[], sinceRound = 0): RoundDoc[] {
  const later = records.filter((r) => r.round > sinceRound).sort((a, b) => a.round - b.round);
  for (let i = 1; i < later.length; i++) if (later[i]?.round === later[i - 1]?.round) throw new EngineInvariantError(`projectFeed: round ${String(later[i]?.round)} appears twice`);
  return later.map(toRoundDoc);
}
