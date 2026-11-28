import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { PROJECTOR_REV, viewersOf } from "@dc/engine";
import { Table } from "./support/drive";
import { FIXTURE_IDS, fixtureHostId, lowerViewsRev, seedFixture } from "./support/fixtures";
import { clear, db, rebuildViews, run } from "./support/harness";
import { canonical, diff, eventVersions, snapshot, viewProblems } from "./support/inspect";
import { newKey, pid } from "./support/ids";

// I6, I25 Skip-unchanged and viewsRev (K-F, LLD 3 sections 5.6 and 10.1). The stale state is the built `viewsStale` fixture (#37);
// castVote is M7.
beforeAll(async () => {
  await clear();
  await seedFixture("viewsStale");
});

/** The stale fixture: the build leaves it stale; an earlier test in the file may have rebuilt it since. */
async function stale(): Promise<Table> {
  const t = Table.attach(FIXTURE_IDS.viewsStale, fixtureHostId("viewsStale"));
  await lowerViewsRev(t.gameId);
  return t;
}
const viewPaths = (s: Map<string, unknown>) => [...s.keys()].filter((p) => p.includes("/views/")).sort();

test("I6 markReminded writes only the aggregate, the events doc (events: []), the ledger and the outbox row", async () => {
  const t = await Table.lobby(3);
  await t.host({ type: "startGame" } as Command);
  const g = await t.state();
  const before = await snapshot(t.gameId);
  const r = await run({ gameId: t.gameId, actor: { kind: "system" }, cmd: { type: "markReminded", episode: g.episode, episodeGen: g.episodeGen } as Command, idemKey: `remind:${g.episode}:${g.reminderDueAt}`, now: g.reminderDueAt ?? 0 });
  expect(r.outcome).toMatchObject({ kind: "accepted", version: g.version + 1, view: null });
  const d = diff(before, await snapshot(t.gameId));
  expect(d.changed).toEqual([`games/${t.gameId}`]);
  expect(d.deleted).toEqual([]);
  expect(d.created.map((p) => p.split("/")[2]).sort()).toEqual(["events", "idem", "outbox"]);
  expect((await db.doc(`games/${t.gameId}/events/${g.version + 1}`).get()).get("events")).toEqual([]);
}, 60_000);

test("I6 a stale viewsRev with an aggregate change rewrites every view once, then skip-unchanged resumes", async () => {
  const t = await stale();
  const b1 = await snapshot(t.gameId);
  const full = await t.fullDraft(1);
  await t.as(1, { type: "saveDraft", red: full.red.slice(1), green: full.green } as Command); // a count change: cardsLeft is public
  const a1 = await snapshot(t.gameId);
  expect(diff(b1, a1).changed.filter((p) => p.includes("/views/"))).toEqual(viewPaths(a1));
  for (const p of viewPaths(a1)) expect(a1.get(p)?.data["viewsRev"]).toBe(PROJECTOR_REV);
  expect((a1.get(`games/${t.gameId}`)?.data["store"] as { viewsRev: number }).viewsRev).toBe(PROJECTOR_REV);
  // The rev is current again, so an aggregate change that no reader can see (a reminder) rewrites no view.
  const g = await t.state();
  const r = await run({ gameId: t.gameId, actor: { kind: "system" }, cmd: { type: "markReminded", episode: g.episode, episodeGen: g.episodeGen } as Command, idemKey: "remind:skip", now: g.reminderDueAt ?? 0 });
  expect(r.outcome).toMatchObject({ kind: "accepted", version: g.version + 1 });
  expect(diff(a1, await snapshot(t.gameId)).changed.filter((p) => p.includes("/views/"))).toEqual([]);
}, 90_000);

/** The same count the stored draft holds, with new text: a text-only save (5.6). */
async function textOnly(t: Table, tag: string): Promise<{ red: string[]; green: string[] }> {
  const g = await t.state();
  const progress = g.players.find((p) => p.id === pid(1))?.writeProgress ?? { red: 0, green: 0 };
  const full = await t.fullDraft(1);
  return { red: full.red.slice(0, progress.red).map((s) => `${s}${tag}`), green: full.green.slice(0, progress.green).map((s) => `${s}${tag}`) };
}

test("I6 a stale viewsRev with a text-only saveDraft rebuilds every view at the unchanged version and records the running viewsRev", async () => {
  const t = await stale();
  const v = (await t.state()).version;
  const before = await snapshot(t.gameId);
  const r = await run({ gameId: t.gameId, actor: { kind: "user", uid: t.uidOf(1) }, cmd: { type: "saveDraft", ...(await textOnly(t, " edit")) } as Command, idemKey: newKey() });
  expect(r.outcome).toMatchObject({ kind: "accepted", version: v });
  const after = await snapshot(t.gameId);
  expect((await t.state()).version).toBe(v);
  expect(diff(before, after).changed.filter((p) => p.includes("/views/"))).toEqual(viewPaths(after));
  for (const p of viewPaths(after)) {
    expect(after.get(p)?.data["viewsRev"]).toBe(PROJECTOR_REV);
    expect(after.get(p)?.data["version"]).toBe(v);
  }
  expect((after.get(`games/${t.gameId}`)?.data["store"] as { viewsRev: number }).viewsRev).toBe(PROJECTOR_REV);
  expect(diff(before, after).created.filter((p) => p.includes("/events/"))).toEqual([]);
}, 90_000);

const aggregateOf = (s: Awaited<ReturnType<typeof snapshot>>, gameId: string) => s.get(`games/${gameId}`)?.data ?? {};
const withoutStore = (d: Record<string, unknown>) => {
  const { store: _s, ...rest } = d;
  return canonical(rest);
};
const viewContent = (d: Record<string, unknown> | undefined) => {
  const { generatedAt: _g, ...rest } = d ?? {};
  return canonical(rest);
};

test("I23 rebuildViews writes the aggregate's rev and every viewer's doc at the unchanged version; no events, ledger or draft write", async () => {
  const t = await Table.lobby(4);
  await t.host({ type: "startGame" } as Command);
  const me = 1;
  await t.as(me, { type: "saveDraft", ...(await t.fullDraft(me)) } as Command);
  const start = await t.state();
  const now = (start.reminderDueAt ?? 0) + 12_345;
  const before = await snapshot(t.gameId);
  const beforeAggregate = aggregateOf(before, t.gameId);
  const writer = `games/${t.gameId}/views/${t.uidOf(me)}`;
  const draftBefore = before.get(writer)?.data;

  const res = await rebuildViews(t.gameId, now);
  expect(res).toEqual({ kind: "rebuilt", gameId: t.gameId, version: start.version, viewsRev: PROJECTOR_REV, writes: 6 });

  const after = await snapshot(t.gameId);
  const aggregate = aggregateOf(after, t.gameId);
  const store = aggregate["store"] as { schema: number; viewsRev: number; updatedAt: number; deleting: unknown };
  expect(aggregate["version"]).toBe(start.version);
  expect(store.viewsRev).toBe(PROJECTOR_REV);
  expect(store.updatedAt).toBe(now);
  expect(store.schema).toBe((beforeAggregate["store"] as { schema: number }).schema);
  expect(store.deleting).toBeNull();
  expect(withoutStore(aggregate)).toBe(withoutStore(beforeAggregate)); // every other aggregate field is byte-equal

  for (const target of viewersOf(start)) {
    const p = `games/${t.gameId}/views/${target.docId}`;
    expect(after.has(p)).toBe(true);
    expect(after.get(p)?.data["viewsRev"]).toBe(PROJECTOR_REV);
    // The rebuild writes the unchanged aggregate version; a disabled spectator doc may have been left at an older envelope by skip-unchanged.
    expect(after.get(p)?.data["version"]).toBe(start.version);
  }
  expect(await viewProblems(t.gameId)).toEqual([]);

  expect(after.get(writer)?.data["draft"]).toEqual(draftBefore?.["draft"]);
  expect(after.get(writer)?.data["draftSeq"]).toBe(draftBefore?.["draftSeq"]);

  const d = diff(before, after);
  expect(d.created).toEqual([]);
  expect(d.deleted).toEqual([]);
  expect(d.changed).toEqual([`games/${t.gameId}`, ...viewPaths(after)].sort());
  expect(after.has(`games/${t.gameId}/events/${start.version + 1}`)).toBe(false);
}, 180_000);

test("I24 a second rebuild at the current rev rewrites identically with generatedAt advanced; missing and deleting are no-ops", async () => {
  const t = await Table.lobby(3);
  await t.host({ type: "startGame" } as Command);
  const v = (await t.state()).version;
  const first = await rebuildViews(t.gameId, 100_000);
  expect(first).toMatchObject({ kind: "rebuilt", version: v, viewsRev: PROJECTOR_REV });
  const s1 = await snapshot(t.gameId);

  const second = await rebuildViews(t.gameId, 200_000);
  expect(second).toEqual({ kind: "rebuilt", gameId: t.gameId, version: v, viewsRev: PROJECTOR_REV, writes: (first as { writes: number }).writes });
  const s2 = await snapshot(t.gameId);
  expect((await t.state()).version).toBe(v);
  for (const p of viewPaths(s2)) {
    expect(s1.has(p)).toBe(true);
    expect(viewContent(s2.get(p)?.data)).toBe(viewContent(s1.get(p)?.data));
    expect(s2.get(p)?.data["generatedAt"]).toBe(200_000);
    expect(s2.get(p)?.data["viewsRev"]).toBe(PROJECTOR_REV);
  }

  const missing = "missingmissingmissin";
  const beforeMissing = await snapshot(missing);
  expect(await rebuildViews(missing, 300_000)).toEqual({ kind: "missing" });
  expect(diff(beforeMissing, await snapshot(missing))).toEqual({ created: [], changed: [], deleted: [] });

  await db.doc(`games/${t.gameId}`).update({ "store.deleting": { at: 1, by: "uid-test-deleting" } });
  const beforeDeleting = await snapshot(t.gameId);
  expect(await rebuildViews(t.gameId, 400_000)).toEqual({ kind: "deleting" });
  const afterDeleting = await snapshot(t.gameId);
  expect(diff(beforeDeleting, afterDeleting)).toEqual({ created: [], changed: [], deleted: [] });
  expect((aggregateOf(afterDeleting, t.gameId)["store"] as { deleting: unknown }).deleting).toEqual({ at: 1, by: "uid-test-deleting" });
}, 180_000);

test("I25 the upgrade path: a text-only saveDraft and then rebuildViews both rebuild every view at the unchanged version", async () => {
  const t = await stale();
  const v = (await t.state()).version;

  // First half: the next user command (K-F) rebuilds at the unchanged version.
  const before = await snapshot(t.gameId);
  const r = await run({ gameId: t.gameId, actor: { kind: "user", uid: t.uidOf(1) }, cmd: { type: "saveDraft", ...(await textOnly(t, " edit")) } as Command, idemKey: newKey() });
  expect(r.outcome).toMatchObject({ kind: "accepted", version: v });
  const afterCommand = await snapshot(t.gameId);
  expect((await t.state()).version).toBe(v);
  expect(diff(before, afterCommand).changed.filter((p) => p.includes("/views/"))).toEqual(viewPaths(afterCommand));
  for (const p of viewPaths(afterCommand)) {
    expect(afterCommand.get(p)?.data["viewsRev"]).toBe(PROJECTOR_REV);
    expect(afterCommand.get(p)?.data["version"]).toBe(v);
  }
  expect((aggregateOf(afterCommand, t.gameId)["store"] as { viewsRev: number }).viewsRev).toBe(PROJECTOR_REV);
  expect(await viewProblems(t.gameId)).toEqual([]);
  expect(diff(before, afterCommand).created.filter((p) => p.includes("/events/"))).toEqual([]);

  // Second half: rebuildViews does the same from the stale state.
  expect(await lowerViewsRev(t.gameId)).toBe(true);
  const beforeRebuild = await snapshot(t.gameId);
  const res = await rebuildViews(t.gameId, 777_000);
  expect(res).toMatchObject({ kind: "rebuilt", version: v, viewsRev: PROJECTOR_REV });
  const afterRebuild = await snapshot(t.gameId);
  expect((await t.state()).version).toBe(v);
  expect(diff(beforeRebuild, afterRebuild).changed.filter((p) => p.includes("/views/"))).toEqual(viewPaths(afterRebuild));
  for (const p of viewPaths(afterRebuild)) {
    expect(afterRebuild.get(p)?.data["viewsRev"]).toBe(PROJECTOR_REV);
    expect(afterRebuild.get(p)?.data["version"]).toBe(v);
  }
  expect((aggregateOf(afterRebuild, t.gameId)["store"] as { viewsRev: number }).viewsRev).toBe(PROJECTOR_REV);
  expect(await viewProblems(t.gameId)).toEqual([]);
  expect(diff(beforeRebuild, afterRebuild).created.filter((p) => p.includes("/events/"))).toEqual([]);
}, 240_000);

test("I26 a parallel rebuildViews and count-changing saveDraft both land: version +1, contiguous events, views equal the projection", async () => {
  const t = await Table.lobby(3, { settings: { spectators: { enabled: true, vote: false } } });
  await t.host({ type: "startGame" } as Command);
  await t.as(1, { type: "saveDraft", ...(await t.fullDraft(1)) } as Command);
  const start = await t.state();
  const full = await t.fullDraft(1);

  const [rebuilt, saved] = await Promise.all([
    rebuildViews(t.gameId, 500_000),
    t.as(1, { type: "saveDraft", red: full.red.slice(1), green: full.green } as Command),
  ]);
  expect(rebuilt.kind).toBe("rebuilt");
  expect(saved.outcome).toMatchObject({ kind: "accepted", version: start.version + 1 });

  const end = await t.state();
  expect(end.version).toBe(start.version + 1);
  expect(await eventVersions(t.gameId)).toEqual(Array.from({ length: end.version }, (_, i) => i + 1));
  expect(await viewProblems(t.gameId)).toEqual([]);
  for (const target of viewersOf(end)) {
    const snap = await db.doc(`games/${t.gameId}/views/${target.docId}`).get();
    expect(snap.get("viewsRev")).toBe(PROJECTOR_REV);
    expect(snap.get("version")).toBe(end.version);
  }
}, 240_000);
