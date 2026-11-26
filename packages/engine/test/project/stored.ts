// #30: the doc the Store holds for one viewer: the view region fan-out writes, plus the viewer's own draft region (LLD 2 4.1, 8.4). Shared by the oracle tests and the suite.
import { VIEW_SCHEMA } from "@dc/contracts";
import type { GameView } from "@dc/contracts";
import { PROJECTOR_REV } from "../../src/project";
import type { Viewer } from "../../src/project";
import type { Game, GameDrafts } from "../../src/types";

/** `generatedAt` is 0: no check reads it. A spectator doc with spectators off is `enabled: false` with no view. A seated player's doc carries `draft` (null when none); nobody else's does. */
export function storedDoc(game: Game, drafts: GameDrafts, viewer: Viewer, view: GameView | null): Record<string, unknown> {
  const off = viewer.kind === "spectator" && viewer.uid === null && !game.settings.spectators.enabled;
  const doc: Record<string, unknown> = { schema: VIEW_SCHEMA, viewsRev: PROJECTOR_REV, gameId: game.id, enabled: !off, version: game.version, generatedAt: 0, view: off ? null : view };
  if (viewer.kind === "player") { const d = drafts[viewer.playerId]; doc.draft = d === undefined ? null : { red: [...d.red], green: [...d.green] }; }
  return doc;
}
