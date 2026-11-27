// rebuildViews (LLD 3 sections 5.6 and 6.5, #35). RED STUB: every doc looks absent, so U11-U13 fail on assertions.
import type { GameId } from "@dc/contracts";
import type { Firestore } from "firebase-admin/firestore";
import type { GameDoc } from "./types";
import type { DocWrite } from "./writeset";

/** The pure plan: the outcome plus every write, so the write set is proved without the emulator. */
export type RebuildPlan =
  | { kind: "missing"; writes: [] }
  | { kind: "deleting"; writes: [] }
  | { kind: "rebuilt"; gameId: GameId; version: number; viewsRev: number; writes: DocWrite[] };

/** What the caller gets: the rebuilt version (unchanged) and how many documents were written. */
export type RebuildResult =
  | { kind: "missing" }
  | { kind: "deleting" }
  | { kind: "rebuilt"; gameId: GameId; version: number; viewsRev: number; writes: number };

/** The pure half: a missing aggregate or a `store.deleting` one writes nothing; otherwise the aggregate's rev and every view. */
export function planRebuild(_doc: GameDoc | null, _o: { now: number }): RebuildPlan {
  return { kind: "missing", writes: [] };
}

/** The shell: one transaction, the aggregate read inside it, the planned writes and a typed result. */
export async function rebuildViews(_db: Firestore, _gameId: GameId, _o: { now: number }): Promise<RebuildResult> {
  return { kind: "missing" };
}
