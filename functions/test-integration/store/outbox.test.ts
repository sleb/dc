import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { Table } from "./support/drive";
import { clear, db, run } from "./support/harness";
import { registryQuery, sentinelHits, snapshot } from "./support/inspect";
import { pid } from "./support/ids";

// I9 Outbox (LLD 3 section 8, ST10).
beforeAll(clear);

test("I9 startGame, a round, a pass, pause and unpause, a reminder and a removal give the expected rows; ids, context and the identity redrive hold", async () => {
  const t = await Table.lobby(3);
  await t.host({ type: "startGame" } as Command);
  await t.writeAll();
  await t.playRound();
  await t.host({ type: "passJudging", expectedVersion: (await t.state()).round?.changedAtVersion } as Command);
  await t.as(2, { type: "leave" } as Command); // below the minimum: paused
  await t.join(3);
  await t.as(3, { type: "saveDraft", ...(await t.fullDraft(3)) } as Command);
  await t.as(3, { type: "finishWriting" } as Command); // unpaused
  const g = await t.state();
  await run({ gameId: t.gameId, actor: { kind: "system" }, cmd: { type: "markReminded", episode: g.episode, episodeGen: g.episodeGen } as Command, idemKey: `remind:${g.episode}:${g.reminderDueAt}`, now: g.reminderDueAt ?? 0 });
  await t.host({ type: "removePlayer", playerId: pid(1) } as Command);

  const rows = (await db.collection(`games/${t.gameId}/outbox`).get()).docs;
  const byType = (type: string) => rows.filter((d) => (d.get("event") as { t: string }).t === type);
  for (const d of rows) {
    expect(d.get("id")).toBe(d.id);
    expect(d.id).toBe(`v${d.get("version") as number}_${d.get("i") as number}`);
    expect(d.get("processedAt")).toBeNull();
  }
  for (const type of ["WritingStarted", "RoundOpened", "SubmissionsClosed", "WinnerPicked", "JudgeChanged", "PausedChanged", "Reminder", "PlayerLeft", "PlayerRemoved"]) expect(byType(type).length).toBeGreaterThan(0);
  const ws = byType("WritingStarted")[0];
  expect(ws?.get("round")).toBeUndefined();
  expect(ws?.get("topic")).toBe("notify");
  for (const d of byType("RoundOpened")) expect((d.get("round") as { phase: string }).phase).toBe("SUBMITTING");
  for (const d of byType("WinnerPicked")) expect(d.get("round")).toBeDefined();
  expect(byType("PausedChanged").some((d) => (d.get("event") as { paused: boolean }).paused)).toBe(true);
  expect(byType("PausedChanged").some((d) => !(d.get("event") as { paused: boolean }).paused)).toBe(true);
  for (const d of [...byType("PlayerLeft"), ...byType("PlayerRemoved")]) {
    expect(d.get("topic")).toBe("identity");
    expect(d.data()["notifDoneAt"]).toBeNull();
  }
  for (const d of rows.filter((x) => x.get("topic") === "notify")) expect(Object.hasOwn(d.data(), "notifDoneAt")).toBe(false);

  // Post-state context of the last command's rows equals the stored aggregate (which that command produced).
  const end = await t.state();
  const last = rows.filter((d) => d.get("version") === end.version);
  expect(last.length).toBeGreaterThan(0);
  for (const d of last) {
    expect(d.get("roster")).toEqual(end.players.filter((p) => p.status === "writing" || p.status === "ready" || p.status === "active").map((p) => ({ playerId: p.id, uid: p.uid, status: p.status })));
    expect(d.get("paused")).toBe(end.paused);
    expect(d.get("waitingOn")).toEqual(end.waitingOn);
    expect(d.get("judgeId")).toBe(end.round?.judgeId ?? null);
  }

  // The identity push-cleanup redrive (3.1's registry query) selects the PlayerRemoved row even after processedAt is set.
  const removed = byType("PlayerRemoved")[0];
  if (removed === undefined) throw new Error("no PlayerRemoved row");
  await removed.ref.update({ processedAt: Date.now() });
  const selected = (await registryQuery(db, "identityCleanup", { values: { at: (removed.get("at") as number) + 1 } }).get()).docs.map((d) => d.ref.path);
  expect(selected).toContain(removed.ref.path);

  expect(sentinelHits(await snapshot(t.gameId), (p) => p.includes("/outbox/") || p.includes("/events/") || p.includes("/idem/"))).toEqual([]);
}, 300_000);
