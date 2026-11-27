import { expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { commandLogLines } from "./run";

// Review 4714480063 (K-A) and 4714480068 (5.8): the command log lines are built purely; this pins their fields.
const input = (type: string) => ({ gameId: "g", cmd: { type } as Command, actor: { kind: "user", uid: "u" } as const, idemKey: "k" });

test("the log lines record writeIn as confirmSubmission, like the events doc and the ledger", () => {
  const lines = commandLogLines(input("writeIn"), { outcome: "ok", version: 4, attempts: 2, latencyMs: 1 });
  expect(lines.map((l) => l.commandType)).toEqual(["confirmSubmission", "confirmSubmission"]);
  expect(lines.map((l) => l.event)).toEqual(["command.done", "txn.retry"]);
});

test("an error line carries the version when one was read", () => {
  const [line] = commandLogLines(input("startGame"), { outcome: "error", reason: "INVARIANT", version: 7, attempts: 1, latencyMs: 1 });
  expect(line).toMatchObject({ event: "command.done", outcome: "error", reason: "INVARIANT", version: 7, gameId: "g", commandType: "startGame" });
});

test("execute logs the loaded aggregate version on a failure (LLD 3 5.8; review 4714480068)", async () => {
  const { spyOn } = await import("bun:test");
  const logger = await import("firebase-functions/logger");
  const { PROJECTOR_REV } = await import("@dc/engine");
  const { MemGame } = await import("./test-support");
  const { execute } = await import("./run");
  const m = MemGame.create().joinAll(3);
  const snap = (path: string, data: unknown) => ({ exists: data !== null, data: () => data, ref: { path } });
  const tx = {
    getAll: async (...refs: { path: string }[]) => refs.map((r) => snap(r.path, r.path === `games/${m.game.id}` ? { ...m.game, store: { schema: 1, viewsRev: PROJECTOR_REV, updatedAt: 1, deleting: null } } : null)),
    create() {}, set() {}, update() {}, delete() {},
  };
  const db = { doc: (path: string) => ({ path }), runTransaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  const writes: Record<string, unknown>[] = [];
  const spy = spyOn(logger, "write").mockImplementation((e) => void writes.push(e as Record<string, unknown>));
  try {
    const deps = { clock: () => 5, newSeed: () => "s", mintId: () => "c_0000000001", faults: { fire: (p: string) => { if (p === "afterWritesBuffered") throw new Error("boom"); } } };
    await expect(execute(db as never, deps, { gameId: m.game.id, cmd: { type: "startGame" } as Command, actor: { kind: "user", uid: m.game.hostId }, idemKey: "k" })).rejects.toMatchObject({ kind: "INVARIANT" });
  } finally {
    spy.mockRestore();
  }
  expect(writes.find((w) => w["event"] === "command.done")).toMatchObject({ outcome: "error", reason: "INVARIANT", version: m.game.version, gameId: m.game.id });
});
