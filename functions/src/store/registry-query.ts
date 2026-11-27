// Builds a Firestore query from a registry entry (queries.ts, #32), so no consumer redeclares one (review of #33). A COLLECTION-scope entry
// whose `parent` is `games/{}` is a subcollection of one game: the `{}` takes `gameId`. Values replace the registry's probes by field.
import { FieldPath } from "firebase-admin/firestore";
import type { Firestore, Query } from "firebase-admin/firestore";
import { DOCUMENT_ID, QUERIES } from "./queries";

export function registryQuery(fs: Firestore, id: string, o: { gameId?: string; values?: Record<string, unknown> }): Query {
  const q = QUERIES.find((x) => x.id === id);
  if (q === undefined) throw new Error(`no registry query ${id}`);
  let base: Query;
  if (q.scope === "COLLECTION_GROUP") base = fs.collectionGroup(q.collectionGroup);
  else if (q.parent === "") base = fs.collection(q.collectionGroup);
  else {
    if (o.gameId === undefined) throw new Error(`registry query ${id} needs a gameId for its parent ${q.parent}`);
    base = fs.collection(`${q.parent.replace("{}", o.gameId)}/${q.collectionGroup}`);
  }
  const values = o.values ?? {};
  const path = (f: string) => (f === DOCUMENT_ID ? FieldPath.documentId() : f);
  for (const w of q.where) base = base.where(path(w.field), w.op, Object.hasOwn(values, w.field) ? values[w.field] : w.value);
  for (const ob of q.orderBy) base = base.orderBy(path(ob.field), ob.direction === "ASCENDING" ? "asc" : "desc");
  return base;
}
