// #29: real `decide` traces for the fan-out properties (P1, Q1): a created game driven to its end by the straight or the churned driver.
import { decide } from "../../src/decide";
import type { Game } from "../../src/types";
import { HOST_UID, pid } from "../support/factories";
import { enumerators } from "../support/legal";
import { membershipDriver, progressDriver, runScenario } from "../support/scenario";
import type { Picks } from "../support/scenario";

const ctx = (n: number) => ({ now: n, rng: { seed: "s", int: () => 0, shuffle: <T>(x: readonly T[]) => [...x] }, mintId: () => `c_000000000${n}`, actor: { kind: "user", uid: HOST_UID } as const, drafts: {} });

/** A fresh LOBBY game with the host seated; People's Choice and spectators on, pitch on when asked. */
export function created(pitch: boolean): Game {
  const c = decide(null, { type: "createGame", gameId: "gameaaaaaaaaaaaaaaaa", roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "Host" }, ctx(1));
  if (!c.ok) throw new Error("createGame");
  const u = decide(c.value.state, { type: "updateSettings", patch: { variants: { pitch, writeIn: false, redraw: false, peoplesChoice: true }, spectators: { enabled: true, vote: true } } } as never, ctx(2));
  if (!u.ok) throw new Error("updateSettings");
  return u.value.state;
}

const placeholders = (steps: number): Picks => Array.from({ length: steps }, () => ({ kind: "legal" as const, pick: 0 }));

export interface Step { prev: Game; next: Game }
/** Every step of a whole game: `prev` the state before, `next` the state after (the same object when the command was rejected). */
export function stepsOf(seed: number, players: number, churn: boolean, pitch: boolean, steps = 400): Step[] {
  const drive = churn ? membershipDriver(`${seed}`, players, enumerators) : progressDriver(`${seed}`, players, enumerators, true);
  const trace = runScenario(decide, created(pitch), placeholders(steps), { seed, table: enumerators, drive });
  const out: Step[] = [];
  for (let i = 0; i + 1 < trace.states.length; i++) {
    const prev = trace.states[i];
    const next = trace.states[i + 1];
    if (prev !== null && prev !== undefined && next !== null && next !== undefined) out.push({ prev, next });
  }
  return out;
}
