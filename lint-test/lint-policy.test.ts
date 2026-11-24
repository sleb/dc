// Lint policy fixtures (LLD 0 section 5; P5, P7, P12, P21). Each forbidden construct must be reported by
// the named rule; each permitted construct must not be. IDs L1..L7 match the plan on issue #10.
import { describe, expect, test } from "bun:test";
import { configPresent, lint, policy, summarize } from "./harness";

const imp = (spec: string) => `import x from "${spec}";\nexport default x;\n`;
const ENGINE = "packages/engine/src/x.ts";
const CONTRACTS = "packages/contracts/src/x.ts";
const WEB = "apps/web/src/x.ts";
const FN = "functions/src/x.ts";
const STORE = "functions/src/store/tx.ts";
const NOTIFY = "functions/src/notify/send.ts";
const SWEEP = "functions/src/notify/sweep.ts";

async function reported(file: string, code: string, rule: string, message?: RegExp) {
  const ms = await lint(file, code);
  const hit = ms.filter((m) => m.ruleId === rule);
  expect({ rule, got: summarize(ms) }).toEqual({ rule, got: expect.arrayContaining([expect.stringContaining(rule)]) });
  if (message) expect(hit.map((m) => m.message).join("\n")).toMatch(message);
}
async function quiet(file: string, code: string) {
  expect(summarize(policy(await lint(file, code)))).toEqual([]);
}

test("eslint.config.js exists", () => {
  expect(configPresent).toBe(true);
});

const NODE_IO = ["node:fs", "node:path", "fs", "fs/promises", "path", "os", "child_process", "net", "http", "https", "crypto", "stream", "worker_threads"];
const FIREBASE = ["firebase", "firebase/app", "firebase-admin", "firebase-admin/firestore", "firebase-functions", "firebase-functions/v2/https", "@firebase/rules-unit-testing", "@google-cloud/firestore"];
const BUN = ["bun", "bun:sqlite", "bun:test"];

describe("L1 engine banned imports (P5)", () => {
  for (const spec of [...FIREBASE, ...NODE_IO, ...BUN, "@dc/functions", "@dc/web"]) {
    test(`reports ${spec}`, () => reported(ENGINE, imp(spec), "no-restricted-imports"));
  }
  for (const spec of ["@dc/contracts", "zod", "./local", "../other"]) {
    test(`allows ${spec}`, () => quiet(ENGINE, imp(spec)));
  }
  test("test files are exempt", () => quiet("packages/engine/src/x.test.ts", imp("bun:test")));
});

describe("L2 engine banned globals (P5)", () => {
  for (const g of ["process", "Buffer", "fetch", "setTimeout", "setInterval", "performance", "crypto", "Bun", "window", "document"]) {
    test(`reports ${g}`, () => reported(ENGINE, `export const v = typeof ${g};\n`, "no-restricted-globals"));
  }
  test("allows ordinary globals", () => quiet(ENGINE, "export const v = [Math.max(1, 2), JSON.stringify({}), new Map()];\n"));
});

describe("L3 engine clock and entropy (P5)", () => {
  const cases: [string, string][] = [
    ["Date.now()", "export const v = Date.now();\n"],
    ["new Date()", "export const v = new Date();\n"],
    ["Math.random()", "export const v = Math.random();\n"],
    ["performance.now()", "export const v = performance.now();\n"],
    ["Date() without new", "export const v = Date();\n"],
    ["Date.now taken by reference", "export const f = Date.now;\n"],
    ["Math.random taken by reference", "export const f = Math.random;\n"],
    ["Math['random']()", "export const v = Math['random']();\n"],
  ];
  for (const [name, code] of cases) test(`reports ${name}`, () => reported(ENGINE, code, "no-restricted-syntax"));
  test("allows new Date(0)", () => quiet(ENGINE, "export const v = new Date(0);\n"));
  test("allows Math.floor", () => quiet(ENGINE, "export const v = Math.floor(1.5);\n"));
  test("test files are exempt", () => quiet("packages/engine/src/x.test.ts", "export const v = [Date.now(), Math.random(), new Date()];\n"));
});

describe("L4 direction rule (P5, section 3)", () => {
  const matrix: [string, string, string, boolean][] = [
    // [description, file, import, reported]
    ["engine -> @dc/functions", ENGINE, "@dc/functions", true],
    ["engine -> @dc/web", ENGINE, "@dc/web", true],
    ["engine -> @dc/contracts", ENGINE, "@dc/contracts", false],
    ["contracts -> @dc/engine", CONTRACTS, "@dc/engine", true],
    ["contracts -> @dc/functions", CONTRACTS, "@dc/functions", true],
    ["contracts -> @dc/web", CONTRACTS, "@dc/web", true],
    ["contracts -> zod", CONTRACTS, "zod", false],
    ["contracts -> firebase-admin", CONTRACTS, "firebase-admin", true],
    ["web -> @dc/engine", WEB, "@dc/engine", true],
    ["web -> @dc/engine/sub (subpath)", WEB, "@dc/engine/sub", true],
    ["web -> @dc/functions", WEB, "@dc/functions", true],
    ["web -> firebase-admin", WEB, "firebase-admin", true],
    ["web -> firebase-admin/auth", WEB, "firebase-admin/auth", true],
    ["web -> bun:sqlite", WEB, "bun:sqlite", true],
    ["web -> @dc/contracts", WEB, "@dc/contracts", false],
    ["web -> firebase/app", WEB, "firebase/app", false],
    ["functions -> @dc/web", FN, "@dc/web", true],
    ["functions -> @dc/engine", FN, "@dc/engine", false],
    ["functions -> @dc/contracts", FN, "@dc/contracts", false],
    ["functions -> firebase-admin", FN, "firebase-admin", false],
  ];
  for (const [name, file, spec, bad] of matrix) {
    test(`${bad ? "reports" : "allows"} ${name}`, () =>
      bad ? reported(file, imp(spec), "no-restricted-imports") : quiet(file, imp(spec)));
  }
});

describe("L4b test files may use bun:test in every package (P7)", () => {
  for (const file of ["packages/contracts/src/x.test.ts", "apps/web/src/x.test.ts", "apps/web/src/x.test.tsx"]) {
    test(`allows bun:test in ${file}`, () => quiet(file, imp("bun:test")));
  }
  test("still reports bun:test in a shipped contracts file", () => reported(CONTRACTS, imp("bun:test"), "no-restricted-imports"));
  test("still reports bun:test in a shipped web file", () => reported(WEB, imp("bun:test"), "no-restricted-imports"));
});

describe("L5 functions base rules (P7, P12)", () => {
  const API = "functions/src/api/handler.ts";
  test("reports onCall import", () => reported(API, `import { onCall } from "firebase-functions/v2/https";\nexport default onCall;\n`, "no-restricted-imports", /defineCallable/));
  test("reports onRequest import", () => reported(API, `import { onRequest } from "firebase-functions/v2/https";\nexport default onRequest;\n`, "no-restricted-imports", /defineCallable/));
  test("allows HttpsError from the same module", () => quiet(API, `import { HttpsError } from "firebase-functions/v2/https";\nexport default HttpsError;\n`));
  test("allows onSchedule", () => quiet(API, `import { onSchedule } from "firebase-functions/v2/scheduler";\nexport default onSchedule;\n`));
  test("allows onCall in api/callable.ts", () => quiet("functions/src/api/callable.ts", `import { onCall } from "firebase-functions/v2/https";\nexport default onCall;\n`));
  test("reports Bun global in functions/src", () => reported(FN, "export const v = typeof Bun;\n", "no-restricted-globals"));
  test("reports bun:sqlite import in functions/src", () => reported(FN, imp("bun:sqlite"), "no-restricted-imports"));
  // P7: Bun appears in no shipped code. The LLD block ignores callable.ts entirely, which would exempt it from this ban too.
  test("reports Bun global in api/callable.ts (P7)", () => reported("functions/src/api/callable.ts", "export const v = typeof Bun;\n", "no-restricted-globals"));
  test("reports bun:sqlite import in api/callable.ts (P7)", () => reported("functions/src/api/callable.ts", imp("bun:sqlite"), "no-restricted-imports"));
  test("allows bun:test in *.test.ts", () => quiet("functions/src/x.test.ts", imp("bun:test")));
  test("allows bun:test in test-integration", () => quiet("functions/test-integration/x.ts", imp("bun:test")));
  test("allows Bun global in functions/scripts", () => quiet("functions/scripts/build.ts", "export const v = typeof Bun;\n"));
  test("allows bun import in repo-level scripts", () => quiet("scripts/smoke.ts", imp("bun")));
});

describe("L6 Store ST2 (P21)", () => {
  test("reports firebase-admin/auth", () => reported(STORE, imp("firebase-admin/auth"), "no-restricted-imports"));
  test("reports firebase-admin/messaging", () => reported(STORE, imp("firebase-admin/messaging"), "no-restricted-imports"));
  test("reports notify import", () => reported(STORE, imp("../notify/send"), "no-restricted-imports"));
  test("reports identity import", () => reported(STORE, imp("../identity/accounts"), "no-restricted-imports"));
  test("reports notify directory import (bypass probe)", () => reported(STORE, imp("../notify"), "no-restricted-imports"));
  test("reports identity directory import (bypass probe)", () => reported(STORE, imp("../identity"), "no-restricted-imports"));
  test("reports fetch", () => reported(STORE, "export const v = typeof fetch;\n", "no-restricted-globals"));
  test("reports Math.random taken by reference", () => reported(STORE, "export const f = Math.random;\n", "no-restricted-syntax", /newSeed/));
  test("reports Math.random()", () => reported(STORE, "export const v = Math.random();\n", "no-restricted-syntax", /newSeed/));
  // The block sets the same rule keys as the base block, so it must re-include the base options (P21 hazard).
  test("still reports onCall import (base re-included)", () => reported(STORE, `import { onCall } from "firebase-functions/v2/https";\nexport default onCall;\n`, "no-restricted-imports", /defineCallable/));
  test("still reports bun:sqlite import (base re-included)", () => reported(STORE, imp("bun:sqlite"), "no-restricted-imports"));
  test("still reports Bun global (base re-included)", () => reported(STORE, "export const v = typeof Bun;\n", "no-restricted-globals"));
  test("allows firebase-admin/firestore", () => quiet(STORE, imp("firebase-admin/firestore")));
  test("allows Date.now() and Math.floor", () => quiet(STORE, "export const v = [Date.now(), Math.floor(1.5)];\n"));
  test("test files are exempt", () => quiet("functions/src/store/tx.test.ts", `${imp("bun:test")}export const v = Math.random();\n`));
});

describe("L7 notify T3 and sweep T1 (P21)", () => {
  test("notify reports Date.now()", () => reported(NOTIFY, "export const v = Date.now();\n", "no-restricted-syntax"));
  test("notify reports new Date()", () => reported(NOTIFY, "export const v = new Date();\n", "no-restricted-syntax"));
  test("notify reports Date() without new", () => reported(NOTIFY, "export const v = Date();\n", "no-restricted-syntax"));
  test("notify allows Math.random()", () => quiet(NOTIFY, "export const v = Math.random();\n"));
  test("notify allows new Date(0)", () => quiet(NOTIFY, "export const v = new Date(0);\n"));
  test("notify still reports Bun global (base applies)", () => reported(NOTIFY, "export const v = typeof Bun;\n", "no-restricted-globals"));
  test("notify test files are exempt from the clock ban", () => quiet("functions/src/notify/send.test.ts", "export const v = Date.now();\n"));

  test("sweep reports Date.now()", () => reported(SWEEP, "export const v = Date.now();\n", "no-restricted-syntax"));
  test("sweep reports @dc/engine", () => reported(SWEEP, imp("@dc/engine"), "no-restricted-imports"));
  test("sweep reports @dc/engine/sub (bypass probe)", () => reported(SWEEP, imp("@dc/engine/sub"), "no-restricted-imports"));
  test("sweep reports store/tx", () => reported(SWEEP, `import { listWaitingOn } from "../store/tx";\nexport default listWaitingOn;\n`, "no-restricted-imports"));
  test("sweep reports a store/index name outside the allowlist", () => reported(SWEEP, `import { runTransaction } from "../store/index";\nexport default runTransaction;\n`, "no-restricted-imports"));
  test("sweep reports a namespace import of the store", () => reported(SWEEP, `import * as store from "../store/index";\nexport default store;\n`, "no-restricted-imports"));
  test("sweep reports store/index.js outside the allowlist (bypass probe)", () => reported(SWEEP, `import { runTransaction } from "../store/index.js";\nexport default runTransaction;\n`, "no-restricted-imports"));
  test("sweep reports the bare ../store directory outside the allowlist (bypass probe)", () => reported(SWEEP, `import { runTransaction } from "../store";\nexport default runTransaction;\n`, "no-restricted-imports"));
  test("sweep allows listWaitingOn and runCommand from store/index", () => quiet(SWEEP, `import { listWaitingOn, runCommand } from "../store/index";\nexport default [listWaitingOn, runCommand];\n`));
  test("sweep allows listWaitingOn from ../store (bare directory)", () => quiet(SWEEP, `import { listWaitingOn } from "../store";\nexport default listWaitingOn;\n`));
  test("sweep still reports onCall import (base re-included)", () => reported(SWEEP, `import { onCall } from "firebase-functions/v2/https";\nexport default onCall;\n`, "no-restricted-imports", /defineCallable/));
  test("sweep still reports bun:sqlite import (base re-included)", () => reported(SWEEP, imp("bun:sqlite"), "no-restricted-imports"));
  test("sweep still reports Bun global (base re-included)", () => reported(SWEEP, "export const v = typeof Bun;\n", "no-restricted-globals"));
  test("sweep allows contracts", () => quiet(SWEEP, imp("@dc/contracts")));
});

// PJ4, PJ5 (LLD 2 section 2; #28): the Projector's files may not read owner-keyed data except `you.ts`, and build views field by field. The block replaces the engine block's
// rules for these keys, so each case that must still hold from the base is asserted too.
describe("L8 Projector rules (LLD 2 section 2, PJ4, PJ5)", () => {
  const PROJECT = "packages/engine/src/project/base.ts";
  const YOU = "packages/engine/src/project/you.ts";
  const sel = (name: string) => `import { ${name} } from "../selectors";\nexport default ${name};\n`;
  for (const name of ["handOf", "ownSubmission", "submittedBy", "submissionOwner", "exportPools"]) {
    test(`reports ${name} outside you.ts`, () => reported(PROJECT, sel(name), "no-restricted-imports", /you\.ts/));
    test(`reports ${name} imported with an alias`, () => reported(PROJECT, `import { ${name} as h } from "../selectors";\nexport default h;\n`, "no-restricted-imports"));
  }
  test("reports a namespace import of the selectors", () => reported(PROJECT, `import * as s from "../selectors";\nexport default s;\n`, "no-restricted-imports"));
  test("reports ownSubmission from the engine index path too", () => reported(PROJECT, `import { ownSubmission } from "../index";\nexport default ownSubmission;\n`, "no-restricted-imports"));
  test("reports handOf from the engine index path too", () => reported(PROJECT, sel("handOf").replace("../selectors", "../selectors.ts"), "no-restricted-imports"));
  test("allows the other selectors outside you.ts", () => quiet(PROJECT, sel("cardText")));
  test("allows handOf and ownSubmission in you.ts", () => quiet(YOU, `import { handOf, ownSubmission } from "../selectors";\nexport default [handOf, ownSubmission];\n`));
  test("you.ts still may not import submittedBy, submissionOwner or exportPools", () => {
    return Promise.all(["submittedBy", "submissionOwner", "exportPools"].map((n) => reported(YOU, sel(n), "no-restricted-imports")));
  });
  test("outside project/, the Engine may import handOf", () => quiet("packages/engine/src/x.ts", sel("handOf")));
  test("test files in project/ are exempt", () => quiet("packages/engine/src/project/x.test.ts", sel("handOf")));

  test("reports an object spread of a Game value", () => reported(PROJECT, "export const f = (game: object) => ({ ...game });\n", "no-restricted-syntax", /field by field/));
  test("reports an object spread of a player, a round and a submission", async () => {
    for (const v of ["player", "p", "round", "submission", "s"]) await reported(PROJECT, `export const f = (${v}: object) => ({ a: 1, ...${v} });\n`, "no-restricted-syntax");
  });
  test("reports a spread of a call or a member (any source but the shared base)", async () => {
    await reported(PROJECT, "export const f = (g: { round: object }) => ({ ...g.round });\n", "no-restricted-syntax");
    await reported(PROJECT, "export const f = (g: object) => ({ ...structuredClone(g) });\n", "no-restricted-syntax");
  });
  test("you.ts is not exempt from the spread ban", () => reported(YOU, "export const f = (p: object) => ({ ...p });\n", "no-restricted-syntax"));
  test("allows spreading the shared base", () => quiet(PROJECT, "export const f = (base: object) => ({ audience: 1, ...base });\n"));
  test("allows array spread", () => quiet(PROJECT, "export const f = (xs: number[]) => [...xs];\n"));
  test("outside project/, an object spread is fine", () => quiet("packages/engine/src/x.ts", "export const f = (game: object) => ({ ...game });\n"));

  test("still reports the clock and entropy (base re-spread)", async () => {
    await reported(PROJECT, "export const v = Date.now();\n", "no-restricted-syntax", /ctx\.now/);
    await reported(PROJECT, "export const v = Math.random();\n", "no-restricted-syntax", /Rng/);
    await reported(PROJECT, "export const v = new Date();\n", "no-restricted-syntax");
  });
  test("still reports the engine's banned imports and globals", async () => {
    await reported(PROJECT, imp("node:fs"), "no-restricted-imports");
    await reported(PROJECT, imp("firebase-admin"), "no-restricted-imports");
    await reported(PROJECT, "export const v = typeof process;\n", "no-restricted-globals");
  });
});
