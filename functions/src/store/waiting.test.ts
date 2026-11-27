import { expect, test } from "bun:test";
import { getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import { pageOf, waitingPageQuery } from "./waiting";

// U9/U10 (#35, LLD 3 section 7): the query is exactly the registry's `waitingOn` entry plus the projection, limit and keyset cursor; the page
// mapping carries the seven fields and makes `next` null only on a short page. Building a query does not connect, so this runs without an emulator.
const app = getApps().find((a) => a.name === "waiting-test") ?? initializeApp({ projectId: "demo-deepcuts" }, "waiting-test");
const fs = getFirestore(app);

const SELECT = ["reminderDueAt", "episode", "episodeGen", "waitingOn", "waitingSince", "version"];

const expected = (now: number, limit: number) =>
  fs
    .collection("games")
    .where("reminderDueAt", "<=", now)
    .orderBy("reminderDueAt", "asc")
    .orderBy(FieldPath.documentId(), "asc")
    .select(...SELECT)
    .limit(limit);

test("U9 waitingPageQuery is the registry query plus select/limit, and startAfter with (dueAt, gameId)", () => {
  const now = 4_200;
  const limit = 100;
  expect(waitingPageQuery(fs, { now, limit }).isEqual(expected(now, limit))).toBe(true);
  // The projection and the limit are part of the pinned shape.
  expect(waitingPageQuery(fs, { now, limit }).isEqual(expected(now, 99))).toBe(false);
  expect(waitingPageQuery(fs, { now, limit }).isEqual(fs.collection("games").where("reminderDueAt", "<=", now).orderBy("reminderDueAt", "asc").orderBy(FieldPath.documentId(), "asc").limit(limit))).toBe(false);
  // A cursor resumes after exactly that pair; a different game id is a different query.
  const after = { dueAt: 4_100, gameId: "gA" };
  expect(waitingPageQuery(fs, { now, limit, after }).isEqual(expected(now, limit).startAfter(after.dueAt, after.gameId))).toBe(true);
  expect(waitingPageQuery(fs, { now, limit, after }).isEqual(expected(now, limit).startAfter(4_100, "gB"))).toBe(false);
});

const doc = (id: string, data: Record<string, unknown>) => ({ id, get: (field: string) => data[field] });
const item = (id: string, dueAt: number) => ({
  gameId: id,
  episode: `e-${id}`,
  episodeGen: 2,
  waitingOn: [`p-${id}`],
  since: 5,
  dueAt,
  version: 7,
});

test("U10 pageOf: a short page is all items and next null; a full page points at the last pair", () => {
  const docs = [doc("g3", item("g3", 30)), doc("g1", item("g1", 10)), doc("g2", item("g2", 20))];
  const short = pageOf(docs, 4);
  expect(short.items).toEqual([item("g3", 30), item("g1", 10), item("g2", 20)]);
  expect(short.next).toBeNull();

  const full = pageOf(docs, 3);
  expect(full.items).toHaveLength(3);
  expect(full.next).toEqual({ dueAt: 20, gameId: "g2" });
});

test("U10 pageOf: an empty page is [] and null", () => {
  expect(pageOf([], 100)).toEqual({ items: [], next: null });
});

test("U10 pageOf: items are exactly the seven fields, since is waitingSince, and nothing else leaks", () => {
  const items = pageOf([doc("g1", { ...item("g1", 10), ignored: "leak", waitingSince: 11 })], 1).items;
  expect(items).toHaveLength(1);
  const it = items[0]!;
  expect(it).toEqual({ gameId: "g1", episode: "e-g1", episodeGen: 2, waitingOn: ["p-g1"], since: 11, dueAt: 10, version: 7 });
  expect(Object.keys(it).sort()).toEqual(["dueAt", "episode", "episodeGen", "gameId", "since", "version", "waitingOn"]);
});
