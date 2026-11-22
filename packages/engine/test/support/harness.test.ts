import { describe, expect, test } from "bun:test";
import { CardIdSchema, CommandEnvelopeSchema, GameIdSchema, PlayerIdSchema, SERVER_ONLY_COMMANDS } from "@dc/contracts";
import { checkAll, checkSerializable, checkers, findNonJson } from "./checks";
import type { Step } from "./checks";
import { addCard, cid, counterMintId, ctxFor, deepFreeze, makeGame, makePlayer, pid, scriptedRng, GAME_ID } from "./factories";
import { JUNK_TYPES, junkCommands, legalCommands, missingEnumerators } from "./legal";
import { fixtureEnumerators, fixtureRegistry } from "./fixtures";
import { buildGame, zeroTime } from "./scenario";

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

describe("harness: legalCommands, junkCommands, coverage", () => {
  test("the real enumerator table starts empty, so legalCommands is empty", () => {
    expect(legalCommands(makeGame(), {})).toEqual([]);
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
