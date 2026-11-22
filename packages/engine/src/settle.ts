import { EngineInvariantError } from "./errors";
import { meetsMinimums, MIN_PLAYERS, totals } from "./rules/playability";
import { beginPlay, closeRound, voidRound } from "./rules/rounds";
import { waitingFields } from "./rules/waiting";
import { activePlayers, seated } from "./selectors";
import type { DomainEvent, Game, Rng } from "./types";

/**
 * `settle` runs after every aggregate-changing command, before `version` is bumped (LLD 1 section 8.2).
 * The slots are named and ordered here. Slot 2 (pause flag) and slot 5 (waiting fields) are real in 1.2, slot 1 (begin play) in 1.4 (#21),
 * slot 4 (auto-advance) in 1.5 (#22, with closeRound and voidRound). Slots 3 (recovery activation) and 3a (judge assignment) are no-ops
 * until #23, which also brings reassignJudge (activateReady, openRound and beginPlay are #21's).
 */
export type SlotId = "1" | "2" | "3" | "3a" | "4" | "5";

export interface SettleEnv {
  readonly rng: Rng;
  readonly now: number;
  /** True once the command or an earlier slot started a new waiting episode; slot 5 reads it. */
  readonly episodeStarted: boolean;
  /** Slot 4's iteration cap; defaults to MAX_ADVANCE_STEPS. Real states settle in at most two steps, so the cap is exercised by calling the slot directly with a small value; `settle` does not plumb it. */
  readonly maxAdvanceSteps?: number;
}

/** Slot 4 closes or voids at most a couple of times per command; past this it is not converging, which is a bug (EngineInvariantError), not a hang. */
export const MAX_ADVANCE_STEPS = 16;

export interface SettleStep {
  state: Game;
  events: readonly DomainEvent[];
  /** Set by a slot that starts an episode (a void or reopen with an unchanged key, a judge change). OR-ed across slots. */
  episodeStarted?: boolean;
}

export interface SettleSlot {
  readonly id: SlotId;
  run(state: Game, env: SettleEnv): SettleStep;
}

const noop = (id: SlotId): SettleSlot => ({ id, run: (state) => ({ state, events: [] }) });

/** Slot 1 (8.2): WRITING, at least 3 seated, every seated player ready and the minimums met at the frozen target: begin play. A null target or writeCounts never begins play.
 * When every seated player is ready but the minimums fail, nothing happens: the game stays in WRITING (LLD 1 sections 8.2 and 9.4). #23 owns the test. */
const beginPlaySlot: SettleSlot = {
  id: "1",
  run: (state, env) => {
    const here = seated(state);
    const ready = state.phase === "WRITING" && state.target !== null && state.writeCounts !== null && here.length >= MIN_PLAYERS && here.every((p) => p.status === "ready");
    if (!ready || state.target === null || !meetsMinimums(totals(state), here.length, state.target)) return { state, events: [] };
    const out = beginPlay(state, env.rng, env.now);
    return { state: out.state, events: out.events, episodeStarted: true }; // a new round is a new episode
  },
};

/** `paused` (LLD 1 section 8.1): PLAYING needs 3 active, WRITING needs 3 seated, any other phase is never paused. */
export function computePaused(g: Game): boolean {
  if (g.phase === "PLAYING") return activePlayers(g).length < 3;
  if (g.phase === "WRITING") return seated(g).length < 3;
  return false;
}

/**
 * Slot 4 (8.2): auto-advance, only in PLAYING and not paused, repeated until stable. A SUBMITTING round in which no expected player (roster, not the judge, still active)
 * lacks a submission closes `allIn` when it has a submission and is voided when it has none; a JUDGING round with an empty `revealOrder` is voided.
 * Each close or void starts a new episode. A round with no judge is left to slot 3a (#23). The void branches are unreachable by commands until eviction (#23).
 */
const autoAdvance: SettleSlot = {
  id: "4",
  run: (start, env) => {
    let state = start;
    const events: DomainEvent[] = [];
    let started = false;
    const cap = env.maxAdvanceSteps ?? MAX_ADVANCE_STEPS;
    for (let steps = 0; ; steps++) {
      const round = state.round;
      if (state.phase !== "PLAYING" || state.paused || round === null || round.judgeId === null) break;
      const active = new Set(activePlayers(state).map((p) => p.id));
      const submitted = new Set(round.submissions.map((s) => s.playerId));
      const waiting = round.roster.some((id) => id !== round.judgeId && active.has(id) && !submitted.has(id));
      const closing = round.phase === "SUBMITTING" && !waiting;
      const voiding = round.phase === "JUDGING" && (round.revealOrder?.length ?? 0) === 0;
      if (!closing && !voiding) break;
      if (steps >= cap) throw new EngineInvariantError(`settle slot 4: still advancing after ${cap} steps`);
      let step: { state: Game; events: DomainEvent[] };
      if (closing) {
        step = round.submissions.length >= 1 ? closeRound(state, env.rng, "allIn") : voidRound(state, env.rng, env.now, "no_submissions");
      } else {
        step = voidRound(state, env.rng, env.now, "no_submissions");
      }
      state = step.state;
      events.push(...step.events);
      started = true;
    }
    return started ? { state, events, episodeStarted: true } : { state, events: [] };
  },
};

const pauseFlag: SettleSlot = {
  id: "2",
  run: (state) => {
    const paused = computePaused(state);
    if (paused === state.paused) return { state, events: [] };
    return { state: { ...state, paused }, events: [{ t: "PausedChanged", paused }] };
  },
};

const waitingSlot: SettleSlot = {
  id: "5",
  run: (state, env) => ({ state: { ...state, ...waitingFields(state, env.now, env.episodeStarted) }, events: [] }),
};

export const SETTLE_SLOTS: readonly SettleSlot[] = [beginPlaySlot, pauseFlag, noop("3"), noop("3a"), autoAdvance, waitingSlot];

export function runSlots(slots: readonly SettleSlot[], state: Game, rng: Rng, now: number, episodeStarted: boolean): { state: Game; events: DomainEvent[] } {
  let current = state;
  let started = episodeStarted;
  const events: DomainEvent[] = [];
  for (const slot of slots) {
    const step = slot.run(current, { rng, now, episodeStarted: started });
    current = step.state;
    events.push(...step.events);
    started = started || step.episodeStarted === true;
  }
  return { state: current, events };
}

export function settle(state: Game, rng: Rng, now: number, episodeStarted: boolean): { state: Game; events: DomainEvent[] } {
  return runSlots(SETTLE_SLOTS, state, rng, now, episodeStarted);
}
