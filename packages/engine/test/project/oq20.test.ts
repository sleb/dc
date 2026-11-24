// #28: LLD 1 open question 20 / LLD 2 open question 8, ruled by `Round.played`. A revealed play vanishing from a JUDGING round must not let a view diff name its author
// when the host removes the card (silent), and the signal is accepted and pinned when a public action (leave, removePlayer, passJudging) caused it.
import { describe, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { decide } from "../../src/decide";
import { project } from "../../src/project";
import type { Viewer } from "../../src/project";
import type { Accepted, Actor, Game } from "../../src/types";
import { GAME_ID, HOST_UID, cid, ctxFor, deepFreeze, pid, seatUidOf, userActor } from "../support/factories";
import { roundGame } from "../support/round-fixtures";
import { HU, P, SPEC, must } from "./fixtures";

const seat = (n: number): Actor => userActor(n === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(n)));
const ok = (g: Game, c: object, actor: Actor): Accepted => {
  const r = decide(deepFreeze(structuredClone(g)), c as unknown as Command, ctxFor({ actor }));
  if (!r.ok) throw new Error(`expected an acceptance of ${JSON.stringify(c)}, got ${JSON.stringify(r.error)}`);
  return r.value;
};
/** Six players, judge 1, plays by 2, 3 and 4 (revealOrder 4, 3, 2), player 5 and the host (0) did not play. */
const fixture = (): Game => roundGame({ n: 6, judge: 1, submitted: [2, 3, 4], phase: "JUDGING", redDeck: 30, greenDeck: 60 });
/** The fixture after one no-op command, so that the scheduler fields (`waitingOn`) are the ones settle computes, as in a real game. */
const judging = (): Game => ok(fixture(), { type: "updateSettings", patch: { profanity: "on" } }, seat(0)).state;
type Json = Record<string, unknown>;
const json = (g: Game, v: Viewer): Json => JSON.parse(JSON.stringify(project(g, v))) as Json;
const round = (j: Json): Json => j["round"] as Json;
/** The paths at which two JSON values differ, `version` ignored. */
function diff(a: unknown, b: unknown, path = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !(path === "" && k === "version"));
    return keys.flatMap((k) => diff((a as Json)[k], (b as Json)[k], `${path}.${k}`));
  }
  return [path];
}

describe("OQ20a host removeCard of a revealed play: no view diff names the author", () => {
  const before = judging();
  const removed = cid(306); // player 3's play
  const after = ok(before, { type: "removeCard", cardId: removed }, seat(0)).state;

  test("the Engine did remove the card from the reveal, and submissions no longer name player 3", () => {
    expect(must(after.round).revealOrder).toEqual([cid(406), cid(206)]);
    expect(must(after.round).submissions.map((s) => s.playerId)).toEqual([pid(2), pid(4)]);
  });
  const others: [string, Viewer][] = [["the spectator", SPEC], ["the judge", P(1)], ["a non-owner submitter", P(2)], ["a non-submitter", P(5)], ["a submitter whose card was kept", P(4)]];
  for (const [who, viewer] of others) {
    test(`${who}: the view differs in round.reveal only (plus the host's own panel, not seen here)`, () => {
      expect(diff(json(before, viewer), json(after, viewer))).toEqual([".round.reveal"]);
    });
  }
  test("submittedBy and expected still contain the removed card's author, for the spectator and the judge", () => {
    for (const v of [SPEC, P(1)]) {
      expect(round(json(after, v))["submittedBy"]).toEqual([pid(2), pid(3), pid(4)]);
      expect(round(json(after, v))["expected"]).toEqual(round(json(before, v))["expected"]);
    }
  });
  test("the reveal lost exactly the card, and the survivors keep their relative order (PJ6)", () => {
    expect((round(json(before, SPEC))["reveal"] as { submissionId: string }[]).map((c) => c.submissionId)).toEqual([cid(406), cid(306), cid(206)]);
    expect((round(json(after, SPEC))["reveal"] as { submissionId: string }[]).map((c) => c.submissionId)).toEqual([cid(406), cid(206)]);
  });
  test("the owner's own view loses yourSubmission, which is their own business; nothing else of theirs changes but the reveal", () => {
    expect(diff(json(before, P(3)), json(after, P(3))).sort()).toEqual([".round.reveal", ".you.yourSubmission"]);
  });
  test("the host's view differs in the reveal and in the registry totals of the panel only", () => {
    expect(diff(json(before, P(0)), json(after, P(0))).sort()).toEqual([".host.playability.totals.red", ".round.reveal"]);
    expect(diff(json(before, HU), json(after, HU)).sort()).toEqual([".host.playability.totals.red", ".round.reveal"]); // the same for an unseated host
  });
  test("N players played and N-1 cards are shown: the table can count, which is the accepted cost of hiding who", () => {
    const view = round(json(after, SPEC));
    expect((view["submittedBy"] as string[]).length).toBe(3);
    expect((view["reveal"] as unknown[]).length).toBe(2);
  });
});

describe("OQ20b a public action that removes a revealed play: the signal is accepted and pinned", () => {
  const before = judging();
  test("leave of a submitter: submittedBy and expected lose them, and players[] shows the departure", () => {
    const after = ok(before, { type: "leave" }, seat(3)).state;
    const s = json(after, SPEC);
    expect(round(s)["submittedBy"]).toEqual([pid(2), pid(4)]);
    expect(round(s)["expected"]).toEqual([pid(0), pid(2), pid(4), pid(5)]);
    expect((round(s)["reveal"] as unknown[]).length).toBe(2);
    expect((s["players"] as { id: string; status: string }[]).find((p) => p.id === pid(3))?.status).toBe("left");
  });
  test("removePlayer of a submitter: the same", () => {
    const after = ok(before, { type: "removePlayer", playerId: pid(4) }, seat(0)).state;
    const s = json(after, SPEC);
    expect(round(s)["submittedBy"]).toEqual([pid(2), pid(3)]);
    expect((s["players"] as { id: string; status: string }[]).find((p) => p.id === pid(4))?.status).toBe("removed");
  });
  test("passJudging to a submitter takes their play back: submittedBy loses them, the reveal loses their card, and they are the judge", () => {
    const after = ok(before, { type: "passJudging", expectedVersion: must(before.round).changedAtVersion }, seat(0)).state;
    const s = json(after, SPEC);
    expect(round(s)["judgeId"]).toBe(pid(2));
    expect(round(s)["submittedBy"]).toEqual([pid(3), pid(4)]);
    expect((round(s)["reveal"] as { submissionId: string }[]).map((c) => c.submissionId)).toEqual([cid(406), cid(306)]);
  });
  test("a judge who leaves hands over to the next submitter with the same effect", () => {
    const after = ok(before, { type: "leave" }, seat(1)).state;
    const s = json(after, SPEC);
    expect(round(s)["judgeId"]).toBe(pid(2));
    expect(round(s)["submittedBy"]).toEqual([pid(3), pid(4)]);
  });
  test("a non-submitter who leaves does not change submittedBy", () => {
    const after = ok(before, { type: "leave" }, seat(5)).state;
    expect(round(json(after, SPEC))["submittedBy"]).toEqual([pid(2), pid(3), pid(4)]);
  });
});

describe("OQ20c resolve after a removal", () => {
  test("the removed card's author is not recorded absent, and the round resolves for the survivors", () => {
    const g = judging();
    const removed = ok(g, { type: "removeCard", cardId: cid(306) }, seat(0)).state;
    const v = ok(removed, { type: "pickWinner", submissionId: cid(206), expectedVersion: must(removed.round).changedAtVersion }, seat(1));
    expect(must(v.roundRecords[0]).absent).toEqual([pid(0), pid(5)]);
    expect(must(v.roundRecords[0]).plays.map((p) => p.playerId)).toEqual([pid(4), pid(2)]);
    const next = json(v.state, SPEC);
    expect(round(next)["submittedBy"]).toEqual([]); // the next round is SUBMITTING and played is reset
    expect(next["resolved"]).toBe(1);
  });
});
