import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { PROJECTOR_REV } from "@dc/engine";
import { Table } from "./support/drive";
import { clear, db, run } from "./support/harness";
import { diff, snapshot } from "./support/inspect";
import { newKey } from "./support/seed";

// I6 Skip-unchanged and viewsRev (K-F, LLD 3 section 5.6). The stale viewsRev is a test-local patch (the viewsStale fixture is #37); castVote is M7.
beforeAll(clear);

async function patchStale(t: Table): Promise<void> {
  await db.doc(`games/${t.gameId}`).update({ "store.viewsRev": PROJECTOR_REV - 1 });
  for (const d of (await db.collection(`games/${t.gameId}/views`).get()).docs) await d.ref.update({ viewsRev: PROJECTOR_REV - 1 });
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
  const t = await Table.lobby(4);
  await t.host({ type: "startGame" } as Command);
  await patchStale(t);
  const b1 = await snapshot(t.gameId);
  await t.as(1, { type: "saveDraft", ...(await t.fullDraft(1)) } as Command); // a count change: cardsLeft is public
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

test("I6 a stale viewsRev with a text-only saveDraft rebuilds every view at the unchanged version and records the running viewsRev", async () => {
  const t = await Table.lobby(3);
  await t.host({ type: "startGame" } as Command);
  await t.as(1, { type: "saveDraft", ...(await t.fullDraft(1)) } as Command);
  await patchStale(t);
  const v = (await t.state()).version;
  const before = await snapshot(t.gameId);
  const r = await run({ gameId: t.gameId, actor: { kind: "user", uid: t.uidOf(1) }, cmd: { type: "saveDraft", ...(await t.fullDraft(1, " edit")) } as Command, idemKey: newKey() });
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
