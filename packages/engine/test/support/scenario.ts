import fc from "fast-check";
import type { Command } from "@dc/contracts";
import { makeRng } from "../../src/rng";
import type { Accepted, Ctx, Draft, Game, GameDrafts, Rejection, Result } from "../../src/types";
import { assertDeepEqual } from "./assert";
import { checkAll } from "./checks";
import type { Step } from "./checks";
import { counterMintId, ctxFor, deepFreeze, cid, makeGame, makePlayer, makeRound, pid, addCard } from "./factories";
import type { Enumerator } from "./legal";
import type { LegalEntry } from "./legal";
import { junkCommands, legalCommands } from "./legal";
import { NEW_DECK_RED, defaultTarget, rMin } from "../../src/rules/playability";

export type Decide = (state: Game | null, cmd: Command, ctx: Ctx) => Result<Accepted, Rejection>;

export interface GameShape {
  n: number;
  /** "JUDGING" is a PLAYING game whose round has closed (at least one submission is forced). */
  phase: "LOBBY" | "WRITING" | "PLAYING" | "JUDGING" | "FINISHED";
  ready: boolean[];
  handSize: number;
  judge: number;
  submitted: boolean[];
  paused: boolean;
}

/**
 * A fixture-world game, coherent for the E5, E6 and E7 checkers: every registry card is in exactly one zone. WRITING: ready players have finished and their cards sit in the decks,
 * the others have nothing pooled. PLAYING, JUDGING, FINISHED: `target` is set, hands hold `handSize` cards, and the registry meets `meetsMinimums` (the red deck and the green deck are filled up to R_min and G_min),
 * so a resolve can top every hand up and open the next round. PLAYING and JUDGING hold an open round with the given submissions and the round's green card on the table; a JUDGING round
 * has `revealOrder` set (the submissions reversed) and at least one submission. Ids: hands 100 i + k (at most 8 players, so below 800), submissions 6000 + i, the round's green 900, greens in the deck 901 and 5000 up, filler reds 4000 up.
 */
export function buildGame(s: GameShape): Game {
  const playing = s.phase === "PLAYING" || s.phase === "JUDGING" || s.phase === "FINISHED";
  const target = defaultTarget(s.n);
  const readyAt = (i: number): boolean => s.phase === "WRITING" && s.ready[i] === true;
  let g = makeGame({
    phase: s.phase === "JUDGING" ? "PLAYING" : s.phase,
    paused: s.paused,
    version: 7,
    players: Array.from({ length: s.n }, (_, i) =>
      makePlayer(i, s.phase === "LOBBY"
        ? { status: "writing" }
        : playing
          ? { status: "active" }
          : { status: readyAt(i) ? "ready" : "writing", writeTarget: { red: NEW_DECK_RED, green: target }, writeProgress: readyAt(i) ? { red: NEW_DECK_RED, green: target } : { red: 0, green: 0 } })),
    ...(s.phase === "WRITING" ? { target, writeCounts: { red: NEW_DECK_RED, green: target } } : {}),
    ...(playing ? { target, writeCounts: { red: NEW_DECK_RED, green: target } } : {}),
  });
  if (s.phase === "WRITING") {
    for (let i = 0; i < s.n; i++) {
      if (!readyAt(i)) continue;
      for (let k = 0; k < NEW_DECK_RED; k++) g = addCard(g, cid(2000 + 100 * i + k), "red", "redDeck");
      for (let k = 0; k < target; k++) g = addCard(g, cid(3000 + 100 * i + k), "green", "greenDeck");
    }
    return g;
  }
  if (!playing) return g;
  const judge = s.judge % s.n;
  const submitters = Array.from({ length: s.n }, (_, i) => i).filter((i) => i !== judge && s.submitted[i] === true);
  if (s.phase === "JUDGING" && submitters.length === 0) submitters.push(judge === 0 ? 1 : 0);
  const open = s.phase !== "FINISHED";
  for (let i = 0; i < s.n; i++) for (let k = 0; k < s.handSize; k++) g = addCard(g, cid(100 * i + k), "red", { hand: pid(i) });
  const redHeld = s.n * s.handSize + (open ? submitters.length : 0);
  for (let k = 0; k < Math.max(0, rMin(s.n) - redHeld); k++) g = addCard(g, cid(4000 + k), "red", "redDeck");
  g = addCard(g, cid(901), "green", "greenDeck");
  for (let k = 0; k < s.n * target - 1; k++) g = addCard(g, cid(5000 + k), "green", "greenDeck");
  if (!open) return { ...g, winnerId: pid(0) };
  const submissions = submitters.map((i) => ({ playerId: pid(i), cardId: cid(6000 + i) }));
  for (const sub of submissions) g = { ...g, cards: { ...g.cards, [sub.cardId]: { kind: "red", text: `card ${sub.cardId}` } } };
  g = { ...g, cards: { ...g.cards, [cid(900)]: { kind: "green", text: "the green card" } } };
  const judging = s.phase === "JUDGING";
  return {
    ...g,
    round: makeRound({
      judgeId: pid(judge), greenCardId: cid(900), roster: g.players.map((p) => p.id), submissions, changedAtVersion: 5,
      ...(judging ? { phase: "JUDGING" as const, revealOrder: submissions.map((x) => x.cardId).reverse(), played: submissions.map((x) => x.playerId) } : {}),
    }),
    judgeCursor: judge,
  };
}

export const arbShape: fc.Arbitrary<GameShape> = fc.record({
  n: fc.integer({ min: 3, max: 6 }),
  phase: fc.constantFrom("LOBBY", "WRITING", "PLAYING", "PLAYING", "JUDGING", "JUDGING", "FINISHED"),
  ready: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
  handSize: fc.integer({ min: 0, max: 3 }),
  judge: fc.nat(5),
  submitted: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
  paused: fc.boolean(),
});

export const arbPicks = fc.array(fc.record({ kind: fc.constantFrom("legal", "legal", "legal", "junk"), pick: fc.nat(1000) }), { maxLength: 25 });
export type Picks = { kind: "legal" | "junk"; pick: number }[];

/** Picks the next command for `runScenario` from the current state and the draft documents, or undefined when the game is over. `i` is the step index. */
export type Driver = (state: Game, drafts: GameDrafts, i: number) => LegalEntry | undefined;

/** What `afterStep` receives once per step, accepted or rejected (#30, LLD 2 11.1). `after` is the state the next step starts from (the same object as `before` when the command was rejected). */
export interface AfterStepInfo {
  before: Game;
  after: Game;
  /** The draft documents after the step, and before it. */
  drafts: GameDrafts;
  draftsBefore: GameDrafts;
  accepted: boolean;
  step: Step;
}

export interface RunOptions {
  seed: number;
  /** A driver replaces the `picks` choice: the run takes up to `picks.length` steps and stops when the driver returns undefined. */
  drive?: Driver;
  now?: (step: number) => number;
  freeze?: boolean;
  table: Readonly<Record<string, Enumerator>>;
  /** Called once after every step, rejected ones included. Observes only: the trace is the same with and without it. */
  afterStep?: (info: AfterStepInfo) => void;
}
export interface Trace { states: (Game | null)[]; results: Result<Accepted, Rejection>[]; /** The command behind each result, same index. */ commands: Command[] }

/** Drive `decide` from `game0` with picks from legalCommands and junkCommands, running every global checker after every step. */
export function runScenario(decide: Decide, game0: Game | null, picks: Picks, opts: RunOptions): Trace {
  let state = game0;
  let drafts: Record<string, Draft> = {};
  const trace: Trace = { states: [state], results: [], commands: [] };
  for (const [i, p] of picks.entries()) {
    let entry: LegalEntry | undefined;
    if (opts.drive !== undefined) {
      entry = state === null ? undefined : opts.drive(state, drafts, i);
      if (entry === undefined) break; // the game is over
    } else {
      const pool = state === null ? [] : p.kind === "legal" ? legalCommands(state, drafts, opts.table) : junkCommands(state);
      entry = pool.length === 0 ? undefined : pool[p.pick % pool.length];
    }
    if (entry === undefined || state === null) continue;
    const ctx = ctxFor({ now: opts.now?.(i) ?? 1_000 + i, rng: makeRng(`${opts.seed}:${i}`), mintId: counterMintId(10_000 * (i + 1)), actor: entry.actor, drafts: drafts as GameDrafts });
    const before = structuredClone(state);
    const cmdBefore = structuredClone(entry.cmd);
    if (opts.freeze === true) { deepFreeze(state); deepFreeze(entry.cmd); deepFreeze(ctx); }
    const result = decide(state, entry.cmd, ctx);
    assertDeepEqual(state, before, `decide mutated its input state at step ${i}`);
    assertDeepEqual(entry.cmd, cmdBefore, `decide mutated its command at step ${i}`);
    const step: Step = { index: i, seed: opts.seed, before: state, cmd: entry.cmd, result, actor: entry.actor, drafts };
    const draftsBefore = drafts;
    checkAll(step);
    trace.results.push(result);
    trace.commands.push(entry.cmd);
    if (result.ok) {
      for (const c of result.value.draftChanges) {
        const { [c.playerId]: _gone, ...rest } = drafts;
        drafts = c.draft === null ? rest : { ...rest, [c.playerId]: c.draft };
      }
      if (result.value.deleteGame !== true) state = result.value.state;
    }
    trace.states.push(state);
    opts.afterStep?.({ before: step.before as Game, after: state, drafts: drafts as GameDrafts, draftsBefore: draftsBefore as GameDrafts, accepted: result.ok, step });
  }
  return trace;
}

/** Zero the five time fields (LLD 1 section 5.4) for the X5 comparison. */
export function zeroTime(g: Game): Game {
  return JSON.parse(JSON.stringify({
    ...g,
    createdAt: 0,
    waitingSince: g.waitingSince === null ? null : 0,
    reminderDueAt: g.reminderDueAt === null ? null : 0,
    round: g.round === null ? null : { ...g.round, openedAt: 0 },
  })) as Game;
}

/**
 * A driver that plays a game to its end through the legal commands only: join to `players`, startGame, write and finish, then every round (each expected player confirms a random card,
 * sometimes the judge or host closes early when `closeEarly`, the judge picks a random revealed card). Randomness comes from `seed` and the step index, so a run replays.
 * In a WRITING game with nothing left to write (a fixture whose players are all ready) it issues a harmless host command so settle can begin play.
 */
export function progressDriver(seed: string, players: number, table: Readonly<Record<string, Enumerator>>, closeEarly = false): Driver {
  return (state, drafts, i) => {
    const pool = legalCommands(state, drafts, table);
    const of = (type: string): LegalEntry[] => pool.filter((e) => e.cmd.type === type);
    const rng = makeRng(`${seed}:driver:${i}`);
    const any = (xs: LegalEntry[]): LegalEntry | undefined => xs[rng.int(Math.max(1, xs.length))];
    if (state.phase === "LOBBY") return state.players.length < players ? any(of("join")) : any(of("startGame"));
    if (state.phase === "WRITING") {
      const finish = of("finishWriting");
      if (finish.length > 0) return any(finish);
      const full = of("saveDraft").filter((e) => {
        const c = e.cmd as { red: unknown[]; green: unknown[] };
        const who = state.players.find((p) => e.actor.kind === "user" && p.uid === e.actor.uid);
        return who?.writeTarget?.red === c.red.length && who.writeTarget.green === c.green.length && who.writeProgress.red !== c.red.length;
      });
      return full.length > 0 ? any(full) : any(of("updateSettings"));
    }
    if (state.phase !== "PLAYING") return undefined;
    const pick = of("pickWinner");
    if (pick.length > 0) return any(pick);
    const close = of("closeSubmissions");
    if (closeEarly && close.length > 0 && rng.int(5) === 0) return any(close);
    return any(of("confirmSubmission")) ?? any(close);
  };
}

/**
 * `progressDriver` with membership churn (#23): about one step in `rate` is a join, a leave or a removal (and about one in 300 an endGame); a late joiner writes and finishes;
 * a paused table is recovered by joins. Randomness comes from `seed` and the step index, so a run replays.
 */
export function membershipDriver(seed: string, players: number, table: Readonly<Record<string, Enumerator>>, rate = 7): Driver {
  const base = progressDriver(seed, players, table, true);
  return (state, drafts, i) => {
    if (state.phase !== "WRITING" && state.phase !== "PLAYING") return base(state, drafts, i);
    const pool = legalCommands(state, drafts, table);
    const of = (type: string): LegalEntry[] => pool.filter((e) => e.cmd.type === type);
    const rng = makeRng(`${seed}:member:${i}`);
    const any = (xs: LegalEntry[]): LegalEntry | undefined => xs[rng.int(Math.max(1, xs.length))];
    if (state.phase === "PLAYING") {
      const finish = of("finishWriting");
      if (finish.length > 0) return any(finish);
      const full = of("saveDraft").filter((e) => {
        const c = e.cmd as { red: unknown[]; green: unknown[] };
        const who = state.players.find((p) => e.actor.kind === "user" && p.uid === e.actor.uid);
        return who?.writeTarget?.red === c.red.length && who.writeTarget.green === c.green.length && who.writeProgress.red !== c.red.length;
      });
      if (full.length > 0) return any(full);
    }
    if (state.paused && of("join").length > 0) return any(of("join"));
    if (rng.int(300) === 0) return any(of("endGame"));
    if (rng.int(rate) === 0) {
      const ops = [...of("join"), ...of("leave"), ...of("removePlayer")];
      // #25: the host also removes a card now and then (one pick from the removeCard entries, so a long list does not drown the membership ops).
      const picks = [any(ops), any(of("removeCard"))].filter((e): e is LegalEntry => e !== undefined);
      if (picks.length > 0) return picks[rng.int(picks.length)];
    }
    return base(state, drafts, i);
  };
}
