// The Projector (LLD 2): the only function that turns a `Game` into something a client may read (V1). Public surface so far;
// `fanOut`, `draftRegion`, `toRoundDoc`, `projectFeed` and `PROJECTOR_REV` arrive with #29.
import type { GameView } from "@dc/contracts";
import { EngineInvariantError } from "../errors";
import type { Game } from "../types";
import { buildBase } from "./base";
import { hostPanel } from "./host";
import type { Viewer } from "./viewer";
import { youView } from "./you";

export { docIdOf, viewerFor, viewersOf } from "./viewer";
export type { Viewer, ViewTarget } from "./viewer";

/**
 * A projector for one state: the shared part is built once and reused for every viewer. Pure and total except for a viewer the state cannot serve,
 * which throws `EngineInvariantError` (fail closed): a `player` viewer who is not seated or whose uid is not the seat's, or a host viewer whose uid is not the host's.
 * The returned views share the base's nested arrays and objects; callers treat them as immutable.
 */
export function makeProjector(game: Game): (viewer: Viewer) => GameView {
  const base = buildBase(game);
  return (viewer) => {
    if (viewer.kind === "departed") return { kind: "departed", audience: "departed", gameId: game.id, version: game.version, reason: viewer.reason };
    if (viewer.kind === "spectator") {
      if (!viewer.isHost) return { audience: "spectator", ...base };
      if (viewer.uid !== game.hostId) throw new EngineInvariantError("project: a host viewer whose uid is not the host's");
      return { audience: "host", ...base, host: hostPanel(game) };
    }
    const me = game.players.find((p) => p.id === viewer.playerId && (p.status === "writing" || p.status === "ready" || p.status === "active"));
    if (me === undefined) throw new EngineInvariantError(`project: ${viewer.playerId} is not a seated player`);
    if (me.uid !== viewer.uid) throw new EngineInvariantError(`project: viewer uid does not match seat ${viewer.playerId}`);
    const isHost = me.uid === game.hostId; // the game's word, not the viewer's, decides who gets the host panel
    const you = youView(game, me, isHost);
    return isHost ? { audience: "player", ...base, you, host: hostPanel(game) } : { audience: "player", ...base, you };
  };
}

export function project(game: Game, viewer: Viewer): GameView {
  return makeProjector(game)(viewer);
}
