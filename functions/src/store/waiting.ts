// listWaitingOn (LLD 3 section 7, #35): one page of the `waitingOn` registry query. The query is built from the registry entry (queries.ts) via
// registryQuery, then gets the projection, the limit and the keyset cursor; the pure `pageOf` maps snapshots to the seven-field item and decides
// `next`. `next` is null only on a short page, so a full final page yields one empty page and then null.
import type { GameId, PlayerId } from "@dc/contracts";
import type { Firestore, Query } from "firebase-admin/firestore";
import { registryQuery } from "./registry-query";

/** The Scheduler's default page size (LLD 3 section 7, LLD 6 section 5.1). */
export const DEFAULT_WAITING_LIMIT = 100;

/** The projected fields: the item plus nothing else is ever read off the aggregate. */
const SELECT = ["reminderDueAt", "episode", "episodeGen", "waitingOn", "waitingSince", "version"] as const;

/** One due game as the Scheduler sees it (LLD 3 section 7): exactly the seven fields below. */
export interface WaitingGame {
  gameId: GameId;
  episode: string;
  episodeGen: number;
  waitingOn: PlayerId[];
  since: number;
  dueAt: number;
  version: number;
}

/** One page; `next` is the keyset cursor of the last item, null only on a short page. */
export interface WaitingPage {
  items: WaitingGame[];
  next: { dueAt: number; gameId: GameId } | null;
}

export interface WaitingQuery {
  now: number;
  limit: number;
  after?: WaitingPage["next"];
}

/** The registry's `waitingOn` query plus the projection, limit and keyset cursor. Building a query connects to nothing. */
export function waitingPageQuery(db: Firestore, o: WaitingQuery): Query {
  let q = registryQuery(db, "waitingOn", { values: { reminderDueAt: o.now } })
    .select(...SELECT)
    .limit(o.limit);
  const after = o.after ?? null;
  if (after !== null) q = q.startAfter(after.dueAt, after.gameId);
  return q;
}

/** Maps one query page to a `WaitingPage`. Pure, so the seven-field shape and the `next` rule are proved without the emulator. */
export function pageOf(docs: readonly { id: string; get(field: string): unknown }[], limit: number): WaitingPage {
  const items: WaitingGame[] = docs.map((s) => ({
    gameId: s.id,
    episode: s.get("episode") as string,
    episodeGen: s.get("episodeGen") as number,
    waitingOn: s.get("waitingOn") as PlayerId[],
    since: s.get("waitingSince") as number,
    dueAt: s.get("reminderDueAt") as number,
    version: s.get("version") as number,
  }));
  const last = docs.at(-1);
  return { items, next: docs.length === limit && last !== undefined ? { dueAt: last.get("reminderDueAt") as number, gameId: last.id } : null };
}

/** LLD 3 section 7: one page of the `waitingOn` registry query, default 100. */
export async function listWaitingOn(db: Firestore, o: { now: number; limit?: number; after?: WaitingPage["next"] }): Promise<WaitingPage> {
  const limit = o.limit ?? DEFAULT_WAITING_LIMIT;
  const after = o.after ?? null;
  const snap = await waitingPageQuery(db, { now: o.now, limit, ...(after === null ? {} : { after }) }).get();
  return pageOf(snap.docs, limit);
}
