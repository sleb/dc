// #24 (1.7): P-X8 of LLD 1 section 15.2 over whole seeded games with membership churn and `markReminded` calls under runScenario (every checker after every step, `checkWaiting` included),
// plus the sharpness of `checkWaiting`. The unit and scenario tests are in waiting.test.ts.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Command } from "@dc/contracts";
import { decide } from "../src/decide";
import { makeRng } from "../src/rng";
import type { Accepted, Draft, Game } from "../src/types";
import { checkWaiting } from "./support/checks";
import type { Step } from "./support/checks";
import { GAME_ID, HOST_UID, counterMintId, ctxFor, gameWithDeck, makePlayer, pid, seatUidOf, userActor } from "./support/factories";
import { assertProperty } from "./support/fc";
import { enumerators } from "./support/legal";
import type { LegalEntry } from "./support/legal";
import { membershipDriver, runScenario } from "./support/scenario";
import type { Picks } from "./support/scenario";

const DAY = 86_400_000;
const cmd = (c: object): Command => c as unknown as Command;
const seat = (n: number) => userActor(n === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(n)));
const env = (): Record<string, string | undefined> => ({ ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? "8" });
const placeholders: Picks = Array.from({ length: 900 }, () => ({ kind: "legal" as const, pick: 0 }));
/** One step is an hour, so a 24 h clock falls due within a game and the reminders interleave with the play. */
const HOUR = 3_600_000;
const nowAt = (i: number): number => 1_000 + i * HOUR;

function lobby(): Game {
  const r = decide(null, cmd({ type: "createGame", gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "Host" }), ctxFor({ actor: seat(0) }));
  if (!r.ok) throw new Error("createGame rejected");
  return r.value.state;
}

/** The membership driver, with about one step in three a `markReminded` from the system: due and matching, or (one in four of those) a stale generation or a wrong episode. */
function remindingDriver(seed: string, players: number) {
  const base = membershipDriver(seed, players, enumerators);
  return (state: Game, drafts: Readonly<Record<string, Draft>>, i: number): LegalEntry | undefined => {
    const rng = makeRng(`${seed}:remind:${i}`);
    if ((state.phase === "WRITING" || state.phase === "PLAYING") && state.episode !== null && rng.int(3) === 0) {
      const kind = rng.int(4);
      const c = kind === 0 ? { episode: state.episode, episodeGen: state.episodeGen + 1 } : kind === 1 ? { episode: `${state.episode}!`, episodeGen: state.episodeGen } : { episode: state.episode, episodeGen: state.episodeGen };
      return { actor: { kind: "system" }, cmd: { type: "markReminded", ...c } as unknown as Command };
    }
    return base(state, drafts, i);
  };
}

const play = (n: number, seed: number) => runScenario(decide, lobby(), placeholders, { seed, table: enumerators, now: nowAt, drive: remindingDriver(`${seed}`, n) });

describe("P-X8 over seeded games with churn and reminders (every checker after every step, checkWaiting included)", () => {
  test("random tables of 3 to 8: the waiting fields follow the LLD at every step, and every accepted markReminded lands exactly 24 h after its own time", () => {
    assertProperty(fc.property(fc.integer({ min: 3, max: 8 }), fc.integer(), (n, seed) => {
      const t = play(n, seed);
      t.results.forEach((r, i) => {
        if (!r.ok || !r.value.aggregateChanged) return;
        const before = t.states[i] as Game;
        const after = r.value.state;
        if (after.episode !== null && before.reminderDueAt !== null && after.reminderDueAt !== before.reminderDueAt && after.waitingSince === before.waitingSince) {
          // the clock moved inside a running episode: only markReminded does that, at the command's own time
          expect(after.reminderDueAt).toBe(nowAt(i) + DAY);
          expect(nowAt(i)).toBeGreaterThanOrEqual(before.reminderDueAt);
        }
      });
    }), env());
  });

  test("the property is not vacuous: over 60 fixed seeds the runs hit accepted advances, stale and mismatched no-ops, episode starts after a pause, late joiners in the wait list and an empty wait", () => {
    const seen = new Map<string, number>();
    const bump = (k: string): void => { seen.set(k, (seen.get(k) ?? 0) + 1); };
    for (let seed = 1; seed <= 60; seed++) {
      const t = play(3 + (seed % 6), seed);
      t.results.forEach((r, i) => {
        const before = t.states[i] as Game;
        if (!r.ok) return;
        const after = r.value.state;
        if (r.value.events.length === 0 && r.value.aggregateChanged && after.reminderDueAt !== before.reminderDueAt && after.episodeGen === before.episodeGen && after.version === before.version + 1 && after.waitingSince === before.waitingSince) bump("advance");
        if (!r.value.aggregateChanged && after.episode !== null && after.episode === before.episode) bump("no-op");
        if (r.value.events.some((e) => e.t === "PausedChanged" && !e.paused) && after.episode !== null) bump("unpause-episode");
        if (before.phase === "PLAYING" && after.waitingOn.some((id) => before.players.find((p) => p.id === id)?.status === "writing")) bump("late-joiner-waited-on");
        if (after.phase !== "LOBBY" && after.episode === null && after.waitingOn.length === 0) bump("empty-wait");
        if (r.value.events.some((e) => e.t === "RoundVoided")) bump("void");
      });
    }
    for (const k of ["advance", "no-op", "unpause-episode", "late-joiner-waited-on", "empty-wait"]) expect([k, (seen.get(k) ?? 0) > 0]).toEqual([k, true]);
  }, 60_000);

  test("seeded games with reminders are deterministic (X3)", () => {
    for (let seed = 200; seed < 206; seed++) expect(play(5, seed)).toEqual(play(5, seed));
  });
});

describe("checkWaiting fails rather than passes vacuously", () => {
  const draft = (red: number, green: number): Draft => ({ red: Array.from({ length: red }, () => "r"), green: Array.from({ length: green }, () => "g") });
  const lobby4 = (): Game => gameWithDeck(4, 0, 0, { version: 3, players: [0, 1, 2, 3].map((i) => makePlayer(i)) });
  const stepOf = (g: Game, c: object, who: ReturnType<typeof seat> | { kind: "system" }, now: number, drafts: Record<string, Draft> = {}): Step & { value: Accepted } => {
    const ctx = ctxFor({ actor: who, now, rng: makeRng("chk"), mintId: counterMintId(70_000), drafts });
    const result = decide(g, cmd(c), ctx);
    if (!result.ok) throw new Error(`rejected ${JSON.stringify(result.error)}`);
    return { index: 0, before: g, cmd: c, result, actor: ctx.actor, drafts, value: result.value };
  };
  const patched = (s: Step & { value: Accepted }, patch: (g: Game) => Game, events?: Accepted["events"]): Step => ({ ...s, result: { ok: true, value: { ...s.value, state: patch(s.value.state), ...(events === undefined ? {} : { events }) } } });
  const started = (): Game => stepOf(lobby4(), { type: "startGame" }, seat(0), 500).value.state;

  test("a start with the wrong waitingOn, episode, clock or generation is caught; the real result passes", () => {
    const s = stepOf(lobby4(), { type: "startGame" }, seat(0), 500);
    expect(() => checkWaiting(s)).not.toThrow();
    expect(() => checkWaiting(patched(s, (g) => ({ ...g, waitingOn: g.waitingOn.slice(1) })))).toThrow(/waitingOn/);
    expect(() => checkWaiting(patched(s, (g) => ({ ...g, waitingOn: [...g.waitingOn, g.waitingOn[0] as string] })))).toThrow(/waitingOn/);
    expect(() => checkWaiting(patched(s, (g) => ({ ...g, episode: null, waitingSince: null, reminderDueAt: null })))).toThrow(/episode is null/);
    expect(() => checkWaiting(patched(s, (g) => ({ ...g, paused: true })))).toThrow(/episode/);
    expect(() => checkWaiting(patched(s, (g) => ({ ...g, reminderDueAt: null })))).toThrow(/null iff/);
    expect(() => checkWaiting(patched(s, (g) => ({ ...g, episode: "1:SUBMITTING:x" })))).toThrow(/"writing"/);
    expect(() => checkWaiting(patched(s, (g) => ({ ...g, episodeGen: 0 })))).toThrow(/episodeGen/);
    expect(() => checkWaiting(patched(s, (g) => ({ ...g, reminderDueAt: (g.waitingSince ?? 0) + DAY + 1 })))).toThrow(/24 h/);
    expect(() => checkWaiting(patched(s, (g) => ({ ...g, reminderDueAt: (g.waitingSince ?? 0) + DAY - 1 })))).toThrow(/24 h/);
  });

  test("a late joiner that restarts the clock or bumps the generation, and a finisher that does, are caught", () => {
    const w = started();
    const j = stepOf(w, { type: "join", playerId: pid(9), name: "Late Nine" }, seat(9), 900);
    expect(() => checkWaiting(j)).not.toThrow();
    expect(() => checkWaiting(patched(j, (g) => ({ ...g, waitingSince: 900, reminderDueAt: 900 + DAY })))).toThrow(/clock changed/);
    expect(() => checkWaiting(patched(j, (g) => ({ ...g, episodeGen: g.episodeGen + 1 })))).toThrow(/no episode started/);
    const f = stepOf(w, { type: "finishWriting" }, seat(2), 950, { [pid(2)]: draft(10, 8) });
    expect(() => checkWaiting(f)).not.toThrow();
    expect(() => checkWaiting(patched(f, (g) => ({ ...g, episodeGen: g.episodeGen + 1, waitingSince: 950, reminderDueAt: 950 + DAY })))).toThrow(/no episode started/);
  });

  test("markReminded: a clock that does not move, moves back, or comes with another change is caught; a stale or mismatched call (no-op) is not looked at", () => {
    const w = started();
    const s = stepOf(w, { type: "markReminded", episode: w.episode, episodeGen: w.episodeGen }, { kind: "system" }, 500 + DAY);
    expect(s.value.aggregateChanged).toBe(true);
    expect(() => checkWaiting(s)).not.toThrow();
    expect(() => checkWaiting(patched(s, (g) => ({ ...g, reminderDueAt: w.reminderDueAt })))).toThrow(/strictly later/);
    expect(() => checkWaiting(patched(s, (g) => ({ ...g, reminderDueAt: (w.reminderDueAt ?? 0) - 1 })))).toThrow(/strictly later|24 h/);
    expect(() => checkWaiting(patched(s, (g) => ({ ...g, waitingSince: 777 })))).toThrow(/more than reminderDueAt/);
    expect(() => checkWaiting(patched(s, (g) => ({ ...g, episodeGen: g.episodeGen + 1 })))).toThrow(/more than reminderDueAt/);
    expect(() => checkWaiting(patched(s, (g) => ({ ...g, waitingOn: g.waitingOn.slice(1) })))).toThrow(/waitingOn/);
    const stale = stepOf(w, { type: "markReminded", episode: w.episode, episodeGen: w.episodeGen - 1 }, { kind: "system" }, 500 + DAY);
    expect(stale.value.aggregateChanged).toBe(false);
    expect(() => checkWaiting(stale)).not.toThrow();
  });
});
