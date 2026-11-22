import { expect } from "bun:test";
import type { Accepted, Game, Rejection, Result } from "../../src/types";

/** One `decide` call and what came out of it, as seen by the global checkers. */
export interface Step {
  index: number;
  seed?: number | string;
  before: Game | null;
  cmd: unknown;
  result: Result<Accepted, Rejection>;
}
export type Checker = (step: Step) => void;

/** Path of the first value that is not plain JSON data (undefined, function, symbol, bigint, non-finite number, Map, Set, Date, class instance), else null. */
export function findNonJson(value: unknown, path = "$"): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (typeof value !== "object") return path;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const bad = findNonJson(v, `${path}[${i}]`);
      if (bad !== null) return bad;
    }
    return null;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return path;
  for (const [k, v] of Object.entries(value)) {
    const bad = findNonJson(v, `${path}.${k}`);
    if (bad !== null) return bad;
  }
  return null;
}

/** X2: the new state survives JSON and holds no `undefined` (Firestore). */
export const checkSerializable: Checker = ({ result }) => {
  if (!result.ok) return;
  const bad = findNonJson(result.value.state);
  if (bad !== null) throw new Error(`state is not plain JSON at ${bad}`);
  expect(JSON.parse(JSON.stringify(result.value.state))).toEqual(result.value.state);
};

/** E3: the version moves by exactly one when the aggregate changed, else not at all. */
export const checkVersion: Checker = ({ before, result }) => {
  if (!result.ok) return;
  const was = before?.version ?? 0;
  const want = was + (result.value.aggregateChanged ? 1 : 0);
  if (result.value.state.version !== want) throw new Error(`version is ${result.value.state.version}, expected ${want} (before ${was}, aggregateChanged ${result.value.aggregateChanged})`);
};

/** E3 corollary: a command reported as not changing the aggregate leaves the state deep-equal to the input (a saveDraft-style handler must not mutate state). */
export const checkUnchangedWhenNotAggregate: Checker = ({ before, result }) => {
  if (!result.ok || result.value.aggregateChanged || before === null) return;
  expect(result.value.state).toEqual(before);
};

/** Append-only: later steps push the E5 to E18 checkers here. */
export const checkers: Checker[] = [checkSerializable, checkVersion, checkUnchangedWhenNotAggregate];

/** Run every checker on a step; a failure names the step index and seed so the run can be replayed. */
export function checkAll(step: Step, list: readonly Checker[] = checkers): void {
  for (const check of list) {
    try {
      check(step);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`checker failed at step ${step.index} (seed ${String(step.seed ?? "n/a")}): ${message}`, { cause: e });
    }
  }
}
