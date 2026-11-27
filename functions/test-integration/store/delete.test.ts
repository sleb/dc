import { beforeAll, describe, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { Timestamp } from "firebase-admin/firestore";
import { buildCascade, seedCascade } from "./support/cascade";
import type { Cascade } from "./support/cascade";
import { Table } from "./support/drive";
import { clear, create, db, runDeletion, runDeletionError } from "./support/harness";
import { diff, snapshot } from "./support/inspect";
import { newKey } from "./support/seed";

// I28-I35 (LLD 3 sections 6.4 and 10.3, S5, ST8, ST9, ST16): phase 0, the ordered resumable cascade, the identity
// union, replay/commands during deletion, room-code ownership and the stuck-job line. The runner is the emulator-only
// harness op; the deployed trigger, the real purgeSeats and the hourly redrive are #42/M6.
const NOW = 5_000_000;
const HOUR = 3_600_000;
const TTL = 7 * 86_400_000;
const STAGES = ["views", "drafts", "identity", "push", "joinIdem", "hostIdem", "history", "aggregate"] as const;

beforeAll(clear);

/** Every seeded document outside `games/{id}` that the cascade must consider. */
const extraPaths = (c: Cascade): string[] => [
  `deletions/${c.game.id}`,
  `roomCodes/${c.game.roomCode}`,
  "roomCodes/ZZZZ",
  `pushSubs/${c.pushSubId}`,
  `joinIdem/${c.joinIdemId}`,
  "pushSubs/other-push",
  "joinIdem/other-join",
  `hosts/${c.game.hostId}/decks/${c.deckId}`,
  `hosts/${c.game.hostId}/idem/${c.hostIdemId}`,
  `hosts/${c.game.hostId}/idem/${c.otherHostIdemId}`,
  `hosts/${c.crossHostId}/idem/${c.crossHostLedgerId}`,
];

async function setup(c: Cascade): Promise<Table> {
  await seedCascade(db, c, { now: c.game.createdAt });
  return Table.attach(c.game.id, c.game.hostId);
}

function actor(c: Cascade): { kind: "user"; uid: string } {
  return { kind: "user", uid: c.game.hostId };
}

async function phase0(t: Table, c: Cascade, now = NOW, idemKey = newKey()) {
  return t.run(actor(c), { type: "deleteGame" } as Command, { now, idemKey });
}

describe("I28 phase 0 through the harness", () => {
  test("owned code: deleting outcome, 3 writes, deleting marker, code gone, job created, no events/idem/version/views change", async () => {
    const c = buildCascade({ hostId: "host-i28" });
    const t = await setup(c);
    const before = await snapshot(c.game.id, extraPaths(c));
    const version = (await t.state()).version;
    const r = await phase0(t, c);
    expect(r.outcome).toEqual({ kind: "deleting" });
    expect(r.writes).toBe(3);

    const after = await snapshot(c.game.id, extraPaths(c));
    const d = diff(before, after);
    expect(d.created).toEqual([`deletions/${c.game.id}`]);
    expect(d.deleted).toEqual([`roomCodes/${c.game.roomCode}`]);
    expect(d.changed).toEqual([`games/${c.game.id}`]);
    expect([...after.keys()].filter((p) => p.includes("/views/"))).toEqual([...before.keys()].filter((p) => p.includes("/views/")));

    const agg = (await db.doc(`games/${c.game.id}`).get()).data();
    expect(agg?.["store"]).toMatchObject({ deleting: { at: NOW, by: c.game.hostId }, updatedAt: NOW });
    expect((await t.state()).version).toBe(version);
    expect((await db.collection(`games/${c.game.id}/events`).get()).empty).toBe(true);
    expect((await db.collection(`games/${c.game.id}/idem`).get()).empty).toBe(true);

    const job = (await db.doc(`deletions/${c.game.id}`).get()).data();
    expect(job).toMatchObject({ gameId: c.game.id, hostId: c.game.hostId, requestedAt: NOW, status: "running", stagesDone: [], heartbeatAt: NOW, attempts: 0 });
    expect(job?.["seatUids"]).toEqual(c.game.players.map((p) => p.uid).filter((u) => u !== c.game.hostId));
  }, 120_000);

  test("a code now owned by another game is left alone: 2 writes and the newer mapping survives", async () => {
    const c = buildCascade({ hostId: "host-i28-other" });
    const t = await setup(c);
    await db.doc(`roomCodes/${c.game.roomCode}`).set({ gameId: "another-game", createdAt: 1 });
    const r = await phase0(t, c);
    expect(r.outcome).toEqual({ kind: "deleting" });
    expect(r.writes).toBe(2);
    expect((await db.doc(`roomCodes/${c.game.roomCode}`).get()).get("gameId")).toBe("another-game");
  }, 120_000);
});

describe("I29 commands during and after deletion", () => {
  test("updateSettings and endGame are NOT_FOUND with zero writes; the same key and a new key both return the exact rejected NOT_FOUND shape; after the cascade too", async () => {
    const c = buildCascade({ hostId: "host-i29" });
    const t = await setup(c);
    const key = newKey();
    expect((await phase0(t, c, NOW, key)).outcome).toEqual({ kind: "deleting" });

    for (const cmd of [{ type: "updateSettings", patch: { profanity: "off" } }, { type: "endGame" }] as Command[]) {
      const r = await t.run(actor(c), cmd, { now: NOW });
      expect(r.outcome).toEqual({ kind: "rejected", rejection: { code: "NOT_FOUND" }, version: 0 });
      expect(r.writes).toBe(0);
    }
    const sameKey = await t.run(actor(c), { type: "deleteGame" } as Command, { now: NOW, idemKey: key });
    expect(sameKey.outcome).toEqual({ kind: "rejected", rejection: { code: "NOT_FOUND" }, version: 0 });
    const newKeyAgain = await t.run(actor(c), { type: "deleteGame" } as Command, { now: NOW, idemKey: newKey() });
    expect(newKeyAgain.outcome).toEqual({ kind: "rejected", rejection: { code: "NOT_FOUND" }, version: 0 });

    expect((await runDeletion(c.game.id, { now: NOW })).result.kind).toBe("done");
    const after = await t.run(actor(c), { type: "deleteGame" } as Command, { now: NOW, idemKey: newKey() });
    expect(after.outcome).toEqual({ kind: "rejected", rejection: { code: "NOT_FOUND" }, version: 0 });
  }, 120_000);
});

interface Inventory {
  aggregate: boolean;
  subcollections: string[];
  pushSubs: string[];
  joinIdem: string[];
  job: { status: string; stagesDone: string[]; expiresAt: number } | null;
  decks: string[];
  hostIdem: string[];
  crossHostIdem: Record<string, unknown> | null;
  other: { code: boolean; push: boolean; join: boolean };
}

async function inventory(c: Cascade): Promise<Inventory> {
  const gameRef = db.doc(`games/${c.game.id}`);
  const g = await gameRef.get();
  const job = await db.doc(`deletions/${c.game.id}`).get();
  const jd = job.data();
  return {
    aggregate: g.exists,
    subcollections: (await gameRef.listCollections()).map((x) => x.id).sort(),
    pushSubs: (await db.collection("pushSubs").where("gameId", "==", c.game.id).get()).docs.map((d) => d.id).sort(),
    joinIdem: (await db.collection("joinIdem").where("gameId", "==", c.game.id).get()).docs.map((d) => d.id).sort(),
    job: jd === undefined ? null : { status: String(jd["status"]), stagesDone: (jd["stagesDone"] as string[]).slice().sort(), expiresAt: (jd["expiresAt"] as Timestamp).toMillis() },
    decks: (await db.collection(`hosts/${c.game.hostId}/decks`).get()).docs.map((d) => d.id).sort(),
    hostIdem: (await db.collection(`hosts/${c.game.hostId}/idem`).get()).docs.map((d) => (d.id === c.otherHostIdemId ? "other" : d.id === c.hostIdemId ? "deleted" : d.id)).sort(),
    crossHostIdem: (await db.doc(`hosts/${c.crossHostId}/idem/${c.crossHostLedgerId}`).get()).data() ?? null,
    other: {
      code: (await db.doc("roomCodes/ZZZZ").get()).exists,
      push: (await db.doc("pushSubs/other-push").get()).exists,
      join: (await db.doc("joinIdem/other-join").get()).exists,
    },
  };
}

const normalized = (inv: Inventory, c: Cascade): Inventory =>
  JSON.parse(JSON.stringify(inv).replaceAll(c.game.id, "<g>").replaceAll(c.game.hostId, "<host>")) as Inventory;

let cleanInventory: Inventory;

beforeAll(async () => {
  const c = buildCascade({ hostId: "host-clean" });
  const t = await setup(c);
  expect((await phase0(t, c)).outcome).toEqual({ kind: "deleting" });
  expect((await runDeletion(c.game.id, { now: NOW })).result.kind).toBe("done");
  cleanInventory = normalized(await inventory(c), c);
}, 120_000);

describe("I31 after done the game is gone, the job keeps its 7 days, hosts decks survive", () => {
  test("no game documents, roomCodes/pushSubs/joinIdem/notifLog rows; job done; the deleted ledger is gone, the other game's ledger and decks survive", async () => {
    const c = buildCascade({ hostId: "host-i31" });
    const t = await setup(c);
    const deckBefore = (await db.doc(`hosts/${c.game.hostId}/decks/${c.deckId}`).get()).data();
    const otherIdemBefore = (await db.doc(`hosts/${c.game.hostId}/idem/${c.otherHostIdemId}`).get()).data();
    expect((await phase0(t, c)).outcome).toEqual({ kind: "deleting" });
    const r = await runDeletion(c.game.id, { now: NOW });
    expect(r.result.kind).toBe("done");

    const gameRef = db.doc(`games/${c.game.id}`);
    expect((await gameRef.get()).exists).toBe(false);
    expect(await gameRef.listCollections()).toEqual([]);
    expect((await db.collection(`games/${c.game.id}/notifLog`).get()).empty).toBe(true);
    expect((await db.collection("pushSubs").where("gameId", "==", c.game.id).get()).empty).toBe(true);
    expect((await db.collection("joinIdem").where("gameId", "==", c.game.id).get()).empty).toBe(true);
    expect((await db.doc(`roomCodes/${c.game.roomCode}`).get()).exists).toBe(false);

    const job = (await db.doc(`deletions/${c.game.id}`).get()).data();
    expect(job?.["status"]).toBe("done");
    expect(job?.["stagesDone"]).toEqual([...STAGES]);
    expect((job?.["expiresAt"] as Timestamp).toMillis()).toBe(NOW + TTL);

    expect((await db.doc(`hosts/${c.game.hostId}/decks/${c.deckId}`).get()).data()).toEqual(deckBefore);
    expect((await db.doc(`hosts/${c.game.hostId}/idem/${c.hostIdemId}`).get()).exists).toBe(false); // the deleted game's createGame ledger is gone (ST9)
    expect((await db.doc(`hosts/${c.game.hostId}/idem/${c.otherHostIdemId}`).get()).data()).toEqual(otherIdemBefore);
    expect((await db.doc("pushSubs/other-push").get()).exists).toBe(true);
    expect((await db.doc("joinIdem/other-join").get()).exists).toBe(true);
    expect((await db.doc("roomCodes/ZZZZ").get()).get("gameId")).toBe("another-game");
  }, 120_000);

  test("deleteWhere pages past 400 pushSubs rows, not just the first page", async () => {
    const c = buildCascade({ hostId: "host-i31-pages" });
    const t = await setup(c);
    const batch = db.batch();
    for (let i = 0; i < 451; i++) batch.set(db.doc(`pushSubs/page-${c.game.id}-${i}`), { gameId: c.game.id, uid: "page-uid", token: "PUSH-SENTINEL-page" });
    await batch.commit();
    expect((await db.collection("pushSubs").where("gameId", "==", c.game.id).get()).size).toBe(452); // 451 + the fixture's one
    expect((await phase0(t, c)).outcome).toEqual({ kind: "deleting" });
    expect((await runDeletion(c.game.id, { now: NOW })).result.kind).toBe("done");
    expect((await db.collection("pushSubs").where("gameId", "==", c.game.id).get()).empty).toBe(true);
    expect((await db.doc("pushSubs/other-push").get()).exists).toBe(true);
  }, 120_000);

  test("a same-key createGame after the cascade creates a new game, not a replay of the deleted one", async () => {
    const c = buildCascade({ hostId: "host-i31-replay" });
    const t = await setup(c);
    expect((await phase0(t, c)).outcome).toEqual({ kind: "deleting" });
    expect((await runDeletion(c.game.id, { now: NOW })).result.kind).toBe("done");
    const created = await create({ hostId: c.game.hostId, hostName: "NAME-SENTINEL-replay", idemKey: c.hostIdemKey, seeds: ["i36-replay-code", "i36-replay-decide"] });
    expect(created.outcome.kind).toBe("accepted");
    if (created.outcome.kind !== "accepted") return;
    expect(created.outcome.replay).toBe(false);
    expect(created.outcome.gameId).not.toBe(c.game.id);
  }, 120_000);
});

describe("I36 the hostIdem stage reads only the host's ledger", () => {
  test("this game's row is gone, the same host's other-game row is byte-equal, and a row under another host naming the game survives", async () => {
    const c = buildCascade({ hostId: "host-i36" });
    const t = await setup(c);
    const otherBefore = (await db.doc(`hosts/${c.game.hostId}/idem/${c.otherHostIdemId}`).get()).data();
    const crossPath = `hosts/${c.crossHostId}/idem/${c.crossHostLedgerId}`;
    const crossBefore = (await db.doc(crossPath).get()).data();
    expect(crossBefore?.["gameId"]).toBe(c.game.id);

    expect((await phase0(t, c)).outcome).toEqual({ kind: "deleting" });
    expect((await runDeletion(c.game.id, { now: NOW })).result.kind).toBe("done");

    expect((await db.doc(`hosts/${c.game.hostId}/idem/${c.hostIdemId}`).get()).exists).toBe(false);
    expect((await db.doc(`hosts/${c.game.hostId}/idem/${c.otherHostIdemId}`).get()).data()).toEqual(otherBefore);
    expect((await db.doc(crossPath).get()).data()).toEqual(crossBefore);
  }, 120_000);
});

describe("I37 the host ledger scan pages past 400 rows", () => {
  test("501 rows naming the deleted game are all removed, one batch per page", async () => {
    const c = buildCascade({ hostId: "host-i37" });
    const t = await setup(c);
    const row = { at: c.game.createdAt, expiresAt: Timestamp.fromMillis(c.game.createdAt + TTL), commandType: "createGame", version: 1, gameId: c.game.id, roomCode: c.game.roomCode };
    for (let start = 0; start < 500; start += 250) {
      const batch = db.batch();
      for (let i = start; i < start + 250; i++) batch.set(db.doc(`hosts/${c.game.hostId}/idem/scan-${i}`), row);
      await batch.commit();
    }
    // 500 seeded plus the fixture's one: two keyset pages, and a single uncapped read plus one commit would exceed 500 writes.
    expect((await db.collection(`hosts/${c.game.hostId}/idem`).where("gameId", "==", c.game.id).get()).size).toBe(501);

    expect((await phase0(t, c)).outcome).toEqual({ kind: "deleting" });
    expect((await runDeletion(c.game.id, { now: NOW })).result.kind).toBe("done");

    expect((await db.collection(`hosts/${c.game.hostId}/idem`).where("gameId", "==", c.game.id).get()).empty).toBe(true);
    expect((await db.doc(`hosts/${c.game.hostId}/idem/${c.otherHostIdemId}`).get()).exists).toBe(true);
  }, 120_000);
});

describe("I32 the identity stage purges exactly the non-host union", () => {
  test("seatUids plus seats/*, the departed and the LOBBY leaver included, the host excluded", async () => {
    const c = buildCascade({ hostId: "host-i32" });
    const t = await setup(c);
    expect((await phase0(t, c)).outcome).toEqual({ kind: "deleting" });
    const r = await runDeletion(c.game.id, { now: NOW });
    expect(r.purged).toHaveLength(1);
    const call = r.purged[0];
    if (call === undefined) throw new Error("no purge call");
    expect(call.gameId).toBe(c.game.id);
    expect([...call.uids].sort()).toEqual([...c.expectedUids].sort());
    expect(call.uids).toContain(c.departedUid);
    expect(call.uids).toContain(c.loobyLeaverUid);
    expect(call.uids).not.toContain(c.game.hostId);
    expect(call.requested).toBe(call.uids.length);
    expect(call.deleted).toBe(call.uids.length);
  }, 120_000);
});

describe("I33 a fault at either boundary of every stage resumes to the clean end state", () => {
  for (const stage of STAGES) {
    for (const point of ["work", "commit"] as const) {
      test(`fault after ${point} of ${stage}`, async () => {
        const c = buildCascade({ hostId: `host-i33-${stage}-${point}` });
        const t = await setup(c);
        expect((await phase0(t, c)).outcome).toEqual({ kind: "deleting" });
        const err = await runDeletionError(c.game.id, { now: NOW, faultAt: { stage, point } });
        expect(err).toEqual({ code: "functions/internal", kind: "FAULT", stage, point });
        if (stage !== "aggregate") expect((await db.doc(`games/${c.game.id}`).get()).exists).toBe(true);

        const resume = await runDeletion(c.game.id, { now: NOW });
        expect(resume.result.kind).toBe("done");
        const i = STAGES.indexOf(stage);
        expect(resume.result.stagesRun).toEqual(point === "work" ? [...STAGES.slice(i)] : [...STAGES.slice(i + 1)]);
        expect(normalized(await inventory(c), c)).toEqual(cleanInventory);
      }, 120_000);
    }
  }
});

describe("I34 a second run after done and a missing job are no-ops", () => {
  test("second run: noop, document diff empty, job untouched", async () => {
    const c = buildCascade({ hostId: "host-i34" });
    const t = await setup(c);
    expect((await phase0(t, c)).outcome).toEqual({ kind: "deleting" });
    expect((await runDeletion(c.game.id, { now: NOW })).result.kind).toBe("done");
    const before = await snapshot(c.game.id, extraPaths(c));
    const again = await runDeletion(c.game.id, { now: NOW + 1_000 });
    expect(again.result).toEqual({ kind: "noop", reason: "done", stagesRun: [], stuck: false });
    expect(again.purged).toEqual([]);
    expect(diff(before, await snapshot(c.game.id, extraPaths(c)))).toEqual({ created: [], changed: [], deleted: [] });
  }, 120_000);

  test("a missing job is a noop with no purge", async () => {
    const missing = "gmissingmissingmissing";
    const r = await runDeletion(missing, { now: NOW });
    expect(r.result).toEqual({ kind: "noop", reason: "missing", stagesRun: [], stuck: false });
    expect(r.purged).toEqual([]);
  }, 60_000);
});

describe("I35 a stale running job raises deletion.stuck", () => {
  test("older than one hour emits one line with the gameId only; exactly one hour emits none", async () => {
    const old = buildCascade({ hostId: "host-i35-old" });
    const tOld = await setup(old);
    expect((await phase0(tOld, old, NOW - HOUR - 1)).outcome).toEqual({ kind: "deleting" });
    const r = await runDeletion(old.game.id, { now: NOW, captureLog: true });
    expect(r.result.stuck).toBe(true);
    expect(r.logs).toEqual([{ event: "deletion.stuck", gameId: old.game.id }]);

    const young = buildCascade({ hostId: "host-i35-young" });
    const tYoung = await setup(young);
    expect((await phase0(tYoung, young, NOW - HOUR)).outcome).toEqual({ kind: "deleting" });
    const y = await runDeletion(young.game.id, { now: NOW, captureLog: true });
    expect(y.result.stuck).toBe(false);
    expect(y.logs).toEqual([]);
  }, 120_000);

  test("the log seam defaults to the real logger (no capture still completes)", async () => {
    const c = buildCascade({ hostId: "host-i35-default" });
    const t = await setup(c);
    expect((await phase0(t, c, NOW - 2 * HOUR)).outcome).toEqual({ kind: "deleting" });
    const r = await runDeletion(c.game.id, { now: NOW });
    expect(r.result.stuck).toBe(true);
    expect(r.logs).toEqual([]);
  }, 120_000);
});
