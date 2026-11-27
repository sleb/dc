import { describe, expect, test } from "bun:test";
import { DELETION_PAGE, DELETION_STAGES, isStuck, identityUids, newDeletionJob, stuckLine } from "./delete";
import { MemGame, pid } from "./test-support";
import type { DeletionJob } from "./types";

// U5 (LLD 3 sections 6.4, 11 ST16): the deletion job builder and the three pure pieces of the runner.
const NOW = 1_000_000;

describe("U5 newDeletionJob", () => {
  test("field set and seatUids: every non-host uid, departed players included", () => {
    const m = MemGame.create({ hostId: "host-uid" }).joinAll(4);
    const game = {
      ...m.game,
      players: m.game.players.map((p) => (p.id === pid(1) ? { ...p, status: "left" as const } : p.id === pid(2) ? { ...p, status: "removed" as const } : p)),
    };
    const callerId = "gCallerGame000000001";
    const job = newDeletionJob(callerId, game, NOW);
    expect(job).toEqual({
      gameId: callerId,
      hostId: game.hostId,
      requestedAt: NOW,
      status: "running",
      stagesDone: [],
      seatUids: game.players.map((p) => p.uid).filter((u) => u !== game.hostId),
      heartbeatAt: NOW,
      attempts: 0,
    });
    expect(job.seatUids).toContain(m.uidOf(1));
    expect(job.seatUids).not.toContain(game.hostId);
    expect(job.gameId).not.toBe(game.id); // the caller id, not the stored aggregate id
  });
});

describe("U5 DELETION_STAGES", () => {
  test("hostIdem runs before history; the aggregate stays last", () => {
    expect([...DELETION_STAGES]).toEqual(["views", "drafts", "identity", "push", "joinIdem", "hostIdem", "history", "aggregate"]);
  });
});

describe("U5 DELETION_PAGE", () => {
  test("one page of deletes stays within Firestore's 500-write commit limit", () => {
    // The emulator accepts an oversized batch, so the bound is asserted here rather than observed by the integration suite.
    expect(DELETION_PAGE).toBeGreaterThan(0);
    expect(DELETION_PAGE).toBeLessThanOrEqual(500);
  });
});

describe("U5 isStuck", () => {
  const job = (heartbeatAt: number): DeletionJob =>
    ({ gameId: "gameaaaaaaaaaaaaaaaa", hostId: "host-uid", requestedAt: 0, status: "running", stagesDone: [], seatUids: [], heartbeatAt, attempts: 1 });

  test("false at exactly one hour, true above it, false when done", () => {
    expect(isStuck(job(NOW - 3_600_000), NOW)).toBe(false);
    expect(isStuck(job(NOW - 3_600_001), NOW)).toBe(true);
    expect(isStuck({ ...job(NOW - 7_200_000), status: "done" }, NOW)).toBe(false);
  });
});

describe("U5 identityUids", () => {
  test("the union of job.seatUids and the seats/* uids, minus the host", () => {
    const job = { gameId: "g", hostId: "host", requestedAt: 0, status: "running" as const, stagesDone: [], seatUids: ["u1", "u2"], heartbeatAt: 0, attempts: 0 };
    expect(identityUids(job, ["u2", "u3", "host"])).toEqual(["u1", "u2", "u3"]);
    expect(identityUids(job, [])).toEqual(["u1", "u2"]);
  });
});

describe("U5 stuckLine", () => {
  test("the line names the game and nothing else", () => {
    expect(stuckLine("gameaaaaaaaaaaaaaaaa")).toEqual({ event: "deletion.stuck", gameId: "gameaaaaaaaaaaaaaaaa" });
  });
});
