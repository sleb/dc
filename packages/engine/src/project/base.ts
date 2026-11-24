// The viewer-independent part of a live view (LLD 2 sections 4.2, 5.1), built once per projector instance, field by field.
// No object spread of a Game value anywhere in `project/` (lint): a field that is not named here cannot reach a view.
import type { GameView } from "@dc/contracts";
import { awards, cardText, effectiveTarget, expectedSubmitters, revealList, waitingOn } from "../selectors";
import type { Game, Player } from "../types";

type Spectator = Extract<GameView, { audience: "spectator" }>;
/** Everything a spectator sees, without the `audience` tag. */
export type Base = Omit<Spectator, "audience">;
type RoundPublic = NonNullable<Base["round"]>;
type PlayerPublic = Base["players"][number];
type AwardsView = NonNullable<Base["awards"]>;

const departed = (p: Player): boolean => p.status === "left" || p.status === "removed";

function playerPublic(game: Game, p: Player): PlayerPublic {
  const writing = p.status === "writing" && p.writeTarget !== null;
  const left = p.writeTarget === null ? { red: 0, green: 0 } : { red: Math.max(0, p.writeTarget.red - p.writeProgress.red), green: Math.max(0, p.writeTarget.green - p.writeProgress.green) };
  return {
    id: p.id,
    name: p.name,
    joinOrder: p.joinOrder,
    status: p.status,
    isHost: p.uid === game.hostId,
    score: departed(p) ? 0 : p.scorePile.length,
    cardsLeft: writing ? left : null,
  };
}

function roundPublic(game: Game, joined: (ids: readonly string[]) => string[]): RoundPublic | null {
  const r = game.round;
  if (r === null || game.phase !== "PLAYING") return null;
  // Who played: live submissions while SUBMITTING, the snapshot taken at close while JUDGING. Never ordered by time (PJ6), never by anything that correlates with revealOrder.
  const played = r.phase === "SUBMITTING" ? r.submissions.map((s) => s.playerId) : r.played;
  return {
    number: r.number,
    judgeId: r.judgeId,
    phase: r.phase,
    green: { id: r.greenCardId, text: cardText(game, r.greenCardId) },
    expected: joined(expectedSubmitters(game)),
    submittedBy: joined(played),
    reveal: r.phase === "JUDGING" ? revealList(game).map((c) => ({ submissionId: c.submissionId, text: c.text, pitch: c.pitch })) : null,
  };
}

function awardsView(game: Game): AwardsView | null {
  if (game.phase !== "FINISHED" && game.phase !== "ENDED") return null;
  const a = awards(game);
  if (a === null) return null;
  return { peoplesChoice: [...a.peoplesChoice], podium: a.podium.map((p) => ({ rank: p.rank, round: p.round, cardId: p.cardId, playerId: p.playerId, votes: p.votes })) };
}

export function buildBase(game: Game): Base {
  const order = new Map(game.players.map((p) => [p.id, p.joinOrder]));
  const joined = (ids: readonly string[]): string[] => [...ids].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
  const s = game.settings;
  return {
    kind: "live",
    gameId: game.id,
    version: game.version,
    phase: game.phase,
    paused: game.paused,
    settings: {
      targetOverride: s.targetOverride,
      profanity: s.profanity,
      variants: { pitch: s.variants.pitch, writeIn: s.variants.writeIn, redraw: s.variants.redraw, peoplesChoice: s.variants.peoplesChoice },
      spectators: { enabled: s.spectators.enabled, vote: s.spectators.vote },
    },
    target: effectiveTarget(game),
    targetFrozen: game.target !== null,
    writeCounts: game.writeCounts === null ? null : { red: game.writeCounts.red, green: game.writeCounts.green },
    players: [...game.players].sort((a, b) => a.joinOrder - b.joinOrder).map((p) => playerPublic(game, p)),
    waitingOn: waitingOn(game),
    round: roundPublic(game, joined),
    resolved: game.history.length,
    winnerId: game.phase === "FINISHED" ? game.winnerId : null,
    awards: awardsView(game),
  };
}
