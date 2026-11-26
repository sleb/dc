// #28 ruling 1 (LLD 1 open question 20): `Round.played`, the public trace of who played this round. Snapshotted by closeRound, pruned by eviction and reassignJudge, never by removeCard,
// and the source of `absent` at resolve. The Projector (test/project/oq20.test.ts) is its reader.
import { describe, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { decide } from "../src/decide";
import * as rounds from "../src/rules/rounds";
import type { Accepted, Actor, Ctx, Game } from "../src/types";
import { GAME_ID, HOST_UID, cid, ctxFor, deepFreeze, pid, scriptedRng, seatUidOf, userActor } from "./support/factories";
import { assertProperty } from "./support/fc";
import { enumerators } from "./support/legal";
import { membershipDriver, runScenario } from "./support/scenario";
import type { Picks } from "./support/scenario";
import { roundGame } from "./support/round-fixtures";
import fc from "fast-check";
import { buildGame } from "./support/scenario";

const cmd = (c: object): Command => c as unknown as Command;
const seat = (n: number): Actor => userActor(n === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(n)));
const ok = (g: Game, c: object, actor: Actor, ctx: Partial<Ctx> = {}): Accepted => {
  const r = decide(deepFreeze(structuredClone(g)), cmd(c), ctxFor({ actor, ...ctx }));
  if (!r.ok) throw new Error(`expected an acceptance of ${JSON.stringify(c)}, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const played = (g: Game): string[] => g.round?.played ?? [];

describe("P1 closeRound snapshots the authors; SUBMITTING holds none", () => {
  test("a round opened by the Engine has played = []; confirming a card does not touch it", () => {
    const g = roundGame({ n: 4, judge: 1, submitted: [2] });
    expect(played(g)).toEqual([]);
    const v = ok(g, { type: "confirmSubmission", cardId: cid(300) , expectedVersion: g.round?.changedAtVersion }, seat(3));
    expect(played(v.state)).toEqual([]);
  });

  test("closeRound sets played to the submitters in submission order, once", () => {
    const g = roundGame({ n: 5, judge: 1, submitted: [3, 2, 4] });
    const closed = rounds.closeRound(g, scriptedRng([0, 0, 0]), "closed").state;
    expect(played(closed)).toEqual([pid(3), pid(2), pid(4)]);
  });
});

describe("P2 which paths prune played", () => {
  const judging = (): Game => roundGame({ n: 5, judge: 1, submitted: [2, 3, 4], phase: "JUDGING", greenDeck: 60 });

  test("removeCard of a revealed play leaves played untouched while submissions and revealOrder lose the card", () => {
    const g = judging();
    const v = ok(g, { type: "removeCard", cardId: cid(306) }, seat(0));
    expect(v.state.round?.submissions.map((s) => s.playerId)).toEqual([pid(2), pid(4)]);
    expect(v.state.round?.revealOrder).toEqual([cid(406), cid(206)]);
    expect(played(v.state)).toEqual([pid(2), pid(3), pid(4)]);
  });

  test("a submitter who leaves or is removed drops out of played", () => {
    const g = judging();
    expect(played(ok(g, { type: "leave" }, seat(3)).state)).toEqual([pid(2), pid(4)]);
    expect(played(ok(g, { type: "removePlayer", playerId: pid(4) }, seat(0)).state)).toEqual([pid(2), pid(3)]);
  });

  test("a non-submitter who leaves changes nothing in played", () => {
    expect(played(ok(judging(), { type: "leave" }, seat(0)).state)).toEqual([pid(2), pid(3), pid(4)]);
  });

  test("passJudging to a submitter takes their play back and drops them from played", () => {
    const g = judging();
    const v = ok(g, { type: "passJudging", expectedVersion: g.round?.changedAtVersion }, seat(0));
    expect(v.state.round?.judgeId).toBe(pid(2));
    expect(played(v.state)).toEqual([pid(3), pid(4)]);
  });

  test("the judge leaving in JUDGING hands over to the next submitter, who leaves played", () => {
    const g = judging();
    const v = ok(g, { type: "leave" }, seat(1));
    expect(v.state.round?.judgeId).toBe(pid(2));
    expect(played(v.state)).toEqual([pid(3), pid(4)]);
  });
});

describe("P3 resolveRound computes absent from played (OQ20c)", () => {
  const g = (): Game => roundGame({ n: 5, judge: 1, submitted: [2, 3, 4], phase: "JUDGING", greenDeck: 60 });
  const pick = (id: string, v: number) => ({ type: "pickWinner", submissionId: id, expectedVersion: v });

  test("everyone who played is not absent, even when their card was removed by the host", () => {
    const base = g();
    const removed = ok(base, { type: "removeCard", cardId: cid(306) }, seat(0)).state;
    const v = ok(removed, pick(cid(206), removed.round?.changedAtVersion ?? 0), seat(1));
    expect(v.roundRecords[0]?.absent).toEqual([pid(0)]);
    expect(v.roundRecords[0]?.plays.map((p) => p.playerId)).toEqual([pid(4), pid(2)]);
  });

  test("a submitter who left before the pick is absent, as before", () => {
    const left = ok(g(), { type: "leave" }, seat(3)).state;
    const v = ok(left, pick(cid(206), left.round?.changedAtVersion ?? 0), seat(1));
    expect(v.roundRecords[0]?.absent).toEqual([pid(0), pid(3)]);
  });

  test("with no removal, absent is the roster minus the judge minus the players who played", () => {
    const base = g();
    const v = ok(base, pick(cid(206), base.round?.changedAtVersion ?? 0), seat(1));
    expect(v.roundRecords[0]?.absent).toEqual([pid(0)]);
  });
});

describe("P4 invariants over whole churned games", () => {
  const placeholders: Picks = Array.from({ length: 400 }, () => ({ kind: "legal" as const, pick: 0 }));
  test("SUBMITTING holds an empty played; JUDGING holds a superset of the surviving submitters and only seated or judging-time authors", () => {
    let judgingSeen = 0;
    assertProperty(fc.property(fc.integer({ min: 3, max: 7 }), fc.integer(), (n, seed) => {
      const lobby = buildGame({ n: 1, phase: "LOBBY", ready: [], handSize: 0, judge: 0, submitted: [], paused: false });
      const trace = runScenario(decide, lobby, placeholders, { seed, table: enumerators, drive: membershipDriver(`${seed}`, n, enumerators) });
      for (const s of trace.states) {
        const r = s?.round;
        if (r === null || r === undefined) continue;
        if (r.phase === "SUBMITTING") expect(r.played).toEqual([]);
        else {
          judgingSeen++;
          for (const sub of r.submissions) expect(r.played).toContain(sub.playerId);
          expect(new Set(r.played).size).toBe(r.played.length);
        }
      }
    }), { ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? "8" });
    expect(judgingSeen).toBeGreaterThan(0);
  });
});
