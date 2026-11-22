import { expect, test } from "bun:test";
import { join } from "node:path";

// V3 (issue #15): the file `firebase deploy --only firestore` uploads declares the six TTL groups and no composite
// index yet. #32 adds the real composites and the remaining field exemptions; this test fails if any arrive early.

const PATH = join(import.meta.dir, "../firestore.indexes.json");
const TTL_GROUPS = ["idem", "outbox", "notifLog", "rateLimits", "deletions", "joinIdem"];

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
