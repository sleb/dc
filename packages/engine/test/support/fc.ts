import fc from "fast-check";

type Env = Record<string, string | undefined>;

/** fast-check parameters from the environment (LLD 0 P11): `FC_SEED` pins the seed, `FC_NUM_RUNS` overrides 200 (CI), 2000 (nightly). */
export function fcParams(env: Env = process.env): { seed: number; numRuns: number } {
  const raw = env.FC_SEED;
  const seed = raw === undefined || raw === "" ? Math.floor(Math.random() * 2 ** 31) : Number(raw);
  if (!Number.isInteger(seed)) throw new Error(`FC_SEED must be an integer, got "${raw}"`);
  return { seed, numRuns: Number(env.FC_NUM_RUNS) || 200 };
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
