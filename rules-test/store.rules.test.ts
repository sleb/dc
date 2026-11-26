import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import type { RulesTestContext } from "@firebase/rules-unit-testing";
import { collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";
import { GAME, LLD_PRINCIPALS, PRINCIPALS, ROWS, SEED, allowed, caseCount, opsOf } from "./matrix";
import type { Op, PrincipalId, Row, SpectatorState, Target } from "./matrix";

// LLD 3 section 3.3 (#32): every (row, target, principal, operation) cell of the denial matrix in `matrix.ts`, run on
// the Firestore emulator against the ruleset `firebase deploy` uploads, read from disk (T4). Allowed cells must
// succeed; every other cell must fail with exactly `permission-denied` (a `not-found` or an evaluation error is a
// failure, not a pass). The last test is the R2 guard: the executed case count equals the count the matrix implies.
// What this proves is the content of `firestore.rules`; that the deployed ruleset equals it is #17's (no read-back).
const RULES = join(import.meta.dir, "../firestore.rules");
if (!(await Bun.file(RULES).exists())) throw new Error(`firestore.rules is missing (${RULES}); test:rules loads the deployed file`);

const env = await initializeTestEnvironment({ projectId: "demo-deepcuts", firestore: { rules: await Bun.file(RULES).text() } });
afterAll(() => env.cleanup());

const contexts = new Map<PrincipalId, RulesTestContext>(
  PRINCIPALS.map((p) => [p.id, p.uid === null ? env.unauthenticatedContext() : env.authenticatedContext(p.uid, p.claims)]),
);
const dbOf = (id: PrincipalId): Firestore => {
  const ctx = contexts.get(id);
  if (!ctx) throw new Error(`no context for principal ${id}`);
  return ctx.firestore() as unknown as Firestore;
};

const SPECTATOR = `games/${GAME}/views/spectator`;
async function setSpectator(state: SpectatorState): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore() as unknown as Firestore;
    if (state === "missing") await deleteDoc(doc(db, SPECTATOR));
    else await setDoc(doc(db, SPECTATOR), { enabled: state === "enabled", view: state === "enabled" ? {} : null });
  });
}

beforeAll(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore() as unknown as Firestore;
    for (const [path, data] of Object.entries(SEED)) await setDoc(doc(db, path), data);
  });
});

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

/** Runs one cell; resolves on success, rejects with the SDK error on denial. */
async function run(db: Firestore, target: Target, op: Op): Promise<void> {
  if (target.kind === "collectionGroup") {
    await getDocs(collectionGroup(db, target.group));
    return;
  }
  if (target.kind === "collection") {
    const ref = collection(db, target.path);
    await getDocs(target.where ? query(ref, where(target.where.field, target.where.op, target.where.value)) : ref);
    return;
  }
  const path = target.path;
  switch (op) {
    case "get": {
      const snap = await getDoc(doc(db, path));
      // An allowed get must see the seeded document, or the case proves nothing about the row.
      if (!snap.exists()) throw new Error(`get ${path} succeeded but the seeded document is missing`);
      return;
    }
    case "list":
      await getDocs(collection(db, parentOf(path)));
      return;
    case "create":
      await setDoc(doc(db, target.missing ? path : `${parentOf(path)}/created-by-rules-test`), { a: 1 });
      return;
    case "update":
      await updateDoc(doc(db, path), { a: 2 });
      return;
    case "delete":
      await deleteDoc(doc(db, path));
      return;
  }
}

const label = (t: Target) => (t.kind === "collectionGroup" ? `collectionGroup(${t.group})` : t.kind === "collection" ? `query ${t.path}${t.where ? ` where ${t.where.field}` : ""}` : t.path);

let executed = 0;

function rowSuite(row: Row) {
  describe(`row ${row.n}: ${row.title}`, () => {
    beforeAll(async () => {
      await setSpectator(row.spectator ?? "enabled");
    });
    for (const target of row.targets) {
      for (const principal of PRINCIPALS) {
        for (const op of opsOf(target)) {
          const allow = allowed(row, principal.id, op);
          test(`${label(target)} ${op} by ${principal.id}: ${allow ? "allowed" : "denied"}`, async () => {
            let error: unknown;
            try {
              await run(dbOf(principal.id), target, op);
            } catch (e) {
              error = e;
            }
            executed += 1;
            if (allow) {
              expect(error === undefined ? "succeeded" : `failed: ${String(error)}`).toBe("succeeded");
            } else {
              expect(error === undefined ? "succeeded" : ((error as { code?: string }).code ?? `no code: ${String(error)}`)).toBe("permission-denied");
            }
          });
        }
      }
    }
  });
}

for (const row of ROWS) rowSuite(row);

describe("R4 the enabled flip: the same spectator doc rewritten between assertions", () => {
  test("true -> false -> true: spec reads, is denied, reads again", async () => {
    const read = async () => {
      try {
        await getDoc(doc(dbOf("spec"), SPECTATOR));
        return "allowed";
      } catch (e) {
        return (e as { code?: string }).code ?? String(e);
      }
    };
    await setSpectator("enabled");
    expect(await read()).toBe("allowed");
    await setSpectator("disabled");
    expect(await read()).toBe("permission-denied");
    await setSpectator("enabled");
    expect(await read()).toBe("allowed");
  });
});

describe("R2 case-count guard", () => {
  test("the matrix has rows 1 to 21, every LLD 3 section 3.3 principal, and every case ran", () => {
    expect(ROWS.map((r) => r.n)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    for (const id of LLD_PRINCIPALS) expect(PRINCIPALS.map((p) => p.id)).toContain(id);
    expect(executed).toBe(caseCount());
  });
});
