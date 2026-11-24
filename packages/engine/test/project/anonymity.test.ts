// #30 A1 to A8, H3 and K3: the anonymity suite on the real projector (LLD 2 11.1, 11.2, 11.7). The suite is a library (`anonymity.ts`); this file runs it on the real projector
// and proves it notices when something is wrong. The mutants are in mutants.test.ts.
import { describe, expect, test } from "bun:test";
import { GameViewSchema } from "@dc/contracts";
import { fcParams } from "../support/fc";
import { FIXTURES } from "./fixtures";
import { DETECTORS, REAL, AnonymityCoverageError, AnonymityViolation, missingCoverage, runAnonymitySuite, scenarioSteps } from "./anonymity";
import type { Detector, ProjectorUnderTest } from "./anonymity";
import { makeProjector, project, viewersOf } from "../../src/project";

/** The fixed seed set CI runs for coverage (H3) and for the mutants: a counter must be positive here, not just over a random seed. */
export const COVERAGE_SEED = 20_260_131;
const CI_RUNS = 200;

describe("K3 the real projector survives the suite; H3 the counters are positive over the fixed seed set", () => {
  test("every detector on, straight and churn drivers, coverage enforced", () => {
    const r = runAnonymitySuite(REAL, { numRuns: CI_RUNS, seed: COVERAGE_SEED, coverage: true });
    expect(missingCoverage(r.counters)).toEqual([]);
    expect(r.counters.steps).toBeGreaterThan(5_000);
    expect(r.counters.roundDocs).toBeGreaterThan(100);
    expect(r.counters.rejected).toBeGreaterThan(100);
    for (const k of ["revealDiffers", "timeVsJoin", "evictionInJudging", "passJudgingInJudging", "removeCardInJudging", "spectatorsOn", "spectatorsOff", "pitchOn", "pitchOff", "paused", "finishedWithVotes", "injectedWriteIn", "injectedRedraw", "injectedVotes"] as const) expect(r.counters[k], k).toBeGreaterThan(0);
    for (const n of ["N1", "N2", "N3", "N4", "N5", "N6"] as const) expect(r.counters.ni[n], n).toBeGreaterThan(0);
  });

  test("a random seed (FC_SEED, FC_NUM_RUNS) passes too; a failure names the seed", () => {
    const { seed, numRuns } = fcParams();
    try {
      runAnonymitySuite(REAL, { numRuns, seed });
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\nReproduce with FC_SEED=${seed}`, { cause: e });
    }
  });

  test("H3 a weakened generator is caught: no injection, no churn, one player count each leave a counter at zero", () => {
    for (const [weaken, zero] of [
      [["noInjection"], "injectedWriteIn"],
      [["noChurn"], "evictionInJudging"],
      [["onePlayerCount"], "cell"],
    ] as const) {
      const r = runAnonymitySuite(REAL, { numRuns: 24, seed: COVERAGE_SEED, weaken: [...weaken] });
      const missing = missingCoverage(r.counters);
      expect(missing.length, weaken.join()).toBeGreaterThan(0);
      if (zero !== "cell") expect(missing).toContain(zero);
      expect(() => runAnonymitySuite(REAL, { numRuns: 24, seed: COVERAGE_SEED, weaken: [...weaken], coverage: true })).toThrow(AnonymityCoverageError);
    }
  });
});

describe("A5 determinism (PJ1)", () => {
  test("the same seed gives the same per-step digest, a different seed another, and the inputs are deep-frozen", () => {
    const a = runAnonymitySuite(REAL, { numRuns: 6, seed: 7, detectors: ["determinism"] });
    const b = runAnonymitySuite(REAL, { numRuns: 6, seed: 7, detectors: ["determinism"] });
    const c = runAnonymitySuite(REAL, { numRuns: 6, seed: 8, detectors: ["determinism"] });
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(c.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{16,}$/);
  });
  test("scenarios replay: the same params give identical states", () => {
    const p = { seed: 3, players: 5, churn: true, pitch: true, peoplesChoice: true, spectators: true, vote: true, profanity: "on" as const, writeIn: true, redraw: true };
    expect(JSON.stringify(scenarioSteps(p, 200).steps)).toBe(JSON.stringify(scenarioSteps(p, 200).steps));
  });
});

const only = (d: Detector) => ({ numRuns: 12, seed: COVERAGE_SEED, detectors: [d] });
const planted = (over: Partial<ProjectorUnderTest>): ProjectorUnderTest => ({ ...REAL, ...over });
const fires = (impl: ProjectorUnderTest, d: Detector): AnonymityViolation => {
  try { runAnonymitySuite(impl, only(d)); } catch (e) { if (e instanceof AnonymityViolation) return e; throw e; }
  throw new Error(`${d} did not fire`);
};

describe("the suite's own checks fire on planted faults (each detector alone)", () => {
  test("determinism: a projector whose output changes between calls, and one that mutates its input", () => {
    let n = 0;
    const flaky = planted({ project: (g, v, d) => { const view = project(g, v); return view.kind === "live" ? { ...view, resolved: view.resolved + (n++ % 2) } : view; } });
    expect(fires(flaky, "determinism").detector).toBe("determinism");
    const mutating = planted({ project: (g, v) => { g.players.sort((a, b) => b.joinOrder - a.joinOrder); return project(g, v); } });
    expect(fires(mutating, "determinism").detector).toBe("determinism");
  });

  test("versioning: a view stamped with another version than the state", () => {
    const stale = planted({ project: (g, v) => { const view = project(g, v); return { ...view, version: view.version - 1 }; } });
    expect(fires(stale, "versioning").detector).toBe("versioning");
  });

  test("stability: a reveal that is rotated by the state version (the order of survivors changes across commands)", () => {
    const rot = planted({ project: (g, v) => {
      const view = project(g, v);
      if (view.kind !== "live" || view.round?.reveal == null || view.round.reveal.length < 2) return view;
      const k = g.version % view.round.reveal.length;
      return { ...view, round: { ...view.round, reveal: [...view.round.reveal.slice(k), ...view.round.reveal.slice(0, k)] } };
    } });
    expect(fires(rot, "stability").detector).toBe("stability");
  });

  test("terminal and size: a tombstone with state in it, a doc over the 64 KiB budget", () => {
    const tomb = planted({ project: (g, v) => { const view = project(g, v); return view.kind === "departed" ? { ...view, phase: g.phase } as never : view; } });
    expect(fires(tomb, "terminal").detector).toBe("terminal");
    const fat = planted({ project: (g, v) => { const view = project(g, v); return view.kind === "live" ? { ...view, players: view.players.map((p) => ({ ...p, name: p.name + "x".repeat(8_000) })) } : view; } });
    expect(fires(fat, "size").detector).toBe("size");
  });

  test("roundDocs: a Store that writes a round doc twice, and one that writes an unresolved round", () => {
    const twice = planted({ roundDocs: (_p, _n, recs) => [...recs, ...recs].map((r) => REAL.toRoundDoc(r)) });
    expect(fires(twice, "roundDocs").detector).toBe("roundDocs");
  });

  test("a violation names the detector, the scenario seed, the step and the viewer, and never carries more than a path and a short detail", () => {
    const e = fires(planted({ project: (g, v) => { const view = project(g, v); return { ...view, version: view.version - 1 }; } }), "versioning");
    expect(e.message).toMatch(/versioning/);
    expect(e.message).toMatch(/seed/);
    expect(e.message).toMatch(/step \d+/);
    expect(e.step).toBeGreaterThanOrEqual(0);
  });
});

describe("A8 a raw aggregate is not a view (runtime half of the type guards)", () => {
  test("JSON.parse(JSON.stringify(game)) fails GameViewSchema for every fixture and for scenario states", () => {
    for (const make of Object.values(FIXTURES)) expect(GameViewSchema.safeParse(JSON.parse(JSON.stringify(make()))).success).toBe(false);
    for (const { after } of scenarioSteps({ seed: 9, players: 5, churn: true, pitch: true, peoplesChoice: true, spectators: true, vote: true, profanity: "on", writeIn: true, redraw: true }, 80).steps.slice(0, 80)) {
      expect(GameViewSchema.safeParse(JSON.parse(JSON.stringify(after))).success).toBe(false);
    }
  });
  test("and the same schema accepts what the projector builds (the check can pass)", () => {
    const g = FIXTURES.judging!();
    for (const t of viewersOf(g)) expect(GameViewSchema.safeParse(makeProjector(g)(t.viewer)).success).toBe(true);
  });
});

test("the detector list is what the matrix names", () => {
  expect([...DETECTORS].sort()).toEqual(["N1", "N2", "N3", "N4", "N5", "N6", "cards", "determinism", "drafts", "identity", "internals", "keyOrder", "order", "othersData", "ownership", "roundDocs", "size", "stability", "strictParse", "subset", "terminal", "time", "versioning", "writeInMarker"]);
});
