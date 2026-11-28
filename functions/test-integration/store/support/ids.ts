// Shared ids and names for the emulator suites (LLD 3 sections 2.4 and 10.1, #37): the shapes production uses, generated the same way.
// Catalogue fixtures and the crafted-state helper both import them; nothing here touches Firestore.
import { randomBytes } from "node:crypto";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const CODE = "BCDFGHJKLMNPQRSTVWXZ";

/** A 20-character id, the shape of a Firestore auto-id (GameIdSchema). */
export const newGameId = (): string => [...randomBytes(20)].map((b) => ALNUM[b % ALNUM.length]).join("");
export const newRoomCode = (): string => [...randomBytes(4)].map((b) => CODE[b % CODE.length]).join("");
/** `p_` + 8 base32 characters; seat N of every suite is the same id. */
export const pid = (n: number): string => `p_aaaaaa${B32[Math.floor(n / 32) % 32] ?? "a"}${B32[n % 32] ?? "a"}`;
export const seatUid = (gameId: string, playerId: string): string => `seat:${gameId}:${playerId}`;
export const newKey = (): string => crypto.randomUUID();
export const HOST_NAME = "NAME-SENTINEL-host";