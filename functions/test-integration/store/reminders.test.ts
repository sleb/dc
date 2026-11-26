import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { REMINDER_INTERVAL_MS } from "@dc/engine";
import { Table } from "./support/drive";
import { clear, db, run } from "./support/harness";
import type { RunResult } from "./support/harness";
import { diff, snapshot } from "./support/inspect";
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
  expect((await db.collection(`games/${t.gameId}/outbox`).where("version", "==", v).get()).size).toBe(1);
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
