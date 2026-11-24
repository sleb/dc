// #30: the anonymity suite (LLD 2 11.1 to 11.4, 11.7). `runAnonymitySuite(impl, options)` drives real `decide` scenarios (straight and churned, 3 to 10 players, every variant on or off, junk commands,
// injected write-ins, redraws and votes), and after every step checks every view doc of every viewer: the forbidden-values oracle (11.2), the cross-viewer and cross-step invariants (PJ6, PJ8, PJ9, PJ10,
// PJ14), determinism, the round docs (PJ13), the key order (PJ15) and non-interference (11.3). It throws `AnonymityViolation` at the first violation of an ENABLED detector, so the mutation matrix
// (mutants.ts) can switch detectors off one at a time and prove each kills a mutant alone. The real projector is `REAL`; a mutant wraps it.
import { RoundDocSchema, VIEW_DOC_BUDGET_BYTES, ViewDocSchema } from "@dc/contracts";
import type { Command, GameView, RoundDoc } from "@dc/contracts";
import fc from "fast-check";
import { decide } from "../../src/decide";
import { EngineInvariantError } from "../../src/errors";
import { PROJECTOR_REV, makeProjector, toRoundDoc, viewersOf } from "../../src/project";
import { fanOutWith } from "../../src/project/fanout";
import type { Viewer, ViewTarget } from "../../src/project";
import { makeRng } from "../../src/rng";
import type { Actor, Game, GameDrafts, RoundRecord } from "../../src/types";
import { deepFreeze } from "../support/factories";
import { junkCommands, legalCommands, enumerators } from "../support/legal";
import type { LegalEntry } from "../support/legal";
import { membershipDriver, progressDriver, runScenario } from "../support/scenario";
import type { Driver } from "../support/scenario";
import { AUDIENCES, NOT_APPLICABLE, PHASES } from "./cells";
import { decorate, sentinelDriver } from "./inject";
import type { VariantKind } from "./inject";
import { keyOrderViolations } from "./keyorder";
import { nonInterference, resolveWith, TRANSFORMATIONS } from "./noninterference";
import type { NName } from "./noninterference";
import { canon, checkDoc, checkRoundDoc } from "./oracle";
import type { Detector as OracleDetector, Finding } from "./oracle";
import { SimRounds, SimStore, commit } from "./store-sim";
import { storedDoc } from "./stored";

export const DETECTORS = [
  // the forbidden-values oracle (11.2)
  "cards", "drafts", "ownership", "identity", "internals", "strictParse", "othersData", "writeInMarker",
  // cross-viewer and cross-step checks
  "order", "time", "subset", "terminal", "size", "versioning", "stability", "determinism",
  // round docs and key order
  "roundDocs", "keyOrder",
  // non-interference (11.3)
  "N1", "N2", "N3", "N4", "N5", "N6",
] as const;
export type Detector = (typeof DETECTORS)[number];
const ORACLE: readonly OracleDetector[] = ["cards", "drafts", "ownership", "identity", "internals", "strictParse", "othersData", "writeInMarker"];
const NI: readonly NName[] = ["N1", "N2", "N3", "N4", "N5", "N6"];

/** The real module, or a leaky mutant. `project` also receives the draft documents: a real projector never sees them (LLD 1 E8) and ignores the argument; a mutant that leaks them needs them. */
export interface ProjectorUnderTest {
  project(g: Game, v: Viewer, drafts: GameDrafts): GameView;
  viewersOf(g: Game): ViewTarget[];
  /** `before` is the state the record resolved from; the real function ignores it. */
  toRoundDoc(rec: RoundRecord, before: Game): RoundDoc;
  /** The round docs one commit writes (default: one `toRoundDoc` per record). A write path that leaks (M-resolve) overrides this. */
  roundDocs?(prev: Game, next: Game, records: readonly RoundRecord[]): RoundDoc[];
}

const projectors = new WeakMap<Game, (v: Viewer) => GameView>();
export const REAL: ProjectorUnderTest = {
  project: (g, v) => {
    let at = projectors.get(g);
    if (at === undefined) { at = makeProjector(g); projectors.set(g, at); }
    return at(v);
  },
  viewersOf,
  toRoundDoc: (rec) => toRoundDoc(rec),
};

export class AnonymityViolation extends Error {
  constructor(readonly detector: Detector, readonly seed: number, readonly step: number, readonly viewer: string, readonly path: string, detail: string) {
    super(`anonymity violation [${detector}] seed ${seed} step ${step} viewer ${viewer} at ${path}: ${detail}`);
    this.name = "AnonymityViolation";
  }
}
export class AnonymityCoverageError extends Error {
  constructor(readonly missing: string[]) {
    super(`the generator never reached: ${missing.join(", ")}`);
    this.name = "AnonymityCoverageError";
  }
}

// ---------------------------------------------------------------- scenarios

export interface ScenarioParams { seed: number; players: number; churn: boolean; pitch: boolean; peoplesChoice: boolean; spectators: boolean; vote: boolean; profanity: "on" | "off"; writeIn: boolean; redraw: boolean }
export interface StepRec {
  index: number;
  before: Game;
  after: Game;
  draftsBefore: GameDrafts;
  drafts: GameDrafts;
  accepted: boolean;
  aggregateChanged: boolean;
  cmd: Command;
  actor: Actor;
  records: RoundRecord[];
  now: number;
}
export interface Scenario { initial: Game; steps: StepRec[] }
export type Weaken = "noInjection" | "noChurn" | "onePlayerCount";

const arbParams: fc.Arbitrary<ScenarioParams> = fc.record({
  seed: fc.integer({ min: 0, max: 2 ** 30 }),
  players: fc.integer({ min: 3, max: 10 }),
  churn: fc.constantFrom(true, true, false),
  pitch: fc.boolean(),
  peoplesChoice: fc.boolean(),
  spectators: fc.boolean(),
  vote: fc.boolean(),
  profanity: fc.constantFrom("on" as const, "off" as const),
  writeIn: fc.boolean(),
  redraw: fc.boolean(),
});

export function sampleParams(seed: number, numRuns: number, weaken: readonly Weaken[] = []): ScenarioParams[] {
  return fc.sample(arbParams, { seed, numRuns }).map((p) => ({ ...p, ...(weaken.includes("noChurn") ? { churn: false } : {}), ...(weaken.includes("onePlayerCount") ? { players: 4 } : {}) }));
}

function createdWith(p: ScenarioParams): Game {
  const ctx = (n: number) => ({ now: n, rng: makeRng("s"), mintId: () => `c_000000000${n}`, actor: { kind: "user", uid: "host-uid" } as const, drafts: {} });
  const c = decide(null, { type: "createGame", gameId: "gameaaaaaaaaaaaaaaaa", roomCode: "BCDF", hostId: "host-uid", hostPlayerId: "p_aaaaaaaa", hostName: "Host" }, ctx(1));
  if (!c.ok) throw new Error("createGame");
  const patch = { profanity: p.profanity, variants: { pitch: p.pitch, writeIn: p.writeIn, redraw: p.redraw, peoplesChoice: p.peoplesChoice }, spectators: { enabled: p.spectators, vote: p.vote } };
  const u = decide(c.value.state, { type: "updateSettings", patch } as never, ctx(2));
  if (!u.ok) throw new Error("updateSettings");
  return u.value.state;
}

/**
 * The churned driver of the suite: `membershipDriver`, plus membership changes in LOBBY, an `endGame` now and then, and, while a round is in JUDGING, a good chance of something other than the
 * pick: `passJudging`, a leave, a removal, a `removeCard`, a join. That is what keeps a JUDGING round alive across commands (E10, A3).
 */
function churnDriver(seed: string, players: number): Driver {
  const base = membershipDriver(seed, players, enumerators);
  return (state, drafts, i) => {
    const rng = makeRng(`${seed}:anon:${i}`);
    const by = (types: readonly string[]): LegalEntry[] => legalCommands(state, drafts, enumerators).filter((e) => types.includes(e.cmd.type));
    const any = (xs: LegalEntry[]): LegalEntry | undefined => xs[rng.int(Math.max(1, xs.length))];
    if (state.phase === "LOBBY" && state.players.length >= players && rng.int(6) === 0) return any(by(["leave", "removePlayer"])) ?? base(state, drafts, i);
    if (state.phase === "PLAYING" && state.round?.phase === "JUDGING" && rng.int(100) < 55) {
      const kinds = ["passJudging", "leave", "removePlayer", "removeCard", "join"].filter((t) => by([t]).length > 0);
      const pick = kinds.length === 0 ? undefined : any(by([kinds[rng.int(kinds.length)] as string]));
      if (pick !== undefined) return pick;
    }
    if ((state.phase === "PLAYING" || state.phase === "WRITING") && rng.int(70) === 0) return any(by(["endGame"])) ?? base(state, drafts, i);
    return base(state, drafts, i);
  };
}

/** Roughly one step in nine is a command the Engine will refuse (a stranger, a stale version, a bogus id): rejected steps are steps too (11.1). */
function withJunk(inner: Driver, seed: string): Driver {
  return (state, drafts, i) => {
    const rng = makeRng(`${seed}:junk:${i}`);
    if (rng.int(9) !== 0) return inner(state, drafts, i);
    const pool = junkCommands(state);
    return pool[rng.int(pool.length)];
  };
}

/** One scenario as a list of steps: the state before and after, the draft documents, whether `decide` accepted, and the round records it returned. Deterministic in `p`. */
export function scenarioSteps(p: ScenarioParams, maxSteps = 400): Scenario {
  const initial = createdWith(p);
  const inner = p.churn ? churnDriver(`${p.seed}`, p.players) : progressDriver(`${p.seed}`, p.players, enumerators, true);
  const drive = withJunk(sentinelDriver(inner), `${p.seed}`);
  const steps: StepRec[] = [];
  const picks = Array.from({ length: maxSteps }, () => ({ kind: "legal" as const, pick: 0 }));
  runScenario(decide, initial, picks, {
    seed: p.seed, table: enumerators, drive,
    afterStep: (i) => {
      const ok = i.step.result.ok ? i.step.result.value : null;
      steps.push({ index: i.step.index, before: i.before, after: i.after, draftsBefore: i.draftsBefore, drafts: i.drafts, accepted: i.accepted, aggregateChanged: ok?.aggregateChanged ?? false, cmd: i.step.cmd as Command, actor: i.step.actor as Actor, records: ok?.roundRecords ?? [], now: 1_000 + i.step.index });
    },
  });
  return { initial, steps };
}

const cache = new Map<string, Scenario>();
function scenarioOf(p: ScenarioParams, maxSteps: number): Scenario {
  const key = `${JSON.stringify(p)}:${maxSteps}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const s = scenarioSteps(p, maxSteps);
  cache.set(key, s);
  if (cache.size > 64) cache.delete(cache.keys().next().value as string);
  return s;
}

// ---------------------------------------------------------------- counters (H3)

export interface Counters {
  steps: number; rejected: number; docs: number; roundDocs: number;
  cells: Record<string, number>;
  revealDiffers: number; timeVsJoin: number; evictionInJudging: number; passJudgingInJudging: number; removeCardInJudging: number;
  spectatorsOn: number; spectatorsOff: number; pitchOn: number; pitchOff: number; paused: number; finishedWithVotes: number;
  /** Scenarios that started with a large table (9 or 10 players) and with the smallest (3). */
  largeTable: number; smallTable: number;
  injectedWriteIn: number; injectedRedraw: number; injectedVotes: number;
  ni: Record<NName, number>;
}
const newCounters = (): Counters => ({
  steps: 0, rejected: 0, docs: 0, roundDocs: 0, cells: {},
  revealDiffers: 0, timeVsJoin: 0, evictionInJudging: 0, passJudgingInJudging: 0, removeCardInJudging: 0,
  spectatorsOn: 0, spectatorsOff: 0, pitchOn: 0, pitchOff: 0, paused: 0, finishedWithVotes: 0, largeTable: 0, smallTable: 0,
  injectedWriteIn: 0, injectedRedraw: 0, injectedVotes: 0,
  ni: { N1: 0, N2: 0, N3: 0, N4: 0, N5: 0, N6: 0 },
});
const SCALARS = ["revealDiffers", "timeVsJoin", "evictionInJudging", "passJudgingInJudging", "removeCardInJudging", "spectatorsOn", "spectatorsOff", "pitchOn", "pitchOff", "paused", "finishedWithVotes", "largeTable", "smallTable", "injectedWriteIn", "injectedRedraw", "injectedVotes"] as const;

/** Counters that are zero, and (phase, audience) cells never seen. Empty means the generator reached everything H3 lists. */
export function missingCoverage(c: Counters): string[] {
  const out: string[] = SCALARS.filter((k) => c[k] === 0);
  for (const n of NI) if (c.ni[n] === 0) out.push(`ni.${n}`);
  for (const ph of PHASES) for (const au of AUDIENCES) if (!NOT_APPLICABLE.some(([p, a]) => p === ph && a === au) && (c.cells[`${ph}/${au}`] ?? 0) === 0) out.push(`cell ${ph}/${au}`);
  if (c.roundDocs === 0) out.push("roundDocs");
  return out;
}

// ---------------------------------------------------------------- the suite

export interface SuiteOptions {
  numRuns: number;
  seed: number;
  /** Which detectors may fail the run (default: all). A violation of a disabled detector is ignored. */
  detectors?: readonly Detector[];
  /** Fail with `AnonymityCoverageError` if a counter of H3 is zero. */
  coverage?: boolean;
  /** Switch parts of the generator off to see the coverage counters notice (test of the test). */
  weaken?: readonly Weaken[];
  maxSteps?: number;
}
export interface SuiteResult { counters: Counters; digest: string }

const isSubset = (a: unknown, b: unknown): boolean => {
  if (a === null || typeof a !== "object") return a === b;
  if (Array.isArray(a)) return canon(a) === canon(b);
  if (b === null || typeof b !== "object" || Array.isArray(b)) return false;
  return Object.entries(a).every(([k, v]) => Object.hasOwn(b, k) && isSubset(v, (b as Record<string, unknown>)[k]));
};

const bytes = (s: string): number => new TextEncoder().encode(s).length;

class Fnv {
  private a = 0x811c9dc5;
  private b = 0x01000193;
  add(s: string): void {
    for (let i = 0; i < s.length; i++) {
      this.a = Math.imul(this.a ^ s.charCodeAt(i), 0x01000193) >>> 0;
      this.b = Math.imul(this.b + s.charCodeAt(i), 0x85ebca6b) >>> 0;
    }
  }
  hex(): string { return this.a.toString(16).padStart(8, "0") + this.b.toString(16).padStart(8, "0"); }
}

const SPECTATOR: Viewer = { kind: "spectator", uid: null, isHost: false };

export function runAnonymitySuite(impl: ProjectorUnderTest, o: SuiteOptions): SuiteResult {
  const on = new Set<Detector>(o.detectors ?? DETECTORS);
  const counters = newCounters();
  const digest = new Fnv();
  const maxSteps = o.maxSteps ?? 400;
  const niIds = new Set<NName>(NI.filter((n) => on.has(n)));
  const params = sampleParams(o.seed, o.numRuns, o.weaken ?? []);

  for (const [pi, p] of params.entries()) {
    const sc = scenarioOf(p, maxSteps);
    if (p.players >= 9) counters.largeTable++;
    if (p.players === 3) counters.smallTable++;
    let stepIndex = -1;
    let viewerLabel = "-";
    const fail = (d: Detector, path: string, detail: string): void => {
      if (on.has(d)) throw new AnonymityViolation(d, p.seed, stepIndex, viewerLabel, path, detail);
    };
    const report = (fs: readonly Finding[]): void => { for (const f of fs) fail(f.detector, f.path, f.detail); };
    const guard = <T>(d: Detector, what: string, f: () => T): T | undefined => {
      try { return f(); } catch (e) {
        if (e instanceof AnonymityViolation) throw e;
        fail(d, "(call)", `${what} threw ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
        return undefined;
      }
    };

    let states = 0;
    const checkState = (game: Game, drafts: GameDrafts, kinds: readonly VariantKind[] | null): void => {
      states++;
      const targets = impl.viewersOf(game);
      const views: { t: ViewTarget; view: GameView | null; doc: Record<string, unknown> }[] = [];
      counters[game.settings.spectators.enabled ? "spectatorsOn" : "spectatorsOff"]++;
      counters[game.settings.variants.pitch ? "pitchOn" : "pitchOff"]++;
      if (game.paused) counters.paused++;
      const r = game.round;
      if (game.phase === "PLAYING" && r !== null) {
        if (r.phase === "JUDGING" && (r.revealOrder?.length ?? 0) >= 2 && r.revealOrder?.join() !== r.submissions.map((s) => s.cardId).join()) counters.revealDiffers++;
        const order = new Map(game.players.map((x) => [x.id, x.joinOrder]));
        const subs = r.submissions.map((s) => s.playerId);
        if (r.phase === "SUBMITTING" && subs.length >= 2 && subs.join() !== [...subs].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).join()) counters.timeVsJoin++;
      }
      if (kinds !== null) {
        if (kinds.includes("writeIn")) counters.injectedWriteIn++;
        if (kinds.includes("redraw")) counters.injectedRedraw++;
        if (kinds.includes("votes")) { counters.injectedVotes++; if (game.phase === "FINISHED") counters.finishedWithVotes++; }
      }

      for (const t of targets) {
        viewerLabel = t.docId.startsWith("seat:") ? "seat" : t.docId;
        const off = t.viewer.kind === "spectator" && t.viewer.uid === null && !game.settings.spectators.enabled;
        const view = off ? null : impl.project(game, t.viewer, drafts);
        const doc = storedDoc(game, drafts, t.viewer, view);
        views.push({ t, view, doc });
        counters.docs++;
        const json = JSON.stringify(doc);
        digest.add(`${t.docId}|${json}`);
        if (view === null) continue;
        if (view.kind === "live") {
          const ph = view.phase === "PLAYING" ? (view.paused ? "PAUSED" : (view.round?.phase ?? "SUBMITTING")) : view.phase;
          const au = view.audience === "player" ? (view.you.isJudge ? "judge" : view.you.isHost ? "host" : "player") : view.audience === "host" ? "unseatedHost" : "spectator";
          counters.cells[`${ph}/${au}`] = (counters.cells[`${ph}/${au}`] ?? 0) + 1;
        }
        // 11.2 oracle
        if (ORACLE.some((d) => on.has(d))) report(checkDoc(game, drafts, t.viewer, doc, { mode: "tokens", parse: kinds !== null || (states + views.length) % 4 === 0 }));
        // PJ14
        if (on.has("size") && bytes(json) > VIEW_DOC_BUDGET_BYTES) fail("size", "(doc)", `${bytes(json)} bytes over the ${VIEW_DOC_BUDGET_BYTES} budget`);
        // PJ10: the view carries the aggregate's version
        if (view.version !== game.version) fail("versioning", "view.version", `${view.version} is not ${game.version}`);
        if (doc.version !== game.version) fail("versioning", "version", `${String(doc.version)} is not ${game.version}`);
        // PJ9
        if (view.kind === "departed") {
          const keys = Object.keys(view).sort().join();
          if (keys !== "audience,gameId,kind,reason,version") fail("terminal", "(view)", `a tombstone with keys ${keys}`);
          if (t.docId === game.hostId) fail("terminal", "(view)", "the host holds a tombstone (the host rule beats it)");
        } else if (game.phase === "FINISHED" || game.phase === "ENDED") {
          if (view.round !== null) fail("terminal", "view.round", "a round in a finished or ended game");
          if (view.audience === "player" && view.you.hand.length > 0) fail("terminal", "view.you.hand", "a hand in a finished or ended game");
        }
        // PJ6
        if (view.kind === "live") {
          const order = new Map(game.players.map((x) => [x.id, x.joinOrder]));
          const sorted = (ids: readonly string[]): boolean => ids.every((id, i) => i === 0 || (order.get(ids[i - 1] as string) ?? 0) < (order.get(id) ?? 0));
          if (view.round !== null) {
            if (!sorted(view.round.submittedBy)) fail("time", "view.round.submittedBy", "not in joinOrder");
            if (!sorted(view.round.expected)) fail("time", "view.round.expected", "not in joinOrder");
            const want = game.phase === "PLAYING" && game.round?.phase === "JUDGING" ? (game.round.revealOrder ?? []) : null;
            const got = view.round.reveal === null ? null : view.round.reveal.map((c) => c.submissionId);
            if (JSON.stringify(got) !== JSON.stringify(want)) fail("order", "view.round.reveal", `reveal ${JSON.stringify(got)?.slice(0, 80)} is not revealOrder ${JSON.stringify(want)?.slice(0, 80)}`);
            for (const c of view.round.reveal ?? []) {
              const sub = game.round?.submissions.find((s) => s.cardId === c.submissionId);
              if (c.text !== game.cards[c.submissionId]?.text || c.pitch !== (sub?.pitch ?? null)) fail("order", "view.round.reveal", "an entry that is not the card's own text and pitch");
            }
          }
        }
      }

      // PJ6 across viewers, PJ8
      viewerLabel = "(all)";
      const live = views.filter((v): v is typeof v & { view: Extract<GameView, { kind: "live" }> } => v.view !== null && v.view.kind === "live");
      const reveals = new Set(live.map((v) => canon(v.view.round?.reveal ?? null)));
      if (reveals.size > 1) fail("order", "view.round.reveal", "two viewers see different reveals");
      const spec = live.find((v) => v.view.audience === "spectator");
      if (spec !== undefined) {
        const { audience: _a, ...rest } = spec.view;
        for (const v of live) if (v.view.audience !== "spectator" && !isSubset(rest, v.view)) fail("subset", "(view)", `the spectator view is not a subset of the ${v.view.audience} view of ${v.t.docId === game.hostId ? "the host" : "a player"}`);
      }

      // A5 inputs are never mutated: project a frozen copy and compare bytes
      if (on.has("determinism") && states % 3 === 1) {
        viewerLabel = "(frozen)";
        const g = deepFreeze(structuredClone(game));
        const d = deepFreeze(structuredClone(drafts));
        const again = guard("determinism", "projecting a frozen state", () => impl.viewersOf(g).map((t) => JSON.stringify(storedDoc(g, d, t.viewer, game.settings.spectators.enabled || t.viewer.kind !== "spectator" || t.viewer.uid !== null ? impl.project(g, t.viewer, d) : null))));
        if (again !== undefined && again.join("|") !== views.map((v) => JSON.stringify(v.doc)).join("|")) fail("determinism", "(docs)", "the docs of a frozen copy differ from the docs of the original");
      }

      // 11.3 non-interference, sampled: the judge, the shared spectator and one rotating viewer
      if (niIds.size > 0) {
        const pick = new Map<string, ViewTarget>();
        const judgeId = game.round?.judgeId ?? null;
        for (const t of targets) if (t.viewer.kind === "player" && t.viewer.playerId === judgeId) pick.set(t.docId, t);
        for (const t of targets) if (t.viewer.kind === "spectator" && t.viewer.uid === null) pick.set(t.docId, t);
        const rot = targets[(states + p.seed) % targets.length];
        if (rot !== undefined) pick.set(rot.docId, rot);
        for (const t of pick.values()) {
          viewerLabel = t.docId.startsWith("seat:") ? "seat" : t.docId;
          const res = nonInterference(impl, game, drafts, t.viewer, niIds, (id) => { counters.ni[id]++; });
          if (res !== null) fail(res.id, res.path, `${res.name}: the view moved`);
        }
      }
    };

    // ---- the scenario
    const spec0 = sc.initial;
    stepIndex = -1;
    checkState(spec0, {}, null);
    const store = new SimStore();
    const rounds = new SimRounds();
    const fan = { project: (g: Game) => (v: Viewer) => impl.project(g, v, {}), rev: PROJECTOR_REV };
    let fanOk = on.has("versioning") || on.has("keyOrder") || on.has("strictParse");
    const NOW = 1_700_000_000_000;
    if (fanOk) {
      viewerLabel = "(fanOut)";
      const ok = guard("strictParse", "the first fan-out", () => { store.apply(fanOutWith(fan, null, spec0, { now: NOW, skipUnchanged: false })); store.viewsRev = PROJECTOR_REV; return true; });
      fanOk = ok === true;
    }
    let lastGame: Game = spec0;
    let lastDrafts: GameDrafts = {};
    let prevReveal: { round: number; ids: string[] } | null = null;

    for (const s of sc.steps) {
      stepIndex = s.index;
      viewerLabel = "-";
      counters.steps++;
      if (!s.accepted) counters.rejected++;
      const b = s.before.round;
      const a = s.after.round;
      const t = (s.cmd as { type: string }).type;
      if (s.accepted && b?.phase === "JUDGING" && a?.phase === "JUDGING" && a.number === b.number) {
        if (t === "leave" || t === "removePlayer") counters.evictionInJudging++;
        if (t === "passJudging") counters.passJudgingInJudging++;
        if (t === "removeCard") counters.removeCardInJudging++;
      }

      // the state itself, and (when the generator allows) a decorated copy of it
      if (s.after !== lastGame || s.drafts !== lastDrafts) checkState(s.after, s.drafts, null);
      lastGame = s.after;
      lastDrafts = s.drafts;
      const terminal = s.after.phase === "FINISHED" || s.after.phase === "ENDED";
      if (!(o.weaken ?? []).includes("noInjection") && (s.index % 4 === 1 || terminal)) {
        const v = decorate(s.after, s.index + p.seed);
        if (v !== null) checkState(v.game, s.drafts, v.kinds);
      }

      // PJ6 across commands (A3): the survivors of a JUDGING round keep their order
      if (on.has("stability")) {
        viewerLabel = "spectator";
        const view = impl.project(s.after, SPECTATOR, s.drafts);
        const ids = view.kind === "live" && view.round?.reveal != null ? view.round.reveal.map((c) => c.submissionId) : null;
        const number = view.kind === "live" ? (view.round?.number ?? -1) : -1;
        if (ids !== null && prevReveal !== null && prevReveal.round === number) {
          const keep = new Set(ids);
          const was = prevReveal.ids.filter((id) => keep.has(id));
          const now = ids.filter((id) => prevReveal?.ids.includes(id) === true);
          if (was.join() !== now.join()) fail("stability", "view.round.reveal", "the surviving cards changed order across commands");
        }
        prevReveal = ids === null ? null : { round: number, ids };
      }

      // PJ10, PJ15 through fanOut and the store simulation
      if (fanOk) {
        viewerLabel = "(fanOut)";
        const res = guard("versioning", "the commit", () => {
          let writes;
          try {
            writes = commit(store, fan, s.before, s.after, { aggregateChanged: s.aggregateChanged, now: NOW });
          } catch (e) {
            if (e instanceof EngineInvariantError) { fail("strictParse", "(fanOut)", e.message.slice(0, 160)); return null; }
            throw e;
          }
          return writes;
        });
        if (res === undefined || res === null) fanOk = on.has("strictParse") ? false : fanOk && res !== null;
        else {
          if (!s.aggregateChanged && res.length > 0) fail("versioning", "(fanOut)", "a command that changed nothing wrote views");
          if (!s.aggregateChanged && s.after.version !== s.before.version) fail("versioning", "version", "a command that changed nothing moved the version");
          for (const w of res) {
            if (w.doc.version !== s.after.version) fail("versioning", w.docId, "a write with another version than the state");
            for (const v of keyOrderViolations(w.doc, ViewDocSchema)) fail("keyOrder", w.docId, v);
          }
          if (s.index % 5 === 0) {
            const reissue = guard("strictParse", "a reissue", () => fanOutWith(fan, s.after, s.after, { now: NOW + 1, skipUnchanged: true }));
            if (reissue !== undefined && reissue.length > 0) fail("versioning", "(fanOut)", "a rejoin or reissue wrote a view");
          }
        }
      }

      // PJ13, PJ15: the round docs this commit writes (a leaky write path may write one on a command that resolved nothing)
      if (s.accepted && (on.has("roundDocs") || on.has("keyOrder") || ORACLE.some((d) => on.has(d)))) {
        viewerLabel = "(round docs)";
        const docs = impl.roundDocs !== undefined ? impl.roundDocs(s.before, s.after, s.records) : s.records.map((rec) => impl.toRoundDoc(rec, s.before));
        counters.roundDocs += docs.length;
        guard("roundDocs", "the round-doc store", () => rounds.apply(docs, s.after));
        for (const d of docs) {
          const rec = s.records.find((x) => x.round === d.round);
          if (rec === undefined) { fail("roundDocs", "(doc)", `a doc for round ${d.round}, which this command did not resolve`); continue; }
          if (canon(d) !== canon(toRoundDoc(rec))) fail("roundDocs", "(doc)", `the doc of round ${d.round} is not toRoundDoc(record)`);
          if (!RoundDocSchema.safeParse(d).success) fail("strictParse", "(doc)", "a round doc that does not parse");
          for (const v of keyOrderViolations(d, RoundDocSchema)) fail("keyOrder", "(round doc)", v);
          report(checkRoundDoc(s.before, rec, d, s.draftsBefore, "tokens"));
        }
        // K-A: a write-in author's play must make no difference to the round doc (N6) and carry no marker
        if (t === "pickWinner" && !(o.weaken ?? []).includes("noInjection")) {
          const v = decorate(s.before, s.index + p.seed);
          if (v !== null && v.kinds.includes("writeIn") && v.game.round !== null) {
            const toggle = TRANSFORMATIONS.find((x) => x.id === "N6");
            const owner = s.actor.kind === "user" ? s.actor.uid : "";
            const marked = resolveWith(impl, v.game, s.cmd, owner);
            const other = toggle?.apply(v.game, s.draftsBefore, { kind: "spectator", uid: null, isHost: false });
            const plain = other === null || other === undefined ? null : resolveWith(impl, other.game, s.cmd, owner);
            if (marked !== null) {
              if (plain !== null) counters.ni.N6++;
              for (let i = 0; i < marked.docs.length; i++) report(checkRoundDoc(v.game, marked.records[i] as RoundRecord, marked.docs[i] as RoundDoc, s.draftsBefore, "tokens"));
              if (plain !== null && canon(marked.docs) !== canon(plain.docs)) fail("N6", "(round doc)", "N6 on round docs: a write-in play changed the round doc");
            }
          }
        }
      }
    }

    // A5: the same scenario twice gives the same states
    if (on.has("determinism") && pi % 8 === 0) {
      viewerLabel = "(replay)";
      stepIndex = -1;
      const again = scenarioSteps(p, maxSteps);
      const h = (x: Scenario): string => { const f = new Fnv(); for (const st of x.steps) f.add(JSON.stringify([st.after, st.drafts, st.accepted])); return f.hex(); };
      if (h(again) !== h(sc)) fail("determinism", "(scenario)", "the same scenario replayed to different states");
    }
  }

  if (o.coverage === true) {
    const missing = missingCoverage(counters);
    if (missing.length > 0) throw new AnonymityCoverageError(missing);
  }
  return { counters, digest: digest.hex() };
}
