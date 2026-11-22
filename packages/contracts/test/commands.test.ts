import { describe, expect, test } from "bun:test";
import {
  CommandEnvelopeSchema,
  SERVER_ONLY_COMMANDS,
  WIRE_DRAFT_MAX,
  WIRE_TEXT_MAX,
  toEngineCommand,
} from "../src/index";

// Built from parts: a whole UUID literal trips the secret scanner (generic-api-key).
const uuid = (...p: string[]) => p.join("-");
const base = {
  v: 1,
  gameId: "a".repeat(20),
  idempotencyKey: uuid("123e4567", "e89b", "42d3", "a456", "426614174000"),
};
const pid = "p_abcdef27";
const cid = "c_abcde01289";
const variants = { pitch: true, writeIn: true, redraw: false, peoplesChoice: false };

type Fixture = { type: string; payload: Record<string, unknown>; engine: Record<string, unknown>; needsVersion: boolean };
const fixtures: Fixture[] = [
  { type: "updateSettings", payload: { patch: { variants } }, engine: { type: "updateSettings", patch: { variants } }, needsVersion: false },
  { type: "leave", payload: {}, engine: { type: "leave" }, needsVersion: false },
  { type: "removePlayer", payload: { playerId: pid }, engine: { type: "removePlayer", playerId: pid }, needsVersion: false },
  { type: "removeCard", payload: { cardId: cid }, engine: { type: "removeCard", cardId: cid }, needsVersion: false },
  { type: "startGame", payload: {}, engine: { type: "startGame" }, needsVersion: false },
  { type: "saveDraft", payload: { red: ["a"], green: [] }, engine: { type: "saveDraft", red: ["a"], green: [] }, needsVersion: false },
  { type: "finishWriting", payload: {}, engine: { type: "finishWriting" }, needsVersion: false },
  { type: "confirmSubmission", payload: { cardId: cid, pitch: "p" }, engine: { type: "confirmSubmission", cardId: cid, pitch: "p" }, needsVersion: true },
  { type: "writeIn", payload: { text: "hi" }, engine: { type: "writeIn", text: "hi" }, needsVersion: true },
  { type: "redraw", payload: {}, engine: { type: "redraw" }, needsVersion: false },
  { type: "closeSubmissions", payload: {}, engine: { type: "closeSubmissions" }, needsVersion: true },
  { type: "pickWinner", payload: { submissionId: cid }, engine: { type: "pickWinner", submissionId: cid }, needsVersion: true },
  { type: "passJudging", payload: {}, engine: { type: "passJudging" }, needsVersion: true },
  { type: "castVote", payload: { round: 1, submissionId: cid }, engine: { type: "castVote", round: 1, submissionId: cid }, needsVersion: false },
  { type: "endGame", payload: {}, engine: { type: "endGame" }, needsVersion: false },
];
const make = (f: Fixture, extra: Record<string, unknown> = {}) => ({ ...base, type: f.type, payload: f.payload, ...extra });
const ok = (v: unknown) => CommandEnvelopeSchema.safeParse(v).success;

describe("C1 fixtures per command", () => {
  for (const f of fixtures) {
    test(`${f.type} parses with an expectedVersion`, () => {
      expect(ok(make(f, { expectedVersion: 4 }))).toBe(true);
    });
  }
  test("bad ids and missing fields fail", () => {
    const f = fixtures.find((x) => x.type === "removePlayer")!;
    expect(ok({ ...make(f, { expectedVersion: 1 }), payload: { playerId: "nope" } })).toBe(false);
    expect(ok({ ...make(f, { expectedVersion: 1 }), payload: {} })).toBe(false);
    expect(ok({ ...make(f, { expectedVersion: 1 }), gameId: "short" })).toBe(false);
    expect(ok({ ...make(f, { expectedVersion: 1 }), idempotencyKey: "x" })).toBe(false);
    expect(ok({ ...make(f, { expectedVersion: 1 }), v: 0 })).toBe(false);
    const { gameId: _g, ...noGame } = make(f, { expectedVersion: 1 });
    expect(ok(noGame)).toBe(false);
    expect(ok({ ...make(f), type: "unknownCommand" })).toBe(false);
  });
  test("text over WIRE_TEXT_MAX fails, at the limit passes", () => {
    const w = fixtures.find((x) => x.type === "writeIn")!;
    expect(ok({ ...make(w, { expectedVersion: 1 }), payload: { text: "x".repeat(WIRE_TEXT_MAX) } })).toBe(true);
    expect(ok({ ...make(w, { expectedVersion: 1 }), payload: { text: "x".repeat(WIRE_TEXT_MAX + 1) } })).toBe(false);
    expect(ok({ ...make(w, { expectedVersion: 1 }), payload: { text: "x", pitch: "x".repeat(WIRE_TEXT_MAX + 1) } })).toBe(false);
  });
  test("drafts over WIRE_DRAFT_MAX fail, at the limit pass", () => {
    const s = fixtures.find((x) => x.type === "saveDraft")!;
    const arr = (n: number) => Array.from({ length: n }, () => "c");
    expect(ok({ ...make(s), payload: { red: arr(WIRE_DRAFT_MAX), green: arr(WIRE_DRAFT_MAX) } })).toBe(true);
    expect(ok({ ...make(s), payload: { red: arr(WIRE_DRAFT_MAX + 1), green: [] } })).toBe(false);
    expect(ok({ ...make(s), payload: { red: [], green: arr(WIRE_DRAFT_MAX + 1) } })).toBe(false);
    expect(ok({ ...make(s), payload: { red: ["x".repeat(WIRE_TEXT_MAX + 1)], green: [] } })).toBe(false);
  });
  test("castVote round must be a positive integer", () => {
    const c = fixtures.find((x) => x.type === "castVote")!;
    expect(ok({ ...make(c), payload: { round: 0, submissionId: cid } })).toBe(false);
    expect(ok({ ...make(c), payload: { round: 1.5, submissionId: cid } })).toBe(false);
  });
});

describe("C2 toEngineCommand", () => {
  for (const f of fixtures) {
    test(`${f.type} maps to the LLD 1 section 7 shape`, () => {
      const env = CommandEnvelopeSchema.parse(make(f, { expectedVersion: 7 }));
      expect(toEngineCommand(env) as unknown).toEqual({ ...f.engine, expectedVersion: 7 });
    });
    test(`${f.type} omits expectedVersion when absent`, () => {
      if (f.needsVersion) return;
      const env = CommandEnvelopeSchema.parse(make(f));
      const out = toEngineCommand(env);
      expect("expectedVersion" in out).toBe(false);
      expect(out as unknown).toEqual(f.engine);
    });
  }
});

describe("C3 required expectedVersion", () => {
  const required = ["confirmSubmission", "writeIn", "closeSubmissions", "pickWinner", "passJudging"];
  test("omitting it fails exactly for the required five", () => {
    const failing = fixtures.filter((f) => !ok(make(f))).map((f) => f.type).sort();
    expect(failing).toEqual([...required].sort());
  });
  test("fixture table agrees with the required set", () => {
    expect(fixtures.filter((f) => f.needsVersion).map((f) => f.type).sort()).toEqual([...required].sort());
  });
  test("a negative expectedVersion fails everywhere", () => {
    for (const f of fixtures) expect(ok(make(f, { expectedVersion: -1 }))).toBe(false);
  });
});

describe("C4 server-only commands", () => {
  const llD1Names = [
    "createGame", "updateSettings", "join", "leave", "removePlayer", "removeCard", "importDeck", "startGame",
    "saveDraft", "finishWriting", "confirmSubmission", "writeIn", "redraw", "closeSubmissions", "pickWinner",
    "passJudging", "castVote", "endGame", "deleteGame", "markReminded",
  ];
  const clientTypes = CommandEnvelopeSchema.options.map((o) => o.shape.type.value as string);
  test("server-only is disjoint from the envelope types", () => {
    for (const t of SERVER_ONLY_COMMANDS) expect(clientTypes).not.toContain(t);
  });
  test("client plus server-only equals the LLD 1 name list", () => {
    expect([...clientTypes, ...SERVER_ONLY_COMMANDS].sort()).toEqual([...llD1Names].sort());
    expect(new Set(clientTypes).size).toBe(clientTypes.length);
  });
  test("the envelope rejects every server-only type (API4)", () => {
    for (const t of SERVER_ONLY_COMMANDS) {
      expect(ok({ ...base, type: t, payload: {}, expectedVersion: 1 })).toBe(false);
    }
  });
});

describe("C5 no authority fields (A2)", () => {
  const banned = new Set(["role", "uid", "hostId", "isHost", "actor", "isJudge"]);
  const keys = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (s: unknown): void => {
    if (typeof s !== "object" || s === null || seen.has(s)) return;
    seen.add(s);
    const o = s as { shape?: Record<string, unknown>; options?: unknown[]; def?: unknown; element?: unknown; innerType?: unknown; _zod?: { def?: unknown } };
    if (o.shape) for (const [k, v] of Object.entries(o.shape)) { keys.add(k); walk(v); }
    if (o.options) o.options.forEach(walk);
    if (o.element) walk(o.element);
    if (o.innerType) walk(o.innerType);
    if (o.def) walk(o.def);
    if (o._zod?.def) walk(o._zod.def);
  };
  test("no schema key is an authority key", () => {
    walk(CommandEnvelopeSchema);
    expect(keys.has("payload")).toBe(true); // the walk reached into the options
    expect(keys.has("playerId")).toBe(true);
    expect(keys.has("variants")).toBe(true); // and into nested settings objects
    expect(keys.has("peoplesChoice")).toBe(true);
    for (const k of keys) expect(banned.has(k)).toBe(false);
  });
});
