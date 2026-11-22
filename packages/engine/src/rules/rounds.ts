import { EngineInvariantError } from "../errors";
import { activePlayers } from "../selectors";
import type { DomainEvent, Game, Player, PlayerId, Rng, Round } from "../types";
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
 * 1 activate ready players (dealing in `joinOrder`, E18); 2 the judge is `judge` when given (only `voidRound`, #22) else `nextJudge`, and the cursor follows;
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
