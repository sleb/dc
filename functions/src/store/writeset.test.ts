import { describe, expect, test } from "bun:test";
import { StoreError } from "./errors";
import { MAX_WRITES, WriteSet, increment } from "./writeset";
import type { DocWrite } from "./writeset";

// U2 (LLD 3 sections 5.2a, 5.7, ST14).
const kindOf = (f: () => unknown): string | null => {
  try {
    f();
  } catch (e) {
    return e instanceof StoreError ? e.kind : `not a StoreError: ${String(e)}`;
  }
  return null;
};
const V = "games/g/views/u";
const viewRegion = { schema: 1, viewsRev: 1, gameId: "g", enabled: true, version: 3, generatedAt: 9, view: null };
const VIEW_FIELDS = ["schema", "viewsRev", "gameId", "enabled", "version", "generatedAt", "view"];
const DRAFT_FIELDS = ["draftSeq", "draft"];
const onlyWrite = (w: WriteSet): DocWrite => {
  const all = w.writes();
  expect(all).toHaveLength(1);
  return all[0] as DocWrite;
};

describe("U2 WriteSet", () => {
  test("one write per path; a second create, set, update or delete on a path throws INVARIANT", () => {
    for (const second of ["create", "set", "update", "delete", "merge"] as const) {
      for (const first of ["create", "set", "update", "delete"] as const) {
        const w = new WriteSet({ max: MAX_WRITES });
        if (first === "delete") w.delete("a/b");
        else w[first]("a/b", { x: 1 });
        const again = () => (second === "delete" ? w.delete("a/b") : second === "merge" ? w.merge("a/b", { x: 1 }, ["x"]) : w[second]("a/b", { x: 1 }));
        expect(kindOf(again)).toBe("INVARIANT");
      }
    }
  });

  test("a create after a merge on the same path throws INVARIANT", () => {
    const w = new WriteSet({ max: MAX_WRITES });
    w.merge(V, viewRegion, VIEW_FIELDS);
    expect(kindOf(() => w.create(V, {}))).toBe("INVARIANT");
  });

  test("merges on one path union their field lists into one write", () => {
    const w = new WriteSet({ max: MAX_WRITES });
    w.merge(V, viewRegion, VIEW_FIELDS);
    w.merge(V, { draft: null, draftSeq: 4 }, DRAFT_FIELDS);
    const x = onlyWrite(w);
    expect(x.op).toBe("merge");
    if (x.op !== "merge") return;
    expect([...x.fields].sort()).toEqual([...VIEW_FIELDS, ...DRAFT_FIELDS].sort());
    expect(x.data).toEqual({ ...viewRegion, draft: null, draftSeq: 4 });
    expect(w.size).toBe(1);
  });

  test("a field written twice with the same value is one field", () => {
    const w = new WriteSet({ max: MAX_WRITES });
    w.merge(V, { draft: null }, ["draft"]);
    w.merge(V, { draft: null }, ["draft"]);
    const x = onlyWrite(w);
    expect(x.op === "merge" ? x.fields : []).toEqual(["draft"]);
  });

  const orders = [
    ["clearDraft first", (w: WriteSet, a: Record<string, unknown>, b: Record<string, unknown>) => { w.merge(V, a, DRAFT_FIELDS); w.merge(V, b, DRAFT_FIELDS); }],
    ["draftChanges first", (w: WriteSet, a: Record<string, unknown>, b: Record<string, unknown>) => { w.merge(V, b, DRAFT_FIELDS); w.merge(V, a, DRAFT_FIELDS); }],
  ] as const;

  for (const [name, both] of orders) {
    test(`an absolute draftSeq beats an increment (${name})`, () => {
      const w = new WriteSet({ max: MAX_WRITES });
      both(w, { draft: null, draftSeq: increment(1) }, { draft: null, draftSeq: 8 });
      const x = onlyWrite(w);
      expect(x.op === "merge" ? x.data : null).toEqual({ draft: null, draftSeq: 8 });
    });

    test(`two increments collapse to one increment(1), not increment(2) (${name})`, () => {
      const w = new WriteSet({ max: MAX_WRITES });
      both(w, { draft: null, draftSeq: increment(1) }, { draft: null, draftSeq: increment(1) });
      const x = onlyWrite(w);
      expect(x.op === "merge" ? x.data : null).toEqual({ draft: null, draftSeq: increment(1) });
    });

    test(`a draft conflict with different values throws INVARIANT (${name})`, () => {
      const w = new WriteSet({ max: MAX_WRITES });
      expect(kindOf(() => both(w, { draft: null, draftSeq: increment(1) }, { draft: { red: ["x"], green: [] }, draftSeq: 3 }))).toBe("INVARIANT");
    });

    test(`two different absolute draftSeq values throw INVARIANT (${name})`, () => {
      const w = new WriteSet({ max: MAX_WRITES });
      expect(kindOf(() => both(w, { draft: null, draftSeq: 3 }, { draft: null, draftSeq: 4 }))).toBe("INVARIANT");
    });
  }

  test("a same-field conflict outside the draft region throws INVARIANT", () => {
    const w = new WriteSet({ max: MAX_WRITES });
    w.merge(V, viewRegion, VIEW_FIELDS);
    expect(kindOf(() => w.merge(V, { ...viewRegion, version: 4 }, VIEW_FIELDS))).toBe("INVARIANT");
  });

  test("the merged result is the same in both call orders", () => {
    const a = new WriteSet({ max: MAX_WRITES });
    a.merge(V, viewRegion, VIEW_FIELDS);
    a.merge(V, { draft: null, draftSeq: increment(1) }, DRAFT_FIELDS);
    a.merge(V, { draft: null, draftSeq: 5 }, DRAFT_FIELDS);
    const b = new WriteSet({ max: MAX_WRITES });
    b.merge(V, { draft: null, draftSeq: 5 }, DRAFT_FIELDS);
    b.merge(V, { draft: null, draftSeq: increment(1) }, DRAFT_FIELDS);
    b.merge(V, viewRegion, VIEW_FIELDS);
    const norm = (w: WriteSet) => w.writes().map((x) => (x.op === "merge" ? { ...x, fields: [...x.fields].sort() } : x));
    expect(norm(a)).toHaveLength(1);
    expect(norm(a)).toEqual(norm(b));
  });

  test("a merge's data carries only its listed fields", () => {
    const w = new WriteSet({ max: MAX_WRITES });
    w.merge(V, { draft: null, draftSeq: 2, view: "leak" }, DRAFT_FIELDS);
    const x = onlyWrite(w);
    expect(x.op === "merge" ? x.data : null).toEqual({ draft: null, draftSeq: 2 });
  });

  test("apply() routes a DocWrite through the same rules", () => {
    const w = new WriteSet({ max: MAX_WRITES });
    w.apply({ op: "create", path: "games/g/seats/p", data: { uid: "u" } });
    expect(kindOf(() => w.apply({ op: "set", path: "games/g/seats/p", data: {} }))).toBe("INVARIANT");
    w.apply({ op: "delete", path: "joinIdem/x" });
    expect(w.size).toBe(2);
  });

  test("MAX_WRITES is 200; distinct documents above max throw TOO_MANY_WRITES, merges into one document do not count twice", () => {
    expect(MAX_WRITES).toBe(200);
    const w = new WriteSet({ max: 3 });
    w.set("a/1", {});
    w.merge("a/2", { x: 1 }, ["x"]);
    w.merge("a/2", { y: 1 }, ["y"]);
    w.delete("a/3");
    expect(w.size).toBe(3);
    expect(kindOf(() => w.create("a/4", {}))).toBe("TOO_MANY_WRITES");
  });
});
