import { expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { eventDoc } from "./events";
import { MemGame } from "./test-support";
import type { MemStep } from "./test-support";

// U4 (LLD 3 section 9, ST15, E8).
const m = MemGame.create().joinAll(3);
const start = m.start() as MemStep;
const p1 = m.game.players[1];
if (p1 === undefined) throw new Error("p1");
m.run({ kind: "user", uid: p1.uid }, { type: "saveDraft", ...m.fullDraft(p1.id) } as Command);
const finish = m.run({ kind: "user", uid: p1.uid }, { type: "finishWriting" } as Command) as MemStep;

test("U4 one doc per version with the command type, the time and the events", () => {
  const d = eventDoc(start.next.version, start.now, start.accepted, start.cmd, start.seed, "p_aaaaaaaa");
  expect(d).toEqual({ version: start.next.version, at: start.now, commandType: "startGame", events: start.accepted.events, seed: start.seed, actorPlayerId: "p_aaaaaaaa" });
});

test("U4 events: [] is allowed", () => {
  const d = eventDoc(9, 5, { ...start.accepted, events: [] }, { type: "markReminded", episode: "e", episodeGen: 0 } as Command, "s", null);
  expect(d.events).toEqual([]);
  expect(Object.hasOwn(d, "actorPlayerId")).toBe(false);
});

test("U4 with redactEnvelope (finishWriting) the doc has no seed and no actorPlayerId", () => {
  expect(finish.accepted.redactEnvelope).toBe(true);
  const d = eventDoc(finish.next.version, finish.now, finish.accepted, finish.cmd, finish.seed, p1.id);
  expect(Object.hasOwn(d, "seed")).toBe(false);
  expect(Object.hasOwn(d, "actorPlayerId")).toBe(false);
  expect(d.commandType).toBe("finishWriting");
});

test("U4 a writeIn is recorded as confirmSubmission (K-A)", () => {
  const d = eventDoc(3, 1, { ...finish.accepted }, { type: "writeIn", text: "x" } as Command, "s", p1.id);
  expect(d.commandType).toBe("confirmSubmission");
  expect(Object.hasOwn(d, "seed")).toBe(false);
});

test("U4 the doc holds no card text (sentinel scan)", () => {
  expect(JSON.stringify([eventDoc(finish.next.version, finish.now, finish.accepted, finish.cmd, finish.seed, p1.id)])).not.toContain("SENTINEL");
});
