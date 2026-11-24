// #28: you.turn (LLD 2 section 4.4). Precedence: LOBBY, over, writing/ready, paused, sit_out, then judge or submission.
import { describe, expect, test } from "bun:test";
import { YOU_TURNS } from "@dc/contracts";
import type { YouTurn } from "@dc/contracts";
import { project } from "../../src/project";
import type { Game } from "../../src/types";
import { pid } from "../support/factories";
import { ended, finished, judging, lateJoiner, lobby, must, P, paused, pausedJudgingEmpty, pausedNoJudge, sitOut, submitting, writing } from "./fixtures";

const turnOf = (g: Game, i: number): YouTurn => {
  const v = project(g, P(i));
  if (v.audience !== "player") throw new Error("not a player view");
  return v.you.turn;
};
const as = (g: Game, i: number, status: Game["players"][number]["status"]): Game => ({ ...g, players: g.players.map((p, k) => (k === i ? { ...p, status } : p)) });
const withPaused = (g: Game): Game => ({ ...g, paused: true });
const hit = new Set<YouTurn>();

// [name, game, player index, expected turn]
const rows: [string, () => Game, number, YouTurn][] = [
  ["LOBBY, host", lobby, 0, "lobby"],
  ["LOBBY, player", lobby, 1, "lobby"],
  ["WRITING, still writing", writing, 0, "write"],
  ["WRITING, finished", writing, 1, "ready"],
  ["WRITING, host who has not finished", writing, 0, "write"],
  ["PLAYING, late joiner still writing", lateJoiner, 5, "write"],
  ["PLAYING, late joiner who finished (ready)", () => as(lateJoiner(), 5, "ready"), 5, "ready"],
  ["PLAYING, ready beats paused", () => withPaused(as(lateJoiner(), 5, "ready")), 5, "ready"],
  ["PLAYING, writing beats paused", () => withPaused(lateJoiner()), 5, "write"],
  ["paused, active judge", paused, 1, "paused"],
  ["paused, active non-judge", paused, 0, "paused"],
  ["paused with no judge", pausedNoJudge, 0, "paused"],
  ["paused with no judge, nobody is judge", pausedNoJudge, 1, "paused"],
  ["paused JUDGING (empty reveal), judge", pausedJudgingEmpty, 1, "paused"],
  ["paused beats sit_out", () => withPaused(sitOut()), 4, "paused"],
  ["paused beats submitted", () => withPaused(submitting()), 3, "paused"],
  ["active but not on the roster", sitOut, 4, "sit_out"],
  ["sit_out in JUDGING", () => { const g = judging(); return { ...g, round: { ...must(g.round), roster: must(g.round).roster.filter((id) => id !== pid(5)) } }; }, 5, "sit_out"],
  ["SUBMITTING, judge", submitting, 1, "wait"],
  ["SUBMITTING, non-judge who has not played", submitting, 4, "submit"],
  ["SUBMITTING, host who has not played", submitting, 0, "submit"],
  ["SUBMITTING, non-judge who played", submitting, 2, "submitted"],
  ["SUBMITTING, the first player to play", submitting, 3, "submitted"],
  ["JUDGING, judge", judging, 1, "judge"],
  ["JUDGING, non-judge who played", judging, 2, "wait"],
  ["JUDGING, non-judge who did not play", judging, 5, "wait"],
  ["FINISHED, winner", finished, 2, "over"],
  ["FINISHED, any other player", finished, 3, "over"],
  ["FINISHED beats a late joiner who is still writing", () => { const g = lateJoiner(); return { ...g, phase: "FINISHED" as const, round: null }; }, 5, "over"],
  ["ENDED, host", ended, 0, "over"],
  ["ENDED, judge of the aborted round", ended, 1, "over"],
];

describe("TN1 you.turn", () => {
  for (const [name, make, i, want] of rows) {
    test(`${name}: ${want}`, () => {
      expect(turnOf(make(), i)).toBe(want);
      hit.add(want);
    });
  }
  test("isJudge follows the round, not the turn: a paused judge is still the judge, a null judge makes nobody the judge", () => {
    const v = (g: Game, i: number) => { const x = project(g, P(i)); return x.audience === "player" ? x.you.isJudge : null; };
    expect(v(paused(), 1)).toBe(true);
    expect(v(paused(), 0)).toBe(false);
    for (let i = 0; i < 2; i++) expect(v(pausedNoJudge(), i)).toBe(false);
    expect(v(finished(), 1)).toBe(false);
  });
  test("every member of YOU_TURNS is produced by some row (a new turn must add a row)", () => {
    for (const row of rows) turnOf(row[1](), row[2]);
    expect([...new Set(rows.map((r) => r[3]))].sort()).toEqual([...YOU_TURNS].sort());
    expect(rows.length).toBeGreaterThanOrEqual(25);
  });
});
