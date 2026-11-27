// findByRoomCode (LLD 3 section 6.1, #34): one `get` of roomCodes/{code}, normalized and validated first. It applies no time window: the 72 h lookup
// rule is Identity's (LLD 4 section 8.1, #42), which filters on `createdAt`.
import { RoomCodeSchema } from "@dc/contracts";
import type { Firestore } from "firebase-admin/firestore";
import { roomCodePath } from "./refs";
import type { RoomCodeDoc } from "./types";

/** `{gameId, createdAt}` for a code that exists, else null; a malformed code is null before any read. */
export async function findByRoomCode(db: Firestore, code: string): Promise<RoomCodeDoc | null> {
  const parsed = RoomCodeSchema.safeParse(code);
  if (!parsed.success) return null;
  const snap = await db.doc(roomCodePath(parsed.data)).get();
  if (!snap.exists) return null;
  const doc = snap.data() as RoomCodeDoc;
  return { gameId: doc.gameId, createdAt: doc.createdAt };
}
