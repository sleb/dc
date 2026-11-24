import { EngineInvariantError } from "../errors";
import type { CardId, DomainEvent, DraftChange, Game, Player, PlayerId, Rng, Round } from "../types";
import { HAND } from "./playability";
import { draw } from "./cards";
import { reassignJudge } from "./rounds";

/**
 * Activate every `ready` player, in `joinOrder` (LLD 1 section 8.5): deal 7 with `draw`, set `active`, emit `PlayerActivated`.
 * Called by `openRound` step 1 (the round boundary, E18), by `beginPlay` and by settle slot 3 (paused recovery, #23).
 * The deal is in `joinOrder`, not list order, so which player gets which cards is a function of the join sequence (E18).
 * Pure; `rng` is consumed only if the red deck runs dry mid-deal.
 */
export function activateReady(game: Game, rng: Rng): { state: Game; events: DomainEvent[] } {
  const ready = game.players.filter((p) => p.status === "ready").sort((a, b) => a.joinOrder - b.joinOrder);
  if (ready.length === 0) return { state: game, events: [] };
  let pools = game.pools;
  const dealt = new Map<string, Player>();
  const events: DomainEvent[] = [];
  for (const p of ready) {
    const out = draw(pools, HAND, rng);
    pools = out.pools;
    dealt.set(p.id, { ...p, status: "active", hand: [...p.hand, ...out.cards] });
    events.push({ t: "PlayerActivated", playerId: p.id });
  }
  return { state: { ...game, pools, players: game.players.map((p) => dealt.get(p.id) ?? p) }, events };
}

/**
 * Remove a seat from play (LLD 1 section 8.5, E17), in this order, drawing from `rng` only for a deck that actually received cards (Q2):
 * 1 the hand, then the seat's submission card, are appended to `redDeck`, which is shuffled (a write-in submission, which never was in the hand, goes to `redDiscard` instead);
 * the submission leaves `round.submissions` and `revealOrder` without bumping `changedAtVersion` (Q6);
 * 2 the score pile is appended to `greenDeck`, which is shuffled (red before green, the points leave with the player, U2);
 * 3 a draft is deleted only for a `writing` seat (Q7); 4 `status` is set and hand and pile are emptied; 5 the judge is replaced by `reassignJudge`, which picks the next active player even when the eviction pauses the game and leaves a null judge only when no candidate exists (LLD 1 8.3).
 * Returns the side-effect events only (`JudgeChanged`); the caller adds `PlayerLeft` or `PlayerRemoved` first. `episodeStarted` is true when the judge changed.
 * LOBBY deletes the record instead and never gets here. Pure.
 */
export function evictPlayer(game: Game, playerId: PlayerId, status: "left" | "removed", rng: Rng): { state: Game; events: DomainEvent[]; draftChanges: DraftChange[]; episodeStarted: boolean } {
  const seatedNow = (p: Player): boolean => p.status === "writing" || p.status === "ready" || p.status === "active";
  const gone = game.players.find((p) => p.id === playerId && seatedNow(p));
  if (gone === undefined) throw new EngineInvariantError(`evictPlayer: no seated player ${playerId}`);
  const round = game.round;
  const mine = round?.submissions.find((s) => s.playerId === playerId);
  const release: CardId[] = [...gone.hand];
  let redDiscard = game.pools.redDiscard;
  if (mine !== undefined) {
    if (mine.writeIn === true) redDiscard = [...redDiscard, mine.cardId];
    else release.push(mine.cardId);
  }
  const redDeck = release.length === 0 ? game.pools.redDeck : rng.shuffle([...game.pools.redDeck, ...release]);
  const greenDeck = gone.scorePile.length === 0 ? game.pools.greenDeck : rng.shuffle([...game.pools.greenDeck, ...gone.scorePile]);
  // `played` loses the seat even when the card is already gone (a host removal), so a leaver is never counted as having played (LLD 1 open question 20).
  const left: Round | null = round === null
    ? null
    : {
      ...round,
      submissions: round.submissions.filter((s) => s.playerId !== playerId),
      revealOrder: round.revealOrder === null || mine === undefined ? round.revealOrder : round.revealOrder.filter((c) => c !== mine.cardId),
      played: round.played.filter((id) => id !== playerId),
    };
  let state: Game = {
    ...game,
    players: game.players.map((p): Player => (p === gone ? { ...p, status, hand: [], scorePile: [] } : p)),
    pools: { ...game.pools, redDeck, redDiscard, greenDeck },
    round: left,
  };
  const draftChanges: DraftChange[] = gone.status === "writing" ? [{ playerId, draft: null }] : [];
  if (left === null || left.judgeId !== playerId) return { state, events: [], draftChanges, episodeStarted: false };
  const next = reassignJudge(state, status, rng);
  state = next.state;
  return { state, events: next.events, draftChanges, episodeStarted: true };
}
