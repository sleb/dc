// The LLD 3 section 3.3 denial matrix as data (#32). `store.rules.test.ts` runs every (row, target, principal,
// operation) cell of it against `firestore.rules` on the emulator, and `scripts/rules-coverage.test.ts` (P10, in
// `bun run test`) checks that it names every collection the rules, the LLD 3 section 2.1 table and tech-stack section 5
// name. Pure data: no Firebase import, so the coverage test can load it without an emulator.
//
// Operation semantics, per target:
// - a document target runs `get` (getDoc), `list` (a query over its parent collection), `create` (setDoc of a new id
//   in the same collection, or of the path itself when the row seeds it missing), `update` (updateDoc) and `delete`;
// - a query target (a collection or collection-group query, rows 11, 17, 18) runs `list` only: it has no document to
//   get, create, update or delete.
// Every cell not listed in `allow` must fail with exactly `permission-denied`.

export type Op = "get" | "list" | "create" | "update" | "delete";
export const OPS: readonly Op[] = ["get", "list", "create", "update", "delete"];

export type PrincipalId =
  | "anon0"
  | "spec"
  | "seatA"
  | "seatB"
  | "seatAold"
  | "host"
  | "host2"
  | "gone"
  | "specLiteral"
  | "seatAnoEp"
  | "seatAstrEp";

/** `uid: null` is the unauthenticated context. `claims` are custom token claims (`ep`, K-B). */
export interface Principal {
  id: PrincipalId;
  uid: string | null;
  claims?: Record<string, unknown>;
  note: string;
}

export const GAME = "g1";
export const HOST_UID = "hostUid";

/** The eight principals of LLD 3 section 3.3, plus the three tokens rows 20 and 21 name; all run on every row. */
export const PRINCIPALS: readonly Principal[] = [
  { id: "anon0", uid: null, note: "not signed in" },
  { id: "spec", uid: "anonSpectatorUid", claims: { firebase: { sign_in_provider: "anonymous" } }, note: "spectator, anonymous Auth" },
  { id: "seatA", uid: "seat:g1:pA", claims: { ep: 1 }, note: "player A, current epoch" },
  { id: "seatB", uid: "seat:g1:pB", claims: { ep: 0 }, note: "player B, current epoch" },
  { id: "seatAold", uid: "seat:g1:pA", claims: { ep: 0 }, note: "player A on a pre-reissue session" },
  { id: "host", uid: HOST_UID, note: "host of g1, seated" },
  { id: "host2", uid: "hostUid2", note: "a different host" },
  { id: "gone", uid: "seat:g1:pR", claims: { ep: 0 }, note: "removed player with a tombstone" },
  { id: "specLiteral", uid: "spectator", note: "row 20: a user whose uid is the literal `spectator`" },
  { id: "seatAnoEp", uid: "seat:g1:pA", note: "row 21: player A's uid with no `ep` claim" },
  { id: "seatAstrEp", uid: "seat:g1:pA", claims: { ep: "1" }, note: "row 21: player A's uid with a string `ep`" },
];

/** The principal ids the LLD 3 section 3.3 principals table defines (the extras are named by rows 20 and 21). */
export const LLD_PRINCIPALS: readonly PrincipalId[] = ["anon0", "spec", "seatA", "seatB", "seatAold", "host", "host2", "gone"];

const SIGNED_IN: readonly PrincipalId[] = PRINCIPALS.filter((p) => p.uid !== null).map((p) => p.id);

/** A where clause for a query target; `value` is a literal. */
export interface Where {
  field: string;
  op: "==";
  value: string | number | boolean;
}

export type Target =
  | { kind: "doc"; path: string; missing?: true }
  | { kind: "collection"; path: string; where?: Where }
  | { kind: "collectionGroup"; group: string };

/** Spectator doc state the row needs; the baseline seeds `enabled: true`. */
export type SpectatorState = "enabled" | "disabled" | "missing";

export interface Row {
  n: number;
  title: string;
  targets: readonly Target[];
  /** The only cells that must succeed. */
  allow: Partial<Record<Op, readonly PrincipalId[]>>;
  spectator?: SpectatorState;
  /** Row 19: paths no rule and no LLD 3 section 2.1 row names. Excluded from the section 2.1 comparison. */
  unlisted?: true;
}

const doc = (path: string): Target => ({ kind: "doc", path });

export const ROWS: readonly Row[] = [
  { n: 1, title: "the aggregate", targets: [doc("games/g1")], allow: {} },
  { n: 2, title: "a draft, even its author's", targets: [doc("games/g1/drafts/pA")], allow: {} },
  { n: 3, title: "resolved rounds: get and list for every signed-in principal, no writes", targets: [doc("games/g1/rounds/1")], allow: { get: SIGNED_IN, list: SIGNED_IN } },
  { n: 4, title: "seat A's view: its own epoch-current session only", targets: [doc("games/g1/views/seat:g1:pA")], allow: { get: ["seatA"] } },
  { n: 5, title: "seat B's view", targets: [doc("games/g1/views/seat:g1:pB")], allow: { get: ["seatB"] } },
  { n: 6, title: "a removed player's tombstone", targets: [doc("games/g1/views/seat:g1:pR")], allow: { get: ["gone"] } },
  { n: 7, title: "the host's view", targets: [doc("games/g1/views/hostUid")], allow: { get: ["host"] } },
  { n: 8, title: "the spectator view while enabled", targets: [doc("games/g1/views/spectator")], allow: { get: SIGNED_IN }, spectator: "enabled" },
  { n: 9, title: "the spectator view while disabled", targets: [doc("games/g1/views/spectator")], allow: {}, spectator: "disabled" },
  { n: 10, title: "the spectator view, document missing", targets: [{ kind: "doc", path: "games/g1/views/spectator", missing: true }], allow: {}, spectator: "missing" },
  {
    n: 11,
    title: "views collection list, any query",
    targets: [
      { kind: "collection", path: "games/g1/views" },
      { kind: "collection", path: "games/g1/views", where: { field: "enabled", op: "==", value: true } },
    ],
    allow: {},
  },
  {
    n: 12,
    title: "private game subcollections",
    targets: [doc("games/g1/events/1"), doc("games/g1/outbox/v1_0"), doc("games/g1/idem/x"), doc("games/g1/seats/pA"), doc("games/g1/notifLog/k")],
    allow: {},
  },
  {
    n: 13,
    title: "server-only top-level collections, including a seat's own pushSubs and joinIdem rows",
    targets: [doc("roomCodes/ABCD"), doc("joinIdem/h"), doc("pushSubs/seat:g1:pA_g1"), doc("rateLimits/join_x"), doc("deletions/g1")],
    allow: {},
  },
  { n: 14, title: "the host profile, even for its host", targets: [doc("hosts/hostUid")], allow: {} },
  { n: 15, title: "saved decks: get and list by their host only", targets: [doc("hosts/hostUid/decks/d1")], allow: { get: ["host"], list: ["host"] } },
  { n: 16, title: "the createGame ledger", targets: [doc("hosts/hostUid/idem/x")], allow: {} },
  {
    n: 17,
    title: "collection-group queries",
    targets: ["rounds", "views", "outbox", "idem", "decks", "events", "seats"].map((group): Target => ({ kind: "collectionGroup", group })),
    allow: {},
  },
  { n: 18, title: "a games query by host", targets: [{ kind: "collection", path: "games", where: { field: "hostId", op: "==", value: HOST_UID } }], allow: {} },
  { n: 19, title: "unlisted paths", targets: [doc("foo/bar"), doc("games/g1/unknown/x")], allow: {}, unlisted: true },
  { n: 20, title: "the literal `spectator` uid on a disabled spectator view (the uid != 'spectator' guard)", targets: [doc("games/g1/views/spectator")], allow: {}, spectator: "disabled" },
  { n: 21, title: "seat A's view with no `ep` claim or a string `ep` (K-B)", targets: [doc("games/g1/views/seat:g1:pA")], allow: { get: ["seatA"] } },
];

/** Documents seeded (rules disabled) before any case runs. `seats/*.epoch` is what the `ep` check compares. */
export const SEED: Readonly<Record<string, Record<string, unknown>>> = {
  "games/g1": { hostId: HOST_UID, phase: "LOBBY", version: 1 },
  "games/g1/drafts/pA": { red: [], green: [] },
  "games/g1/rounds/1": { round: 1, plays: [] },
  "games/g1/views/seat:g1:pA": { enabled: true, view: {} },
  "games/g1/views/seat:g1:pB": { enabled: true, view: {} },
  "games/g1/views/seat:g1:pR": { enabled: true, view: {} },
  "games/g1/views/hostUid": { enabled: true, view: {} },
  "games/g1/views/spectator": { enabled: true, view: {} },
  "games/g1/events/1": { events: [] },
  "games/g1/outbox/v1_0": { topic: "notify" },
  "games/g1/idem/x": { meta: {} },
  "games/g1/seats/pA": { uid: "seat:g1:pA", epoch: 1 },
  "games/g1/seats/pB": { uid: "seat:g1:pB", epoch: 0 },
  "games/g1/seats/pR": { uid: "seat:g1:pR", epoch: 0 },
  "games/g1/notifLog/k": { at: 1 },
  "roomCodes/ABCD": { gameId: GAME },
  "joinIdem/h": { gameId: GAME, playerId: "pA" },
  "pushSubs/seat:g1:pA_g1": { gameId: GAME, uid: "seat:g1:pA", devices: {} },
  "rateLimits/join_x": { count: 1 },
  "deletions/g1": { status: "running" },
  "hosts/hostUid": { schema: 1 },
  "hosts/hostUid/decks/d1": { name: "deck" },
  "hosts/hostUid/idem/x": { meta: {} },
  "foo/bar": { a: 1 },
  "games/g1/unknown/x": { a: 1 },
};

/** The operations a target runs: all five for a document, `list` alone for a query. */
export function opsOf(target: Target): readonly Op[] {
  return target.kind === "doc" ? OPS : ["list"];
}

/** Whether a cell must succeed. */
export function allowed(row: Row, principal: PrincipalId, op: Op): boolean {
  return (row.allow[op] ?? []).includes(principal);
}

/** The number of cases the suite must execute (the R2 guard). */
export function caseCount(rows: readonly Row[] = ROWS, principals: readonly Principal[] = PRINCIPALS): number {
  return rows.reduce((n, row) => n + row.targets.reduce((m, t) => m + opsOf(t).length, 0) * principals.length, 0);
}

/** `games/g1/views/spectator` -> `games/{}/views`; a collection path `hosts/hostUid/decks` -> `hosts/{}/decks`. */
export function collectionPathOf(target: Target): string | null {
  if (target.kind === "collectionGroup") return null;
  const segments = target.path.split("/");
  const collection = target.kind === "doc" ? segments.slice(0, -1) : segments;
  return collection.map((s, i) => (i % 2 === 1 ? "{}" : s)).join("/");
}
