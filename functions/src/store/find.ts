// findByRoomCode (LLD 3 section 6.1, #34): one `get` of roomCodes/{code}, normalized and validated. Typed stub for the red commit.
import type { Firestore } from "firebase-admin/firestore";
import type { RoomCodeDoc } from "./types";

export async function findByRoomCode(_db: Firestore, _code: string): Promise<RoomCodeDoc | null> {
  return null;
}
