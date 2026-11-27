import { describe, expect, spyOn, test } from "bun:test";
import { ViewDocSchema } from "@dc/contracts";
import type { Settings } from "@dc/contracts";
import { PROJECTOR_REV, VIEW_REGION_FIELDS } from "@dc/engine";
import { Timestamp } from "firebase-admin/firestore";
import { HTTPS_CODE } from "../harness/store";
import { CREATE_ATTEMPTS, createGame, executeCreate, planCreate } from "./create";
import type { CreateAttempt, CreateInput, CreatePlan, CreatePlanDeps, CreateReads } from "./create";
import { roomCodeFromSeed } from "./codes";
import { StoreError, mapStoreError } from "./errors";
import { idemId } from "./idem";
import { eventPath, gamePath, hostIdemPath, roomCodePath, viewPath } from "./refs";
import type { CreateLedgerDoc, Deps } from "./types";

// U4-U6, U8 (LLD 3 sections 2.3, 5.4, 5.8 and 6.1, ST8): the pure createGame planner and the 8-attempt loop over a fake Firestore.
const NOW = 1_700_000_000_000;
const HOST = "host-1";
const INPUT: CreateInput = { hostId: HOST, hostName: "NAME-SENTINEL-host", idemKey: "idem-1" };
const ATTEMPT: CreateAttempt = { ...INPUT, gameId: "gCreate0000000000001", roomCode: "BCDF", hostPlayerId: "p_abcdefgh" };
const PLAN_DEPS: CreatePlanDeps = { now: NOW, seed: "create-seed", mintId: () => "c_0000000000" };
const actor = { kind: "user", uid: HOST } as const;
const LEDGER_PATH = hostIdemPath(HOST, idemId(actor, INPUT.idemKey));

type Write = { op: string; path: string; data: Record<string, unknown>; fields?: string[] };
const byPath = (writes: readonly { path: string }[]) => new Map(writes.map((w) => [w.path, w as Write]));
const planOf = (reads: Partial<CreateReads>, i: Partial<CreateAttempt> = {}) => planCreate({ ledger: null, code: null, ...reads }, { ...ATTEMPT, ...i }, PLAN_DEPS);
/** Assert the plan's kind and narrow it, so `outcome` is readable on the accepted/replay/rejected branches. */
function planOfKind<K extends CreatePlan["kind"]>(plan: ReturnType<typeof planOf>, kind: K): Extract<CreatePlan, { kind: K }> {
  expect(plan.kind).toBe(kind);
  if (plan.kind !== kind) throw new Error(`expected ${kind}, got ${plan.kind}`);
  return plan as Extract<CreatePlan, { kind: K }>;
}

describe("U4 planCreate: the six writes", () => {
  const plan = planOf({});
  const writes = plan.writes;

  test("exactly six documents: aggregate, events/1, host and spectator views, roomCodes, the host's ledger", () => {
    expect(plan.kind).toBe("accepted");
    expect(writes).toHaveLength(6);
    expect(writes.length).toBeLessThanOrEqual(200); // MAX_WRITES
    expect([...byPath(writes).keys()].sort()).toEqual(
      [
        gamePath(ATTEMPT.gameId),
        eventPath(ATTEMPT.gameId, 1),
        viewPath(ATTEMPT.gameId, HOST),
        viewPath(ATTEMPT.gameId, "spectator"),
        roomCodePath("BCDF"),
        LEDGER_PATH,
      ].sort(),
    );
  });

  test("the aggregate is a full create of the LOBBY state with the fresh store map", () => {
    const w = byPath(writes).get(gamePath(ATTEMPT.gameId)) as Write;
    expect(w.op).toBe("create");
    expect(w.data).toMatchObject({ id: ATTEMPT.gameId, version: 1, phase: "LOBBY", hostId: HOST, roomCode: "BCDF" });
    expect(w.data["store"]).toEqual({ schema: 1, viewsRev: PROJECTOR_REV, updatedAt: NOW, deleting: null });
    const host = (w.data["players"] as { id: string; uid: string }[]).find((p) => p.uid === HOST);
    expect(host?.id).toBe(ATTEMPT.hostPlayerId);
  });

  test("events/1 is createGame v1 with the attempt's seed and the host's actorPlayerId", () => {
    const w = byPath(writes).get(eventPath(ATTEMPT.gameId, 1)) as Write;
    expect(w.op).toBe("create");
    expect(w.data).toMatchObject({
      version: 1,
      at: NOW,
      commandType: "createGame",
      seed: "create-seed",
      actorPlayerId: ATTEMPT.hostPlayerId,
      events: [{ t: "GameCreated", hostPlayerId: ATTEMPT.hostPlayerId }],
    });
  });

  test("the host and spectator views are strict-parsed doc merges over VIEW_REGION_FIELDS; spectators are off", () => {
    const host = byPath(writes).get(viewPath(ATTEMPT.gameId, HOST)) as Write;
    expect(host.op).toBe("merge");
    expect(host.fields).toEqual([...VIEW_REGION_FIELDS]);
    expect(ViewDocSchema.safeParse(host.data).success).toBe(true);
    expect((host.data["view"] as { kind: string }).kind).toBe("live");
    const spectator = byPath(writes).get(viewPath(ATTEMPT.gameId, "spectator")) as Write;
    expect(spectator.data).toMatchObject({ enabled: false, view: null, version: 1 });
  });

  test("roomCodes/{code} is {gameId, createdAt} and the ledger is a CreateLedgerDoc expiring in 7 days", () => {
    const code = byPath(writes).get(roomCodePath("BCDF")) as Write;
    expect(code.op).toBe("create");
    expect(code.data).toEqual({ gameId: ATTEMPT.gameId, createdAt: NOW });
    const ledger = byPath(writes).get(LEDGER_PATH) as Write;
    expect(ledger.op).toBe("create");
    expect(ledger.data).toMatchObject({ at: NOW, commandType: "createGame", version: 1, gameId: ATTEMPT.gameId, roomCode: "BCDF" });
    expect((ledger.data["expiresAt"] as Timestamp).toMillis()).toBe(NOW + 7 * 86_400_000);
  });
});

describe("U5 planCreate: replay, taken and rejected branches", () => {
  const ledger: CreateLedgerDoc = {
    at: 1,
    expiresAt: Timestamp.fromMillis(2),
    commandType: "createGame",
    version: 1,
    gameId: "gLedger0000000000001",
    roomCode: "BDFG",
  };

  test("a ledger hit is an accepted replay with the ledger's ids, zero writes, even when the code belongs to another game", () => {
    const plan = planOfKind(planOf({ ledger, code: { gameId: "gOther0000000000001", createdAt: 1 } }), "replay");
    expect(plan.outcome).toEqual({ kind: "accepted", gameId: ledger.gameId, roomCode: ledger.roomCode, replay: true });
    expect(plan.writes).toEqual([]);
  });

  test("a code held with no ledger is taken", () => {
    const plan = planOfKind(planOf({ code: { gameId: "gOther0000000000001", createdAt: 1 } }), "taken");
    expect(plan.writes).toEqual([]);
  });

  test("an invalid settings patch is rejected INVALID_ARGUMENT with no writes and no ledger", () => {
    const plan = planOfKind(planOf({}, { settings: { spectators: { enabled: "yes" } } as unknown as Partial<Settings> }), "rejected");
    expect(plan.outcome).toEqual({ kind: "rejected", rejection: { code: "INVALID_ARGUMENT" } });
    expect(plan.writes).toEqual([]);
  });

  test("a rejected host name is CONTENT_REJECTED with no writes and no ledger", () => {
    const plan = planOfKind(planOf({}, { hostName: "   " }), "rejected");
    expect(plan.outcome).toMatchObject({ kind: "rejected", rejection: { code: "CONTENT_REJECTED" } });
    expect(plan.writes).toEqual([]);
  });
});

interface FakeWrite { op: "create" | "set" | "update" | "delete"; path: string; data?: Record<string, unknown> }

/** A minimal Firestore: docs in a map, transactions that read then apply buffered writes, and an injectable failure. */
class FakeDb {
  readonly store = new Map<string, Record<string, unknown>>();
  failNext: unknown = null;
  private seq = 0;

  constructor(initial: Record<string, Record<string, unknown>> = {}) {
    for (const [path, data] of Object.entries(initial)) this.store.set(path, data);
  }
  doc(path: string) {
    return { path };
  }
  collection() {
    return { doc: () => ({ id: `gFake${String(++this.seq).padStart(15, "0")}` }) };
  }
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    if (this.failNext !== null) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const ops: FakeWrite[] = [];
    const tx = {
      getAll: async (...refs: { path: string }[]) =>
        refs.map((r) => {
          const data = this.store.get(r.path) ?? null;
          return { exists: data !== null, data: () => data, ref: { path: r.path } };
        }),
      create: (r: { path: string }, data: Record<string, unknown>) => {
        if (this.store.has(r.path)) throw Object.assign(new Error(`6 ALREADY_EXISTS: Document already exists: ${r.path}`), { code: 6 });
        ops.push({ op: "create", path: r.path, data });
      },
      set: (r: { path: string }, data: Record<string, unknown>) => ops.push({ op: "set", path: r.path, data }),
      update: (r: { path: string }, data: Record<string, unknown>) => ops.push({ op: "update", path: r.path, data }),
      delete: (r: { path: string }) => ops.push({ op: "delete", path: r.path }),
    };
    const out = await fn(tx);
    for (const o of ops) {
      if (o.op === "delete") this.store.delete(o.path);
      else this.store.set(o.path, o.data as Record<string, unknown>);
    }
    return out;
  }
  games(): string[] {
    return [...this.store.keys()].filter((p) => /^games\/[^/]+$/.test(p));
  }
  hosted(): string[] {
    return [...this.store.keys()].filter((p) => p.startsWith(`hosts/${HOST}/`));
  }
}

/** The fake deps draw alternating seeds, so attempt k's code seed is code-{k} and its decide seed is decide-{k}. */
function fakeDeps(): Deps {
  let calls = 0;
  return {
    clock: () => NOW,
    newSeed: () => {
      const k = calls++;
      return k % 2 === 0 ? `code-${k / 2 + 1}` : `decide-${(k - 1) / 2 + 1}`;
    },
    mintId: () => "c_0000000000",
  };
}
const codesFor = (n: number): string[] => Array.from({ length: n }, (_, i) => roomCodeFromSeed(`code-${i + 1}`));
const occupied = (codes: string[]): Record<string, Record<string, unknown>> =>
  Object.fromEntries(codes.map((code, i) => [roomCodePath(code), { gameId: `gOccupied${String(i).padStart(11, "0")}`, createdAt: 1 }]));

/** Run `fn` with the logger's `write` captured; returns the value or the error plus the captured lines. */
async function withLogs<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; logs: Record<string, unknown>[] }> {
  const logs: Record<string, unknown>[] = [];
  const logger = await import("firebase-functions/logger");
  const spy = spyOn(logger, "write").mockImplementation((e) => {
    logs.push(e as Record<string, unknown>);
  });
  try {
    return { value: await fn(), logs };
  } catch (e) {
    return { error: e, logs };
  } finally {
    spy.mockRestore();
  }
}
const collisions = (logs: Record<string, unknown>[]) => logs.filter((l) => l["event"] === "roomcode.collision");

describe("U6 the attempt loop", () => {
  test("7 occupied scripted codes then success on the 8th, with one collision line per lost attempt", async () => {
    const codes = codesFor(8);
    expect(new Set(codes).size).toBe(8);
    const db = new FakeDb(occupied(codes.slice(0, 7)));
    const { value, error, logs } = await withLogs(() => executeCreate(db as never, fakeDeps(), INPUT));
    expect(error).toBeUndefined();
    const x = value as Awaited<ReturnType<typeof executeCreate>>;
    if (x.outcome.kind !== "accepted") throw new Error(`not accepted: ${JSON.stringify(x.outcome)}`);
    expect(x.attempts).toBe(CREATE_ATTEMPTS);
    expect(x.outcome.roomCode).toBe(codes[7] as string);
    expect(x.outcome.replay).toBe(false);
    expect(collisions(logs)).toHaveLength(7);
    expect(collisions(logs).map((l) => l["attempts"])).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(db.games()).toHaveLength(1);
    expect(db.hosted()).toHaveLength(1);
  });

  test("8 occupied codes exhaust the loop: ROOM_CODES_EXHAUSTED after 8 attempts, nothing written", async () => {
    const codes = codesFor(8);
    const db = new FakeDb(occupied(codes));
    const before = db.store.size;
    const { error, logs } = await withLogs(() => executeCreate(db as never, fakeDeps(), INPUT));
    expect(error).toBeInstanceOf(StoreError);
    expect(error).toMatchObject({ kind: "ROOM_CODES_EXHAUSTED" });
    expect(collisions(logs)).toHaveLength(8);
    expect(collisions(logs).map((l) => l["attempts"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(db.games()).toEqual([]);
    expect(db.hosted()).toEqual([]);
    expect(db.store.size).toBe(before);
  });

  test("a replay on attempt 1 writes nothing", async () => {
    const ledger: CreateLedgerDoc = {
      at: 1,
      expiresAt: Timestamp.fromMillis(2),
      commandType: "createGame",
      version: 1,
      gameId: "gLedger0000000000001",
      roomCode: "BDFG",
    };
    const db = new FakeDb({ [LEDGER_PATH]: ledger as unknown as Record<string, unknown> });
    const { value, logs } = await withLogs(() => executeCreate(db as never, fakeDeps(), INPUT));
    const x = value as Awaited<ReturnType<typeof executeCreate>>;
    expect(x.attempts).toBe(1);
    expect(x.outcome).toEqual({ kind: "accepted", gameId: ledger.gameId, roomCode: ledger.roomCode, replay: true });
    expect(collisions(logs)).toEqual([]);
    expect(db.games()).toEqual([]);
    expect(db.store.size).toBe(1);
  });

  test("an ALREADY_EXISTS naming the roomCodes path is a lost race and is retried", async () => {
    const codes = codesFor(2);
    const db = new FakeDb();
    db.failNext = Object.assign(new Error(`6 ALREADY_EXISTS: Document already exists: projects/demo/databases/(default)/documents/${roomCodePath(codes[0] as string)}`), { code: 6 });
    const { value, logs } = await withLogs(() => executeCreate(db as never, fakeDeps(), INPUT));
    const x = value as Awaited<ReturnType<typeof executeCreate>>;
    if (x.outcome.kind !== "accepted") throw new Error("not accepted");
    expect(x.attempts).toBe(2);
    expect(x.outcome.roomCode).toBe(codes[1] as string);
    expect(collisions(logs)).toHaveLength(1);
  });

  test("an ALREADY_EXISTS naming another path is INVARIANT", async () => {
    const db = new FakeDb();
    db.failNext = Object.assign(new Error("6 ALREADY_EXISTS: Document already exists: projects/demo/databases/(default)/documents/games/gCreate0000000000001"), { code: 6 });
    const { error } = await withLogs(() => executeCreate(db as never, fakeDeps(), INPUT));
    expect(error).toMatchObject({ kind: "INVARIANT" });
  });
});

describe("U8 error mapping", () => {
  test("mapStoreError passes ROOM_CODES_EXHAUSTED through unchanged", () => {
    const e = new StoreError("ROOM_CODES_EXHAUSTED", "x");
    expect(mapStoreError(e, 8)).toBe(e);
  });

  test("the harness maps ROOM_CODES_EXHAUSTED to resource-exhausted with details.kind", () => {
    expect(HTTPS_CODE.ROOM_CODES_EXHAUSTED).toBe("resource-exhausted");
  });

  test("createGame returns the execution's outcome", async () => {
    const db = new FakeDb();
    const out = await createGame(db as never, fakeDeps(), INPUT);
    expect(out.kind).toBe("accepted");
  });
});
