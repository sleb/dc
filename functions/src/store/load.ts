// load (LLD 3 section 1): a read-only helper for tests and tools. The aggregate alone is enough to decide (S4).
import type { Game } from "@dc/engine";
import type { Firestore } from "firebase-admin/firestore";
import { splitStore } from "./plan";
import { gamePath } from "./refs";
import type { GameDoc, StoreMeta } from "./types";

export async function load(db: Firestore, gameId: string): Promise<{ game: Game; store: StoreMeta } | null> {
  const snap = await db.doc(gamePath(gameId)).get();
  if (!snap.exists) return null;
  const { prev, store } = splitStore(snap.data() as GameDoc);
  return { game: prev, store };
}
