// listWaitingOn (LLD 3 section 7, #35). RED STUB: the query is the bare registry entry and the mapping is empty, so U9/U10 fail on assertions.
import type { GameId, PlayerId } from "@dc/contracts";
import type { Firestore, Query } from "firebase-admin/firestore";
import { registryQuery } from "./registry-query";

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
  return registryQuery(db, "waitingOn", { values: { reminderDueAt: o.now } });
}

/** Maps one query page to a `WaitingPage`. Pure, so the seven-field shape and the `next` rule are proved without the emulator. */
export function pageOf(_docs: readonly { id: string; get(field: string): unknown }[], _limit: number): WaitingPage {
  return { items: [], next: null };
}

/** LLD 3 section 7: one page of the `waitingOn` registry query, default 100. */
export async function listWaitingOn(_db: Firestore, _o: { now: number; limit?: number; after?: WaitingPage["next"] }): Promise<WaitingPage> {
  return { items: [], next: null };
}
