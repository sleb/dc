import { describe, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { IDENTITY_EVENTS, NOTIFY_EVENTS, buildOutbox } from "./outbox";
import { MemGame, pid } from "./test-support";
import type { MemStep } from "./test-support";

// U3 (LLD 3 section 8, ST10), over traces driven through the real `decide`.
const DAY = 86_400_000;
const rowsOf = (s: MemStep) => buildOutbox(s.prev, s.next, s.cmd, s.accepted, s.now);

/** A 3-player game: start, write, a full round, a pass, a leave (pause), a join and its writing (unpause), a reminder, a removal. */
function trace(): { m: MemGame; remind: MemStep; noop: MemStep | null } {
  const m = MemGame.playing(3);
  m.playRound();
  const r = m.game.round;
  if (r === null) throw new Error("no round");
  m.host({ type: "passJudging", expectedVersion: r.changedAtVersion } as Command);
  m.as(2, { type: "leave" } as Command);
  m.join(3);
  m.as(3, { type: "saveDraft", ...m.fullDraft(pid(3)) } as Command);
  m.as(3, { type: "finishWriting" } as Command);
  const due = m.game.reminderDueAt ?? 0;
  const ep = { episode: m.game.episode ?? "", episodeGen: m.game.episodeGen };
  const remind = m.run({ kind: "system" }, { type: "markReminded", ...ep } as Command, { now: due }) as MemStep;
  const noop = m.run({ kind: "system" }, { type: "markReminded", ...ep } as Command, { now: due + 1 });
  m.host({ type: "removePlayer", playerId: pid(1) } as Command);
  return { m, remind, noop };
}

describe("U3 buildOutbox", () => {
  const { m, remind, noop } = trace();

  test("the qualifying sets are LLD 3 section 8's", () => {
    expect([...NOTIFY_EVENTS].sort()).toEqual(["GameEnded", "GameFinished", "JudgeChanged", "PausedChanged", "RoundOpened", "SubmissionsClosed", "WinnerPicked", "WritingStarted"]);
    expect([...IDENTITY_EVENTS].sort()).toEqual(["PlayerLeft", "PlayerRemoved"]);
  });

  test("one row per qualifying event, id v{version}_{i} with i the event's index, id stored in the row", () => {
    let seen = 0;
    for (const s of m.steps) {
      if (s.cmd.type === "markReminded") continue;
      const rows = rowsOf(s);
      const want = s.accepted.events.flatMap((e, i) => (NOTIFY_EVENTS.has(e.t) || IDENTITY_EVENTS.has(e.t) ? [{ i, e }] : []));
      expect(rows.map((r) => r.i)).toEqual(want.map((w) => w.i));
      for (const [k, row] of rows.entries()) {
        expect(row.id).toBe(`v${s.next.version}_${row.i}`);
        expect(row.event).toEqual(want[k]?.e as never);
        expect(row.version).toBe(s.next.version);
        expect(row.gameId).toBe(s.next.id);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(8);
  });

  test("topics: notify for NOTIFY_EVENTS; identity for PlayerLeft and PlayerRemoved, with notifDoneAt: null; notify rows have no notifDoneAt key", () => {
    const all = m.steps.flatMap(rowsOf);
    const identity = all.filter((r) => r.topic === "identity");
    expect(identity.map((r) => r.event.t).sort()).toEqual(["PlayerLeft", "PlayerRemoved"]);
    for (const r of identity) expect(Object.hasOwn(r, "notifDoneAt") && r.notifDoneAt === null).toBe(true);
    for (const r of all.filter((x) => x.topic === "notify")) expect(Object.hasOwn(r, "notifDoneAt")).toBe(false);
    for (const r of all) expect(r.processedAt).toBeNull();
  });

  test("post-state context: roster of seated players, judgeId, paused, round only while PLAYING, waitingOn", () => {
    let checked = 0;
    for (const s of m.steps) {
      for (const r of rowsOf(s)) {
        checked++;
        const seated = s.next.players.filter((p) => p.status === "writing" || p.status === "ready" || p.status === "active");
        expect(r.roster).toEqual(seated.map((p) => ({ playerId: p.id, uid: p.uid, status: p.status })));
        expect(r.judgeId).toBe(s.next.round?.judgeId ?? null);
        expect(r.paused).toBe(s.next.paused);
        expect(r.waitingOn).toEqual(s.next.waitingOn);
        if (s.next.phase === "PLAYING" && s.next.round !== null) expect(r.round).toEqual({ number: s.next.round.number, phase: s.next.round.phase });
        else expect(Object.hasOwn(r, "round")).toBe(false);
        expect(r.at).toBe(s.now);
        expect(r.expiresAt.toMillis()).toBe(s.now + 14 * DAY);
      }
    }
    expect(checked).toBeGreaterThan(8);
  });

  test("the WritingStarted row has no round; RoundOpened carries it; a paused: true PausedChanged row exists", () => {
    const all = m.steps.flatMap(rowsOf);
    const ws = all.find((r) => r.event.t === "WritingStarted");
    expect(ws !== undefined && !Object.hasOwn(ws, "round")).toBe(true);
    expect(all.find((r) => r.event.t === "RoundOpened")?.round?.phase).toBe("SUBMITTING");
    expect(all.some((r) => r.event.t === "PausedChanged" && (r.event as { paused: boolean }).paused)).toBe(true);
    expect(all.some((r) => r.event.t === "PausedChanged" && !(r.event as { paused: boolean }).paused)).toBe(true);
  });

  test("a Reminder row only for an accepted aggregate-changing markReminded: the episode reminded, the due time consumed", () => {
    expect(remind.accepted.aggregateChanged).toBe(true);
    const rows = rowsOf(remind);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.id).toBe(`v${remind.next.version}_0`);
    expect(row?.i).toBe(0);
    expect(row?.topic).toBe("notify");
    expect(row?.event).toEqual({ t: "Reminder", episode: remind.prev.episode ?? "", episodeGen: remind.prev.episodeGen, dueAt: remind.prev.reminderDueAt ?? -1, waitingOn: remind.next.waitingOn });
    expect(noop?.accepted.aggregateChanged).toBe(false);
    if (noop !== null) expect(rowsOf(noop)).toEqual([]);
    // Any other command is never given a Reminder row.
    for (const s of m.steps.filter((x) => x.cmd.type !== "markReminded")) expect(rowsOf(s).some((r) => r.event.t === "Reminder")).toBe(false);
  });

  test("no card text or names in any row (P19 sentinels)", () => {
    expect(m.steps.flatMap(rowsOf).length).toBeGreaterThan(8);
    expect(JSON.stringify(m.steps.flatMap(rowsOf))).not.toContain("SENTINEL");
  });
});
