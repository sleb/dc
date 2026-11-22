import { describe, expect, test } from "bun:test";
import { SETTLE_SLOTS, runSlots, settle } from "../src/settle";
import type { SettleSlot } from "../src/settle";
import type { Game, Player } from "../src/types";
import { makeGame, makePlayer, makeRound, pid, scriptedRng } from "./support/factories";

const rng = () => scriptedRng([]); // settle's real slots draw nothing in 1.2
const players = (statuses: Player["status"][]): Player[] => statuses.map((status, i) => makePlayer(i, { status }));

describe("V7 settle step 2: pause flag (LLD 1 section 8.1)", () => {
  const paused = (g: Game) => settle(g, rng(), 1, false).state.paused;

  test("PLAYING is paused iff fewer than 3 players are active", () => {
    const play = (statuses: Player["status"][]) => makeGame({ phase: "PLAYING", players: players(statuses), round: makeRound({ roster: statuses.map((_, i) => pid(i)) }) }); // everyone expected, so slot 4 (#22) has nothing to advance
    expect(paused(play(["active", "active"]))).toBe(true);
    expect(paused(play(["active", "active", "active"]))).toBe(false);
    expect(paused(play(["active", "active", "ready", "writing"]))).toBe(true);
    expect(paused(play(["active", "active", "active", "left", "removed"]))).toBe(false);
    expect(paused(play(["active", "active", "left"]))).toBe(true);
  });

  test("WRITING is paused iff fewer than 3 players are seated (writing, ready or active)", () => {
    const write = (statuses: Player["status"][]) => makeGame({ phase: "WRITING", players: players(statuses) });
    expect(paused(write(["writing", "ready"]))).toBe(true);
    expect(paused(write(["writing", "ready", "writing"]))).toBe(false);
    expect(paused(write(["writing", "ready", "left"]))).toBe(true);
    expect(paused(write(["writing", "ready", "writing", "removed"]))).toBe(false);
  });

  test("LOBBY, FINISHED and ENDED are never paused, even if the stored flag says so", () => {
    for (const phase of ["LOBBY", "FINISHED", "ENDED"] as const) expect(paused(makeGame({ phase, paused: true, players: players(["active"]) }))).toBe(false);
  });

  test("PausedChanged is emitted exactly when the flag flips", () => {
    const g = makeGame({ phase: "WRITING", players: players(["writing", "writing"]) });
    expect(settle(g, rng(), 1, false).events).toEqual([{ t: "PausedChanged", paused: true }]);
    expect(settle({ ...g, paused: true }, rng(), 1, false).events).toEqual([]);
    const full = makeGame({ phase: "WRITING", paused: true, players: players(["writing", "writing", "writing"]) });
    expect(settle(full, rng(), 1, false).events).toEqual([{ t: "PausedChanged", paused: false }]);
    expect(settle({ ...full, paused: false }, rng(), 1, false).events).toEqual([]);
  });
});

describe("V7 settle step 5: waiting fields", () => {
  test("starting an episode in WRITING records now and the 24 h reminder", () => {
    const g = makeGame({ phase: "WRITING", players: players(["writing", "ready", "writing"]) });
    const s = settle(g, rng(), 777, true).state;
    expect([s.waitingOn, s.episode, s.episodeGen, s.waitingSince, s.reminderDueAt]).toEqual([[pid(0), pid(2)], "writing", 1, 777, 777 + 86_400_000]);
  });

  test("a paused WRITING game computes waitingOn but has no episode (step 2 feeds step 5)", () => {
    const g = makeGame({ phase: "WRITING", players: players(["writing", "writing"]) });
    const s = settle(g, rng(), 777, true).state;
    expect([s.paused, s.waitingOn.length, s.episode, s.waitingSince, s.reminderDueAt]).toEqual([true, 2, null, null, null]);
  });
});

describe("V8 slot order", () => {
  test("the slots are 1, 2, 3, 3a, 4, 5 in that order", () => {
    expect(SETTLE_SLOTS.map((s) => s.id)).toEqual(["1", "2", "3", "3a", "4", "5"]);
  });

  test("slots 1, 3, 3a and 4 are no-ops on a PLAYING game that is waiting for submissions (slot 1 acts only in WRITING; slot 4 needs everyone in; 3 and 3a are #23)", () => {
    const g = makeGame({ phase: "PLAYING", players: players(["active", "active", "active"]), round: makeRound({ roster: [pid(0), pid(1), pid(2)] }) });
    for (const id of ["1", "3", "3a", "4"] as const) {
      const slot = SETTLE_SLOTS.find((s) => s.id === id);
      const out = slot?.run(g, { rng: rng(), now: 1, episodeStarted: false });
      expect(out?.state).toBe(g);
      expect(out?.events).toEqual([]);
    }
  });

  test("runSlots calls every slot once, in order, threading state and events", () => {
    const calls: string[] = [];
    const wrapped: SettleSlot[] = SETTLE_SLOTS.map((s) => ({ id: s.id, run: (st, env) => { calls.push(s.id); return s.run(st, env); } }));
    const g = makeGame({ phase: "WRITING", players: players(["writing", "writing"]) });
    const out = runSlots(wrapped, g, rng(), 9, false);
    expect(calls).toEqual(["1", "2", "3", "3a", "4", "5"]);
    expect(out).toEqual(settle(g, rng(), 9, false));
  });

  test("events are concatenated in slot order and each slot sees the previous slot's state", () => {
    const seen: number[] = [];
    const slot = (id: SettleSlot["id"], n: number): SettleSlot => ({
      id,
      run: (st) => { seen.push(st.totalJoins); return { state: { ...st, totalJoins: st.totalJoins + 1 }, events: [{ t: "PlayerJoined", playerId: pid(n) }] }; },
    });
    const out = runSlots([slot("1", 1), slot("2", 2), slot("3", 3)], makeGame(), rng(), 1, false);
    expect(seen).toEqual([0, 1, 2]);
    expect(out.events.map((e) => (e.t === "PlayerJoined" ? e.playerId : ""))).toEqual([pid(1), pid(2), pid(3)]);
    expect(out.state.totalJoins).toBe(3);
  });

  test("a slot can raise episodeStarted for step 5 (how #22's void and open start episodes)", () => {
    const running = makeGame({ phase: "WRITING", players: players(["writing", "writing", "writing"]), episode: "writing", episodeGen: 2, waitingSince: 10, reminderDueAt: 10 + 86_400_000 });
    const raise: SettleSlot = { id: "4", run: (state) => ({ state, events: [], episodeStarted: true }) };
    const slots = SETTLE_SLOTS.map((s) => (s.id === "4" ? raise : s));
    expect(runSlots(slots, running, rng(), 99, false).state).toMatchObject({ episodeGen: 3, waitingSince: 99 });
    expect(runSlots(SETTLE_SLOTS, running, rng(), 99, false).state).toMatchObject({ episodeGen: 2, waitingSince: 10 });
  });

  test("settle does not mutate its input", () => {
    const g = makeGame({ phase: "WRITING", players: players(["writing", "writing"]) });
    const before = structuredClone(g);
    Object.freeze(g);
    settle(g, rng(), 1, true);
    expect(g).toEqual(before);
  });
});
