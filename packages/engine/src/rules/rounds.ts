import { EngineInvariantError } from "../errors";
import { activePlayers } from "../selectors";
import type { CardId, DomainEvent, Game, Player, PlayerId, Rng, Round, RoundRecord, RoundSummary } from "../types";
import { topUp } from "./cards";
import { MIN_PLAYERS } from "./playability";
import { activateReady } from "./membership";

/**
 * The judge after `cursor` (LLD 1 section 8.3): among the active players sorted by `joinOrder`, the smallest `joinOrder` above the cursor,
 * else the smallest overall (wrap). A null cursor is the first judge: `rng.int(active.length)` over the sorted list, one draw.
 * Rotating by `joinOrder` rather than list index keeps it stable when the previous judge has left. No active player is an invariant violation.
 */
export function nextJudge(players: readonly Player[], cursor: number | null, rng: Rng): Player {
  const active = players.filter((p) => p.status === "active").sort((a, b) => a.joinOrder - b.joinOrder);
  const first = active[0];
  if (first === undefined) throw new EngineInvariantError("nextJudge: no active player");
  if (cursor === null) return active[rng.int(active.length)] ?? first;
  return active.find((p) => p.joinOrder > cursor) ?? first;
}

/**
 * Open the next round (8.3). Preconditions after step 1: at least 3 active players and a non-empty green deck, else EngineInvariantError.
 * 1 activate ready players (dealing in `joinOrder`, E18); 2 the judge is `judge` when given (`voidRound` after a reassignment) else `nextJudge`, and the cursor follows;
 * 3 the top green card leaves the deck, the roster is the actives, `changedAtVersion = version + 1`; 4 `RoundOpened`.
 * Events: `PlayerActivated` per activated player, then `RoundOpened`. It sets `round` and `judgeCursor` only: `phase` is the caller's.
 */
export function openRound(game: Game, rng: Rng, now: number, judge?: PlayerId): { state: Game; events: DomainEvent[] } {
  const activated = activateReady(game, rng);
  const state = activated.state;
  const roster = activePlayers(state);
  if (roster.length < MIN_PLAYERS) throw new EngineInvariantError(`openRound: ${roster.length} active players`);
  const greenCardId = state.pools.greenDeck[0];
  if (greenCardId === undefined) throw new EngineInvariantError("openRound: the green deck is empty");
  const chosen = judge === undefined ? nextJudge(state.players, state.judgeCursor, rng) : roster.find((p) => p.id === judge);
  if (chosen === undefined) throw new EngineInvariantError("openRound: the given judge is not active");
  const ids = roster.map((p) => p.id);
  const round: Round = {
    number: state.history.length + 1,
    judgeId: chosen.id,
    judgeReassigned: false,
    greenCardId,
    phase: "SUBMITTING",
    roster: ids,
    submissions: [],
    revealOrder: null,
    played: [],
    openedAt: now,
    changedAtVersion: state.version + 1,
  };
  const opened: DomainEvent = { t: "RoundOpened", round: round.number, judgeId: chosen.id, greenCardId, expected: ids.filter((id) => id !== chosen.id) };
  return {
    state: { ...state, pools: { ...state.pools, greenDeck: state.pools.greenDeck.slice(1) }, round, judgeCursor: chosen.joinOrder },
    events: [...activated.events, opened],
  };
}

/**
 * Settle slot 1's effect (8.7): shuffle `redDeck`, then `greenDeck`, with `rng`; `phase = PLAYING`; the first round opens with a null cursor,
 * so `openRound` activates every ready player (7 cards each, `joinOrder`) and draws the first judge with `rng.int`.
 * Events: `PlayStarted{playerIds, firstJudgeId}`, `PlayerActivated` per player, `RoundOpened`. The rng order is replay-critical.
 */
export function beginPlay(game: Game, rng: Rng, now: number): { state: Game; events: DomainEvent[] } {
  const redDeck = rng.shuffle(game.pools.redDeck);
  const greenDeck = rng.shuffle(game.pools.greenDeck);
  const opened = openRound({ ...game, phase: "PLAYING", judgeCursor: null, pools: { ...game.pools, redDeck, greenDeck } }, rng, now);
  const round = opened.state.round;
  if (round === null || round.judgeId === null) throw new EngineInvariantError("beginPlay: no round was opened");
  const playerIds = opened.events.flatMap((e) => (e.t === "PlayerActivated" ? [e.playerId] : []));
  return { state: opened.state, events: [{ t: "PlayStarted", playerIds, firstJudgeId: round.judgeId }, ...opened.events] };
}

const openRoundOf = (game: Game, what: string): Round => {
  if (game.round === null) throw new EngineInvariantError(`${what}: no round is open`);
  return game.round;
};

/**
 * Close submissions (8.3, E10): `revealOrder` is one `rng.shuffle` of the submitted card ids, the round becomes JUDGING and `changedAtVersion = version + 1`.
 * Event `SubmissionsClosed{round, judgeId, reason}`. Players who had not submitted keep their hand. Preconditions (SUBMITTING, at least one submission,
 * a judge) are the callers' guards, so a violation is an EngineInvariantError.
 */
export function closeRound(game: Game, rng: Rng, reason: "allIn" | "closed"): { state: Game; events: DomainEvent[] } {
  const round = openRoundOf(game, "closeRound");
  if (round.phase !== "SUBMITTING" || round.submissions.length === 0 || round.judgeId === null) {
    throw new EngineInvariantError(`closeRound: round ${round.number} is ${round.phase} with ${round.submissions.length} submissions and judge ${String(round.judgeId)}`);
  }
  const revealOrder = rng.shuffle(round.submissions.map((s) => s.cardId));
  return {
    state: { ...game, round: { ...round, phase: "JUDGING", revealOrder, played: round.submissions.map((s) => s.playerId), changedAtVersion: game.version + 1 } },
    events: [{ t: "SubmissionsClosed", round: round.number, judgeId: round.judgeId, reason }],
  };
}

/**
 * Resolve a JUDGING round for the submission `winnerCardId` (8.3 steps 1 to 5, E5, E6, E14). In order:
 * 1 the card's owner takes the round's green card into their score pile; 2 a summary joins `history` and a `RoundRecord` is returned
 * (plays in `revealOrder` order, pitches only in the record); 3 the submitted cards go to `redDiscard`; 4 every active player is topped up to 7 in `joinOrder`
 * (the red reshuffle happens here, if the deck runs dry); 5 at the target the game is FINISHED, otherwise the next round opens (`openRound`).
 * rng order: top-up reshuffle, then any activation deal at the boundary; the next judge is `nextJudge` by the cursor and draws nothing.
 * The caller's guards make `winnerCardId` a revealed card; anything else is an EngineInvariantError.
 */
export function resolveRound(game: Game, winnerCardId: CardId, rng: Rng, now: number): { state: Game; events: DomainEvent[]; roundRecords: RoundRecord[] } {
  const round = openRoundOf(game, "resolveRound");
  const winning = round.submissions.find((s) => s.cardId === winnerCardId);
  if (round.phase !== "JUDGING" || round.revealOrder === null || round.judgeId === null || winning === undefined || game.target === null) {
    throw new EngineInvariantError(`resolveRound: round ${round.number} cannot resolve (${round.phase}, card ${winnerCardId}, target ${String(game.target)})`);
  }
  const judgeId = round.judgeId;
  const winnerId = winning.playerId;
  const ordered = round.revealOrder.flatMap((id) => round.submissions.filter((s) => s.cardId === id));
  const greenText = game.cards[round.greenCardId]?.text ?? "";
  const summary: RoundSummary = {
    round: round.number,
    judgeId,
    greenCardId: round.greenCardId,
    plays: ordered.map((s) => ({ playerId: s.playerId, cardId: s.cardId })),
    winnerCardId,
    winnerId,
  };
  const submitters = new Set(round.played); // not `submissions`: a play the host removed (`removeCard`) still counts as played (LLD 1 open question 20)
  const record: RoundRecord = {
    ...summary,
    green: { id: round.greenCardId, text: greenText },
    playsDetail: ordered.map((s) => ({ playerId: s.playerId, cardId: s.cardId, text: game.cards[s.cardId]?.text ?? "", ...(s.pitch === undefined ? {} : { pitch: s.pitch }) })),
    absent: round.roster.filter((id) => id !== judgeId && !submitters.has(id)),
    resolvedAt: now,
  };
  // 1 and 3: the point, and the played cards to the discard.
  let pools = { ...game.pools, redDiscard: [...game.pools.redDiscard, ...ordered.map((s) => s.cardId)] };
  let players = game.players.map((p) => (p.id === winnerId ? { ...p, scorePile: [...p.scorePile, round.greenCardId] } : p));
  // 4: top up every active player, in joinOrder.
  const hands = new Map<PlayerId, CardId[]>();
  for (const p of [...players].filter((q) => q.status === "active").sort((a, b) => a.joinOrder - b.joinOrder)) {
    const out = topUp(pools, p.hand, rng);
    pools = out.pools;
    hands.set(p.id, out.hand);
  }
  players = players.map((p) => ({ ...p, hand: hands.get(p.id) ?? p.hand }));
  const picked: DomainEvent = { t: "WinnerPicked", round: round.number, judgeId, winnerId, winnerCardId };
  const resolved: Game = { ...game, pools, players, round: null, history: [...game.history, summary] };
  // 5: the target, else the next round.
  const winner = players.find((p) => p.id === winnerId);
  if ((winner?.scorePile.length ?? 0) >= game.target) {
    return { state: { ...resolved, phase: "FINISHED", winnerId, paused: false }, events: [picked, { t: "GameFinished", winnerId }], roundRecords: [record] };
  }
  const next = openRound(resolved, rng, now);
  return { state: next.state, events: [picked, ...next.events], roundRecords: [record] };
}

/**
 * Void a round with nothing to judge (8.3): the green card goes to the bottom of `greenDeck`, `RoundVoided`, then `openRound` for the replacement.
 * The number stays `history.length + 1`. A judge who came from a pass or a leave (`judgeReassigned`) and is still active judges the replacement too;
 * otherwise the judge rotates from the cursor. A round that still holds submissions is an EngineInvariantError.
 */
export function voidRound(game: Game, rng: Rng, now: number, reason: "no_submissions"): { state: Game; events: DomainEvent[] } {
  const round = openRoundOf(game, "voidRound");
  if (round.submissions.length > 0) throw new EngineInvariantError(`voidRound: round ${round.number} still holds ${round.submissions.length} submissions`);
  const keep = round.judgeReassigned && round.judgeId !== null && activePlayers(game).some((p) => p.id === round.judgeId) ? round.judgeId : undefined;
  const voided: Game = { ...game, round: null, pools: { ...game.pools, greenDeck: [...game.pools.greenDeck, round.greenCardId] } };
  const next = openRound(voided, rng, now, keep);
  return { state: next.state, events: [{ t: "RoundVoided", round: round.number, reason }, ...next.events] };
}

export type ReassignReason = "passed" | "left" | "removed" | "resumed";

/**
 * Hand the round to another judge (8.3): used by `passJudging`, the judge's `leave` and `removePlayer` (eviction has already set their status), and settle slot 3a.
 * The new judge is `nextJudge` over the active players except the outgoing judge, from the outgoing judge's `joinOrder` (from `judgeCursor` when there is no outgoing judge, "resumed").
 * With no candidate (the evicted judge was the last active player, so the game is paused) `judgeId` becomes null, the cursor stays, `changedAtVersion` bumps and nothing is emitted.
 * Otherwise the new judge's own submission is taken back (a hand play returns to their hand, a write-in goes to `redDiscard`; `revealOrder` loses the entry and keeps the order of the rest, E10),
 * they join `roster` if recovery activated them mid-round, `judgeReassigned` is set, the cursor follows and `JudgeChanged` is emitted. The old judge, still active in SUBMITTING, is an expected player (they are on
 * the roster); in JUDGING they sit out. Draws nothing from `rng` unless the cursor is null. Pure.
 */
export function reassignJudge(game: Game, reason: ReassignReason, rng: Rng): { state: Game; events: DomainEvent[] } {
  const round = openRoundOf(game, "reassignJudge");
  const outgoing = round.judgeId === null ? undefined : game.players.find((p) => p.id === round.judgeId);
  const candidates = game.players.filter((p) => p.status === "active" && p.id !== round.judgeId);
  if (candidates.length === 0) return { state: { ...game, round: { ...round, judgeId: null, changedAtVersion: game.version + 1 } }, events: [] };
  const next = nextJudge(candidates, outgoing?.joinOrder ?? game.judgeCursor, rng);
  const theirs = round.submissions.find((s) => s.playerId === next.id);
  let players = game.players;
  let pools = game.pools;
  if (theirs !== undefined) {
    if (theirs.writeIn === true) pools = { ...pools, redDiscard: [...pools.redDiscard, theirs.cardId] };
    else players = players.map((p) => (p.id === next.id ? { ...p, hand: [...p.hand, theirs.cardId] } : p));
  }
  const reassigned: Round = {
    ...round,
    judgeId: next.id,
    judgeReassigned: true,
    submissions: theirs === undefined ? round.submissions : round.submissions.filter((s) => s.playerId !== next.id),
    played: round.played.filter((id) => id !== next.id),
    revealOrder: theirs === undefined || round.revealOrder === null ? round.revealOrder : round.revealOrder.filter((c) => c !== theirs.cardId),
    roster: round.roster.includes(next.id) ? round.roster : [...round.roster, next.id],
    changedAtVersion: game.version + 1,
  };
  return {
    state: { ...game, players, pools, round: reassigned, judgeCursor: next.joinOrder },
    events: [{ t: "JudgeChanged", round: round.number, from: round.judgeId, to: next.id, reason }],
  };
}

/**
 * `endGame`'s abort (8.3): each hand-played submission returns to its owner's hand, a write-in submission goes to `redDiscard`, the green card goes to the bottom of `greenDeck`, `round = null`.
 * No round, no change.
 */
export function abortRound(game: Game): Game {
  const round = game.round;
  if (round === null) return game;
  let pools = { ...game.pools, greenDeck: [...game.pools.greenDeck, round.greenCardId] };
  let players = game.players;
  for (const s of round.submissions) {
    if (s.writeIn === true) pools = { ...pools, redDiscard: [...pools.redDiscard, s.cardId] };
    else players = players.map((p) => (p.id === s.playerId ? { ...p, hand: [...p.hand, s.cardId] } : p));
  }
  return { ...game, players, pools, round: null };
}
