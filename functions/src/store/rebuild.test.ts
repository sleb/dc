import { expect, test } from "bun:test";
import { PROJECTOR_REV, VIEW_REGION_FIELDS, viewersOf } from "@dc/engine";
import { StoreError } from "./errors";
import { planRebuild, rebuildViews } from "./rebuild";
import { MAX_ATTEMPTS } from "./run";
import { MemGame } from "./test-support";
import type { GameDoc } from "./types";
import type { DocWrite } from "./writeset";

// U11-U13 (#35, LLD 3 sections 5.6 and 6.5): the rebuild plans the aggregate's rev and every view, unconditionally, at the unchanged version, and
// never touches the draft region, the event log, the ledger, the outbox or the drafts docs. The pure half is proved here without the emulator.
const docFor = (m: MemGame, store: Partial<GameDoc["store"]> = {}): GameDoc => ({
  ...m.game,
  store: { schema: 1, viewsRev: PROJECTOR_REV, updatedAt: 1_000, deleting: null, ...store },
});

const noDraftFields = (w: DocWrite): boolean => w.op === "merge" && !w.fields.some((f) => f === "draft" || f === "draftSeq");

test("U11 planRebuild: a missing or deleting aggregate plans no write", () => {
  expect(planRebuild(null, { now: 5 })).toEqual({ kind: "missing", writes: [] });
  const m = MemGame.create().joinAll(3);
  const deleting = docFor(m, { deleting: { at: 3, by: m.game.hostId } });
  expect(planRebuild(deleting, { now: 5 })).toEqual({ kind: "deleting", writes: [] });
});

test("U11 planRebuild: one aggregate update plus one view merge per viewer, at the unchanged version", () => {
  const m = MemGame.create().joinAll(4);
  const doc = docFor(m, { viewsRev: 1 });
  const now = 9_000;
  const plan = planRebuild(doc, { now });
  expect(plan.kind).toBe("rebuilt");
  if (plan.kind !== "rebuilt") return;
  expect(plan).toMatchObject({ gameId: m.game.id, version: m.game.version, viewsRev: PROJECTOR_REV });
  expect(plan.writes).toHaveLength(1 + viewersOf(m.game).length);
  expect(plan.writes.length).toBeLessThanOrEqual(1 + 52);

  const [aggregate, ...views] = plan.writes;
  expect(aggregate).toEqual({ op: "update", path: `games/${m.game.id}`, data: { "store.viewsRev": PROJECTOR_REV, "store.updatedAt": now } });
  expect(aggregate?.op === "update" ? Object.keys(aggregate.data).sort() : []).toEqual(["store.updatedAt", "store.viewsRev"]);
  expect(JSON.stringify(aggregate)).not.toContain("version");

  const paths = viewersOf(m.game).map((t) => `games/${m.game.id}/views/${t.docId}`);
  expect(views.map((w) => w.path).sort()).toEqual(paths.sort());
  for (const w of views) {
    expect(w.op).toBe("merge");
    expect(noDraftFields(w)).toBe(true);
    expect(w.op === "merge" ? [...w.fields].sort() : []).toEqual([...VIEW_REGION_FIELDS].sort());
    expect(w.op === "merge" ? Object.keys(w.data).sort() : []).toEqual([...VIEW_REGION_FIELDS].sort());
  }
  // Nothing outside the aggregate and the views: no events, ledger, outbox or drafts write.
  for (const w of plan.writes) expect(w.path).not.toMatch(/\/(events|idem|outbox|drafts)\//);
});

test("U12 the rebuild is unconditional: the current rev still plans every write, and no write carries the draft region", () => {
  const m = MemGame.create().joinAll(3);
  const current = docFor(m, { viewsRev: PROJECTOR_REV });
  const plan = planRebuild(current, { now: 7 });
  expect(plan.kind).toBe("rebuilt");
  if (plan.kind !== "rebuilt") return;
  expect(plan.writes).toHaveLength(1 + viewersOf(m.game).length);
  for (const w of plan.writes) {
    expect(w.op === "merge" ? w.fields.includes("clearDraft") : false).toBe(false);
    expect(noDraftFields(w)).toBe(true);
    expect(JSON.stringify(w)).not.toContain("clearDraft");
  }
});

interface FakeTx {
  get(ref: { path: string }): Promise<{ exists: boolean; data(): unknown; ref: { path: string } }>;
  create(ref: { path: string }, data: unknown): void;
  set(ref: { path: string }, data: unknown, options?: unknown): void;
  update(ref: { path: string }, data: unknown): void;
  delete(ref: { path: string }): void;
}

function fakeDb(path: string, doc: GameDoc | null) {
  const applied: string[] = [];
  const options: unknown[] = [];
  const tx: FakeTx = {
    get: async (ref) => ({ exists: doc !== null && ref.path === path, data: () => doc, ref }),
    create: (ref) => void applied.push(`create ${ref.path}`),
    set: (ref) => void applied.push(`set ${ref.path}`),
    update: (ref) => void applied.push(`update ${ref.path}`),
    delete: (ref) => void applied.push(`delete ${ref.path}`),
  };
  const db = {
    doc: (p: string) => ({ path: p }),
    runTransaction: async (fn: (t: FakeTx) => Promise<unknown>, o: unknown) => {
      options.push(o);
      return fn(tx);
    },
  };
  return { db: db as never, applied, options };
}

test("U13 rebuildViews: one transaction with MAX_ATTEMPTS, exactly the planned writes, a typed result", async () => {
  const m = MemGame.create().joinAll(3);
  const doc = docFor(m, { viewsRev: 1 });
  const now = 12_000;
  const expected = planRebuild(doc, { now });
  if (expected.kind !== "rebuilt") throw new Error("expected a rebuild plan");
  const { db, applied, options } = fakeDb(`games/${m.game.id}`, doc);
  const result = await rebuildViews(db, m.game.id, { now });
  expect(options).toEqual([{ maxAttempts: MAX_ATTEMPTS }]);
  expect(result).toEqual({ kind: "rebuilt", gameId: m.game.id, version: m.game.version, viewsRev: PROJECTOR_REV, writes: expected.writes.length });
  expect(applied).toEqual(expected.writes.map((w) => `${w.op} ${w.path}`));
});

test("U13 rebuildViews: a missing aggregate returns missing and writes nothing", async () => {
  const { db, applied, options } = fakeDb("games/missing", null);
  expect(await rebuildViews(db, "missing", { now: 1 })).toEqual({ kind: "missing" });
  expect(options).toHaveLength(1);
  expect(applied).toEqual([]);
});

test("U13 rebuildViews: a thrown StoreError passes through mapStoreError unchanged", async () => {
  const err = new StoreError("INVARIANT", "boom");
  const db = {
    doc: (p: string) => ({ path: p }),
    runTransaction: async () => {
      throw err;
    },
  };
  await expect(rebuildViews(db as never, "g", { now: 1 })).rejects.toBe(err);
});
