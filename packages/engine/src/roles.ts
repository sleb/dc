import type { Actor, Game, GameId, PlayerId, Roles, Uid } from "./types";

/** `seat:{gameId}:{playerId}` (tech-stack section 4; LLD 4 ratifies). */
export function seatUid(gameId: GameId, playerId: PlayerId): Uid {
  return `seat:${gameId}:${playerId}`;
}

/**
 * Resolution is by uid only. The host's seat has uid = hostId, so one uid is both `host` and a player;
 * host powers never depend on a seat. A departed (left or removed) seat does not count. The system actor is no one's seat and not a spectator.
 */
export function actorRole(game: Game, actor: Actor): Roles {
  if (actor.kind === "system") return { host: false, playerId: null, status: null, judge: false, spectator: false };
  const seat = game.players.find((p) => p.uid === actor.uid && p.status !== "left" && p.status !== "removed");
  const playerId = seat?.id ?? null;
  return {
    host: actor.uid === game.hostId,
    playerId,
    status: seat?.status ?? null,
    judge: playerId !== null && game.round !== null && game.round.judgeId === playerId,
    spectator: playerId === null,
  };
}
