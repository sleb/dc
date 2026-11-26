// Viewers and the set of view documents (LLD 2 section 3). Pure: no state, no clock.
import type { DepartedReason } from "@dc/contracts";
import { actorRole } from "../roles";
import type { Game, PlayerId, Uid } from "../types";

export type Viewer =
  | { kind: "player"; uid: Uid; playerId: PlayerId; isHost: boolean } // seated: writing, ready or active (the host's own seat included)
  | { kind: "spectator"; uid: Uid | null; isHost: boolean } // uid null is the shared spectator doc; isHost is a host with no seat
  | { kind: "departed"; uid: Uid; playerId: PlayerId; reason: DepartedReason };

/** One view document that must exist: its key under `games/{id}/views` and who reads it. */
export interface ViewTarget { docId: string; viewer: Viewer }

/** The shared spectator doc's key. A seat uid contains `seat:` and a Firebase uid is 28 characters, so it cannot collide (LLD 2 3.4). */
export const SPECTATOR_DOC = "spectator";

/**
 * The viewer for a uid (LLD 2 3.2), first match wins: a seated player; the host without a seat (the host rule beats a tombstone, PJ9);
 * a departed record; else the shared spectator. `null` is an anonymous spectator.
 */
export function viewerFor(game: Game, uid: Uid | null): Viewer {
  if (uid === null) return { kind: "spectator", uid: null, isHost: false };
  const roles = actorRole(game, { kind: "user", uid });
  if (roles.playerId !== null) return { kind: "player", uid, playerId: roles.playerId, isHost: roles.host };
  if (roles.host) return { kind: "spectator", uid, isHost: true };
  const gone = game.players.find((p) => p.uid === uid && (p.status === "left" || p.status === "removed"));
  if (gone !== undefined && (gone.status === "left" || gone.status === "removed")) return { kind: "departed", uid, playerId: gone.id, reason: gone.status };
  return { kind: "spectator", uid: null, isHost: false };
}

/** The key of a viewer's document: its uid, or the shared key for the anonymous spectator. */
export function docIdOf(viewer: Viewer): string {
  return viewer.kind === "spectator" ? (viewer.uid ?? SPECTATOR_DOC) : viewer.uid;
}

/**
 * Every view document that must exist for this state (LLD 2 3.3), in a fixed order: seated players in list order, the unseated host,
 * the shared spectator, then departed players (never the host: their doc is the unseated-host view).
 */
export function viewersOf(game: Game): ViewTarget[] {
  const targets: ViewTarget[] = [];
  const seated = game.players.filter((p) => p.status === "writing" || p.status === "ready" || p.status === "active");
  for (const p of seated) targets.push({ docId: p.uid, viewer: { kind: "player", uid: p.uid, playerId: p.id, isHost: p.uid === game.hostId } });
  if (!targets.some((t) => t.docId === game.hostId)) targets.push({ docId: game.hostId, viewer: { kind: "spectator", uid: game.hostId, isHost: true } });
  targets.push({ docId: SPECTATOR_DOC, viewer: { kind: "spectator", uid: null, isHost: false } });
  for (const p of game.players) {
    if ((p.status === "left" || p.status === "removed") && p.uid !== game.hostId) targets.push({ docId: p.uid, viewer: { kind: "departed", uid: p.uid, playerId: p.id, reason: p.status } });
  }
  return targets;
}
