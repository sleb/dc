import { expect, test } from "bun:test";
import { join } from "node:path";
import { TTL_GROUPS } from "./wait-indexes";

// V3 (issue #15): the file `firebase deploy --only firestore` uploads declares the six TTL groups and no composite
// index yet. #32 adds the real composites and the remaining field exemptions; this test fails if any arrive early.
// The group list has one source (`TTL_GROUPS` in wait-indexes.ts, which is what waits for them) and one other copy,
// in verify-staging.sh, which cannot import TypeScript: the last test here keeps the two from drifting apart.

const PATH = join(import.meta.dir, "../firestore.indexes.json");
const VERIFY = join(import.meta.dir, "verify-staging.sh");

type FieldOverride = { collectionGroup: string; fieldPath: string; ttl?: boolean; indexes?: { order: string; queryScope: string }[] };

const readFile = async (): Promise<{ indexes?: unknown; fieldOverrides?: FieldOverride[] }> =>
  Bun.file(PATH)
    .json()
    .catch(() => {
      throw new Error(`firestore.indexes.json is missing or is not valid JSON (${PATH})`);
    });

test("V3 the indexes file declares no composite index yet", async () => {
  const config = await readFile();
  expect(Object.keys(config).sort()).toEqual(["fieldOverrides", "indexes"]);
  expect(config.indexes).toEqual([]);
});

test("V3 exactly one fieldOverride per TTL group, set equality in both directions", async () => {
  const config = await readFile();
  expect((config.fieldOverrides ?? []).map((o) => o.collectionGroup).sort()).toEqual([...TTL_GROUPS].sort());
});

test("V3 every fieldOverride is expiresAt with ttl true and one ASCENDING COLLECTION index", async () => {
  const config = await readFile();
  const expected = [...TTL_GROUPS].sort().map((collectionGroup) => ({
    collectionGroup,
    fieldPath: "expiresAt",
    ttl: true,
    indexes: [{ order: "ASCENDING", queryScope: "COLLECTION" }],
  }));
  const actual = (config.fieldOverrides ?? [])
    .map((o) => ({ collectionGroup: o.collectionGroup, fieldPath: o.fieldPath, ttl: o.ttl, indexes: o.indexes }))
    .sort((a, b) => a.collectionGroup.localeCompare(b.collectionGroup));
  expect(actual).toEqual(expected);
  for (const o of config.fieldOverrides ?? []) expect(Object.keys(o).sort()).toEqual(["collectionGroup", "fieldPath", "indexes", "ttl"]);
});

test("V3 verify-staging.sh waits on the same TTL groups as wait-indexes.ts", async () => {
  const script = await Bun.file(VERIFY).text();
  const line = /^TTL_GROUPS="([^"]*)"/m.exec(script);
  expect(line?.[1]).toBeDefined();
  expect((line?.[1] ?? "").split(/\s+/).filter(Boolean)).toEqual([...TTL_GROUPS]);
});
