// The Projector's public surface so far (LLD 2 section 2). `fanOut`, `draftRegion`, `toRoundDoc`, `projectFeed` and `PROJECTOR_REV` arrive with #29.
import type { GameView } from "@dc/contracts";
import type { Game } from "../types";
import type { Viewer } from "./viewer";

export { docIdOf, viewerFor, viewersOf } from "./viewer";
export type { Viewer, ViewTarget } from "./viewer";

export function project(_game: Game, _viewer: Viewer): GameView {
  throw new Error("not implemented: project");
}

export function makeProjector(_game: Game): (viewer: Viewer) => GameView {
  throw new Error("not implemented: makeProjector");
}
