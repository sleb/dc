import { describe, expect, test } from "bun:test";
import { REMINDER_INTERVAL_MS, waitingFields } from "../src/rules/waiting";
import type { Game } from "../src/types";
import { makeGame, makePlayer, makeRound, pid } from "./support/factories";

const DAY = 86_400_000;
const NOW = 5_000_000;
const none = { waitingOn: [], episode: null, waitingSince: null, reminderDueAt: null };

/** WRITING with players 0..n-1; `writing` lists who has not finished. */
const writingGame = (n: number, writing: number[], over: Partial<Game> = {}): Game =>
  makeGame({ phase: "WRITING", players: Array.from({ length: n }, (_, i) => makePlayer(i, { status: writing.includes(i) ? "writing" : "ready" })), ...over });

/** PLAYING with active players 0..n-1 (0 judges by default) and an open round. */
const playingGame = (n: number, over: Partial<Game> = {}, round: Parameters<typeof makeRound>[0] = {}): Game =>
  makeGame({
    phase: "PLAYING",
    players: Array.from({ length: n }, (_, i) => makePlayer(i, { status: "active" })),
    round: makeRound({ number: 3, judgeId: pid(0), roster: Array.from({ length: n }, (_, i) => pid(i)), ...round }),
    ...over,
  });

describe("V7 REMINDER_INTERVAL_MS", () => {
  test("is 24 hours", () => expect(REMINDER_INTERVAL_MS).toBe(DAY));
});

describe("V7 waitingOn (LLD 1 section 4.2)", () => {
  test("WRITING: the seated players still writing, in seat order", () => {
    expect(waitingFields(writingGame(4, [1, 3]), NOW, true).waitingOn).toEqual([pid(1), pid(3)]);
  });

  test("WRITING: left and removed players are not waited on", () => {
    const g = writingGame(4, [1, 3]);
    const left = { ...g, players: g.players.map((p) => (p.id === pid(1) ? { ...p, status: "left" as const } : p)) };
    expect(waitingFields(left, NOW, true).waitingOn).toEqual([pid(3)]);
  });

  test("SUBMITTING: expected players (roster, active, not the judge) with no submission", () => {
    const g = playingGame(4, {}, { submissions: [{ playerId: pid(2), cardId: "c_0000000001" }] });
    expect(waitingFields(g, NOW, true).waitingOn).toEqual([pid(1), pid(3)]);
  });

  test("SUBMITTING: a roster member who left, and a player not in the roster, are not expected", () => {
    const base = playingGame(5, {}, { roster: [pid(0), pid(1), pid(2), pid(3)] });
    const g = { ...base, players: base.players.map((p) => (p.id === pid(3) ? { ...p, status: "left" as const } : p)) };
    expect(waitingFields(g, NOW, true).waitingOn).toEqual([pid(1), pid(2)]);
  });

  test("JUDGING: the judge alone; [] when the judge is null", () => {
    expect(waitingFields(playingGame(4, {}, { phase: "JUDGING", revealOrder: ["c_0000000001"] }), NOW, true).waitingOn).toEqual([pid(0)]);
    const nullJudge = waitingFields(playingGame(4, {}, { phase: "JUDGING", judgeId: null }), NOW, true);
    expect(nullJudge.waitingOn).toEqual([]);
    expect(nullJudge.episode).toBeNull();
  });

  test("PLAYING: late joiners still writing are appended in both round phases", () => {
    const withLate = (round: Parameters<typeof makeRound>[0]): Game => {
      const g = playingGame(3, {}, round);
      return { ...g, players: [...g.players, makePlayer(3, { status: "writing" })] };
    };
    expect(waitingFields(withLate({}), NOW, true).waitingOn).toEqual([pid(1), pid(2), pid(3)]);
    expect(waitingFields(withLate({ phase: "JUDGING" }), NOW, true).waitingOn).toEqual([pid(0), pid(3)]);
  });

  test("computed even while paused", () => {
    expect(waitingFields(writingGame(2, [0, 1], { paused: true }), NOW, true).waitingOn).toEqual([pid(0), pid(1)]);
  });

  test("LOBBY, FINISHED and ENDED wait on nobody", () => {
    for (const phase of ["LOBBY", "FINISHED", "ENDED"] as const) {
      expect(waitingFields(makeGame({ phase, players: [makePlayer(0, { status: "writing" })] }), NOW, true)).toMatchObject(none);
    }
  });
});

describe("V7 episode key", () => {
  test("WRITING is \"writing\"; SUBMITTING and JUDGING are {round}:{roundPhase}:{judgeId}", () => {
    expect(waitingFields(writingGame(3, [0]), NOW, true).episode).toBe("writing");
    expect(waitingFields(playingGame(3), NOW, true).episode).toBe(`3:SUBMITTING:${pid(0)}`);
    expect(waitingFields(playingGame(3, {}, { phase: "JUDGING" }), NOW, true).episode).toBe(`3:JUDGING:${pid(0)}`);
  });

  test("null when paused, when nobody is waited on, and in any other phase", () => {
    expect(waitingFields(writingGame(2, [0, 1], { paused: true }), NOW, true).episode).toBeNull();
    expect(waitingFields(playingGame(3, { paused: true }), NOW, true).episode).toBeNull();
    expect(waitingFields(writingGame(3, []), NOW, true).episode).toBeNull();
    expect(waitingFields(makeGame({ phase: "LOBBY" }), NOW, true).episode).toBeNull();
  });

  test("a null episode has null waitingSince and reminderDueAt and keeps episodeGen", () => {
    const f = waitingFields(writingGame(3, [], { episodeGen: 4, waitingSince: 1, reminderDueAt: 2, episode: "writing" }), NOW, true);
    expect(f).toEqual({ waitingOn: [], episode: null, episodeGen: 4, waitingSince: null, reminderDueAt: null });
  });
});

describe("V7 episode clock", () => {
  const running = (over: Partial<Game> = {}) => writingGame(3, [0, 1], { episode: "writing", episodeGen: 2, waitingSince: 100, reminderDueAt: 100 + DAY, ...over });

  test("an episode that starts sets waitingSince = now, reminderDueAt = now + 24 h and episodeGen + 1", () => {
    expect(waitingFields(running(), NOW, true)).toEqual({ waitingOn: [pid(0), pid(1)], episode: "writing", episodeGen: 3, waitingSince: NOW, reminderDueAt: NOW + DAY });
  });

  test("a running episode keeps its clock and generation; only waitingOn is recomputed", () => {
    expect(waitingFields(running(), NOW, false)).toEqual({ waitingOn: [pid(0), pid(1)], episode: "writing", episodeGen: 2, waitingSince: 100, reminderDueAt: 100 + DAY });
  });

  test("a late joiner or a finisher changes waitingOn but not the episode, generation or clock", () => {
    const g = running();
    const joined = { ...g, players: [...g.players, makePlayer(3, { status: "writing" })] };
    expect(waitingFields(joined, NOW, false)).toMatchObject({ waitingOn: [pid(0), pid(1), pid(3)], episodeGen: 2, waitingSince: 100, reminderDueAt: 100 + DAY });
  });

  test("a new episode starts by itself when the key changes (round open, close, judge change) even without the flag", () => {
    const g = playingGame(3, { episode: `3:SUBMITTING:${pid(0)}`, episodeGen: 5, waitingSince: 100, reminderDueAt: 100 + DAY }, { phase: "JUDGING" });
    expect(waitingFields(g, NOW, false)).toMatchObject({ episode: `3:JUDGING:${pid(0)}`, episodeGen: 6, waitingSince: NOW, reminderDueAt: NOW + DAY });
  });

  test("un-pausing starts a new episode: the key was null, so \"writing\" returns with a higher generation", () => {
    const paused = writingGame(3, [0, 1], { episode: null, episodeGen: 2, waitingSince: null, reminderDueAt: null });
    expect(waitingFields(paused, NOW, false)).toMatchObject({ episode: "writing", episodeGen: 3, waitingSince: NOW });
  });

  test("the same key can start again when the caller says so (a voided round reopened with the same number and judge)", () => {
    const g = playingGame(3, { episode: `3:SUBMITTING:${pid(0)}`, episodeGen: 5, waitingSince: 100, reminderDueAt: 100 + DAY });
    expect(waitingFields(g, NOW, true)).toMatchObject({ episodeGen: 6, waitingSince: NOW });
  });

  test("reminderDueAt - waitingSince is exactly 24 h whenever the episode is non-null", () => {
    const f = waitingFields(running(), NOW, true);
    expect((f.reminderDueAt ?? 0) - (f.waitingSince ?? 0)).toBe(DAY);
  });
});
