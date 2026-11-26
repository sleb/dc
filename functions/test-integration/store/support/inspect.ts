// Independent inspection for the store suites: a recursive document snapshot with update times, the diff between two snapshots (the oracle for the
// harness's write count), the PJ11 check that every stored view equals a full projection of the stored aggregate, the sentinel scan, and queries
// built from the 3.1 registry (functions/src/store/queries.ts), never redeclared.
import { makeProjector, viewersOf } from "@dc/engine";
import type { Game } from "@dc/engine";
import type { Firestore, Query } from "firebase-admin/firestore";
import { FieldPath } from "firebase-admin/firestore";
import { DOCUMENT_ID, QUERIES } from "../../../src/store/queries";
import { db } from "./harness";

export interface Snap { updateTime: string; data: Record<string, unknown> }
const ts = (t: { seconds: number; nanoseconds: number } | undefined): string => (t === undefined ? "" : `${t.seconds}.${String(t.nanoseconds).padStart(9, "0")}`);
export type Snapshot = Map<string, Snap>;

/** Every document of the game (the aggregate and every subcollection), plus the extra paths (roomCodes, joinIdem). */
export async function snapshot(gameId: string, extra: string[] = []): Promise<Snapshot> {
  const out: Snapshot = new Map();
  const root = db.doc(`games/${gameId}`);
  const g = await root.get();
  if (g.exists) out.set(g.ref.path, { updateTime: ts(g.updateTime), data: g.data() ?? {} });
  for (const c of await root.listCollections()) {
    for (const d of (await c.get()).docs) out.set(d.ref.path, { updateTime: ts(d.updateTime), data: d.data() });
  }
  for (const p of extra) {
    const s = await db.doc(p).get();
    if (s.exists) out.set(p, { updateTime: ts(s.updateTime), data: s.data() ?? {} });
  }
  return out;
}

export interface Diff { created: string[]; changed: string[]; deleted: string[] }
export function diff(before: Snapshot, after: Snapshot): Diff {
  const created = [...after.keys()].filter((k) => !before.has(k)).sort();
  const deleted = [...before.keys()].filter((k) => !after.has(k)).sort();
  const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k)?.updateTime !== after.get(k)?.updateTime).sort();
  return { created, changed, deleted };
}
export const updateTimeOf = (s: Snapshot, path: string): string | undefined => s.get(path)?.updateTime;
export const touched = (d: Diff): number => d.created.length + d.changed.length + d.deleted.length;

const withoutVersion = (view: unknown): string => {
  if (view === null || typeof view !== "object") return JSON.stringify(view);
  const { version: _v, ...rest } = view as Record<string, unknown>;
  return JSON.stringify(rest);
};

/** PJ11: what is wrong with the stored views against `makeProjector(load())`. Empty when every view is right. */
export async function viewProblems(gameId: string): Promise<string[]> {
  const snap = await db.doc(`games/${gameId}`).get();
  const { store: _s, ...game } = snap.data() as Game & { store: unknown };
  const at = makeProjector(game as Game);
  const problems: string[] = [];
  for (const t of viewersOf(game as Game)) {
    const doc = (await db.doc(`games/${gameId}/views/${t.docId}`).get()).data() as { version: number; enabled: boolean; view: { version: number } | null } | undefined;
    if (doc === undefined) {
      problems.push(`${t.docId}: missing`);
      continue;
    }
    const off = t.viewer.kind === "spectator" && t.viewer.uid === null && !(game as Game).settings.spectators.enabled;
    if (withoutVersion(doc.view) !== withoutVersion(off ? null : at(t.viewer))) problems.push(`${t.docId}: differs from the projection`);
    if (doc.version > (game as Game).version) problems.push(`${t.docId}: version ahead`);
    if (doc.view !== null && doc.view.version !== doc.version) problems.push(`${t.docId}: doc.version != view.version`);
  }
  return problems;
}

/** Paths of the documents whose stored JSON contains a P19 sentinel. */
export function sentinelHits(s: Snapshot, include: (path: string) => boolean): string[] {
  return [...s.entries()].filter(([p, d]) => include(p) && /SENTINEL/.test(JSON.stringify(d.data))).map(([p]) => p);
}

/** A registry query (3.1's QUERIES) with the given values in place of the probes. */
export function registryQuery(fs: Firestore, id: string, values: Record<string, unknown>): Query {
  const q = QUERIES.find((x) => x.id === id);
  if (q === undefined) throw new Error(`no registry query ${id}`);
  let query: Query = q.scope === "COLLECTION_GROUP" ? fs.collectionGroup(q.collectionGroup) : fs.collection(q.collectionGroup);
  for (const w of q.where) query = query.where(w.field === DOCUMENT_ID ? FieldPath.documentId() : w.field, w.op, Object.hasOwn(values, w.field) ? values[w.field] : w.value);
  for (const o of q.orderBy) query = query.orderBy(o.field === DOCUMENT_ID ? FieldPath.documentId() : o.field, o.direction === "ASCENDING" ? "asc" : "desc");
  return query;
}

/** Event doc versions of the game, ascending. */
export async function eventVersions(gameId: string): Promise<number[]> {
  return (await db.collection(`games/${gameId}/events`).get()).docs.map((d) => d.get("version") as number).sort((a, b) => a - b);
}
