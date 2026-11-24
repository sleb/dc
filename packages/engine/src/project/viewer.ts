// Viewers and the set of view documents (LLD 2 section 3).
import type { DepartedReason } from "@dc/contracts";
import type { Game, PlayerId, Uid } from "../types";

export type Viewer =
  | { kind: "player"; uid: Uid; playerId: PlayerId; isHost: boolean }
  | { kind: "spectator"; uid: Uid | null; isHost: boolean }
  | { kind: "departed"; uid: Uid; playerId: PlayerId; reason: DepartedReason };

export interface ViewTarget { docId: string; viewer: Viewer }

export function viewerFor(_game: Game, _uid: Uid | null): Viewer {
  throw new Error("not implemented: viewerFor");
}

export function viewersOf(_game: Game): ViewTarget[] {
  throw new Error("not implemented: viewersOf");
}

export function docIdOf(_viewer: Viewer): string {
  throw new Error("not implemented: docIdOf");
}
