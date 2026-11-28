// Crafted emulator state (LLD 3 sections 6.4 and 10.3, #37): the shapes the production path cannot (yet) produce — an oversized
// aggregate, a game stopped one pick before it finishes, the cascade's seeded side rows and a `store.deleting` game. Catalogue
// shapes are built by `fixtures.ts` through the real commands; nothing here may become a fixture.
import { PROJECTOR_REV, decide, fanOut, makeRng } from "@dc/engine";
import type { Game, GameDrafts } from "@dc/engine";
import type { Firestore } from "firebase-admin/firestore";
import { HOST_NAME, newGameId, newRoomCode, pid } from "./ids";

const CRAFTED_NOW = 1_000_000;

/** A fresh LOBBY game from the Engine's createGame, host seated as pid(0). */
export function craftedGame(o: { gameId?: string; hostId?: string; roomCode?: string } = {}): Game {
  const gameId = o.gameId ?? newGameId();
  const hostId = o.hostId ?? `host-${gameId}`;
  const res = decide(null, { type: "createGame", gameId, roomCode: o.roomCode ?? newRoomCode(), hostId, hostPlayerId: pid(0), hostName: HOST_NAME } as never, {
    now: CRAFTED_NOW, rng: makeRng("seed"), mintId: () => "c_0000000000", actor: { kind: "user", uid: hostId }, drafts: {},
  });
  if (!res.ok) throw new Error(`createGame rejected: ${res.error.code}`);
  return res.value.state;
}

export interface CraftedOptions {
  drafts?: GameDrafts;
}

/**
 * Writes `game` as the Store would have committed it: the aggregate with the current `store` map, every view doc from a creation
 * fan-out, the drafted text and the room code. No `events/1` and no host ledger — a crafted game is not created by `createGame`.
 */
export async function seedCraftedGame(db: Firestore, game: Game, o: CraftedOptions = {}): Promise<void> {
  const now = game.createdAt;
  const batch = db.batch();
  batch.set(db.doc(`games/${game.id}`), { ...game, store: { schema: 1, viewsRev: PROJECTOR_REV, updatedAt: now, deleting: null } });
  for (const w of fanOut(null, game, { now, storedRev: 0 })) batch.set(db.doc(`games/${game.id}/views/${w.docId}`), w.doc);
  for (const [playerId, d] of Object.entries(o.drafts ?? {})) batch.set(db.doc(`games/${game.id}/drafts/${playerId}`), { red: d.red, green: d.green, seq: 1, updatedAt: now });
  batch.set(db.doc(`roomCodes/${game.roomCode}`), { gameId: game.id, createdAt: game.createdAt });
  await batch.commit();
}