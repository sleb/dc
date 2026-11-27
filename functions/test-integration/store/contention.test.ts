import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { MemGame } from "../../src/store/test-support";
import { Table } from "./support/drive";
import { clear, run } from "./support/harness";
import type { RunResult } from "./support/harness";
import { eventVersions, viewProblems } from "./support/inspect";
import { newGameId, newKey } from "./support/seed";

// I1 Contention (LLD 3 section 10.3, S1, ST4, ST5). A 10-player game built in Bun and seeded at round 1 SUBMITTING, then driven only through the harness.
beforeAll(clear);

function check(results: RunResult[]): number {
  for (const r of results) expect(["accepted", "rejected"]).toContain(r.outcome.kind);
  return results.filter((r) => r.outcome.kind === "accepted" && !r.outcome.replay).length;
}

async function invariants(t: Table, start: number, accepted: number): Promise<void> {
  const g = await t.state();
  expect(g.version).toBe(start + accepted);
  const versions = (await eventVersions(t.gameId)).filter((v) => v > start);
  expect(versions).toEqual(Array.from({ length: accepted }, (_, k) => start + 1 + k)); // one events doc per version, no gaps or repeats
  expect(await viewProblems(t.gameId)).toEqual([]); // PJ11
}

test("I1 9 parallel confirmSubmissions on a 10-player game: all accepted or typed-rejected, contiguous versions and events, views equal a full projection", async () => {
  const m = MemGame.playing(10, { gameId: newGameId() });
  const t = await Table.seed(m.game);
  const g = m.game;
  const r = g.round;
  if (r === null) throw new Error("round");
  const submitters = g.players.filter((p) => p.status === "active" && p.id !== r.judgeId);
  expect(submitters).toHaveLength(9);
  const results = await Promise.all(submitters.map((p) => run({ gameId: g.id, actor: { kind: "user", uid: p.uid }, cmd: { type: "confirmSubmission", cardId: p.hand[0], expectedVersion: r.changedAtVersion } as Command, idemKey: newKey() })));
  const accepted = check(results);
  expect(accepted).toBe(9);
  await invariants(t, g.version, accepted);
  expect((await t.state()).round?.phase).toBe("JUDGING"); // the ninth closed it allIn
  // Natural contention: the emulator aborts contending transactions, so at least one of the nine retried (txn.retry). The forced ABORTED of I4 proves the retry path separately.
  expect(Math.max(...results.map((x) => x.attempts))).toBeGreaterThan(1);
}, 300_000);

test("I1 20 parallel mixed commands from 10 actors keep every invariant", async () => {
  const m = MemGame.playing(10, { gameId: newGameId() });
  const t = await Table.seed(m.game);
  const g = m.game;
  const r = g.round;
  if (r === null) throw new Error("round");
  const host = { kind: "user", uid: g.hostId } as const;
  const judge = g.players.find((p) => p.id === r.judgeId);
  const reqs: { actor: { kind: "user"; uid: string }; cmd: Command }[] = [
    ...g.players.filter((p) => p.status === "active" && p.id !== r.judgeId).slice(0, 4).map((p) => ({ actor: { kind: "user" as const, uid: p.uid }, cmd: { type: "confirmSubmission", cardId: p.hand[0], expectedVersion: r.changedAtVersion } as Command })),
    ...Array.from({ length: 5 }, (_, k) => ({ actor: host, cmd: { type: "updateSettings", patch: { profanity: k % 2 === 0 ? "off" : "on" } } as Command })),
    ...g.players.filter((p) => p.status === "active" && p.id !== r.judgeId).slice(4).map((p) => ({ actor: { kind: "user" as const, uid: p.uid }, cmd: { type: "confirmSubmission", cardId: p.hand[0], expectedVersion: r.changedAtVersion } as Command })),
    ...Array.from({ length: 3 }, () => ({ actor: { kind: "user" as const, uid: judge?.uid ?? "" }, cmd: { type: "closeSubmissions", expectedVersion: r.changedAtVersion } as Command })),
    ...Array.from({ length: 3 }, () => ({ actor: host, cmd: { type: "passJudging", expectedVersion: r.changedAtVersion } as Command })),
  ];
  expect(reqs).toHaveLength(20);
  // Two waves of 10 in flight, not 20. The Functions emulator starts a worker per concurrent call: with 20 in flight on the 3.8 GiB, 2-CPU dev host
  // they reached about 3 GB (21 Node processes, 21 MB free, measured) and the run also passed the 300 s harness timeout. Each wave still has 10
  // transactions contending on the one aggregate lock, and every invariant is checked on the final state. What no longer races: wave 2's
  // closeSubmissions and passJudging (and its last four confirms) against wave 1's first five confirms and its five updateSettings.
  const results: RunResult[] = [];
  for (const wave of [reqs.slice(0, 10), reqs.slice(10)]) {
    const got = await Promise.all(wave.map((q) => run({ gameId: g.id, actor: q.actor, cmd: q.cmd, idemKey: newKey() })));
    expect(Math.max(...got.map((x) => x.attempts))).toBeGreaterThan(1); // each wave contends on its own
    results.push(...got);
  }
  const accepted = check(results);
  expect(accepted).toBeGreaterThan(5);
  await invariants(t, g.version, accepted);
}, 300_000);
