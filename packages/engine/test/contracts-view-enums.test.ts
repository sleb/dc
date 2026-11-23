// #27 V8: the contracts enum tuples equal the Engine's literal types in both directions (LLD 5 2.5; LLD 2 11.6 `_d`).
import { expect, test } from "bun:test";
import { PHASES, PLAYER_STATUSES, ROUND_PHASES } from "@dc/contracts";
import type { Phase, PlayerStatus, RoundPhase } from "../src/types";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>(): void => undefined;
assertType<Equal<(typeof PHASES)[number], Phase>>();
assertType<Equal<(typeof PLAYER_STATUSES)[number], PlayerStatus>>();
assertType<Equal<(typeof ROUND_PHASES)[number], RoundPhase>>();

// Exhaustive maps: an Engine addition fails compilation here, and the runtime check pins the tuple.
const enginePhases: Record<Phase, true> = { LOBBY: true, WRITING: true, PLAYING: true, FINISHED: true, ENDED: true };
const engineStatuses: Record<PlayerStatus, true> = { writing: true, ready: true, active: true, left: true, removed: true };
const engineRoundPhases: Record<RoundPhase, true> = { SUBMITTING: true, JUDGING: true };

test("V8 the contracts tuples list exactly the Engine's phases, statuses and round phases", () => {
  expect([...PHASES].sort()).toEqual(Object.keys(enginePhases).sort());
  expect([...PLAYER_STATUSES].sort()).toEqual(Object.keys(engineStatuses).sort());
  expect([...ROUND_PHASES].sort()).toEqual(Object.keys(engineRoundPhases).sort());
});
