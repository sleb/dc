// WriteSet (LLD 3 sections 5.2a and 5.7): every write of one command, keyed by document path, one write per path. Pure: it buffers `DocWrite`s,
// which `applyWrites` turns into transaction calls, so the planner can be tested without Firestore. The 5.7 count is distinct documents.
import { FieldValue } from "firebase-admin/firestore";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { StoreError } from "./errors";

/** `FieldValue.increment(n)`, as a plain value the WriteSet can compare. */
export interface Inc { readonly __inc: number }
export const increment = (n: number): Inc => ({ __inc: n });
const isInc = (v: unknown): v is Inc => typeof v === "object" && v !== null && Object.hasOwn(v, "__inc");

export type DocWrite =
  | { op: "create" | "set" | "update"; path: string; data: Record<string, unknown> }
  | { op: "delete"; path: string }
  | { op: "merge"; path: string; data: Record<string, unknown>; fields: string[] };

export const MAX_WRITES = 200;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Combines two values of one field. Only `draftSeq` has a rule beyond equality: an absolute number beats an increment, two increments are one. */
function combine(path: string, field: string, a: unknown, b: unknown): unknown {
  if (same(a, b)) return isInc(a) ? increment(1) : a;
  if (field === "draftSeq") {
    if (isInc(a) && isInc(b)) return increment(1);
    if (isInc(a) && typeof b === "number") return b;
    if (isInc(b) && typeof a === "number") return a;
  }
  throw new StoreError("INVARIANT", `WriteSet: conflicting values for ${field} of one document (${path.split("/").slice(0, 3).join("/")})`);
}

export class WriteSet {
  private readonly byPath = new Map<string, DocWrite>();
  constructor(private readonly o: { max: number }) {}

  get size(): number {
    return this.byPath.size;
  }

  private add(w: DocWrite): void {
    if (this.byPath.has(w.path)) throw new StoreError("INVARIANT", `WriteSet: a second ${w.op} on one document`);
    if (this.byPath.size + 1 > this.o.max) throw new StoreError("TOO_MANY_WRITES", `more than ${this.o.max} documents in one command`);
    this.byPath.set(w.path, w);
  }

  create(path: string, data: Record<string, unknown>): void {
    this.add({ op: "create", path, data });
  }
  set(path: string, data: Record<string, unknown>): void {
    this.add({ op: "set", path, data });
  }
  update(path: string, data: Record<string, unknown>): void {
    this.add({ op: "update", path, data });
  }
  delete(path: string): void {
    this.add({ op: "delete", path });
  }

  /** A `set(..., {mergeFields})`: only `fields` are written. Merges on one path combine field by field (5.2a). */
  merge(path: string, data: Record<string, unknown>, fields: readonly string[]): void {
    const picked: Record<string, unknown> = {};
    for (const f of fields) picked[f] = data[f];
    const prev = this.byPath.get(path);
    if (prev === undefined) {
      this.add({ op: "merge", path, data: picked, fields: [...new Set(fields)] });
      return;
    }
    if (prev.op !== "merge") throw new StoreError("INVARIANT", `WriteSet: a merge after a ${prev.op} on one document`);
    const out = { ...prev.data };
    for (const f of fields) out[f] = Object.hasOwn(prev.data, f) ? combine(path, f, prev.data[f], picked[f]) : picked[f];
    this.byPath.set(path, { op: "merge", path, data: out, fields: [...new Set([...prev.fields, ...fields])] });
  }

  apply(w: DocWrite): void {
    if (w.op === "merge") this.merge(w.path, w.data, w.fields);
    else if (w.op === "delete") this.delete(w.path);
    else this[w.op](w.path, w.data);
  }

  writes(): DocWrite[] {
    return [...this.byPath.values()];
  }
}

const toFirestore = (data: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = isInc(v) ? FieldValue.increment(v.__inc) : v;
  return out;
};

/** Buffers the writes on the transaction (they commit together, ST1). */
export function applyWrites(tx: Transaction, db: Firestore, writes: readonly DocWrite[]): void {
  for (const w of writes) {
    const ref = db.doc(w.path);
    if (w.op === "create") tx.create(ref, toFirestore(w.data));
    else if (w.op === "set") tx.set(ref, toFirestore(w.data));
    else if (w.op === "update") tx.update(ref, toFirestore(w.data));
    else if (w.op === "delete") tx.delete(ref);
    else if (w.op === "merge") tx.set(ref, toFirestore(w.data), { mergeFields: w.fields });
  }
}
