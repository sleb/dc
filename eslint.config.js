// Lint and TypeScript policy (LLD 0 section 5). The behaviour of every block is asserted by lint-test/.
import tseslint from "typescript-eslint";

const NODE_IO = ["node:*", "fs", "fs/promises", "path", "os", "child_process", "net", "http", "https", "crypto", "stream", "worker_threads"];
const FIREBASE = ["firebase", "firebase/*", "firebase-admin", "firebase-admin/*", "firebase-functions", "firebase-functions/*", "@firebase/*", "@google-cloud/*"];
const BUN = ["bun", "bun:*"];
// Member selectors (not call selectors) so `const f = Date.now`, `Math["random"]()` and `Date()` are caught too.
const CLOCK = [
  { selector: "MemberExpression[object.name='Date'][property.name='now']", message: "No clock in engine; use ctx.now." },
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "No clock in engine; use ctx.now." },
  { selector: "CallExpression[callee.name='Date']", message: "No clock in engine; use ctx.now." },
];
const RANDOM = { selector: "MemberExpression[object.name='Math'][property.value='random'], MemberExpression[object.name='Math'][property.name='random']", message: "Use the injected Rng." };
const CLOCK_AND_ENTROPY = [
  ...CLOCK,
  RANDOM,
  { selector: "CallExpression[callee.object.name='performance']", message: "No clock in engine." },
];
// Base restrictions for all of packages/engine/src (the Projector blocks below re-spread them).
const ENGINE_IMPORT_PATTERNS = [{ group: [...FIREBASE, ...NODE_IO, ...BUN, "@dc/functions", "@dc/web"] }];
const ENGINE_GLOBALS = ["process", "Buffer", "fetch", "setTimeout", "setInterval", "performance", "crypto", "Bun", "window", "document"];
const SELECTORS = ["**/selectors", "**/selectors.*", "**/index", "**/index.*"];
const NO_OBJECT_SPREAD = { selector: "ObjectExpression > SpreadElement[argument.name!='base']", message: "Build views field by field; only the shared `base` may be spread (LLD 2 section 2)." };
// Base restrictions for all of functions/src. A later flat-config block that sets the same rule key
// replaces the earlier options instead of merging them, so every narrower functions/src block below
// spreads these in rather than restating (or dropping) them.
const FN_IMPORT_PATTERNS = [...BUN, "@dc/web"];
const FN_IMPORT_PATHS = [{ name: "firebase-functions/v2/https", importNames: ["onCall", "onRequest"], message: "Use defineCallable() from api/callable." }];
const FN_GLOBALS = ["Bun"];
const TESTS = ["**/*.test.ts", "**/*.test.tsx"];

export default [
  { ignores: ["**/dist/**", "**/node_modules/**"] },

  // Every TypeScript file: type-aware rules. Test configs are listed so *.test.ts files have a project.
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ["packages/*/tsconfig.json", "packages/*/tsconfig.test.json", "functions/tsconfig.json", "functions/tsconfig.test.json", "apps/web/tsconfig.json", "apps/web/tsconfig.test.json", "apps/web/tsconfig.node.json", "lint-test/tsconfig.json", "rules-test/tsconfig.json", "scripts/tsconfig.json", "hosting-test/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: "warn" },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },

  { files: ["packages/engine/src/**/*.ts"], ignores: TESTS, rules: {
      "no-restricted-imports": ["error", { patterns: ENGINE_IMPORT_PATTERNS }],
      "no-restricted-globals": ["error", ...ENGINE_GLOBALS],
      "no-restricted-syntax": ["error", ...CLOCK_AND_ENTROPY] } },
  // LLD 2 section 2, PJ4, PJ5 (#28): the Projector builds views field by field and reads owner-keyed data in one place. These blocks set the same three rule keys as the engine block above
  // and so replace it for these files: every engine rule is re-spread. `handOf` and `ownSubmission` are importable only by you.ts; `submittedBy`, `submissionOwner` and `exportPools` by no file in project/ (PJ4: never called).
  // The spread rule is syntactic, not type-aware: the only object spread allowed is of the shared `base`, built once from named fields.
  { files: ["packages/engine/src/project/**/*.ts"], ignores: TESTS, rules: {
      "no-restricted-imports": ["error", { patterns: [...ENGINE_IMPORT_PATTERNS, { group: SELECTORS, importNames: ["handOf", "ownSubmission", "submittedBy", "submissionOwner", "exportPools"], message: "Hand and own-submission reads belong to project/you.ts only (LLD 2 section 2); submittedBy, submissionOwner and exportPools are never used by the Projector (PJ4, PJ6)." }] }],
      "no-restricted-globals": ["error", ...ENGINE_GLOBALS],
      "no-restricted-syntax": ["error", ...CLOCK_AND_ENTROPY, NO_OBJECT_SPREAD] } },
  { files: ["packages/engine/src/project/you.ts"], ignores: TESTS, rules: {
      "no-restricted-imports": ["error", { patterns: [...ENGINE_IMPORT_PATTERNS, { group: SELECTORS, importNames: ["submittedBy", "submissionOwner", "exportPools"], message: "The Projector never calls submittedBy (time order, PJ6), submissionOwner or exportPools (PJ4)." }] }],
      "no-restricted-globals": ["error", ...ENGINE_GLOBALS],
      "no-restricted-syntax": ["error", ...CLOCK_AND_ENTROPY, NO_OBJECT_SPREAD] } },
  { files: ["packages/contracts/src/**/*.ts"], ignores: TESTS, rules: {
      "no-restricted-imports": ["error", { patterns: [...FIREBASE, ...NODE_IO, ...BUN, "@dc/*"] }] } },
  { files: ["apps/web/src/**/*.{ts,tsx}"], ignores: TESTS, rules: {
      "no-restricted-imports": ["error", { patterns: [...BUN, "firebase-admin", "firebase-admin/*", "@dc/engine", "@dc/engine/*", "@dc/functions"] }] } },

  { files: ["functions/src/**/*.ts"], ignores: ["functions/src/api/callable.ts", ...TESTS], rules: {
      "no-restricted-imports": ["error", { patterns: FN_IMPORT_PATTERNS, paths: FN_IMPORT_PATHS }],
      "no-restricted-globals": ["error", ...FN_GLOBALS] } },
  // P12: callable.ts is the one module that may import onCall/onRequest. It is still shipped code, so P7 applies.
  { files: ["functions/src/api/callable.ts"], rules: {
      "no-restricted-imports": ["error", { patterns: FN_IMPORT_PATTERNS }],
      "no-restricted-globals": ["error", ...FN_GLOBALS] } },
  // ST2 (LLD 3): the transaction callback is re-executable, so the Store has no side-effect or entropy sources.
  { files: ["functions/src/store/**/*.ts"], ignores: TESTS, rules: {
      "no-restricted-imports": ["error", { patterns: [...FN_IMPORT_PATTERNS, "firebase-admin/auth", "firebase-admin/messaging", "**/notify", "**/notify/*", "**/identity", "**/identity/*"], paths: FN_IMPORT_PATHS }],
      "no-restricted-globals": ["error", ...FN_GLOBALS, "fetch"],
      "no-restricted-syntax": ["error", { ...RANDOM, message: "Use deps.newSeed()." }] } },
  // T3 (LLD 6): time enters notifications only through the injected clock.
  { files: ["functions/src/notify/**/*.ts"], ignores: TESTS, rules: {
      "no-restricted-syntax": ["error", ...CLOCK] } },
  // T1 (LLD 6): the sweep holds no game logic; from the Store it may import only listWaitingOn and runCommand.
  // (The notify block above sets only no-restricted-syntax, which the base block does not, so nothing is lost there.)
  { files: ["functions/src/notify/sweep.ts"], rules: {
      "no-restricted-imports": ["error", { patterns: [
        // A patterns array is all strings or all objects, so the base strings go in as one group.
        { group: FN_IMPORT_PATTERNS },
        { group: ["@dc/engine", "@dc/engine/*"] },
        { group: ["**/store/*", "!**/store/index", "!**/store/index.*"], message: "The sweep may import only listWaitingOn and runCommand, from the store index." },
        { group: ["**/store", "**/store/index", "**/store/index.*"], allowImportNames: ["listWaitingOn", "runCommand"], message: "The sweep may import only listWaitingOn and runCommand from the store." },
      ], paths: FN_IMPORT_PATHS }] } },
  // No block for *.test.ts, functions/test-integration and rules-test: the BUN ban is not applied to them, so bun:test is allowed there and nowhere else.
];
