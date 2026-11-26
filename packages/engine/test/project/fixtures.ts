// Fixtures for the Projector tests (#28): named states and viewer literals. Card ids and texts are fixed, so a golden never depends on a seed.
// Ids: hands cid(100 i + k), a player's play cid(100 i + 6), the round's green cid(900), pool cards cid(2000+), see test/support/round-fixtures.ts.
import type { Viewer } from "../../src/project";
import type { Game, Player, Settings, Vote } from "../../src/types";
import { DEFAULT_SETTINGS, GAME_ID, HOST_UID, addCard, cid, makeGame, makePlayer, pid, seatUidOf } from "../support/factories";
import { park, roundGame } from "../support/round-fixtures";

export const must = <T>(x: T | undefined | null): T => {
  if (x === undefined || x === null) throw new Error("fixture: missing value");
  return x;
};

export const uidOf = (i: number): string => (i === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(i)));
/** A seated viewer; player 0 is the host. */
export const P = (i: number): Viewer => ({ kind: "player", uid: uidOf(i), playerId: pid(i), isHost: i === 0 });
export const SPEC: Viewer = { kind: "spectator", uid: null, isHost: false };
export const HU: Viewer = { kind: "spectator", uid: HOST_UID, isHost: true };
export const DEP = (i: number, reason: "left" | "removed" | "gone"): Viewer => ({ kind: "departed", uid: uidOf(i), playerId: pid(i), reason });

export const settings = (over: { pitch?: boolean; peoplesChoice?: boolean; writeIn?: boolean; spectators?: boolean; writeCountsOverride?: Settings["writeCountsOverride"] } = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  variants: { pitch: over.pitch ?? false, writeIn: over.writeIn ?? false, redraw: false, peoplesChoice: over.peoplesChoice ?? false },
  spectators: { enabled: over.spectators ?? true, vote: false },
  writeCountsOverride: over.writeCountsOverride ?? null,
});

/** Server-only noise a projector must never copy: scheduler fields and a seed-like episode. */
const NOISE = { waitingSince: 1_700_000_000_000, reminderDueAt: 1_700_086_400_000, episode: "EPISODE-SECRET-0001", episodeGen: 3, createdAt: 1_600_000_000_000, totalJoins: 7 } as const;

const named = (g: Game): Game => ({ ...g, players: g.players.map((p, i) => ({ ...p, name: `Name${i}` })) });

export function lobby(): Game {
  return named(makeGame({ version: 4, settings: settings(), players: [0, 1, 2].map((i) => makePlayer(i, { status: "writing" })), ...NOISE }));
}

const WRITE = { red: 10, green: 3 };
export function writing(): Game {
  const players: Player[] = [
    makePlayer(0, { status: "writing", writeTarget: WRITE, writeProgress: { red: 4, green: 1 } }),
    makePlayer(1, { status: "ready", writeTarget: WRITE, writeProgress: WRITE }),
    makePlayer(2, { status: "writing", writeTarget: WRITE, writeProgress: { red: 0, green: 0 } }),
    makePlayer(3, { status: "writing", writeTarget: WRITE, writeProgress: { red: 10, green: 2 } }),
  ];
  let g = named(makeGame({ phase: "WRITING", version: 12, target: 3, writeCounts: WRITE, settings: settings(), players, waitingOn: [pid(0), pid(2), pid(3)], ...NOISE }));
  for (let k = 0; k < 10; k++) g = addCard(g, cid(2000 + k), "red", "redDeck", `POOLRED${String(k).padStart(2, "0")}`);
  for (let k = 0; k < 3; k++) g = addCard(g, cid(2100 + k), "green", "greenDeck", `POOLGRN${String(k).padStart(2, "0")}`);
  return g;
}

const HISTORY1 = { round: 1, judgeId: pid(1), greenCardId: cid(800), plays: [{ playerId: pid(2), cardId: cid(206) }, { playerId: pid(3), cardId: cid(306) }], winnerCardId: cid(206), winnerId: pid(2) };

const withPitch = (g: Game, i: number, pitch: string): Game => g.round === null ? g : { ...g, round: { ...g.round, submissions: g.round.submissions.map((s) => (s.playerId === pid(i) ? { ...s, pitch } : s)) } };

/** Round 2 open, 5 players, judge 1, players 2 and 3 have played (3 first in time), one earlier round resolved. */
export function submitting(): Game {
  const g = roundGame({ n: 5, judge: 1, submitted: [3, 2], scores: [0, 0, 1, 0, 0], history: [HISTORY1], extra: { settings: settings({ pitch: true }), waitingOn: [pid(0), pid(4)], ...NOISE } });
  return withPitch(named(g), 2, "PITCH-P2");
}

/** Round 1 closed with three plays (2, 3, 4), six players, judge 1, player 5 did not play. revealOrder is the plays reversed. */
export function judging(): Game {
  return withPitch(named(roundGame({ n: 6, judge: 1, submitted: [4, 2, 3], phase: "JUDGING", extra: { settings: settings({ pitch: true }), waitingOn: [pid(1)], ...NOISE } })), 3, "PITCH-P3");
}

/** Three players, one of whom left: two active, paused, round 1 open and empty. */
export function paused(): Game {
  const g = park(roundGame({ n: 3, judge: 1, extra: { settings: settings() } }), 2, "left");
  return named({ ...g, paused: true, ...NOISE });
}

/** Paused after the last candidate judge was evicted: no judge. */
export function pausedNoJudge(): Game {
  const g = paused();
  return { ...g, round: { ...must(g.round), judgeId: null } };
}

/** A paused JUDGING round whose reveal list was emptied by removeCard. */
export function pausedJudgingEmpty(): Game {
  const g = park(roundGame({ n: 4, judge: 1, submitted: [2], phase: "JUDGING", extra: { settings: settings() } }), 3, "left");
  return named({ ...g, paused: true, round: { ...must(g.round), submissions: [], revealOrder: [] } });
}

/** An active player who joined at a boundary after the roster was fixed: on no roster. */
export function sitOut(): Game {
  let g = roundGame({ n: 5, judge: 1, submitted: [2], extra: { settings: settings() } });
  g = { ...g, players: g.players.map((p) => (p.id === pid(4) ? p : p)) };
  const roster = must(g.round).roster.filter((id) => id !== pid(4));
  return named({ ...g, round: { ...must(g.round), roster } });
}

/** A writer who joined mid-play: status writing, nothing in hand. */
export function lateJoiner(): Game {
  const g = roundGame({ n: 5, judge: 1, submitted: [2], extra: { settings: settings() } });
  const late = makePlayer(5, { status: "writing", writeTarget: { red: 10, green: 8 }, writeProgress: { red: 2, green: 0 } });
  return named({ ...g, players: [...g.players, late], waitingOn: [pid(0), pid(3), pid(4), pid(5)] });
}

/** Four rounds of play, player 2 won at target 3. People's Choice on, votes cast. */
export function finished(): Game {
  const base = roundGame({ n: 4, judge: 1, target: 3, scores: [0, 0, 3, 1], extra: { settings: settings({ peoplesChoice: true }) } });
  const history = [
    HISTORY1,
    { round: 2, judgeId: pid(0), greenCardId: cid(801), plays: [{ playerId: pid(2), cardId: cid(207) }, { playerId: pid(1), cardId: cid(107) }], winnerCardId: cid(207), winnerId: pid(2) },
    { round: 3, judgeId: pid(3), greenCardId: cid(802), plays: [{ playerId: pid(2), cardId: cid(208) }, { playerId: pid(0), cardId: cid(1) }], winnerCardId: cid(208), winnerId: pid(2) },
  ];
  const votes: Vote[] = [
    { round: 1, voter: `p:${pid(0)}`, cardId: cid(206) }, { round: 1, voter: "s:spectator-uid-1", cardId: cid(206) },
    { round: 2, voter: `p:${pid(0)}`, cardId: cid(207) }, { round: 2, voter: `p:${pid(3)}`, cardId: cid(207) },
    { round: 3, voter: `p:${pid(1)}`, cardId: cid(1) },
  ];
  return named({ ...base, phase: "FINISHED", round: null, judgeCursor: 1, history, votes, winnerId: pid(2), ...NOISE });
}

export function ended(): Game {
  const g = roundGame({ n: 4, judge: 1, submitted: [2], extra: { settings: settings({ peoplesChoice: true }) } });
  return named({ ...g, phase: "ENDED", round: null, paused: false, history: [HISTORY1], votes: [{ round: 1, voter: `p:${pid(0)}`, cardId: cid(206) }] });
}

/** The host's seat is gone (left); every other seat is as it was. LOBBY deletes the record instead. */
export function unseatHost(g: Game): Game {
  if (g.phase === "LOBBY") return { ...g, players: g.players.filter((p) => p.id !== pid(0)) };
  const p0 = must(g.players.find((p) => p.id === pid(0)));
  return { ...g, waitingOn: g.waitingOn.filter((id) => id !== p0.id), players: g.players.map((p) => (p === p0 ? { ...p, status: "left" as const, hand: [], scorePile: [] } : p)) };
}

export const FIXTURES: Record<string, () => Game> = { lobby, writing, submitting, judging, paused, pausedNoJudge, pausedJudgingEmpty, sitOut, lateJoiner, finished, ended };
