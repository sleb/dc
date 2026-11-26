// The outbox (LLD 3 section 8): one row per qualifying event of a committed command, self-contained, ids only (N2).
import type { Command } from "@dc/contracts";
import type { Accepted, Game } from "@dc/engine";
import { Timestamp } from "firebase-admin/firestore";
import { StoreError } from "./errors";
import type { OutboxRow } from "./types";

export const NOTIFY_EVENTS: ReadonlySet<string> = new Set(["WritingStarted", "RoundOpened", "SubmissionsClosed", "WinnerPicked", "GameFinished", "GameEnded", "JudgeChanged", "PausedChanged"]);
export const IDENTITY_EVENTS: ReadonlySet<string> = new Set(["PlayerLeft", "PlayerRemoved"]);
export const OUTBOX_TTL_MS = 14 * 86_400_000;

type Context = Pick<OutboxRow, "gameId" | "version" | "at" | "roster" | "judgeId" | "paused" | "round" | "waitingOn" | "processedAt" | "expiresAt">;

function contextOf(next: Game, now: number): Context {
  const r = next.round;
  return {
    gameId: next.id,
    version: next.version,
    at: now,
    roster: next.players.filter((p) => p.status === "writing" || p.status === "ready" || p.status === "active").map((p) => ({ playerId: p.id, uid: p.uid, status: p.status })),
    judgeId: r?.judgeId ?? null,
    paused: next.paused,
    ...(next.phase === "PLAYING" && r !== null ? { round: { number: r.number, phase: r.phase } } : {}),
    waitingOn: [...next.waitingOn],
    processedAt: null,
    expiresAt: Timestamp.fromMillis(now + OUTBOX_TTL_MS),
  };
}

/** Pure. `cmd` and `a.aggregateChanged` tell it a reminder was consumed (the Reminder row, section 7); events come from `a.events`. */
export function buildOutbox(prev: Game, next: Game, cmd: Command, a: Accepted, now: number): OutboxRow[] {
  if (!a.aggregateChanged) return [];
  const ctx = contextOf(next, now);
  const rows: OutboxRow[] = [];
  for (const [i, event] of a.events.entries()) {
    const id = `v${next.version}_${i}`;
    if (NOTIFY_EVENTS.has(event.t)) rows.push({ id, i, topic: "notify", event, ...ctx });
    else if (IDENTITY_EVENTS.has(event.t)) rows.push({ id, i, topic: "identity", event, ...ctx, notifDoneAt: null });
  }
  if (cmd.type === "markReminded") {
    if (prev.episode === null || prev.reminderDueAt === null) throw new StoreError("INVARIANT", "markReminded accepted without an episode or a due time");
    if (rows.some((r) => r.i === 0)) throw new StoreError("INVARIANT", "markReminded produced a qualifying event at index 0");
    rows.unshift({ id: `v${next.version}_0`, i: 0, topic: "notify", event: { t: "Reminder", episode: prev.episode, episodeGen: prev.episodeGen, dueAt: prev.reminderDueAt, waitingOn: [...next.waitingOn] }, ...ctx });
  }
  return rows;
}
