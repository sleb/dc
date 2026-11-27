import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DOCUMENT_ID, QUERIES } from "./queries";
import type { DeclaredQuery } from "./queries";

// The index registry (LLD 3 section 4, #32). The emulator does not enforce composite indexes, so this is the check
// that runs on every PR: each declared query is served by the indexes `firebase deploy --only firestore` uploads.
//   Q1  served: one distinct field (the document id aside) at COLLECTION scope uses the automatic single-field index;
//       otherwise a composite of the same collection group and scope has the equality fields first (any order), then
//       the inequality field and the orderBy fields, in order and direction;
//   Q2  no field override with `indexes: []` (on the field or a parent map) covers a field a query filters or orders on;
//   Q3  every declared composite serves at least one declared query.
// What this does not prove: that production code issues only these queries (each consumer step imports from
// queries.ts), or that the deployed project has the indexes (the post-deploy smoke runs each query).

type Field = { fieldPath: string; order?: string };
type Composite = { collectionGroup: string; queryScope: string; fields: Field[] };
type Override = { collectionGroup: string; fieldPath: string; ttl?: boolean; indexes: { order?: string; queryScope: string }[] };
type IndexFile = { indexes: Composite[]; fieldOverrides: Override[] };

const FILE = join(import.meta.dir, "../../../firestore.indexes.json");
const config = (await Bun.file(FILE).json()) as IndexFile;

/** The composite a query needs, as a list of fields: null if the automatic single-field index serves it. */
export function requiredComposite(q: DeclaredQuery): { equality: Set<string>; tail: Field[] } | null {
  const equality = new Set(q.where.filter((w) => w.op === "==").map((w) => w.field));
  const inequality = [...new Set(q.where.filter((w) => w.op !== "==").map((w) => w.field))];
  const tail: Field[] = [];
  // Firestore orders by the inequality field first, ascending unless the query orders it otherwise.
  for (const field of inequality) if (!q.orderBy.some((o) => o.field === field)) tail.push({ fieldPath: field, order: "ASCENDING" });
  for (const o of q.orderBy) if (o.field !== DOCUMENT_ID && !equality.has(o.field)) tail.push({ fieldPath: o.field, order: o.direction });
  const fields = new Set([...equality, ...tail.map((f) => f.fieldPath)]);
  if (fields.size <= 1 && q.scope === "COLLECTION") return null;
  return { equality, tail };
}

/** The composite that serves `q`, "automatic" for the single-field index, or null when nothing does. */
export function servingIndex(q: DeclaredQuery, indexes: Composite[]): Composite | "automatic" | null {
  const need = requiredComposite(q);
  if (need === null) return "automatic";
  return (
    indexes.find((c) => {
      if (c.collectionGroup !== q.collectionGroup || c.queryScope !== q.scope) return false;
      if (c.fields.length !== need.equality.size + need.tail.length) return false;
      const head = c.fields.slice(0, need.equality.size).map((f) => f.fieldPath);
      if (new Set(head).size !== need.equality.size || head.some((f) => !need.equality.has(f))) return false;
      return need.tail.every((f, i) => {
        const have = c.fields[need.equality.size + i];
        return have?.fieldPath === f.fieldPath && have.order === f.order;
      });
    }) ?? null
  );
}

const fieldsOf = (q: DeclaredQuery) => [...new Set([...q.where.map((w) => w.field), ...q.orderBy.map((o) => o.field)])].filter((f) => f !== DOCUMENT_ID);

/** A collection-group query with one equality field and no order is served by an enabled collection-group single-field index. */
export function cgSingleField(q: DeclaredQuery, overrides: Override[]): boolean {
  const fields = fieldsOf(q);
  if (q.scope !== "COLLECTION_GROUP" || fields.length !== 1 || q.orderBy.length > 0) return false;
  const field = fields[0];
  return overrides.some((o) => o.collectionGroup === q.collectionGroup && o.fieldPath === field && (o.indexes ?? []).some((i) => i.queryScope === "COLLECTION_GROUP"));
}

/** The `indexes: []` overrides that cover a queried field (the field itself or a parent map). */
export function exemptionsHit(q: DeclaredQuery, overrides: Override[]): string[] {
  return overrides
    .filter((o) => o.collectionGroup === q.collectionGroup && o.indexes.length === 0)
    .filter((o) => fieldsOf(q).some((f) => f === o.fieldPath || f.startsWith(`${o.fieldPath}.`)))
    .map((o) => `${o.collectionGroup}.${o.fieldPath}`);
}

describe("the registry", () => {
  test("query ids are unique and every query names where it is specified", () => {
    expect(new Set(QUERIES.map((q) => q.id)).size).toBe(QUERIES.length);
    for (const q of QUERIES) expect(q.source).not.toBe("");
  });

  test("a subcollection query names its parent document, a root or collection-group query does not", () => {
    for (const q of QUERIES) {
      if (q.scope === "COLLECTION_GROUP") expect({ id: q.id, parent: q.parent }).toEqual({ id: q.id, parent: "" });
      else expect({ id: q.id, ok: q.parent === "" || /^[A-Za-z]+\/\{\}(\/[A-Za-z]+\/\{\})*$/.test(q.parent) }).toEqual({ id: q.id, ok: true });
    }
  });
});

describe("Q1 every declared query is served", () => {
  for (const q of QUERIES) {
    test(q.id, () => {
      const served = servingIndex(q, config.indexes) !== null || cgSingleField(q, config.fieldOverrides);
      expect({ query: q.id, servedBy: served ? "an index" : "nothing" }).toEqual({ query: q.id, servedBy: "an index" });
    });
  }
});

describe("Q2 no field exemption covers a queried field", () => {
  for (const q of QUERIES) {
    test(q.id, () => {
      expect({ query: q.id, exempted: exemptionsHit(q, config.fieldOverrides) }).toEqual({ query: q.id, exempted: [] });
    });
  }
});

test("Q3 every declared composite serves at least one declared query", () => {
  const used = new Set(QUERIES.map((q) => servingIndex(q, config.indexes)).filter((c): c is Composite => typeof c === "object" && c !== null));
  const orphans = config.indexes.filter((c) => !used.has(c)).map((c) => `${c.collectionGroup}(${c.fields.map((f) => f.fieldPath).join(",")})`);
  expect({ orphanComposites: orphans }).toEqual({ orphanComposites: [] });
});

describe("the matcher, on planted input", () => {
  const base: DeclaredQuery = { id: "t", collectionGroup: "c", scope: "COLLECTION", parent: "", where: [], orderBy: [], source: "test" };
  const composite = (...fields: [string, string][]): Composite => ({ collectionGroup: "c", queryScope: "COLLECTION", fields: fields.map(([fieldPath, order]) => ({ fieldPath, order })) });

  test("one field is automatic at COLLECTION scope, not at COLLECTION_GROUP scope unless an override enables it", () => {
    const q = { ...base, where: [{ field: "a", op: "==" as const, value: 1 }] };
    expect(servingIndex(q, [])).toBe("automatic");
    expect(servingIndex({ ...q, scope: "COLLECTION_GROUP" }, [])).toBeNull();
    const cg = { ...q, scope: "COLLECTION_GROUP" as const };
    expect(cgSingleField(cg, [{ collectionGroup: "c", fieldPath: "a", indexes: [] }])).toBe(false);
    expect(cgSingleField(cg, [{ collectionGroup: "c", fieldPath: "a", indexes: [{ order: "ASCENDING", queryScope: "COLLECTION_GROUP" }] }])).toBe(true);
  });

  test("equality fields go first in any order; the tail must match in order and direction", () => {
    const q = { ...base, where: [{ field: "a", op: "==" as const, value: 1 }, { field: "b", op: "==" as const, value: 1 }, { field: "t", op: "<" as const, value: 1 }] };
    expect(servingIndex(q, [composite(["b", "ASCENDING"], ["a", "ASCENDING"], ["t", "ASCENDING"])])).not.toBeNull();
    expect(servingIndex(q, [composite(["a", "ASCENDING"], ["t", "ASCENDING"], ["b", "ASCENDING"])])).toBeNull();
    expect(servingIndex(q, [composite(["a", "ASCENDING"], ["b", "ASCENDING"], ["t", "DESCENDING"])])).toBeNull();
    expect(servingIndex({ ...q, scope: "COLLECTION_GROUP" }, [composite(["a", "ASCENDING"], ["b", "ASCENDING"], ["t", "ASCENDING"])])).toBeNull();
  });

  test("an exemption on a parent map covers its subfields", () => {
    const q = { ...base, where: [{ field: "store.viewsRev", op: "==" as const, value: 1 }] };
    expect(exemptionsHit(q, [{ collectionGroup: "c", fieldPath: "store", indexes: [] }])).toEqual(["c.store"]);
    expect(exemptionsHit(q, [{ collectionGroup: "c", fieldPath: "storeX", indexes: [] }])).toEqual([]);
  });
});
