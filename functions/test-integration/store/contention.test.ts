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
const attemptsSeen: number[] = [];

function check(results: RunResult[]): number {
  for (const r of results) {
    expect(["accepted", "rejected"]).toContain(r.outcome.kind);
    attemptsSeen.push(r.attempts);
  }
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
    ...g.players.filter((p) => p.status === "active" && p.id !== r.judgeId).map((p) => ({ actor: { kind: "user" as const, uid: p.uid }, cmd: { type: "confirmSubmission", cardId: p.hand[0], expectedVersion: r.changedAtVersion } as Command })),
    ...Array.from({ length: 5 }, (_, k) => ({ actor: host, cmd: { type: "updateSettings", patch: { profanity: k % 2 === 0 ? "off" : "on" } } as Command })),
    ...Array.from({ length: 3 }, () => ({ actor: { kind: "user" as const, uid: judge?.uid ?? "" }, cmd: { type: "closeSubmissions", expectedVersion: r.changedAtVersion } as Command })),
    ...Array.from({ length: 3 }, () => ({ actor: host, cmd: { type: "passJudging", expectedVersion: r.changedAtVersion } as Command })),
  ];
  expect(reqs).toHaveLength(20);
  const results = await Promise.all(reqs.map((q) => run({ gameId: g.id, actor: q.actor, cmd: q.cmd, idemKey: newKey() })));
  const accepted = check(results);
  expect(accepted).toBeGreaterThan(5);
  await invariants(t, g.version, accepted);
}, 300_000);

test("I1 the retry path ran under natural contention (attempts > 1 at least once; txn.retry)", () => {
  // Phase 0 found the Firestore emulator aborts contending transactions, so this is natural contention, not fault injection (I4 forces ABORTED separately).
  expect(attemptsSeen.length).toBe(29);
  expect(Math.max(...attemptsSeen)).toBeGreaterThan(1);
});
