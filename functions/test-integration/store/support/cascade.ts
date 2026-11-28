// The deleteGame cascade fixture (#36, LLD 3 sections 6.4 and 10.3): 4 seated players, one resolved round, a late
// joiner's saved draft, a LOBBY leaver (no player record, only a seeded `seats/*` row) and a non-LOBBY departure whose
// uid survives only in `seatUids`. The documentation shapes of pushSubs, joinIdem, notifLog, seats, hosts decks and
// hosts idem are seeded here because their real writers are #41/#42/#43/M6; the cascade must still remove the ones that
// name the game and leave the other game's rows alone.
import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import type { Command } from "@dc/contracts";
import type { Game, GameDrafts } from "@dc/engine";
import { idemId } from "../../../src/store";
import { MemGame, pid } from "../../../src/store/test-support";
import { seedCraftedGame } from "./crafted";
import { newGameId, newRoomCode, seatUid } from "./ids";

export interface Cascade {
  game: Game;
  drafts: GameDrafts;
  loobyLeaverUid: string;
  lateUid: string;
  departedUid: string;
  /** The non-host uid union the identity stage must purge: `seatUids` plus the LOBBY leaver's `seats/*` uid. */
  expectedUids: string[];
  pushSubId: string;
  joinIdemId: string;
  notifLogId: string;
  deckId: string;
  /** The host's createGame ledger for this game; the cascade must remove it (ST9). */
  hostIdemId: string;
  hostIdemKey: string;
  /** A second host ledger naming another game; it must survive. */
  otherHostIdemId: string;
  /** A crafted ledger row under a host who does not own the game, naming it; the cascade leaves it alone (#82). */
  crossHostId: string;
  crossHostLedgerId: string;
}

/**
 * Deterministic except for ids. `gameId`, `roomCode` and `hostId` may be pinned so two fixtures can be compared after
 * replacing the id; `playerId`s and seat uids follow from the game id.
 */
export function buildCascade(o: { gameId?: string; roomCode?: string; hostId?: string } = {}): Cascade {
  const gameId = o.gameId ?? newGameId();
  const hostId = o.hostId ?? `host-${gameId}`;
  const m = MemGame.create({ gameId, roomCode: o.roomCode ?? newRoomCode(), hostId }).joinAll(4);
  m.join(7);
  m.as(7, { type: "leave" } as Command); // LOBBY: the player record is deleted, the seat doc is seeded below
  m.start();
  m.playRound(); // one resolved round, PLAYING between rounds
  m.join(5); // a late joiner in PLAYING
  const late = m.game.players.find((p) => p.id === pid(5));
  if (late === undefined) throw new Error("cascade: no late joiner");
  m.run({ kind: "user", uid: late.uid }, { type: "saveDraft", ...m.fullDraft(late.id) } as Command);
  m.as(1, { type: "leave" } as Command); // a non-LOBBY departure: kept in players[], so its uid is in seatUids
  const loobyLeaverUid = seatUid(gameId, pid(7));
  const seatUids = m.game.players.map((p) => p.uid).filter((u) => u !== hostId);
  const hostIdemKey = `create-key-${gameId}`;
  return {
    game: m.game,
    drafts: m.drafts,
    loobyLeaverUid,
    lateUid: late.uid,
    departedUid: m.uidOf(1),
    expectedUids: [...new Set([...seatUids, loobyLeaverUid])].filter((u) => u !== hostId),
    pushSubId: `push-${gameId}`,
    joinIdemId: `join-${gameId}`,
    notifLogId: `notif-${gameId}`,
    deckId: `deck-${gameId}`,
    hostIdemId: idemId({ kind: "user", uid: hostId }, hostIdemKey),
    hostIdemKey,
    otherHostIdemId: idemId({ kind: "user", uid: hostId }, `other-key-${gameId}`),
    crossHostId: `host-cross-${gameId}`,
    crossHostLedgerId: idemId({ kind: "user", uid: `host-cross-${gameId}` }, `cross-key-${gameId}`),
  };
}

export interface CascadeExtras {
  gameId: string;
  hostId: string;
  ownedCode: string;
  otherCode: string;
  pushSubId: string;
  joinIdemId: string;
  notifLogId: string;
  deckId: string;
  hostIdemId: string;
  otherHostIdemId: string;
  otherPushSubId: string;
  otherJoinIdemId: string;
}

/** Writes the aggregate, views, drafts, the owned code and every documented side row. Returns the paths to inspect. */
export async function seedCascade(db: Firestore, c: Cascade, o: { now?: number } = {}): Promise<CascadeExtras> {
  const now = o.now ?? c.game.createdAt;
  await seedCraftedGame(db, c.game, { drafts: c.drafts });
  const otherCode = "ZZZZ";
  const otherPushSubId = "other-push";
  const otherJoinIdemId = "other-join";
  const expiresAt = Timestamp.fromMillis(now + 7 * 86_400_000);
  const batch = db.batch();
  batch.set(db.doc(`games/${c.game.id}/seats/${pid(7)}`), { uid: c.loobyLeaverUid, secretHash: "SEAT-SENTINEL-hash", createdAt: now, epoch: 0, notBefore: 0, firstSignInAt: null, revokedAt: null });
  // The host has a seat row too in the real Identity write; the identity stage must still never purge the host's Auth account.
  batch.set(db.doc(`games/${c.game.id}/seats/${pid(0)}`), { uid: c.game.hostId, secretHash: "SEAT-SENTINEL-host", createdAt: now, epoch: 0, notBefore: 0, firstSignInAt: null, revokedAt: null });
  batch.set(db.doc(`pushSubs/${c.pushSubId}`), { gameId: c.game.id, uid: c.lateUid, token: "PUSH-SENTINEL" });
  batch.set(db.doc(`joinIdem/${c.joinIdemId}`), { gameId: c.game.id, playerId: pid(5), uid: c.lateUid, createdAt: now, expiresAt });
  batch.set(db.doc(`games/${c.game.id}/notifLog/${c.notifLogId}`), { gameId: c.game.id, uid: c.game.hostId, at: now, title: "NOTIF-SENTINEL" });
  batch.set(db.doc(`hosts/${c.game.hostId}/decks/${c.deckId}`), { name: "Deck", red: ["DECK-SENTINEL-red"], green: ["DECK-SENTINEL-green"], createdAt: now, updatedAt: now });
  batch.set(db.doc(`hosts/${c.game.hostId}/idem/${c.hostIdemId}`), { at: now, expiresAt, commandType: "createGame", version: 1, gameId: c.game.id, roomCode: c.game.roomCode });
  batch.set(db.doc(`hosts/${c.game.hostId}/idem/${c.otherHostIdemId}`), { at: now, expiresAt, commandType: "createGame", version: 1, gameId: "another-game", roomCode: otherCode });
  // A crafted row under another host naming this game: no writer produces it, and the cascade reads only the host's own ledger (#82).
  batch.set(db.doc(`hosts/${c.crossHostId}/idem/${c.crossHostLedgerId}`), { at: now, expiresAt, commandType: "createGame", version: 1, gameId: c.game.id, roomCode: c.game.roomCode });
  batch.set(db.doc(`pushSubs/${otherPushSubId}`), { gameId: "another-game", uid: "another-uid", token: "OTHER-PUSH-SENTINEL" });
  batch.set(db.doc(`joinIdem/${otherJoinIdemId}`), { gameId: "another-game", playerId: pid(6), uid: "another-uid", createdAt: now, expiresAt });
  batch.set(db.doc(`roomCodes/${otherCode}`), { gameId: "another-game", createdAt: now });
  await batch.commit();
  return {
    gameId: c.game.id,
    hostId: c.game.hostId,
    ownedCode: c.game.roomCode,
    otherCode,
    pushSubId: c.pushSubId,
    joinIdemId: c.joinIdemId,
    notifLogId: c.notifLogId,
    deckId: c.deckId,
    hostIdemId: c.hostIdemId,
    otherHostIdemId: c.otherHostIdemId,
    otherPushSubId,
    otherJoinIdemId,
  };
}
