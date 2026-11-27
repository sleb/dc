import { expect, test } from "bun:test";
import { join } from "node:path";
import { TTL_GROUPS } from "./wait-indexes";

// V3 (issue #15) and I1 to I3 (#32): the file `firebase deploy --only firestore` uploads is LLD 3 section 4: the four
// composite indexes, the 17 field exemptions and the six TTL overrides, set equality in each case. The TTL group list
// has one source (`TTL_GROUPS` in wait-indexes.ts, which is what waits for them) and one other copy, in
// verify-staging.sh, which cannot import TypeScript: the last test here keeps the two from drifting apart. That every
// declared query is served by these indexes is `functions/src/store/queries.test.ts`.

const PATH = join(import.meta.dir, "../firestore.indexes.json");
const VERIFY = join(import.meta.dir, "verify-staging.sh");

type FieldOverride = { collectionGroup: string; fieldPath: string; ttl?: boolean; indexes?: { order: string; queryScope: string }[] };
type Composite = { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order: string }[] };

const readFile = async (): Promise<{ indexes?: Composite[]; fieldOverrides?: FieldOverride[] }> =>
  Bun.file(PATH)
    .json()
    .catch(() => {
      throw new Error(`firestore.indexes.json is missing or is not valid JSON (${PATH})`);
    });

const asc = (fieldPath: string) => ({ fieldPath, order: "ASCENDING" });
/** LLD 3 section 4: the redrive, push-cleanup, stuck-deletion and host game-list composites. */
const COMPOSITES: Composite[] = [
  { collectionGroup: "games", queryScope: "COLLECTION", fields: [asc("hostId"), { fieldPath: "createdAt", order: "DESCENDING" }] },
  { collectionGroup: "outbox", queryScope: "COLLECTION_GROUP", fields: [asc("processedAt"), asc("at")] },
  { collectionGroup: "outbox", queryScope: "COLLECTION_GROUP", fields: [asc("topic"), asc("notifDoneAt"), asc("at")] },
  { collectionGroup: "deletions", queryScope: "COLLECTION", fields: [asc("status"), asc("heartbeatAt")] },
];
/** LLD 3 section 4: maps and arrays the Store never queries, so their subfields are not indexed. */
const EXEMPTIONS = [
  "games.cards", "games.history", "games.votes", "games.players", "games.pools", "games.round", "games.settings", "games.waitingOn",
  "views.view", "views.draft", "rounds.plays", "events.events", "outbox.event", "outbox.roster", "drafts.red", "drafts.green", "idem.meta",
];
const key = (o: { collectionGroup: string; fieldPath: string }) => `${o.collectionGroup}.${o.fieldPath}`;
const ttlOnly = (all: FieldOverride[] | undefined) => (all ?? []).filter((o) => o.ttl === true);

test("V3 the indexes file has exactly the keys indexes and fieldOverrides", async () => {
  expect(Object.keys(await readFile()).sort()).toEqual(["fieldOverrides", "indexes"]);
});

test("I1 the composite indexes are exactly the four of LLD 3 section 4 (set equality)", async () => {
  const canon = (c: Composite) => JSON.stringify({ collectionGroup: c.collectionGroup, queryScope: c.queryScope, fields: c.fields.map((f) => ({ fieldPath: f.fieldPath, order: f.order })) });
  const actual = (await readFile()).indexes ?? [];
  expect(actual.map(canon).sort()).toEqual(COMPOSITES.map(canon).sort());
  for (const c of actual) expect(Object.keys(c).sort()).toEqual(["collectionGroup", "fields", "queryScope"]);
});

test("I2 the field exemptions are exactly the 17 of LLD 3 section 4, each with indexes: [] and no ttl", async () => {
  const exemptions = ((await readFile()).fieldOverrides ?? []).filter((o) => o.ttl !== true && (o.indexes?.length ?? 0) === 0);
  expect(exemptions.map(key).sort()).toEqual([...EXEMPTIONS].sort());
  for (const o of exemptions) expect(o).toEqual({ collectionGroup: o.collectionGroup, fieldPath: o.fieldPath, indexes: [] });
});

test("I2b the one enabled collection-group single-field index is idem.gameId", async () => {
  const enabled = ((await readFile()).fieldOverrides ?? []).filter((o) => o.ttl !== true && (o.indexes?.length ?? 0) > 0);
  expect(enabled).toEqual([{ collectionGroup: "idem", fieldPath: "gameId", indexes: [{ order: "ASCENDING", queryScope: "COLLECTION_GROUP" }] }]);
});

test("V3 exactly one TTL fieldOverride per TTL group, set equality in both directions", async () => {
  const config = await readFile();
  expect(ttlOnly(config.fieldOverrides).map((o) => o.collectionGroup).sort()).toEqual([...TTL_GROUPS].sort());
});

test("V3 every TTL fieldOverride is expiresAt with ttl true and one ASCENDING COLLECTION index", async () => {
  const config = await readFile();
  const expected = [...TTL_GROUPS].sort().map((collectionGroup) => ({
    collectionGroup,
    fieldPath: "expiresAt",
    ttl: true,
    indexes: [{ order: "ASCENDING", queryScope: "COLLECTION" }],
  }));
  const actual = ttlOnly(config.fieldOverrides)
    .map((o) => ({ collectionGroup: o.collectionGroup, fieldPath: o.fieldPath, ttl: o.ttl, indexes: o.indexes }))
    .sort((a, b) => a.collectionGroup.localeCompare(b.collectionGroup));
  expect(actual).toEqual(expected);
  for (const o of ttlOnly(config.fieldOverrides)) expect(Object.keys(o).sort()).toEqual(["collectionGroup", "fieldPath", "indexes", "ttl"]);
});

test("V3 verify-staging.sh waits on the same TTL groups as wait-indexes.ts", async () => {
  const script = await Bun.file(VERIFY).text();
  const line = /^TTL_GROUPS="([^"]*)"/m.exec(script);
  expect(line?.[1]).toBeDefined();
  expect((line?.[1] ?? "").split(/\s+/).filter(Boolean)).toEqual([...TTL_GROUPS]);
});

test("docs current: the LLD 3 section 4 JSON is the file", async () => {
  const lld = await Bun.file(join(import.meta.dir, "../docs/lld/03-game-store.md")).text();
  const at = lld.indexOf("## 4. Indexes and field exemptions");
  const block = /```json\n([\s\S]*?)\n```/.exec(lld.slice(at))?.[1];
  expect(block).toBeDefined();
  expect(JSON.parse(block ?? "null")).toEqual(await readFile());
});
