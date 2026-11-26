// Every production Firestore query, declared as data (LLD 3 section 4, #32). Nothing here touches Firestore: the
// index-registry test (`queries.test.ts`) proves each query is served by an automatic single-field index or a
// composite in `firestore.indexes.json` and that no field exemption covers a field it uses, and the post-deploy smoke
// (`scripts/smoke.ts`) runs each one against the deployed project, where a missing index is a hard failure.
//
// Consumers (`listWaitingOn`, the deletion cascade and sweep, LLD 4's rejoin lookup, LLD 5's `listGamesByHost`, LLD 6's
// redrives, LLD 7's history listener) build their queries from these entries rather than redeclaring them, so a new
// query cannot ship without an index check. Adding a query here is how a later step asks for an index.

export type QueryScope = "COLLECTION" | "COLLECTION_GROUP";
export type WhereOp = "==" | "<" | "<=" | ">" | ">=";
export type Direction = "ASCENDING" | "DESCENDING";

/** `value` is what the smoke sends: the literal for `== null`, otherwise a probe of the field's type. */
export interface WhereClause {
  field: string;
  op: WhereOp;
  value: string | number | null;
}

export interface DeclaredQuery {
  id: string;
  /** The collection id (`games`, `outbox`), which is also the index's collection group. */
  collectionGroup: string;
  scope: QueryScope;
  /** Path of the parent document for a COLLECTION-scope subcollection query, `{}` standing for an id; "" at the root. */
  parent: string;
  where: readonly WhereClause[];
  /** `__name__` is the document id (FieldPath.documentId()). */
  orderBy: readonly { field: string; direction: Direction }[];
  /** Where the query is specified. */
  source: string;
}

export const DOCUMENT_ID = "__name__";

export const QUERIES: readonly DeclaredQuery[] = [
  {
    id: "gamesByHost",
    collectionGroup: "games",
    scope: "COLLECTION",
    parent: "",
    where: [{ field: "hostId", op: "==", value: "probe" }],
    orderBy: [{ field: "createdAt", direction: "DESCENDING" }],
    source: "LLD 3 open question 4, LLD 5 listGamesByHost",
  },
  {
    id: "waitingOn",
    collectionGroup: "games",
    scope: "COLLECTION",
    parent: "",
    where: [{ field: "reminderDueAt", op: "<=", value: 0 }],
    orderBy: [
      { field: "reminderDueAt", direction: "ASCENDING" },
      { field: DOCUMENT_ID, direction: "ASCENDING" },
    ],
    source: "LLD 3 section 7 listWaitingOn",
  },
  {
    id: "outboxRedrive",
    collectionGroup: "outbox",
    scope: "COLLECTION_GROUP",
    parent: "",
    where: [
      { field: "processedAt", op: "==", value: null },
      { field: "at", op: "<", value: 0 },
    ],
    orderBy: [{ field: "at", direction: "ASCENDING" }],
    source: "LLD 3 section 8, LLD 6 section 4.6 outbox redrive",
  },
  {
    id: "identityCleanup",
    collectionGroup: "outbox",
    scope: "COLLECTION_GROUP",
    parent: "",
    where: [
      { field: "topic", op: "==", value: "identity" },
      { field: "notifDoneAt", op: "==", value: null },
      { field: "at", op: "<", value: 0 },
    ],
    orderBy: [{ field: "at", direction: "ASCENDING" }],
    source: "LLD 3 section 8, LLD 6 section 4.6 push-cleanup redrive",
  },
  {
    id: "stuckDeletions",
    collectionGroup: "deletions",
    scope: "COLLECTION",
    parent: "",
    where: [
      { field: "status", op: "==", value: "running" },
      { field: "heartbeatAt", op: "<", value: 0 },
    ],
    orderBy: [],
    source: "LLD 3 section 6.4 stuck-job sweep",
  },
  {
    id: "pushSubsByGame",
    collectionGroup: "pushSubs",
    scope: "COLLECTION",
    parent: "",
    where: [{ field: "gameId", op: "==", value: "probe" }],
    orderBy: [],
    source: "LLD 3 section 6.4 cascade stage push",
  },
  {
    id: "joinIdemByGame",
    collectionGroup: "joinIdem",
    scope: "COLLECTION",
    parent: "",
    where: [{ field: "gameId", op: "==", value: "probe" }],
    orderBy: [],
    source: "LLD 3 section 6.4 cascade stage joinIdem",
  },
  {
    id: "seatBySecret",
    collectionGroup: "seats",
    scope: "COLLECTION",
    parent: "games/{}",
    where: [{ field: "secretHash", op: "==", value: "probe" }],
    orderBy: [],
    source: "LLD 4 rejoin",
  },
  {
    id: "outboxSiblings",
    collectionGroup: "outbox",
    scope: "COLLECTION",
    parent: "games/{}",
    where: [{ field: "version", op: "==", value: 0 }],
    orderBy: [],
    source: "LLD 6 section 3.3 sibling rows (planVersion)",
  },
  {
    id: "roundsByNumber",
    collectionGroup: "rounds",
    scope: "COLLECTION",
    parent: "games/{}",
    where: [],
    orderBy: [{ field: "round", direction: "ASCENDING" }],
    source: "LLD 7 history listener",
  },
];
