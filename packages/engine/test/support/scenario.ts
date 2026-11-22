import { expect } from "bun:test";
import fc from "fast-check";
import type { Command } from "@dc/contracts";
import { makeRng } from "../../src/rng";
import type { Accepted, Ctx, Draft, Game, GameDrafts, Rejection, Result } from "../../src/types";
import { checkAll } from "./checks";
import type { Step } from "./checks";
import { counterMintId, ctxFor, deepFreeze, cid, makeGame, makePlayer, makeRound, pid, addCard } from "./factories";
import type { Enumerator } from "./legal";
import { junkCommands, legalCommands } from "./legal";
import { NEW_DECK_RED, defaultTarget } from "../../src/rules/playability";

export type Decide = (state: Game | null, cmd: Command, ctx: Ctx) => Result<Accepted, Rejection>;

export interface GameShape {
  n: number;
  phase: "LOBBY" | "WRITING" | "PLAYING" | "FINISHED";
  ready: boolean[];
  handSize: number;
  judge: number;
  submitted: boolean[];
  paused: boolean;
}

/** A fixture-world game, coherent for the E5 and E6 checkers: every registry card is in exactly one zone. WRITING: ready players have finished and their cards sit in the decks, the others have nothing pooled. PLAYING: hands, an open SUBMITTING round with the given submissions, a green card on the table and one in the deck. */
export function buildGame(s: GameShape): Game {
  const playing = s.phase === "PLAYING" || s.phase === "FINISHED";
  const target = defaultTarget(s.n);
  const readyAt = (i: number): boolean => s.phase === "WRITING" && s.ready[i] === true;
  let g = makeGame({
    phase: s.phase,
    paused: s.paused,
    version: 7,
    players: Array.from({ length: s.n }, (_, i) =>
      makePlayer(i, s.phase === "LOBBY"
        ? { status: "writing" }
        : playing
          ? { status: "active" }
          : { status: readyAt(i) ? "ready" : "writing", writeTarget: { red: NEW_DECK_RED, green: target }, writeProgress: readyAt(i) ? { red: NEW_DECK_RED, green: target } : { red: 0, green: 0 } })),
    ...(s.phase === "WRITING" ? { target, writeCounts: { red: NEW_DECK_RED, green: target } } : {}),
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
  for (let i = 0; i < s.n; i++) for (let k = 0; k < s.handSize; k++) g = addCard(g, cid(100 * i + k), "red", { hand: pid(i) });
  g = addCard(g, cid(901), "green", "greenDeck");
  if (s.phase === "FINISHED") return g;
  const judge = s.judge % s.n;
  const submissions = Array.from({ length: s.n }, (_, i) => i)
    .filter((i) => i !== judge && s.submitted[i])
    .map((i) => ({ playerId: pid(i), cardId: cid(700 + i) }));
  for (const sub of submissions) g = { ...g, cards: { ...g.cards, [sub.cardId]: { kind: "red", text: `card ${sub.cardId}` } } };
  g = { ...g, cards: { ...g.cards, [cid(900)]: { kind: "green", text: "the green card" } } };
  return { ...g, round: makeRound({ judgeId: pid(judge), greenCardId: cid(900), roster: g.players.map((p) => p.id), submissions, changedAtVersion: 5 }), judgeCursor: judge };
}

export const arbShape: fc.Arbitrary<GameShape> = fc.record({
  n: fc.integer({ min: 3, max: 6 }),
  phase: fc.constantFrom("LOBBY", "WRITING", "PLAYING", "PLAYING", "FINISHED"),
  ready: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
  handSize: fc.integer({ min: 0, max: 3 }),
  judge: fc.nat(5),
  submitted: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
  paused: fc.boolean(),
});

export const arbPicks = fc.array(fc.record({ kind: fc.constantFrom("legal", "legal", "legal", "junk"), pick: fc.nat(1000) }), { maxLength: 25 });
export type Picks = { kind: "legal" | "junk"; pick: number }[];

export interface RunOptions {
  seed: number;
  now?: (step: number) => number;
  freeze?: boolean;
  table: Readonly<Record<string, Enumerator>>;
}
export interface Trace { states: (Game | null)[]; results: Result<Accepted, Rejection>[] }

/** Drive `decide` from `game0` with picks from legalCommands and junkCommands, running every global checker after every step. */
export function runScenario(decide: Decide, game0: Game | null, picks: Picks, opts: RunOptions): Trace {
  let state = game0;
  let drafts: Record<string, Draft> = {};
  const trace: Trace = { states: [state], results: [] };
  picks.forEach((p, i) => {
    const pool = state === null ? [] : p.kind === "legal" ? legalCommands(state, drafts, opts.table) : junkCommands(state);
    const entry = pool.length === 0 ? undefined : pool[p.pick % pool.length];
    if (entry === undefined || state === null) return;
    const ctx = ctxFor({ now: opts.now?.(i) ?? 1_000 + i, rng: makeRng(`${opts.seed}:${i}`), mintId: counterMintId(10_000 * (i + 1)), actor: entry.actor, drafts: drafts as GameDrafts });
    const before = structuredClone(state);
    const cmdBefore = structuredClone(entry.cmd);
    if (opts.freeze === true) { deepFreeze(state); deepFreeze(entry.cmd); deepFreeze(ctx); }
    const result = decide(state, entry.cmd, ctx);
    expect(state).toEqual(before);
    expect(entry.cmd).toEqual(cmdBefore);
    const step: Step = { index: i, seed: opts.seed, before: state, cmd: entry.cmd, result, actor: entry.actor, drafts };
    checkAll(step);
    trace.results.push(result);
    if (result.ok) {
      for (const c of result.value.draftChanges) {
        const { [c.playerId]: _gone, ...rest } = drafts;
        drafts = c.draft === null ? rest : { ...rest, [c.playerId]: c.draft };
      }
      if (result.value.deleteGame !== true) state = result.value.state;
    }
    trace.states.push(state);
  });
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
