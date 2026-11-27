import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { REMINDER_INTERVAL_MS } from "@dc/engine";
import { Table } from "./support/drive";
import { clear, db, listWaitingOn, run } from "./support/harness";
import type { RunResult } from "./support/harness";
import type { WaitingPage } from "../../src/store";
import { diff, registryQuery, snapshot } from "./support/inspect";
import { pid } from "./support/seed";

// I12 Reminders, the markReminded half (LLD 3 sections 7 and 8). listWaitingOn and its paging are #35.
beforeAll(clear);

async function remind(t: Table, o: { episode?: string; episodeGen?: number; key?: string } = {}): Promise<{ r: RunResult; before: Awaited<ReturnType<Table["state"]>> }> {
  const g = await t.state();
  const episode = o.episode ?? g.episode;
  const r = await run({ gameId: t.gameId, actor: { kind: "system" }, cmd: { type: "markReminded", episode, episodeGen: o.episodeGen ?? g.episodeGen } as Command, idemKey: o.key ?? `remind:${episode}:${g.reminderDueAt}`, now: g.reminderDueAt ?? 0 });
  return { r, before: g };
}

async function expectReminded(t: Table, kind: "WRITING" | "SUBMITTING" | "JUDGING"): Promise<void> {
  const { r, before } = await remind(t);
  const v = before.version + 1;
  expect(r.outcome).toMatchObject({ kind: "accepted", version: v, replay: false });
  const after = await t.state();
  expect(after.reminderDueAt).toBe((before.reminderDueAt ?? 0) + REMINDER_INTERVAL_MS);
  expect((await db.doc(`games/${t.gameId}/events/${v}`).get()).get("events")).toEqual([]);
  const row = (await db.doc(`games/${t.gameId}/outbox/v${v}_0`).get()).data();
  expect(row?.["event"]).toEqual({ t: "Reminder", episode: before.episode, episodeGen: before.episodeGen, dueAt: before.reminderDueAt, waitingOn: after.waitingOn });
  expect(row?.["waitingOn"]).toEqual(after.waitingOn);
  expect((row?.["roster"] as unknown[]).length).toBe(after.players.filter((p) => p.status === "writing" || p.status === "ready" || p.status === "active").length);
  if (kind === "WRITING") expect(row?.["round"]).toBeUndefined();
  else expect(row?.["round"]).toEqual({ number: after.round?.number, phase: kind });
  expect((await registryQuery(db, "outboxSiblings", { gameId: t.gameId, values: { version: v } }).get()).size).toBe(1); // the registry's sibling-rows query (LLD 6 3.3)
}

test("I12 markReminded in WRITING, SUBMITTING and JUDGING: one events doc, one Reminder row with episodeGen and context, reminderDueAt advanced; a same-key rerun replays", async () => {
  const t = await Table.lobby(3);
  await t.host({ type: "startGame" } as Command);
  await expectReminded(t, "WRITING");
  const g = await t.state();
  const key = `remind:${g.episode}:${(g.reminderDueAt ?? 0) - REMINDER_INTERVAL_MS}`;
  const again = await run({ gameId: t.gameId, actor: { kind: "system" }, cmd: { type: "markReminded", episode: g.episode, episodeGen: g.episodeGen } as Command, idemKey: key, now: g.reminderDueAt ?? 0 });
  expect(again.outcome).toMatchObject({ kind: "accepted", replay: true, version: g.version });
  await t.writeAll();
  await expectReminded(t, "SUBMITTING");
  await t.submitAll();
  await expectReminded(t, "JUDGING");
}, 300_000);

test("I12 a changed episode, or a bumped episodeGen of the same kind (pause, unpause), is a zero-write no-op", async () => {
  const t = await Table.playing(3);
  const old = await t.state();
  await t.submitAll(); // SUBMITTING -> JUDGING: a new episode
  const before = await snapshot(t.gameId);
  const { r } = await remind(t, { episode: old.episode ?? "", episodeGen: old.episodeGen, key: "remind:old-episode" });
  expect(r.outcome).toMatchObject({ kind: "accepted", version: (await t.state()).version, replay: false });
  expect(r.writes).toBe(0);
  expect(diff(before, await snapshot(t.gameId))).toEqual({ created: [], changed: [], deleted: [] });

  // Same kind, next generation: a pause and an unpause in JUDGING.
  const j = await t.state();
  const nonJudge = j.players.find((p) => p.status === "active" && p.id !== j.round?.judgeId && p.uid !== j.hostId);
  await t.as(t.indexOf(nonJudge?.id ?? ""), { type: "leave" } as Command);
  expect((await t.state()).paused).toBe(true);
  await t.join(3);
  await t.as(3, { type: "saveDraft", ...(await t.fullDraft(3)) } as Command);
  await t.as(3, { type: "finishWriting" } as Command);
  const u = await t.state();
  expect(u.paused).toBe(false);
  expect(u.episodeGen).toBeGreaterThan(j.episodeGen);
  const b2 = await snapshot(t.gameId);
  const stale = await remind(t, { episode: j.episode ?? "", episodeGen: j.episodeGen, key: "remind:old-gen" });
  expect(stale.r.writes).toBe(0);
  expect(diff(b2, await snapshot(t.gameId))).toEqual({ created: [], changed: [], deleted: [] });
}, 300_000);

test("I12 a late joiner writing during PLAYING appears in waitingOn and leaves waitingSince unchanged", async () => {
  const t = await Table.playing(3);
  const before = await t.state();
  await t.join(3);
  const after = await t.state();
  expect(after.players.find((p) => p.id === pid(3))?.status).toBe("writing");
  expect(after.waitingOn).toContain(pid(3));
  expect(after.waitingSince).toBe(before.waitingSince);
  expect(after.episode).toBe(before.episode);
}, 300_000);

test("I27 listWaitingOn pages the waitingOn query over 250 due, 50 future and 50 null games", async () => {
  const t = await Table.lobby(3);
  await t.host({ type: "startGame" } as Command);
  const REAL_DUE = 1000;
  await db.doc(`games/${t.gameId}`).update({ reminderDueAt: REAL_DUE }); // only this item comes from a Store-written aggregate
  const real = await t.state();
  const now = 10_000_000;

  // 249 lean Admin-written due docs plus the real game make 250 due; ties on dueAt are deliberate.
  const lean = Array.from({ length: 249 }, (_, i) => ({ gameId: `g${String(i).padStart(19, "0")}`, dueAt: 1000 + Math.floor(i / 10) }));
  const future = Array.from({ length: 50 }, (_, i) => ({ gameId: `f${String(i).padStart(19, "0")}`, dueAt: now + 1 + i }));
  const nulls = Array.from({ length: 50 }, (_, i) => ({ gameId: `n${String(i).padStart(19, "0")}` }));
  const batch = db.batch();
  for (const d of lean) batch.set(db.doc(`games/${d.gameId}`), { reminderDueAt: d.dueAt, episode: `e-${d.gameId}`, episodeGen: 1, waitingOn: ["p_lean"], waitingSince: 5, version: 1 });
  for (const d of future) batch.set(db.doc(`games/${d.gameId}`), { reminderDueAt: d.dueAt, episode: `e-${d.gameId}`, episodeGen: 1, waitingOn: ["p_future"], waitingSince: 5, version: 1 });
  for (const d of nulls) batch.set(db.doc(`games/${d.gameId}`), { reminderDueAt: null, episode: null, episodeGen: 0, waitingOn: [], waitingSince: 0, version: 1 });
  await batch.commit();

  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const want = [{ gameId: t.gameId, dueAt: REAL_DUE }, ...lean]
    .sort((a, b) => a.dueAt - b.dueAt || cmp(a.gameId, b.gameId))
    .map((x) => x.gameId);

  const pages = async (limit?: number): Promise<WaitingPage[]> => {
    const out: WaitingPage[] = [];
    let after: WaitingPage["next"] = null;
    for (let i = 0; i < 200; i++) {
      const p = await listWaitingOn({ now, ...(limit === undefined ? {} : { limit }), ...(after === null ? {} : { after }) });
      out.push(p);
      after = p.next;
      if (after === null) return out;
    }
    throw new Error("paging did not terminate");
  };
  const expectCursors = (out: WaitingPage[]) => {
    for (const p of out.slice(0, -1)) {
      const last = p.items.at(-1)!;
      expect(p.next).toEqual({ dueAt: last.dueAt, gameId: last.gameId });
    }
    expect(out.at(-1)?.next).toBeNull();
  };

  // Default limit 100: 100/100/50, exact order, no repeats; next null only on the short last page.
  const def = await pages();
  expect(def.map((p) => p.items.length)).toEqual([100, 100, 50]);
  const flat = def.flatMap((p) => p.items);
  expect(flat).toHaveLength(250);
  expect(new Set(flat.map((x) => x.gameId)).size).toBe(250);
  expect(flat.map((x) => x.gameId)).toEqual(want);
  expectCursors(def);

  // limit 50: five full pages, then one empty page with next null (the full final page still yields a cursor).
  const fifty = await pages(50);
  expect(fifty.map((p) => p.items.length)).toEqual([50, 50, 50, 50, 50, 0]);
  expect(fifty.at(-2)?.next).not.toBeNull();
  expect(fifty.flatMap((p) => p.items).map((x) => x.gameId)).toEqual(want);
  expectCursors(fifty);

  // limit 7 over tied dueAt values: exact order and boundaries.
  const seven = await pages(7);
  expect(seven.slice(0, -1).every((p) => p.items.length === 7)).toBe(true);
  expect(seven.at(-1)?.items.length).toBe(5);
  expect(seven.flatMap((p) => p.items).map((x) => x.gameId)).toEqual(want);
  expectCursors(seven);

  // Future and null games never appear; each item carries exactly the seven fields.
  const seen = new Set(flat.map((x) => x.gameId));
  expect(future.some((d) => seen.has(d.gameId))).toBe(false);
  expect(nulls.some((d) => seen.has(d.gameId))).toBe(false);
  expect(Object.keys(flat[0] ?? {}).sort()).toEqual(["dueAt", "episode", "episodeGen", "gameId", "since", "version", "waitingOn"]);

  // The real game's item is its aggregate's fields.
  const realItem = flat.find((x) => x.gameId === t.gameId);
  expect(realItem).toBeDefined();
  expect(realItem?.episode).toBe(real.episode as string); // WRITING guarantees a non-null episode (X8)
  expect(realItem?.episodeGen).toBe(real.episodeGen);
  expect(realItem?.waitingOn).toEqual(real.waitingOn);
  expect(realItem?.since).toBe(real.waitingSince as number);
  expect(realItem?.dueAt).toBe(REAL_DUE);
  expect(realItem?.version).toBe(real.version);
}, 300_000);
