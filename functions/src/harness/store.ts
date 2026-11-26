// The emulator-only Store harness (#33, LLD 3 section 10.3, LLD 0 P9 as amended): the route the Store integration suites use to reach `runCommand`
// and `load` in the Node bundle before the real callables exist (#40). Exported only when FUNCTIONS_EMULATOR is "true" (the Functions emulator sets
// it; `firebase deploy` discovery and the deployed runtime do not), listed in exports.emulator.json, and re-gated in the handler. `check-bundle`
// proves it is absent from the deployed export list. It takes the actor from the request, so it must never deploy.
//
// Per request, also emulator-gated: `now` (the clock), `seeds` (the shuffle seed of attempt k is seeds[k-1]), `faults` (`throwAt` a point, or an
// ABORTED on the listed attempts), and a named test recipe for `extraWrites`. It reports the attempts, the distinct documents written and the seed
// of every attempt.
import { HttpsError } from "firebase-functions/v2/https";
import { RT, defineCallable } from "../api/callable";
import { newCardId } from "../deps";
import { db } from "../firebase";
import { StoreError, execute, load } from "../store";
import type { CommandInput, Deps, DocWrite, FaultHooks, FaultPoint, Json } from "../store";

const isEmulator = (): boolean => process.env["FUNCTIONS_EMULATOR"] === "true";

/** The fault a `throwAt` raises: not a StoreError, so it reaches the caller as itself (the "crash"). */
class InjectedFault extends Error {
  constructor(readonly point: FaultPoint) {
    super(`injected fault at ${point}`);
  }
}

interface Faults { throwAt?: FaultPoint; abortAttempts?: number[] }
interface RunRequest { op: "run"; gameId: string; cmd: CommandInput["cmd"]; actor: CommandInput["actor"]; idemKey: string; meta?: Json; extraWrites?: { recipe: "testSeat"; keyHash: string }; now?: number; seeds?: string[]; faults?: Faults }
interface LoadRequest { op: "load"; gameId: string }

const HTTPS_CODE = { CONTENTION: "aborted", UNAVAILABLE: "unavailable", INVARIANT: "internal", AGGREGATE_TOO_LARGE: "resource-exhausted", TOO_MANY_WRITES: "resource-exhausted" } as const;

function bad(what: string): never {
  throw new HttpsError("invalid-argument", `storeHarness: ${what}`);
}

/**
 * The test recipe for `extraWrites` (LLD 3 section 6.2, the Store half only): a seat doc and a `joinIdem` row for the joining player, computed purely
 * from the state and the request. Identity's real writes, `keyHash` handling and the raw-key sentinel are #42.
 */
function testSeat(keyHash: string, at: number): NonNullable<CommandInput["extraWrites"]> {
  return ({ next }) => {
    const p = next.players.at(-1);
    if (p === undefined) return [];
    const writes: DocWrite[] = [
      { op: "create", path: `games/${next.id}/seats/${p.id}`, data: { uid: p.uid, secretHash: "test-recipe-hash", createdAt: at, epoch: 0, notBefore: 0, firstSignInAt: null, revokedAt: null } },
      { op: "create", path: `joinIdem/${keyHash}`, data: { gameId: next.id, playerId: p.id, uid: p.uid, createdAt: at } },
    ];
    return writes;
  };
}

function faultHooks(f: Faults | undefined): FaultHooks | undefined {
  if (f === undefined) return undefined;
  return {
    fire(point, attempt) {
      if (point === "afterWritesBuffered" && f.abortAttempts?.includes(attempt) === true) throw Object.assign(new Error("injected ABORTED"), { code: 10 });
      if (f.throwAt === point) throw new InjectedFault(point);
    },
  };
}

async function runOp(r: RunRequest): Promise<{ ok: true; outcome: unknown; attempts: number; writes: number; seeds: string[] }> {
  if (typeof r.gameId !== "string" || typeof r.idemKey !== "string" || typeof r.cmd !== "object" || r.cmd === null || typeof r.actor !== "object" || r.actor === null) bad("run needs gameId, cmd, actor and idemKey");
  const seeds: string[] = [];
  const at = r.now ?? Date.now();
  const deps: Deps = {
    clock: () => r.now ?? Date.now(),
    newSeed: () => {
      const s = r.seeds?.[seeds.length] ?? `harness-${at}-${seeds.length}-${newCardId()}`;
      seeds.push(s);
      return s;
    },
    mintId: newCardId,
    ...(r.faults === undefined ? {} : { faults: faultHooks(r.faults) as FaultHooks }),
  };
  const input: CommandInput = {
    gameId: r.gameId, cmd: r.cmd, actor: r.actor, idemKey: r.idemKey,
    ...(r.meta === undefined ? {} : { meta: r.meta }),
    ...(r.extraWrites?.recipe === "testSeat" ? { extraWrites: testSeat(r.extraWrites.keyHash, at) } : {}),
  };
  try {
    const x = await execute(db(), deps, input);
    return { ok: true, outcome: x.outcome, attempts: x.attempts, writes: x.writes, seeds };
  } catch (e) {
    if (e instanceof StoreError) throw new HttpsError(HTTPS_CODE[e.kind], e.kind, { kind: e.kind });
    if (e instanceof InjectedFault) throw new HttpsError("internal", "injected fault", { kind: "FAULT", point: e.point });
    throw e;
  }
}

/** The handler, exported for the H2 unit test. Refuses outside the emulator even if reached. */
export async function handleStoreHarness(data: unknown): Promise<{ ok: true; [k: string]: unknown }> {
  if (!isEmulator()) throw new HttpsError("failed-precondition", "storeHarness runs only in the Functions emulator");
  const req = data as RunRequest | LoadRequest | null;
  if (req === null || typeof req !== "object") bad("no request");
  if (req.op === "load") {
    if (typeof req.gameId !== "string") bad("load needs gameId");
    return { ok: true, loaded: await load(db(), req.gameId) };
  }
  if (req.op === "run") return runOp(req);
  return bad("unknown op");
}

export const storeHarness = isEmulator()
  ? defineCallable({ name: "storeHarness", allow: ["guest"], runtime: RT.command, handler: async ({ req }) => handleStoreHarness(req.data) })
  : undefined;
