// #28: what each viewer sees, field by field, from the tables of LLD 2 sections 5.1 to 5.3 (RD1 to RD6). Written from the tables, not from the output.
import { describe, expect, test } from "bun:test";
import type { GameView } from "@dc/contracts";
import { project, viewersOf } from "../../src/project";
import type { Game } from "../../src/types";
import { HOST_UID, cid, pid } from "../support/factories";
import { roundGame } from "../support/round-fixtures";
import { ended, finished, judging, lateJoiner, lobby, must, P, HU, SPEC, paused, pausedJudgingEmpty, pausedNoJudge, settings, sitOut, submitting, unseatHost, uidOf, writing, FIXTURES } from "./fixtures";

type Live = Extract<GameView, { kind: "live" }>;
type Player = Extract<GameView, { audience: "player" }>;
const live = (v: GameView): Live => { if (v.kind !== "live") throw new Error("departed"); return v; };
const player = (g: Game, i: number): Player => { const v = project(g, P(i)); if (v.audience !== "player") throw new Error("not a player view"); return v; };
const spec = (g: Game): Live => live(project(g, SPEC));
const roundOf = (v: Live) => must(v.round);

describe("RD1 the shared part is the same for every viewer", () => {
  const strip = (v: GameView): unknown => { const { audience: _a, ...rest } = v as Record<string, unknown> & { audience: string }; const { you: _y, host: _h, ...shared } = rest; return shared; };
  for (const [name, make] of Object.entries(FIXTURES)) {
    test(`${name}: every non-departed viewer's shared fields are equal`, () => {
      const g = make();
      const all = [...viewersOf(g), ...viewersOf(unseatHost(g))].map((t) => t.viewer).filter((v) => v.kind !== "departed");
      const first = JSON.stringify(strip(project(g, SPEC)));
      for (const v of viewersOf(g).map((t) => t.viewer).filter((x) => x.kind !== "departed")) expect(JSON.stringify(strip(project(g, v))), `${name} ${JSON.stringify(v)}`).toBe(first);
      expect(all.length).toBeGreaterThan(2);
    });
    test(`${name}: PJ8 spot check, the spectator JSON is a subset of every seated player's, and of the unseated host's`, () => {
      const g = make();
      const s = project(g, SPEC) as unknown as Record<string, unknown>;
      for (const t of viewersOf(g)) {
        if (t.viewer.kind !== "player") continue;
        const p = project(g, t.viewer) as unknown as Record<string, unknown>;
        for (const [k, val] of Object.entries(s)) if (k !== "audience") expect(JSON.stringify(p[k]), `${name} ${k}`).toBe(JSON.stringify(val));
      }
    });
  }
});

describe("RD2 players[]", () => {
  test("each entry carries exactly id, name, joinOrder, status, isHost, score, cardsLeft: no uid, no hand, no pile, no write progress", () => {
    for (const p of live(project(submitting(), SPEC)).players) expect(Object.keys(p).sort()).toEqual(["cardsLeft", "id", "isHost", "joinOrder", "name", "score", "status"]);
  });
  test("isHost is true for the host's seat only, and is derived without exposing the uid", () => {
    const players = spec(submitting()).players;
    expect(players.map((p) => p.isHost)).toEqual([true, false, false, false, false]);
    expect(JSON.stringify(project(submitting(), SPEC))).not.toContain(HOST_UID);
    expect(JSON.stringify(project(submitting(), SPEC))).not.toContain("seat:");
  });
  test("ordered by joinOrder ascending even when the stored list is not", () => {
    const g = submitting();
    const shuffled = { ...g, players: [g.players[3], g.players[0], g.players[4], g.players[1], g.players[2]].map(must) };
    expect(spec(shuffled).players.map((p) => p.joinOrder)).toEqual([0, 1, 2, 3, 4]);
  });
  test("score is the score pile size; a departed player is listed with score 0 even if a pile were left", () => {
    const g = submitting();
    expect(spec(g).players.map((p) => p.score)).toEqual([0, 0, 1, 0, 0]);
    const left = { ...g, players: g.players.map((p) => (p.id === pid(2) ? { ...p, status: "left" as const } : p)) };
    expect(spec(left).players.map((p) => [p.status, p.score])[2]).toEqual(["left", 0]);
    const removed = { ...g, players: g.players.map((p) => (p.id === pid(2) ? { ...p, status: "removed" as const } : p)) };
    expect(spec(removed).players[2]?.score).toBe(0);
  });
  test("cardsLeft: counts for a writer with a target, null for ready, active, LOBBY and departed players", () => {
    const w = spec(writing()).players;
    expect(w.map((p) => p.cardsLeft)).toEqual([{ red: 6, green: 2 }, null, { red: 10, green: 3 }, { red: 0, green: 1 }]);
    expect(spec(lobby()).players.map((p) => p.cardsLeft)).toEqual([null, null, null]);
    expect(spec(submitting()).players.map((p) => p.cardsLeft)).toEqual([null, null, null, null, null]);
    expect(spec(lateJoiner()).players[5]?.cardsLeft).toEqual({ red: 8, green: 8 });
    const lost = { ...writing(), players: writing().players.map((p) => (p.id === pid(0) ? { ...p, status: "left" as const } : p)) };
    expect(spec(lost).players[0]?.cardsLeft).toBeNull();
  });
});

describe("RD3 settings, counts and the round (5.1)", () => {
  test("PublicSettings has no writeCountsOverride; target is the effective target, targetFrozen says whether it is frozen", () => {
    const l = spec(lobby());
    expect(Object.keys(l.settings).sort()).toEqual(["profanity", "spectators", "targetOverride", "variants"]);
    expect(l.target).toBe(8); // default for 3 seated
    expect(l.targetFrozen).toBe(false);
    expect(l.writeCounts).toBeNull();
    const w = spec(writing());
    expect([w.target, w.targetFrozen, w.writeCounts]).toEqual([3, true, { red: 10, green: 3 }]);
    expect(spec({ ...lobby(), settings: { ...settings(), targetOverride: 5 } }).target).toBe(5);
  });
  test("waitingOn is the settled field; none of the scheduler's fields leak", () => {
    expect(spec(writing()).waitingOn).toEqual([pid(0), pid(2), pid(3)]);
    const text = JSON.stringify(project(writing(), SPEC));
    for (const x of ["EPISODE-SECRET-0001", "1700000000000", "1700086400000", "waitingSince", "reminderDueAt", "episode", "createdAt", "totalJoins", "changedAtVersion", "openedAt", "hostId"]) expect(text).not.toContain(x);
  });
  test("round: null outside PLAYING, present in PLAYING with number, judge, phase and the green card text", () => {
    for (const g of [lobby(), writing(), finished(), ended()]) expect(spec(g).round).toBeNull();
    const r = roundOf(spec(submitting()));
    expect([r.number, r.judgeId, r.phase, r.green]).toEqual([2, pid(1), "SUBMITTING", { id: cid(900), text: "the green card" }]);
  });
  test("expected is the non-judge active roster by joinOrder, whatever the roster's own order", () => {
    const g = submitting();
    const reversed = { ...g, round: { ...must(g.round), roster: [...must(g.round).roster].reverse() } };
    expect(roundOf(spec(reversed)).expected).toEqual([pid(0), pid(2), pid(3), pid(4)]);
    const gone = { ...g, players: g.players.map((p) => (p.id === pid(4) ? { ...p, status: "left" as const } : p)) };
    expect(roundOf(spec(gone)).expected).toEqual([pid(0), pid(2), pid(3)]);
  });
  test("submittedBy is sorted by joinOrder, not by time; who, never what (SUBMITTING)", () => {
    const r = roundOf(spec(submitting())); // 3 played before 2
    expect(r.submittedBy).toEqual([pid(2), pid(3)]);
    expect(r.reveal).toBeNull();
    expect(JSON.stringify(r)).not.toContain(cid(206));
    expect(JSON.stringify(r)).not.toContain("card c_");
  });
  test("reveal: JUDGING only, in revealOrder order, text and pitch, no owner; the same for every viewer (PJ6)", () => {
    const g = judging(); // plays 4, 2, 3; revealOrder is the reverse of the submissions: 3, 2, 4
    expect(must(g.round).revealOrder).toEqual([cid(306), cid(206), cid(406)]);
    const want = [
      { submissionId: cid(306), text: `card ${cid(306)}`, pitch: "PITCH-P3" },
      { submissionId: cid(206), text: `card ${cid(206)}`, pitch: null },
      { submissionId: cid(406), text: `card ${cid(406)}`, pitch: null },
    ];
    for (const v of [SPEC, HU, P(0), P(1), P(2), P(5)]) {
      const view = live(project(v.kind === "spectator" && v.isHost ? unseatHost(g) : g, v));
      expect(roundOf(view).reveal, JSON.stringify(v)).toEqual(want);
    }
    expect(roundOf(spec(g)).submittedBy).toEqual([pid(2), pid(3), pid(4)]);
    expect(JSON.stringify(roundOf(spec(g)).reveal)).not.toMatch(/playerId|writeIn|p_aaaa/);
  });
  test("resolved is the number of resolved rounds; winnerId only in FINISHED", () => {
    expect(spec(lobby()).resolved).toBe(0);
    expect(spec(submitting()).resolved).toBe(1);
    expect([spec(finished()).resolved, spec(finished()).winnerId]).toEqual([3, pid(2)]);
    expect(spec(ended()).winnerId).toBeNull();
    expect(spec({ ...ended(), winnerId: pid(2) }).winnerId).toBeNull(); // gated by the phase, not by the field
    expect(spec({ ...submitting(), winnerId: pid(2) }).winnerId).toBeNull();
  });
  test("awards: FINISHED or ENDED with People's Choice on; null in every earlier phase and with the variant off", () => {
    const f = must(spec(finished()).awards);
    expect(f.peoplesChoice).toEqual([pid(2)]);
    expect(f.podium).toEqual([
      { rank: 1, round: 1, cardId: cid(206), playerId: pid(2), votes: 2 },
      { rank: 2, round: 2, cardId: cid(207), playerId: pid(2), votes: 2 },
      { rank: 3, round: 3, cardId: cid(1), playerId: pid(0), votes: 1 },
    ]);
    expect(spec(ended()).awards).toEqual({ peoplesChoice: [pid(2)], podium: [{ rank: 1, round: 1, cardId: cid(206), playerId: pid(2), votes: 1 }] });
    const voting = { ...submitting(), settings: settings({ peoplesChoice: true }), votes: finished().votes };
    expect(spec(voting).awards).toBeNull();
    expect(spec({ ...finished(), settings: settings() }).awards).toBeNull();
    expect(spec(lobby()).awards).toBeNull();
  });
});

describe("RD4 you: own data only (5.2)", () => {
  test("hand: PLAYING and active only, in hand order with texts; empty for a late joiner, a ready player, FINISHED and ENDED", () => {
    const h = player(submitting(), 4).you.hand;
    expect(h.map((c) => c.id)).toEqual([0, 1, 2, 3, 4, 5, 6].map((k) => cid(400 + k)));
    expect(h[0]).toEqual({ id: cid(400), text: `card ${cid(400)}` });
    expect(player(lateJoiner(), 5).you.hand).toEqual([]);
    expect(player({ ...lateJoiner(), players: lateJoiner().players.map((p) => (p.id === pid(5) ? { ...p, status: "ready" as const } : p)) }, 5).you.hand).toEqual([]);
    expect(player(finished(), 3).you.hand).toEqual([]);
    expect(player(ended(), 3).you.hand).toEqual([]);
    expect(player(writing(), 0).you.hand).toEqual([]);
    expect(player(paused(), 0).you.hand).toHaveLength(7); // hands stay visible while paused
  });
  test("a player's hand is in their own view only: no other viewer's JSON holds a card id or text of it", () => {
    const g = submitting();
    const mine = player(g, 4).you.hand;
    for (const v of [SPEC, P(0), P(1), P(2), P(3)]) {
      const text = JSON.stringify(project(g, v));
      for (const c of mine) { expect(text).not.toContain(c.id); expect(text).not.toContain(c.text); }
    }
    for (const c of mine) expect(JSON.stringify(project(unseatHost(g), HU))).not.toContain(c.id);
  });
  test("yourSubmission: the owner's own card with text and pitch, in SUBMITTING and JUDGING; null for a non-submitter and for the judge", () => {
    expect(player(submitting(), 2).you.yourSubmission).toEqual({ cardId: cid(206), text: `card ${cid(206)}`, pitch: "PITCH-P2" });
    expect(player(submitting(), 3).you.yourSubmission).toEqual({ cardId: cid(306), text: `card ${cid(306)}`, pitch: null });
    expect(player(submitting(), 4).you.yourSubmission).toBeNull();
    expect(player(submitting(), 1).you.yourSubmission).toBeNull();
    expect(player(judging(), 3).you.yourSubmission).toEqual({ cardId: cid(306), text: `card ${cid(306)}`, pitch: "PITCH-P3" });
    expect(player(judging(), 5).you.yourSubmission).toBeNull();
    expect(player(finished(), 2).you.yourSubmission).toBeNull();
  });
  test("a submission is pitched into exactly the owner's view and the reveal, never into submittedBy or another doc's you", () => {
    const g = submitting();
    expect(JSON.stringify(project(g, SPEC))).not.toContain("PITCH-P2");
    expect(JSON.stringify(project(g, P(3)))).not.toContain("PITCH-P2");
    expect(JSON.stringify(project(g, P(2)))).toContain("PITCH-P2");
  });
  test("powerUsage is the viewer's own and appears nowhere else", () => {
    const g = submitting();
    const used = { ...g, players: g.players.map((p) => (p.id === pid(2) ? { ...p, powerUsage: { writeIn: true, redraw: true } } : p)) };
    expect(player(used, 2).you.powerUsage).toEqual({ writeIn: true, redraw: true });
    expect(player(used, 3).you.powerUsage).toEqual({ writeIn: false, redraw: false });
    for (const v of [SPEC, P(0), P(3)]) expect(JSON.stringify(project(used, v)).includes('"redraw":true')).toBe(false);
    expect(JSON.stringify(project(used, SPEC))).not.toContain("powerUsage");
    expect(JSON.stringify(project(unseatHost(used), HU))).not.toContain("powerUsage");
  });
  test("writeTarget and cardsLeft: counts while writing with a target; null when ready, active, in LOBBY (ruling 3)", () => {
    expect([player(writing(), 0).you.writeTarget, player(writing(), 0).you.cardsLeft]).toEqual([{ red: 10, green: 3 }, { red: 6, green: 2 }]);
    expect([player(writing(), 1).you.writeTarget, player(writing(), 1).you.cardsLeft]).toEqual([null, null]);
    expect([player(lobby(), 1).you.writeTarget, player(lobby(), 1).you.cardsLeft]).toEqual([null, null]);
    expect([player(submitting(), 2).you.writeTarget, player(submitting(), 2).you.cardsLeft]).toEqual([null, null]);
    expect([player(lateJoiner(), 5).you.writeTarget, player(lateJoiner(), 5).you.cardsLeft]).toEqual([{ red: 10, green: 8 }, { red: 8, green: 8 }]);
  });
  test("myVotes: own votes keyed by round (ascending) with People's Choice on; {} with it off, and never another voter's", () => {
    expect(player(finished(), 0).you.myVotes).toEqual({ "1": cid(206), "2": cid(207) });
    expect(Object.keys(player(finished(), 0).you.myVotes)).toEqual(["1", "2"]);
    expect(player(finished(), 1).you.myVotes).toEqual({ "3": cid(1) });
    expect(player(finished(), 2).you.myVotes).toEqual({});
    expect(player({ ...finished(), settings: settings() }, 0).you.myVotes).toEqual({});
    expect(JSON.stringify(project(finished(), SPEC))).not.toContain("spectator-uid-1");
  });
  test("identity fields: playerId, status, isHost, isJudge, score", () => {
    const y = player(submitting(), 2).you;
    expect([y.playerId, y.status, y.isHost, y.isJudge, y.score]).toEqual([pid(2), "active", false, false, 1]);
    const j = player(submitting(), 1).you;
    expect([j.isJudge, j.isHost]).toEqual([true, false]);
    expect(player(submitting(), 0).you.isHost).toBe(true);
  });
  test("roomCode: in a player's you and a host panel; nowhere in a spectator view or a departed view", () => {
    const g = submitting();
    expect(player(g, 2).you.roomCode).toBe(g.roomCode);
    expect(JSON.stringify(project(g, SPEC))).not.toContain(g.roomCode);
    expect(JSON.stringify(project(g, { kind: "departed", uid: "x", playerId: pid(1), reason: "left" }))).not.toContain(g.roomCode);
    expect(JSON.stringify(project(g, P(2))).split(g.roomCode)).toHaveLength(2); // once, in you
  });
  test("a player view has no uid and no hostId", () => {
    const text = JSON.stringify(project(submitting(), P(0)));
    expect(text).not.toContain("seat:");
    expect(text).not.toContain(HOST_UID);
    expect(text).not.toContain(uidOf(2));
  });
});

describe("RD5 the host panel (5.2)", () => {
  const panel = (v: GameView) => (v as { host?: unknown }).host;
  test("a seated host has you and host; a non-host seat has no host key; the unseated host has host and no you; a spectator has neither", () => {
    const g = submitting();
    expect(Object.hasOwn(project(g, P(0)), "host")).toBe(true);
    expect(Object.hasOwn(project(g, P(2)), "host")).toBe(false);
    expect(Object.hasOwn(project(g, P(1)), "host")).toBe(false); // the judge, not host
    expect(project(unseatHost(g), HU).audience).toBe("host");
    expect(panel(project(g, SPEC))).toBeUndefined();
  });
  test("host panel in every phase including ENDED, for a seated and an unseated host", () => {
    for (const [name, make] of Object.entries(FIXTURES)) {
      const g = make();
      expect(panel(project(g, P(0))), `${name} seated`).toBeDefined();
      expect(panel(project(unseatHost(g), HU)), `${name} unseated`).toBeDefined();
    }
  });
  test("contents: roomCode, playability (counts only) and writeCountsOverride; no card id or text, no pool contents", () => {
    const g = { ...writing(), settings: settings({ writeCountsOverride: { red: 12, green: 4 } }) };
    const p = panel(project(g, P(0))) as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(["playability", "roomCode", "writeCountsOverride"]);
    expect(p["roomCode"]).toBe(g.roomCode);
    expect(p["writeCountsOverride"]).toEqual({ red: 12, green: 4 });
    expect(p["playability"]).toEqual({ n: 4, target: 3, totals: { red: 10, green: 3 }, rMin: 36, gMin: 12, meets: false });
    const text = JSON.stringify(p);
    expect(text).not.toContain("POOLRED");
    expect(text).not.toContain("c_00");
  });
  test("playability is the selector's report over the seated count and the registry", () => {
    const l = panel(project(lobby(), P(0))) as { playability: Record<string, unknown> };
    expect(l.playability).toEqual({ n: 3, target: 8, totals: { red: 0, green: 0 }, rMin: 28, gMin: 24, meets: false });
    const s = panel(project(submitting(), P(0))) as { playability: { n: number; totals: { red: number } } };
    expect(s.playability.n).toBe(5);
    expect(s.playability.totals.red).toBe(Object.values(submitting().cards).filter((c) => c.kind === "red").length);
  });
  test("the unseated host's panel counts the seated players only, and carries the same room code and override", () => {
    const g = judging();
    const seated = panel(project(g, P(0))) as { roomCode: string; playability: { n: number }; writeCountsOverride: unknown };
    const unseated = panel(project(unseatHost(g), HU)) as typeof seated;
    expect([seated.playability.n, unseated.playability.n]).toEqual([6, 5]);
    expect([unseated.roomCode, unseated.writeCountsOverride]).toEqual([seated.roomCode, seated.writeCountsOverride]);
  });
});

describe("RD6 paused and degenerate rounds (5.3)", () => {
  test("PLAYING and paused: the same data plus paused, hands visible, turn paused", () => {
    const v = player(paused(), 0);
    expect([v.paused, v.phase, v.you.turn, v.you.hand.length]).toEqual([true, "PLAYING", "paused", 7]);
    expect(roundOf(live(v)).phase).toBe("SUBMITTING");
    expect(spec(paused()).paused).toBe(true);
  });
  test("a null judgeId is projected as null, with no judge anywhere", () => {
    const g = pausedNoJudge();
    expect(roundOf(spec(g)).judgeId).toBeNull();
    for (const i of [0, 1]) expect(player(g, i).you.isJudge).toBe(false);
  });
  test("a paused JUDGING round with an emptied reveal projects reveal [] (not null) and empty submittedBy", () => {
    const g = pausedJudgingEmpty();
    expect(roundOf(spec(g)).reveal).toEqual([]);
    expect(roundOf(spec(g)).phase).toBe("JUDGING");
  });
  test("a SUBMITTING round with a revealOrder somehow set still has reveal null (the phase is the gate)", () => {
    const g = submitting();
    expect(roundOf(spec({ ...g, round: { ...must(g.round), revealOrder: [cid(206)] } })).reveal).toBeNull();
  });
  test("roundGame sanity: a plain PLAYING game has no winner and no awards", () => {
    const v = spec(roundGame({ n: 4, judge: 1 }));
    expect([v.winnerId, v.awards, v.resolved]).toEqual([null, null, 0]);
  });
});
