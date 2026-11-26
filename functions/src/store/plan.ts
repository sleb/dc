// Red stub (#33): the planner arrives in the green commit.
import type { decide } from "@dc/engine";
import type { CommandInput, CommandOutcome, GameDoc, IdemDoc } from "./types";
import type { DocWrite } from "./writeset";

export interface Reads { game: GameDoc | null; idem: IdemDoc | null }
export interface PlanDeps { now: number; seed: string; mintId: () => string; decide?: typeof decide }
export interface Plan { outcome: CommandOutcome; writes: DocWrite[]; sizeWarn: boolean }

export function extraReadPaths(_r: Reads, _i: CommandInput): string[] {
  return [];
}

export function planCommand(_r: Reads, _extra: ReadonlyMap<string, Record<string, unknown> | null>, _i: CommandInput, _d: PlanDeps): Plan {
  throw new Error("red: not implemented");
}
