import fc from "fast-check";

type Env = Record<string, string | undefined>;

/** fast-check parameters from the environment (LLD 0 P11): `FC_SEED` pins the seed, `FC_NUM_RUNS` overrides 200 (CI), 2000 (nightly). */
export function fcParams(env: Env = process.env): { seed: number; numRuns: number } {
  const raw = env.FC_SEED?.trim();
  const seed = raw === undefined || raw === "" ? Math.floor(Math.random() * 2 ** 31) : Number(raw);
  // fast-check seeds are 32-bit integers; anything wider may be truncated and would not replay.
  if (!Number.isInteger(seed) || seed < -(2 ** 31) || seed >= 2 ** 31) throw new Error(`FC_SEED must be a 32-bit integer, got "${env.FC_SEED}"`);
  const rawRuns = env.FC_NUM_RUNS?.trim();
  const numRuns = rawRuns === undefined || rawRuns === "" ? 200 : Number(rawRuns);
  if (!Number.isInteger(numRuns) || numRuns < 1) throw new Error(`FC_NUM_RUNS must be a positive integer, got "${env.FC_NUM_RUNS}"`);
  return { seed, numRuns };
}

/** `fc.assert` with the seed pinned; a failure is rethrown with `FC_SEED=<n>` so the run can be replayed. */
export function assertProperty<T>(property: fc.IPropertyWithHooks<T>, env: Env = process.env): void {
  const params = fcParams(env);
  try {
    fc.assert(property, params);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`${message}\nReproduce with FC_SEED=${params.seed}`, { cause: e });
  }
}
