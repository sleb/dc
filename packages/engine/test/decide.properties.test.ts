import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { ERROR_CODES } from "@dc/contracts";
import type { Command } from "@dc/contracts";
import { makeDecide } from "../src/decide";
import { REGISTRY } from "../src/registry";
import { makeRng } from "../src/rng";
import { cid, counterMintId, ctxFor, deepFreeze, pid, seatUidOf, GAME_ID, HOST_UID, userActor } from "./support/factories";
import { assertProperty } from "./support/fc";
import { fixtureEnumerators, fixtureRegistry } from "./support/fixtures";
import { enumerators, exemptions, junkCommands, legalCommands, missingEnumerators } from "./support/legal";
import { arbPicks, arbShape, buildGame, runScenario, zeroTime } from "./support/scenario";
import type { Decide } from "./support/scenario";
import { checkAll } from "./support/checks";

// The real registry is empty in 1.2: it adds no commands, so the properties run over fixture specs and, for X1, also over the empty registry.
// Each of #20 to #22 adds its commands to REGISTRY, its enumerators to support/legal.ts, and these properties then cover them.
const fixtureDecide: Decide = makeDecide(fixtureRegistry);
const realDecide: Decide = makeDecide(REGISTRY);
const asCommand = (c: unknown): Command => c as Command;

const arbJson: fc.Arbitrary<unknown> = fc.oneof(fc.anything(), fc.jsonValue(), fc.constantFrom(null, undefined, 0, "", [], {}));
// fxInvariant and fxBug throw on purpose (V3), so X1 runs over the registry without them.
const { fxInvariant: _i, fxBug: _b, ...totalRegistry } = fixtureRegistry;
const totalDecide: Decide = makeDecide(totalRegistry);
const FIXTURE_TYPES = Object.keys(totalRegistry);
/** Typed junk against the fixture specs: a real type name with arbitrary field values. */
const arbTyped = fc.record({
  type: fc.constantFrom(...FIXTURE_TYPES, "__proto__", "constructor"),
  expectedVersion: fc.anything(),
  cardId: fc.anything(),
  pitch: fc.anything(),
  hostId: fc.anything(),
  gameId: fc.anything(),
  hostName: fc.anything(),
  failRole: fc.anything(),
  failPayload: fc.anything(),
}, { requiredKeys: ["type"] });
const arbActor = fc.constantFrom(userActor(HOST_UID), userActor(seatUidOf(GAME_ID, pid(1))), userActor("stranger"), { kind: "system" as const });

describe("X1 decide is total", () => {
  test("arbitrary JSON as cmd never throws over the real registry, and is always INVALID_ARGUMENT there (nothing is registered)", () => {
    assertProperty(fc.property(arbShape, arbJson, arbActor, (shape, c, actor) => {
      for (const state of [null, buildGame(shape)]) {
        const r = realDecide(state, asCommand(c), ctxFor({ actor }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toStrictEqual({ code: "INVALID_ARGUMENT" });
      }
    }));
  });

  test("arbitrary JSON and typed junk never throw over the fixture registry; a rejection always carries an allowed code", () => {
    assertProperty(fc.property(arbShape, fc.oneof(arbJson, arbTyped), arbActor, (shape, c, actor) => {
      for (const state of [null, buildGame(shape)]) {
        const r = totalDecide(state, asCommand(c), ctxFor({ actor }));
        if (!r.ok) expect((ERROR_CODES as readonly string[]).includes(r.error.code)).toBe(true);
      }
    }));
  });

  test("the junkCommands list is rejected and never throws, with the input state unchanged", () => {
    const g = buildGame({ n: 4, phase: "PLAYING", ready: [], handSize: 2, judge: 1, submitted: [false, false, true, false], paused: false });
    const before = structuredClone(g);
    for (const { actor, cmd } of junkCommands(g)) {
      const r = realDecide(deepFreeze(structuredClone(g)), cmd, ctxFor({ actor }));
      expect(r.ok).toBe(false);
    }
    expect(g).toEqual(before);
  });
});

describe("X2 to X5 over scenarios of legal and junk commands (every step checked by checkAll)", () => {
  const run = (g: ReturnType<typeof buildGame>, picks: Parameters<typeof runScenario>[2], seed: number, opts: Partial<Parameters<typeof runScenario>[3]> = {}) =>
    runScenario(fixtureDecide, g, picks, { seed, table: fixtureEnumerators, ...opts });

  test("X2 state stays plain JSON after every step", () => {
    assertProperty(fc.property(arbShape, arbPicks, fc.integer(), (shape, picks, seed) => { run(buildGame(shape), picks, seed); }));
  });

  test("X3 the same inputs and the same seeds give deep-equal states, events and records at every step", () => {
    assertProperty(fc.property(arbShape, arbPicks, fc.integer(), (shape, picks, seed) => {
      const a = run(buildGame(shape), picks, seed);
      const b = run(buildGame(shape), picks, seed);
      expect(b).toEqual(a);
    }));
  });

  test("X3 a different seed changes the shuffle order and nothing else", () => {
    const g = buildGame({ n: 3, phase: "WRITING", ready: [true, true, true], handSize: 0, judge: 0, submitted: [], paused: false });
    const withRedDeck = { ...g, cards: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [cid(i), { kind: "red" as const, text: "t" }])), pools: { ...g.pools, redDeck: Array.from({ length: 12 }, (_, i) => cid(i)) } };
    const go = (seed: string) => fixtureDecide(withRedDeck, asCommand({ type: "fxShuffle" }), ctxFor({ rng: makeRng(seed), mintId: counterMintId(500) }));
    const x = go("seed-a"), y = go("seed-b");
    if (!x.ok || !y.ok) throw new Error("expected acceptance");
    expect(x.value.state.pools.redDeck).not.toEqual(y.value.state.pools.redDeck);
    expect([...x.value.state.pools.redDeck].sort()).toEqual([...y.value.state.pools.redDeck].sort());
    expect({ ...x.value.state, pools: null }).toEqual({ ...y.value.state, pools: null });
    expect(x.value.seed).toBe("seed-a");
  });

  test("X4 inputs are deep-frozen and decide neither mutates nor throws a TypeError", () => {
    assertProperty(fc.property(arbShape, arbPicks, fc.integer(), (shape, picks, seed) => { run(buildGame(shape), picks, seed, { freeze: true }); }));
  });

  test("X5 two runs with different now are equal after zeroing the five time fields", () => {
    assertProperty(fc.property(arbShape, arbPicks, fc.integer(), fc.integer({ min: 0, max: 1e12 }), (shape, picks, seed, shift) => {
      const a = run(buildGame(shape), picks, seed, { now: (i) => 1_000 + i });
      const b = run(buildGame(shape), picks, seed, { now: (i) => 1_000 + i + shift });
      expect(b.states.map((s) => (s === null ? null : zeroTime(s)))).toEqual(a.states.map((s) => (s === null ? null : zeroTime(s))));
    }));
  });

  test("X5 is not vacuous: now does land in the time fields", () => {
    const g = buildGame({ n: 3, phase: "WRITING", ready: [false, false, false], handSize: 0, judge: 0, submitted: [], paused: false });
    const at = (now: number) => fixtureDecide(g, asCommand({ type: "fxHost" }), ctxFor({ now }));
    const a = at(10), b = at(99);
    expect(a.ok && b.ok && a.value.state.waitingSince !== b.value.state.waitingSince).toBe(true);
  });
});

describe("G1 generator sanity", () => {
  test("every legalCommands entry is accepted", () => {
    assertProperty(fc.property(arbShape, fc.integer(), (shape, seed) => {
      const g = buildGame(shape);
      legalCommands(g, {}, fixtureEnumerators).forEach(({ actor, cmd }, i) => {
        const r = fixtureDecide(g, cmd, ctxFor({ actor, rng: makeRng(`${seed}:${i}`) }));
        if (!r.ok) throw new Error(`legal command rejected: ${JSON.stringify(cmd)} as ${JSON.stringify(actor)} -> ${JSON.stringify(r.error)}`);
        checkAll({ index: i, seed, before: g, cmd, result: r });
      });
    }));
  });

  test("the enumerators are not vacuous: the fixture states do produce legal commands", () => {
    const g = buildGame({ n: 4, phase: "PLAYING", ready: [], handSize: 2, judge: 0, submitted: [false, false, false, false], paused: false });
    expect(legalCommands(g, {}, fixtureEnumerators).length).toBeGreaterThan(6);
  });

  test("meta: every registered command in the real registry has an enumerator or an explicit exemption", () => {
    expect(missingEnumerators(REGISTRY, enumerators, exemptions)).toEqual([]);
    expect(Object.keys(REGISTRY)).toEqual([]); // empty in 1.2; #20 to #22 add rows here
  });

  test("meta: a registered command with neither fails the check (test the test)", () => {
    expect(missingEnumerators(fixtureRegistry, fixtureEnumerators, {}).sort()).toEqual(["createGame", "fxBug", "fxInvariant", "fxOrder"]);
    expect(missingEnumerators({ ...fixtureRegistry, fxNew: fixtureRegistry["fxHost"] as never }, { ...fixtureEnumerators }, { createGame: "creates", fxBug: "x", fxInvariant: "x", fxOrder: "x" })).toEqual(["fxNew"]);
  });
});
