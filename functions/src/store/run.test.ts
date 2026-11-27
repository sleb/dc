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
