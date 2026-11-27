import { describe, expect, test } from "bun:test";
import { CardIdSchema, CommandEnvelopeSchema, GameIdSchema, PlayerIdSchema, SERVER_ONLY_COMMANDS } from "@dc/contracts";
import { checkAll, checkSerializable, checkUnchangedWhenNotAggregate, checkers, findNonJson } from "./checks";
import type { Step } from "./checks";
import { addCard, cid, counterMintId, ctxFor, deepFreeze, makeGame, makePlayer, pid, scriptedRng, GAME_ID } from "./factories";
import { JUNK_TYPES, junkCommands, legalCommands, missingEnumerators } from "./legal";
import { fixtureEnumerators, fixtureRegistry } from "./fixtures";
import { makeDecide } from "../../src/decide";
import type { Command } from "@dc/contracts";
import type { Ctx, Game } from "../../src/types";
import { buildGame, membershipDriver, progressDriver, runScenario, zeroTime } from "./scenario";
import type { AfterStepInfo } from "./scenario";
import { decide } from "../../src/decide";
import { enumerators } from "./legal";
import { created } from "../project/scenarios";

// The harness is test code and is specified here; it imports engine types, the factories and the fixture specs, so it needs the engine modules to load.
describe("harness: factories", () => {
  test("ids satisfy the contracts formats", () => {
    expect(GameIdSchema.safeParse(GAME_ID).success).toBe(true);
    for (let i = 0; i < 12; i++) expect(PlayerIdSchema.safeParse(pid(i)).success).toBe(true);
    for (const n of [0, 1, 35, 1295, 99_999]) expect(CardIdSchema.safeParse(cid(n)).success).toBe(true);
  });

  test("makeGame is a LOBBY game with the host seated; makePlayer 0 holds the host uid, others a seat uid", () => {
    const g = makeGame();
    expect(g.phase).toBe("LOBBY");
    expect(g.players.map((p) => p.uid)).toEqual(["host-uid"]);
    expect(makePlayer(2).uid).toBe(`seat:${GAME_ID}:${pid(2)}`);
  });

  test("addCard registers once and places the card in exactly one zone", () => {
    let g = makeGame({ players: [makePlayer(0), makePlayer(1)] });
    g = addCard(g, cid(1), "red", "redDeck");
    g = addCard(g, cid(2), "red", { hand: pid(1) });
    g = addCard(g, cid(3), "green", { scorePile: pid(0) });
    expect(Object.keys(g.cards).sort()).toEqual([cid(1), cid(2), cid(3)]);
    expect(g.pools.redDeck).toEqual([cid(1)]);
    expect(g.players[1]?.hand).toEqual([cid(2)]);
    expect(g.players[0]?.scorePile).toEqual([cid(3)]);
  });

  test("counterMintId counts up from the given start; scriptedRng replays values and rejects out-of-range or exhausted draws", () => {
    const mint = counterMintId(5);
    expect([mint(), mint()]).toEqual([cid(5), cid(6)]);
    const r = scriptedRng([1, 0, 2]);
    expect(r.int(3)).toBe(1);
    expect(r.shuffle(["a", "b"])).toEqual(["b", "a"]); // Fisher-Yates from the end: j = int(2) = 0 swaps index 1 and 0
    expect(() => r.int(2)).toThrow("outside");
    expect(() => r.int(5)).toThrow("exhausted");
  });

  test("scriptedRng.shuffle draws int(i + 1) for i from n-1 down to 1", () => {
    const r = scriptedRng([0, 0]);
    expect(r.shuffle([1, 2, 3])).toEqual([2, 3, 1]);
    expect(r.drawn).toBe(2);
  });

  test("deepFreeze freezes nested objects and arrays", () => {
    const g = deepFreeze(makeGame());
    expect(Object.isFrozen(g.players[0]?.hand)).toBe(true);
    expect(() => { (g.settings.variants as { pitch: boolean }).pitch = true; }).toThrow(TypeError);
  });

  test("ctxFor defaults to the host and accepts overrides", () => {
    expect(ctxFor().actor).toEqual({ kind: "user", uid: "host-uid" });
    expect(ctxFor({ now: 5 }).now).toBe(5);
  });
});

describe("harness: checkers", () => {
  test("findNonJson names the path of undefined, Map, Date, NaN and class instances", () => {
    expect(findNonJson({ a: [1, { b: undefined }] })).toBe("$.a[1].b");
    expect(findNonJson({ m: new Map() })).toBe("$.m");
    expect(findNonJson({ d: new Date(0) })).toBe("$.d");
    expect(findNonJson({ n: Number.NaN })).toBe("$.n");
    expect(findNonJson({ ok: [1, "a", null, true, { x: {} }] })).toBeNull();
  });

  const okStep = (state: unknown): Step => ({ index: 3, seed: 99, before: makeGame(), cmd: {}, result: { ok: true, value: { state, aggregateChanged: false, events: [], draftChanges: [], roundRecords: [], seed: "s", redactEnvelope: false } as never } });

  test("checkSerializable passes plain state and fails an undefined field", () => {
    expect(() => checkSerializable(okStep(makeGame()))).not.toThrow();
    expect(() => checkSerializable(okStep({ ...makeGame(), winnerId: undefined }))).toThrow("$.winnerId");
  });

  test("checkAll runs the append-only checkers array and names the step and seed on failure", () => {
    expect(checkers).toContain(checkSerializable);
    expect(() => checkAll(okStep({ ...makeGame(), winnerId: undefined }))).toThrow(/step 3 \(seed 99\).*winnerId/);
    const seen: number[] = [];
    checkAll(okStep(makeGame()), [(s) => { seen.push(s.index); }]);
    expect(seen).toEqual([3]);
  });

  test("checkVersion fails a state whose version did not move by one", () => {
    expect(() => checkAll(okStep(makeGame({ version: 1 })))).not.toThrow();
    const bumped = okStep(makeGame({ version: 2 }));
    expect(() => checkAll(bumped)).toThrow("version");
  });
});

describe("harness: checkUnchangedWhenNotAggregate", () => {
  const stepFor = (reg: Parameters<typeof makeDecide>[0], cmd: object): Step => {
    const before = makeGame();
    const result = makeDecide(reg)(before, cmd as never, ctxFor());
    return { index: 0, before, cmd, result };
  };
  test("passes the fixture draft command and deleteGame (aggregateChanged false, state untouched)", () => {
    expect(() => checkUnchangedWhenNotAggregate(stepFor({ fxDraft: fixtureRegistry["fxDraft"] as never }, { type: "fxDraft" }))).not.toThrow();
    expect(() => checkUnchangedWhenNotAggregate(stepFor({ deleteGame: fixtureRegistry["deleteGame"] as never }, { type: "deleteGame" }))).not.toThrow();
  });
  test("a bad fixture that mutates state but reports aggregateChanged false trips it (and checkVersion alone does not)", () => {
    const bad = { type: "fxBadDraft", phases: ["LOBBY"], actor: () => true, handle: (i: { state: ReturnType<typeof makeGame> }) => ({ state: { ...i.state, paused: true }, events: [], draftChanges: [], roundRecords: [], redactEnvelope: false, aggregateChanged: false }) };
    const step = stepFor({ fxBadDraft: bad as never }, { type: "fxBadDraft" });
    expect(() => checkAll(step, [checkers[1] as never])).not.toThrow();
    expect(() => checkUnchangedWhenNotAggregate(step)).toThrow();
    expect(checkers).toContain(checkUnchangedWhenNotAggregate);
  });
});

describe("harness: legalCommands, junkCommands, coverage", () => {
  test("the real enumerator table: a LOBBY game has legal commands, a FINISHED one only endGame and deleteGame", () => {
    expect(legalCommands(makeGame(), {}).length).toBeGreaterThan(0);
    expect(legalCommands(makeGame({ phase: "FINISHED" }), {}).map((e) => e.cmd.type)).toEqual(["endGame", "deleteGame"]); // #23 and #36: the host may end or delete a finished game
    expect(legalCommands(makeGame({ phase: "ENDED" }), {}).map((e) => e.cmd.type)).toEqual(["deleteGame"]);
  });

  test("missingEnumerators lists registered types with neither an enumerator nor an exemption", () => {
    expect(missingEnumerators(fixtureRegistry, fixtureEnumerators, {}).sort()).toEqual(["createGame", "fxBug", "fxInvariant", "fxOrder"]);
    expect(missingEnumerators(fixtureRegistry, fixtureEnumerators, { createGame: "state-creating", fxBug: "x", fxInvariant: "x", fxOrder: "x" })).toEqual([]);
  });

  test("junkCommands covers every command type in the contracts", () => {
    const contractTypes = [...CommandEnvelopeSchema.options.map((o) => o.shape.type.value as string), ...SERVER_ONLY_COMMANDS].sort();
    expect([...JUNK_TYPES].sort()).toEqual(contractTypes);
    const types = new Set<string>(junkCommands(makeGame()).map((e) => e.cmd.type));
    expect([...types].sort()).toEqual(contractTypes);
  });

  test("fixture enumerators list fxPlay for non-judge roster members without a submission", () => {
    const g = buildGame({ n: 3, phase: "PLAYING", ready: [], handSize: 2, judge: 0, submitted: [false, true, false], paused: false });
    const plays = legalCommands(g, {}, fixtureEnumerators).filter((e) => (e.cmd as { type: string }).type === "fxPlay");
    expect(plays).toHaveLength(2); // player 2 only, two cards
    expect(plays.every((e) => e.actor.kind === "user" && e.actor.uid === g.players[2]?.uid)).toBe(true);
  });

  test("zeroTime zeroes exactly the five time fields", () => {
    const g = buildGame({ n: 3, phase: "PLAYING", ready: [], handSize: 1, judge: 0, submitted: [], paused: false });
    const z = zeroTime({ ...g, createdAt: 5, waitingSince: 6, reminderDueAt: 7, round: g.round === null ? null : { ...g.round, openedAt: 8 } });
    expect([z.createdAt, z.waitingSince, z.reminderDueAt, z.round?.openedAt]).toEqual([0, 0, 0, 0]);
    expect(zeroTime(makeGame()).waitingSince).toBeNull();
  });
});

// #30 H1: runScenario's afterStep hook (LLD 2 11.1).
describe("H1 afterStep", () => {
  const picks = Array.from({ length: 150 }, (_, i) => ({ kind: i % 5 === 4 ? ("junk" as const) : ("legal" as const), pick: 0 }));
  // picks without a driver: legal and junk commands drawn from the pools, so some steps are rejected
  const run = (afterStep?: (i: AfterStepInfo) => void) => runScenario(decide, created(true), picks.map((p, i) => ({ ...p, pick: i * 7 })), { seed: 11, table: enumerators, ...(afterStep === undefined ? {} : { afterStep }) });

  test("called once per step, accepted and rejected, with the state before and after; the trace is identical with and without it", () => {
    const seen: AfterStepInfo[] = [];
    const without = run();
    const withHook = run((i) => seen.push(i));
    expect(JSON.stringify(withHook)).toBe(JSON.stringify(without));
    expect(seen.length).toBe(withHook.results.length);
    expect(seen.length).toBeGreaterThan(20);
    expect(seen.some((i) => !i.accepted)).toBe(true);
    expect(seen.some((i) => i.accepted)).toBe(true);
    seen.forEach((info, k) => {
      expect(info.step.index).toBeGreaterThanOrEqual(k);
      expect(info.before).toBe(withHook.states[k] as never);
      expect(info.after).toBe(withHook.states[k + 1] as never);
      expect(info.accepted).toBe(withHook.results[k]?.ok === true);
      if (!info.accepted) expect(info.after).toBe(info.before);
    });
  });

  test("drafts is the draft map after the step, draftsBefore the map before it", () => {
    const seen: AfterStepInfo[] = [];
    runScenario(decide, created(true), picks, { seed: 11, table: enumerators, drive: membershipDriver("11", 4, enumerators), afterStep: (i) => seen.push(i) });
    const saved = seen.filter((i) => i.accepted && (i.step.cmd as { type: string }).type === "saveDraft");
    expect(saved.length).toBeGreaterThan(0);
    for (const i of saved) {
      const uid = i.step.actor?.kind === "user" ? i.step.actor.uid : "";
      const who = i.before.players.find((p) => p.uid === uid);
      expect(who === undefined ? undefined : i.drafts[who.id]).toBeDefined();
    }
    for (let k = 1; k < seen.length; k++) expect(seen[k]?.draftsBefore).toEqual(seen[k - 1]?.drafts as never);
  });

  test("works with the straight driver too", () => {
    let n = 0;
    runScenario(decide, created(false), picks, { seed: 3, table: enumerators, drive: progressDriver("3", 4, enumerators, true), afterStep: () => { n++; } });
    expect(n).toBeGreaterThan(30);
  });
});

// runScenario guards decide's inputs: a decide that writes into the state or the command it was given fails the run, at any depth, on any step, and
// whether the write changes a value, adds a key (an undefined one included) or removes one. Proven before and after the guard moved from clone-and-compare to freezing.
describe("H2 runScenario refuses a decide that mutates its inputs", () => {
  const picks = Array.from({ length: 60 }, () => ({ kind: "legal" as const, pick: 0 }));
  const at = (k: number, mutate: (state: Game, cmd: Command) => void) => {
    let i = 0;
    // the write happens inside the call, after decide has read its inputs: a handler that writes into the input as it builds the result
    return (state: Game | null, cmd: Command, ctx: Ctx) => { const r = decide(state, cmd, ctx); if (i++ === k && state !== null) mutate(state, cmd); return r; };
  };
  const drive = () => membershipDriver("5", 4, enumerators);
  const runWith = (d: ReturnType<typeof at>) => runScenario(d, created(true), picks, { seed: 5, table: enumerators, drive: drive() });

  test("the unmutated run completes (the cases below fail for the mutation, not for the wrapper)", () => {
    expect(runWith(at(-1, () => {})).results.length).toBeGreaterThan(20);
  });
  const cases: [string, number, (s: Game, c: Command) => void][] = [
    ["a top-level field on the first step", 0, (s) => { (s as { roomCode: string }).roomCode = "ZZZZ"; }],
    ["a nested field after the state has been through earlier steps", 12, (s) => { (s.players[0] as { name: string }).name = "Mutated"; }],
    ["an array push deep in the state", 15, (s) => { (s.players as unknown[]).push(structuredClone(s.players[0])); }],
    ["a new key holding undefined", 8, (s) => { (s as unknown as Record<string, unknown>).extra = undefined; }],
    ["a deleted key", 10, (s) => { delete (s.settings as unknown as Record<string, unknown>).profanity; }],
    ["the command", 6, (_s, c) => { (c as unknown as Record<string, unknown>).type = "mutated"; }],
  ];
  for (const [name, k, mutate] of cases) test(`${name}`, () => { expect(() => runWith(at(k, mutate))).toThrow(); });
});
