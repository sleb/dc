// #29: the worst-case fixtures of LLD 2 8.3 and PJ14: ten seated players, every card text 80 code points of 4-byte characters, every pitch 140, every name 24, a full hand,
// a JUDGING reveal of nine cards; and a FINISHED game with the maximum 1500 own votes.
import type { Game, Vote } from "../../src/types";
import { HOST_UID, cid, pid } from "../support/factories";
import { roundGame } from "../support/round-fixtures";
import { must, settings } from "./fixtures";

const ASTRAL = "\u{1F600}"; // 4 bytes in UTF-8, two UTF-16 units
export const text80 = (tag: string): string => `${tag}${ASTRAL.repeat(80 - [...tag].length)}`;
export const pitch140 = (tag: string): string => `${tag}${ASTRAL.repeat(140 - [...tag].length)}`;
const name24 = (i: number): string => `N${i}${ASTRAL.repeat(24 - 2)}`;

/** Every card in the registry gets an 80-code-point text; every player a 24-code-point name. */
function fatten(g: Game): Game {
  const cards = Object.fromEntries(Object.entries(g.cards).map(([id, c]) => [id, { kind: c.kind, text: text80(id) }]));
  return { ...g, cards, players: g.players.map((p, i) => ({ ...p, name: name24(i) })) };
}

/** JUDGING, 10 seated players (judge 1), the other nine all played, 140-code-point pitches. Seven-card hands. */
export function maximalJudging(): Game {
  const g = fatten(roundGame({ n: 10, judge: 1, submitted: [0, 2, 3, 4, 5, 6, 7, 8, 9], phase: "JUDGING", extra: { settings: settings({ pitch: true, peoplesChoice: true }) } }));
  const round = must(g.round);
  return { ...g, round: { ...round, submissions: round.submissions.map((s) => ({ ...s, pitch: pitch140(s.playerId) })) } };
}

/** FINISHED with People's Choice, the host holding 1500 votes (the cap), a three-round podium history. */
export function maximalFinished(): Game {
  const g = fatten(roundGame({ n: 10, judge: 1, target: 3, scores: [0, 0, 3, 1], extra: { settings: settings({ peoplesChoice: true }) } }));
  const history = [1, 2, 3].map((round) => ({ round, judgeId: pid(1), greenCardId: cid(800 + round), plays: [{ playerId: pid(2), cardId: cid(200 + round) }, { playerId: pid(3), cardId: cid(300 + round) }], winnerCardId: cid(200 + round), winnerId: pid(2) }));
  const votes: Vote[] = Array.from({ length: 1500 }, (_, i) => ({ round: i + 1, voter: `p:${pid(0)}`, cardId: cid(200 + (i % 3) + 1) }));
  return { ...g, phase: "FINISHED", round: null, judgeCursor: 1, history, votes, winnerId: pid(2), hostId: HOST_UID };
}
