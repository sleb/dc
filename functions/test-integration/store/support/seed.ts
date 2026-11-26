// Test-local seeding (#33, ruling 2): a game built in Bun with the real Engine and written with the Admin SDK in the shape the Store writes
// (aggregate with `store`, every view doc from a creation fan-out, the room code). No production code path writes it; #34 replaces this with the
// real createGame. From the seed on, the suites drive the game only through the harness.
import { randomBytes } from "node:crypto";
import { PROJECTOR_REV, decide, fanOut, makeRng } from "@dc/engine";
import type { Game, GameDrafts } from "@dc/engine";
import type { Firestore } from "firebase-admin/firestore";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const CODE = "BCDFGHJKLMNPQRSTVWXZ";

export const newGameId = (): string => [...randomBytes(20)].map((b) => ALNUM[b % ALNUM.length]).join("");
export const newRoomCode = (): string => [...randomBytes(4)].map((b) => CODE[b % CODE.length]).join("");
export const pid = (n: number): string => `p_aaaaaa${B32[Math.floor(n / 32) % 32] ?? "a"}${B32[n % 32] ?? "a"}`;
export const seatUid = (gameId: string, playerId: string): string => `seat:${gameId}:${playerId}`;
export const newKey = (): string => crypto.randomUUID();
export const HOST_NAME = "NAME-SENTINEL-host";

/** A fresh LOBBY game from the Engine's createGame, host seated as pid(0). */
export function createdGame(o: { gameId?: string; hostId?: string; roomCode?: string; now?: number; settings?: Record<string, unknown> } = {}): Game {
  const gameId = o.gameId ?? newGameId();
  const hostId = o.hostId ?? `host-${gameId}`;
  const res = decide(null, { type: "createGame", gameId, roomCode: o.roomCode ?? newRoomCode(), hostId, hostPlayerId: pid(0), hostName: HOST_NAME, ...(o.settings ? { settings: o.settings } : {}) } as never, {
    now: o.now ?? 1_000_000, rng: makeRng("seed"), mintId: () => "c_0000000000", actor: { kind: "user", uid: hostId }, drafts: {},
  });
  if (!res.ok) throw new Error(`createGame rejected: ${res.error.code}`);
  return res.value.state;
}

export interface SeedOptions { viewsRev?: number; drafts?: GameDrafts; roomCode?: boolean; now?: number }

/** Writes `game` as the Store would have committed it. */
export async function seedGame(db: Firestore, game: Game, o: SeedOptions = {}): Promise<void> {
  const now = o.now ?? game.createdAt;
  const batch = db.batch();
  batch.set(db.doc(`games/${game.id}`), { ...game, store: { schema: 1, viewsRev: o.viewsRev ?? PROJECTOR_REV, updatedAt: now, deleting: null } });
  for (const w of fanOut(null, game, { now, storedRev: 0 })) batch.set(db.doc(`games/${game.id}/views/${w.docId}`), w.doc);
  for (const [playerId, d] of Object.entries(o.drafts ?? {})) batch.set(db.doc(`games/${game.id}/drafts/${playerId}`), { red: d.red, green: d.green, seq: 1, updatedAt: now });
  if (o.roomCode !== false) batch.set(db.doc(`roomCodes/${game.roomCode}`), { gameId: game.id, createdAt: game.createdAt });
  await batch.commit();
}
