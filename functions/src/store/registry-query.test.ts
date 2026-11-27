import { expect, test } from "bun:test";
import { getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import { registryQuery } from "./registry-query";

// Review 4714647591: a registry query is built with its parent honoured. Building a query does not connect, so this runs without an emulator.
const app = getApps().find((a) => a.name === "registry-query-test") ?? initializeApp({ projectId: "demo-deepcuts" }, "registry-query-test");
const fs = getFirestore(app);

test("a COLLECTION-scope query under games/{} queries that game's subcollection", () => {
  const q = registryQuery(fs, "outboxSiblings", { gameId: "G1", values: { version: 3 } });
  expect(q.isEqual(fs.collection("games/G1/outbox").where("version", "==", 3))).toBe(true);
  expect(q.isEqual(fs.collection("outbox").where("version", "==", 3))).toBe(false);
  expect(registryQuery(fs, "roundsByNumber", { gameId: "G1" }).isEqual(fs.collection("games/G1/rounds").orderBy("round", "asc"))).toBe(true);
});

test("a COLLECTION_GROUP query stays a collection group; a root COLLECTION query stays at the root", () => {
  const g = registryQuery(fs, "identityCleanup", { values: { at: 5 } });
  expect(g.isEqual(fs.collectionGroup("outbox").where("topic", "==", "identity").where("notifDoneAt", "==", null).where("at", "<", 5).orderBy("at", "asc"))).toBe(true);
  const w = registryQuery(fs, "waitingOn", { values: { reminderDueAt: 9 } });
  expect(w.isEqual(fs.collection("games").where("reminderDueAt", "<=", 9).orderBy("reminderDueAt", "asc").orderBy(FieldPath.documentId(), "asc"))).toBe(true);
});

test("a games/{} query without a gameId, and an unknown id, throw", () => {
  expect(() => registryQuery(fs, "seatBySecret", {})).toThrow(/gameId/);
  expect(() => registryQuery(fs, "nope", {})).toThrow(/no registry query/);
});
