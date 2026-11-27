// Document paths (LLD 3 section 2.1). Pure strings, so the planner needs no Firestore handle.
import type { GameId, PlayerId, Uid } from "@dc/contracts";

export const gamePath = (g: GameId): string => `games/${g}`;
/** createGame has no game to hold its ledger, so it lives under the host (LLD 3 section 6.1). */
export const hostIdemPath = (hostUid: Uid, id: string): string => `hosts/${hostUid}/idem/${id}`;
/** The host's whole createGame ledger; the cascade scans it in `__name__` order, with no query index (#82). */
export const hostIdemCollectionPath = (hostUid: Uid): string => `hosts/${hostUid}/idem`;
export const idemPath = (g: GameId, id: string): string => `games/${g}/idem/${id}`;
export const draftPath = (g: GameId, p: PlayerId): string => `games/${g}/drafts/${p}`;
export const roundPath = (g: GameId, n: number): string => `games/${g}/rounds/${n}`;
export const viewPath = (g: GameId, docId: string): string => `games/${g}/views/${docId}`;
export const eventPath = (g: GameId, v: number): string => `games/${g}/events/${v}`;
export const outboxPath = (g: GameId, rowId: string): string => `games/${g}/outbox/${rowId}`;
export const roomCodePath = (code: string): string => `roomCodes/${code}`;
/** The cascade job outlives the aggregate (LLD 3 section 6.4). */
export const deletionPath = (g: GameId): string => `deletions/${g}`;
