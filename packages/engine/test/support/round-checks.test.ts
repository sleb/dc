// #22: the checker hardening (H1) and the new round checkers (E5 to E15) tested against deliberately broken results: a checker that cannot fail proves nothing.
import { describe, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { decide } from "../../src/decide";
import { makeRng } from "../../src/rng";
import type { Accepted, Draft, Game } from "../../src/types";
import { checkAggregateChanged, checkConservation, checkFinished, checkJudges, checkNoAuthorship, checkOwnerHidden, checkPlayable, checkRevealOrder, checkRoundMoves, checkScoring, checkTopUp, checkers } from "./checks";
import type { Step } from "./checks";
import { GAME_ID, HOST_UID, cid, counterMintId, ctxFor, makeGame, makePlayer, pid, seatUidOf, userActor } from "./factories";
import { roundGame } from "./round-fixtures";

const seat = (n: number) => userActor(n === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(n)));
const cmd = (c: object): Command => c as unknown as Command;

/** A real accepted step of `c` by player `who` on `g`. */
function stepOf(g: Game, c: object, who: number, drafts: Record<string, Draft> = {}): Step & { value: Accepted } {
  const ctx = ctxFor({ actor: seat(who), drafts, rng: makeRng("chk"), mintId: counterMintId(50_000) });
  const result = decide(g, cmd(c), ctx);
  if (!result.ok) throw new Error(`rejected ${JSON.stringify(result.error)}`);
  return { index: 0, before: g, cmd: c, result, actor: ctx.actor, drafts, value: result.value };
}
const withValue = (s: Step & { value: Accepted }, patch: Partial<Accepted>): Step => ({ ...s, result: { ok: true, value: { ...s.value, ...patch } } });

/** Three writers with a 2 red + 1 green target; p1 has a saved draft of the given texts and the others are still writing. */
const writing = (): Game => makeGame({
  phase: "WRITING", version: 3, target: 1, writeCounts: { red: 2, green: 1 },
  players: [0, 1, 2].map((i) => makePlayer(i, { status: "writing", writeTarget: { red: 2, green: 1 }, writeProgress: { red: 0, green: 0 } })),
});
const finish = (texts: Draft): Step & { value: Accepted } => stepOf(writing(), { type: "finishWriting" }, 1, { [pid(1)]: texts });

describe("H1 the checkers fail rather than pass vacuously", () => {
  test("a finishWriting step without the drafts is rejected by checkConservation and checkNoAuthorship", () => {
    const s = finish({ red: ["r1", "r2"], green: ["g1"] });
    expect(() => checkConservation(s)).not.toThrow();
    expect(() => checkNoAuthorship(s)).not.toThrow();
    const { drafts: _d, ...bare } = s;
    expect(() => checkConservation(bare)).toThrow(/drafts/);
    expect(() => checkNoAuthorship(bare)).toThrow(/drafts/);
  });

  test("a saveDraft step without the actor is rejected by checkAggregateChanged", () => {
    const s = stepOf(writing(), { type: "saveDraft", red: ["a", "b"], green: ["c"] }, 1);
    expect(() => checkAggregateChanged(s)).not.toThrow();
    const { actor: _a, ...bare } = s;
    expect(() => checkAggregateChanged(bare)).toThrow(/actor/);
  });

  test("checkNoAuthorship matches whole draft texts: a one-letter draft is not found inside event names, an event that is exactly the text is", () => {
    const s = finish({ red: ["a", "e"], green: ["P"] }); // 'a', 'e' and 'P' are all substrings of "PlayerFinishedWriting"
    expect(() => checkNoAuthorship(s)).not.toThrow();
    const leaked = withValue(s, { events: [...s.value.events, { t: "PlayerJoined", playerId: "a" }] });
    expect(() => checkNoAuthorship(leaked)).toThrow(/draft text/);
  });

  test("the hardened checkers are still in the append-only list", () => {
    for (const c of [checkConservation, checkNoAuthorship, checkAggregateChanged]) expect(checkers).toContain(c);
  });
});

describe("the new round checkers each fail on a broken result", () => {
  const sub = roundGame({ judge: 1, submitted: [0, 2] }); // p3 is the last one out
  const confirm = (): Step & { value: Accepted } => stepOf(sub, { type: "confirmSubmission", cardId: cid(300), expectedVersion: 5 }, 3);
  const judging = roundGame({ judge: 1, submitted: [2, 3], phase: "JUDGING" });
  const picked = (): Step & { value: Accepted } => stepOf(judging, { type: "pickWinner", submissionId: cid(206), expectedVersion: 5 }, 1);

  test("the genuine steps pass every checker", () => {
    for (const s of [confirm(), picked(), stepOf(sub, { type: "closeSubmissions", expectedVersion: 5 }, 1)]) {
      for (const c of checkers) expect(() => c(s)).not.toThrow();
    }
  });

  test("E9 checkOwnerHidden: an event before WinnerPicked that carries a submitted card id fails; a card id after WinnerPicked is allowed", () => {
    const s = confirm();
    expect(() => checkOwnerHidden(withValue(s, { events: [{ t: "SubmissionConfirmed", round: 1, playerId: pid(3), cardId: cid(300) } as never] }))).toThrow(/mentions the submitted card/);
    const p = picked();
    expect(() => checkOwnerHidden(p)).not.toThrow();
    expect(() => checkOwnerHidden(withValue(p, { events: [{ t: "RoundVoided", round: 1, reason: "no_submissions", cardId: cid(206) } as never, ...p.value.events] }))).toThrow();
  });

  test("E10 checkRevealOrder: a JUDGING round without a revealOrder, with the wrong set, or changed after the close fails", () => {
    const closed = stepOf(sub, { type: "closeSubmissions", expectedVersion: 5 }, 1);
    const round = closed.value.state.round as NonNullable<Game["round"]>;
    expect(() => checkRevealOrder(withValue(closed, { state: { ...closed.value.state, round: { ...round, revealOrder: null } } }))).toThrow(/no revealOrder/);
    expect(() => checkRevealOrder(withValue(closed, { state: { ...closed.value.state, round: { ...round, revealOrder: [cid(6)] } } }))).toThrow(/card set/);
    const again = { ...closed, before: closed.value.state, result: { ok: true as const, value: { ...closed.value, state: { ...closed.value.state, round: { ...round, revealOrder: [...(round.revealOrder ?? [])].reverse() } } } } };
    expect(() => checkRevealOrder(again)).toThrow(/changed after the close/);
    expect(() => checkRevealOrder(withValue(confirm(), { state: { ...sub, round: { ...(sub.round as NonNullable<Game["round"]>), revealOrder: [cid(6)] } } }))).toThrow(/SUBMITTING round has a revealOrder/);
  });

  test("E12 checkJudges: a judge who submitted, an inactive judge, and a wrong rotation fail", () => {
    const p = picked();
    const after = p.value.state;
    const round = after.round as NonNullable<Game["round"]>;
    expect(() => checkJudges(withValue(p, { state: { ...after, round: { ...round, submissions: [{ playerId: round.judgeId as string, cardId: cid(1) }] } } }))).toThrow(/judge has a submission/);
    expect(() => checkJudges(withValue(p, { state: { ...after, players: after.players.map((q) => (q.id === round.judgeId ? { ...q, status: "left" as const } : q)) } }))).toThrow(/no active judge/);
    expect(() => checkJudges(withValue(p, { state: { ...after, round: { ...round, judgeId: pid(3) } } }))).toThrow(/rotation says/);
  });

  test("E5 and E13 checkRoundMoves: a confirm that moves another player's card, a pick that scores the wrong player, a close that moves a card all fail", () => {
    const c = confirm();
    const after = c.value.state;
    expect(() => checkRoundMoves(withValue(c, { state: { ...after, players: after.players.map((q) => (q.id === pid(2) ? { ...q, hand: q.hand.slice(1) } : q)) } }))).toThrow(/hand changed unexpectedly/);
    const p = picked();
    expect(() => checkRoundMoves(withValue(p, { state: { ...p.value.state, players: p.value.state.players.map((q) => (q.id === pid(2) ? { ...q, scorePile: [] } : q)) } }))).toThrow(/score pile is wrong/);
    const close = stepOf(sub, { type: "closeSubmissions", expectedVersion: 5 }, 1);
    expect(() => checkRoundMoves(withValue(close, { state: { ...close.value.state, pools: { ...close.value.state.pools, redDeck: [] } } }))).toThrow(/a close moved a card/);
  });

  test("E6 checkTopUp: a short hand after a pick fails", () => {
    const p = picked();
    expect(() => checkTopUp(withValue(p, { state: { ...p.value.state, players: p.value.state.players.map((q, i) => (i === 2 ? { ...q, hand: q.hand.slice(1) } : q)) } }))).toThrow(/after a resolve/);
  });

  test("E7 checkPlayable: PLAYING below the minimums or with an empty green deck fails", () => {
    const p = picked();
    expect(() => checkPlayable(withValue(p, { state: { ...p.value.state, pools: { ...p.value.state.pools, greenDeck: [] } } }))).toThrow(/empty green deck/);
    const [firstRed] = Object.keys(p.value.state.cards);
    const cards = Object.fromEntries(Object.entries(p.value.state.cards).filter(([k]) => k !== firstRed));
    expect(() => checkPlayable(withValue(p, { state: { ...p.value.state, cards } }))).toThrow(/minimums/);
  });

  test("E14 checkScoring: a point without history, two winners, and the judge winning fail", () => {
    const p = picked();
    expect(() => checkScoring(withValue(p, { state: { ...p.value.state, history: [] } }))).toThrow(/history grew/);
    const winner = p.value.events[0] as Extract<Accepted["events"][number], { t: "WinnerPicked" }>;
    expect(() => checkScoring(withValue(p, { events: [winner, winner] }))).toThrow(/two WinnerPicked/);
    expect(() => checkScoring(withValue(p, { events: [{ ...winner, winnerId: winner.judgeId }] }))).toThrow(/the judge won/);
    expect(() => checkScoring(withValue(p, { state: { ...p.value.state, players: p.value.state.players.map((q) => (q.id === pid(2) ? { ...q, scorePile: [] } : q)) } }))).toThrow(/score piles hold/);
  });

  test("E15 checkFinished: FINISHED with a round, a round opened in FINISHED, and an accepted command in a finished game fail", () => {
    const fin = stepOf(roundGame({ judge: 1, submitted: [2, 3], phase: "JUDGING", target: 1 }), { type: "pickWinner", submissionId: cid(206), expectedVersion: 5 }, 1);
    expect(fin.value.state.phase).toBe("FINISHED");
    expect(() => checkFinished(fin)).not.toThrow();
    expect(() => checkFinished(withValue(fin, { state: { ...fin.value.state, round: judging.round } }))).toThrow(/FINISHED with a round/);
    expect(() => checkFinished(withValue(fin, { events: [...fin.value.events, { t: "RoundOpened", round: 9, judgeId: pid(1), greenCardId: cid(1), expected: [] }] }))).toThrow(/a round opened/);
    expect(() => checkFinished({ ...fin, before: fin.value.state, cmd: { type: "updateSettings" } })).toThrow(/accepted in FINISHED/);
    expect(() => checkFinished({ ...fin, before: fin.value.state, cmd: { type: "endGame" } })).not.toThrow();
  });
});
