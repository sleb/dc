# Deep Cuts: LLD 0, Platform, Build & Deploy

Status: draft v0.1. Companion to [gameplay.md](../gameplay.md), [high-level-design.md](../high-level-design.md) and [tech-stack.md](../tech-stack.md); the tech stack is the main source for this document. It covers the Firebase projects, the Bun monorepo, the functions bundling step, lint and TypeScript rules, CI/CD, the emulator test setup, config and secrets, observability, and a step-by-step first staging deploy. It contains no game logic, data model, rules content or UI. "Must" statements are testable and labeled P1 onward.

## 1. Environments

| Env | Firebase project | Backend | Web | Deployed by |
|---|---|---|---|---|
| local | `demo-deepcuts` (emulators only) | Emulator Suite, Functions emulator running the Node bundle | `vite dev` or `vite preview` | developer |
| PR preview | `deepcuts-staging` | Staging functions, Firestore and Auth (shared, not per-PR) | Hosting preview channel `pr-{n}`, 7-day expiry | CI on pull request |
| staging | `deepcuts-staging` | Staging | Live channel | CI on push to `main` |
| prod | `deepcuts-prod` | Prod | Live channel | CI on tag `v*.*.*` |

- P1. The `demo-` project id prefix is used for every emulator run, so tests cannot reach a real project. Test scripts must unset `GOOGLE_APPLICATION_CREDENTIALS` and fail if it is set.
- P2. Real project ids appear only in `.firebaserc`, the committed per-env web config files and the names of the function param files `functions/.env.<projectId>` (section 7), plus the explicit `--project` flags in CI. Function code reads its project from the runtime (`process.env.GCLOUD_PROJECT`), never from a literal.
- Region: Firestore `nam5`; functions `us-central1` (co-located; set once in `setGlobalOptions`). Neither can change cheaply, so both are fixed here.

## 2. Firebase project setup

Done once per project (`deepcuts-staging`, `deepcuts-prod`), by hand in the console or `gcloud`; the first-deploy walkthrough (section 11) sequences it. Nothing here is created by CI.

| Item | Setting |
|---|---|
| Plan | Blaze. Budget with alerts at 50%, 90%, 100% of $10/month (staging) and $25/month (prod), emailed to the owner. Budgets alert but do not cap; the alert is the control. |
| Default GCP resource location | `us-central` (set implicitly by creating Firestore in `nam5`). This also satisfies Cloud Scheduler. |
| Firestore | Native mode, `nam5`. TTL policies on field `expiresAt` for the six collection groups LLD 3 sections 2 and 4 lists: `idem` (covers `games/*/idem` and `hosts/*/idem`, 7 days), `outbox` (14 days), `notifLog` (30 days), `rateLimits` (two windows), `deletions` (7 days after completion), `joinIdem` (top-level join idempotency records keyed by key hash, 7 days; LLD 4). Declared in `firestore.indexes.json` `fieldOverrides` (`"ttl": true`); that this is accepted by the pinned `firebase-tools` is **unverified**, so the first-deploy walkthrough tests it and falls back to `gcloud firestore fields ttls update expiresAt --collection-group=<group> --enable-ttl` per group (step 2), run by `ops-apply` thereafter. Rules and indexes deploy from the repo, never edited in the console. |
| Auth providers | Email link (passwordless) and Anonymous. Password and all others stay off. Authorized domains: the project's `web.app` and `firebaseapp.com` hosts, plus the custom domain once it exists. |
| Identity Platform | Upgrade Firebase Authentication to Identity Platform (LLD 4 section 13; free tier at this scale, to confirm). Enable automatic cleanup of anonymous accounts (30 days inactive) and App Check enforcement for Auth endpoints; it is also the prerequisite for the `beforeEmailSent` blocking function (LLD 5 8.1). |
| Hosting | Default site. SPA rewrite and headers from `firebase.json`. |
| App Check | reCAPTCHA Enterprise provider for the web app. Enforcement ON for Firestore (so nothing client-side bypasses callables) and enforced per callable in code (`enforceAppCheck: true`). A debug token is registered per project for CI smoke tests (section 8). |
| Web app | One registered web app per project; its config object is public and committed (section 7). |
| Secret Manager | API enabled; secrets in section 7. |
| APIs | Besides the section 11 list: `fcm.googleapis.com` and `fcmregistrations.googleapis.com` (LLD 6 push), `identitytoolkit.googleapis.com` (Identity Platform). |
| Error Reporting, Logging, Monitoring | On by default; used per section 9. |

**IAM.** Three service accounts per project, least privilege, no downloaded keys.

| Account | Purpose | Roles |
|---|---|---|
| `fn-runtime@{project}.iam.gserviceaccount.com` | Runtime identity for all functions (`serviceAccount` in `setGlobalOptions`) | `roles/datastore.user`, `roles/firebaseauth.admin` (create/delete seat users, revoke tokens), `roles/firebasecloudmessaging.admin`, `roles/secretmanager.secretAccessor`, `roles/logging.logWriter`, `roles/cloudtrace.agent`, and `roles/iam.serviceAccountTokenCreator` **granted on itself** |
| `ci-deployer@{project}.iam.gserviceaccount.com` | Used by GitHub Actions via Workload Identity Federation | `roles/firebase.admin`, `roles/cloudfunctions.developer`, `roles/cloudscheduler.admin`, `roles/artifactregistry.writer`, `roles/serviceusage.serviceUsageConsumer`, `roles/iam.serviceAccountUser` on `fn-runtime`, plus monitoring/logging config roles for the `ops` step |
| Default compute SA | Unused; its `Editor` role is removed | none |

The self-grant of `iam.serviceAccountTokenCreator` is what lets `admin.auth().createCustomToken()` sign through IAM `signBlob` in the cloud (tech-stack section 4). Without it, `joinGame` and `rejoin` fail in cloud but pass in the emulator, so it is the first thing the first-deploy walkthrough verifies.

- P3. Besides the accounts Google creates itself (the default compute and App Engine accounts, and `firebase-adminsdk-*`, which is Firebase's own and is never used by our code), each project has exactly the accounts above, and no user-managed service account key exists on any account in the project. There is no organization on a personal account, so the `iam.disableServiceAccountKeyCreation` org policy is not available; the control is that no key is ever created, and check V9 asserts it. GitHub reaches GCP only through Workload Identity Federation, with the provider's attribute condition restricted to this repository.
- P4. The prod provider condition additionally requires `assertion.environment == 'production'`; staging's requires `environment == 'staging'` or a PR from the same repository.

### 2.1 Setup checklist

`scripts/verify-staging.sh` asserts every row (read-only, exits 0 only if all pass); `scripts/provision-staging.sh` creates them idempotently. Both take `PROJECT=`, `ENV_NAME`, `ENV_SUFFIX` and `BUDGET_AMOUNT`; prod additionally needs its P4 WIF condition wired in M8, which is not done yet. See [scripts/README.md](../../scripts/README.md).

| Check | Item | staging | prod |
|---|---|---|---|
| V1 | Project exists, Blaze billing attached | [x] | [ ] |
| V2 | Budget with alerts at 50/90/100% ($10 staging, $25 prod) | [x] | [ ] |
| V3 | Firestore Native at `nam5` | [x] | [ ] |
| V4 | TTL on `expiresAt` for the six groups, state ACTIVE | [x] | [ ] |
| V5 | All required APIs enabled | [x] | [ ] |
| V6 | Identity Platform: Email link and Anonymous only, anonymous auto-cleanup, authorized domains | [x] | [ ] |
| V7 | Web app, App Check on reCAPTCHA Enterprise, enforcement on Firestore and Identity Toolkit, debug token | [x] | [ ] |
| V8 | `fn-runtime` and `ci-deployer` have exactly the roles above, self-grant, `serviceAccountUser` on `fn-runtime`, compute SA has no `Editor` | [x] | [ ] |
| V9 | No user-managed service account keys | [x] | [ ] |
| V10 | WIF pool and provider restricted to this repo with the P4 condition; GitHub environment and variables | [x] | [ ] |
| V11 | Three secrets exist and `fn-runtime` is the only principal bound on each secret (V11 checks secret-level bindings; project-level owners can still read); `APPCHECK_DEBUG_TOKEN` in the GitHub environment | [x] | [ ] |
| V12 | `apps/web/.env.<mode>`, `functions/.env.<projectId>` and `.firebaserc` have the required keys | [x] | [ ] |
| V13 | No secret value committed (betterleaks, config `.betterleaks.toml`) | [x] | [ ] |
| V14 | Default Hosting site exists | [x] | [ ] |

Not proven by the checklist: V8 shows the self-grant is present, not that `createCustomToken` signs at runtime (the `diag` probe, section 11 step 16); and whether the pinned `firebase-tools` accepts `"ttl": true` in `fieldOverrides` (first deploy). The gcloud TTL fallback is what is live today.

Notes from setting up staging:

- **Everything is scriptable.** The Identity Platform upgrade (`identityPlatform:initializeAuth`), the Auth config, the reCAPTCHA Enterprise key (`gcloud recaptcha keys create`), the App Check provider, enforcement and debug token (Firebase App Check REST API) all work without the console. Only choosing the billing account is a human decision.
- **Authorized domains.** The `web.app` and `firebaseapp.com` hosts are authorized by default. Whether Hosting preview channel hosts (`<project>--pr-<n>-<hash>.web.app`) are accepted for email-link sign-in is **unverified**; check on the first preview in the first deploy. If they are not, the preview build skips email-link sign-in and the smoke path uses the debug token only.
- **Budget alerts** go to the billing account's admins by IAM, not to a custom notification channel.
- **ci-deployer extra roles** ("monitoring/logging config roles for the `ops` step") are `roles/monitoring.editor` and `roles/logging.configWriter`.
- **WIF names.** Pool and provider are both `github`. The staging provider condition is `assertion.repository == '<repo>' && (assertion.environment == 'staging' || assertion.event_name == 'pull_request')`.

## 3. Repository layout

```
dc/
  .bun-version                 # exact Bun version, read by setup-bun
  .firebaserc
  .github/workflows/ci.yml
  bun.lock
  bunfig.toml                  # exact = true: `bun add` pins exact versions
  eslint.config.js
  firebase.json
  firestore.indexes.json
  firestore.rules
  package.json
  tsconfig.base.json
  lint-test/                   # policy tests: real eslint.config.js and tsc against snippets (`bun run test:lint`); own tsconfig.json
  apps/web/                    # @dc/web: React, Vite, PWA, Tailwind
    .env.staging  .env.production  .env.emulator   # public config, committed; Vite's .env.<mode> names, read for --mode <mode>
    package.json  tsconfig.json  tsconfig.test.json  vite.config.ts  src/
  functions/                   # @dc/functions
    package.json  tsconfig.json  tsconfig.test.json   # tsconfig.test.json also covers scripts/
    src/index.ts               # exports every deployed function
    src/api/callable.ts        # defineCallable (alias callable): the only module allowed to import onCall (P12)
    src/store/  src/notify/    # lint-isolated trees (ST2, T3; section 5)
    src/log.ts                 # typed logger (section 9); starts minimal (#12: `api.done` and its fields), #17 extends it
    exports.json               # every deployed function name (check-bundle)
    scripts/build.ts  scripts/check-bundle.ts  # exported functions plus a thin `import.meta.main` CLI; tests in scripts/*.test.ts (fixtures, a fake `npm` on PATH)
    test-integration/          # emulator suites, bun:test, run against dist (P9)
    .env.deepcuts-staging  .env.deepcuts-prod   # non-secret function params, committed; copied into dist by build.ts
    dist/                      # generated, gitignored: index.cjs, package.json, package-lock.json, node_modules, .env.* copies
  packages/
    engine/                    # @dc/engine: pure core, Projector, Moderation (package.json, tsconfig.json, tsconfig.test.json, src/)
    contracts/                 # @dc/contracts: zod schemas and types (same shape)
  rules-test/                  # @firebase/rules-unit-testing suites
  e2e/                         # Playwright
  ops/                         # metrics, alert policies, dashboard JSON (section 9)
  scripts/                     # repo-level Bun scripts (smoke.ts, ops-apply.ts, wait-indexes.ts, check-web-size.ts); not shipped
  docs/
```

Dependency direction, enforced by lint (P5): `contracts` imports no workspace package; `engine` imports only `contracts`; `functions` imports `engine` and `contracts`; `web` imports only `contracts` (the client holds no authority, HLD C1, so it never imports the engine; anything it needs to display comes in the `GameView`).

Root `package.json` (the scripts marked "this step" exist now; the rest arrive with the step that owns them: the `test*` scripts with #13, `build:web` with #14, `dev` with #15):

```jsonc
{
  "name": "deepcuts",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*", "functions"],
  "scripts": {
    "lint": "eslint . --max-warnings 0",                                   // this step
    "typecheck": "bun run --filter '*' typecheck && tsc --noEmit -p lint-test/tsconfig.json && tsc --noEmit -p rules-test/tsconfig.json",  // this step; #13 adds rules-test
    "test:lint": "bun test lint-test",                                    // this step; `test` also runs it (about 6 s); kept for running it alone
    "test": "bun test packages functions/src functions/scripts lint-test",   // #13
    "test:web": "bun test --preload ./apps/web/test/setup.ts apps/web/src",   // #13 (Bun needs the leading ./)
    "test:rules": "firebase emulators:exec --only firestore --project demo-deepcuts 'bun test rules-test'",
    "test:integration": "bun run build:functions && firebase emulators:exec --only auth,firestore,functions --project demo-deepcuts 'bun test functions/test-integration --timeout 30000'",
    "test:e2e": "echo 'test:e2e: NO SUITE. ...'",   // #13 placeholder: exits 0 and says no suite ran; #14 onward replaces it with the line below
    // "test:e2e": "bun run build:functions && firebase emulators:exec --only auth,firestore,functions --project demo-deepcuts 'bunx playwright test'",
    "build:functions": "bun run --cwd functions build",             // issue #11
    "build:web": "bun run --cwd apps/web build",
    "dev": "firebase emulators:start --project demo-deepcuts"
  }
}
```

Dev dependencies are the latest stable at the time each step adds them, exact-pinned in `package.json` and `bun.lock` (`bunfig.toml` sets `exact = true`); this document carries no version numbers. This step adds `eslint`, `typescript-eslint`, `typescript`, `@types/bun` and `@types/node` (the Node 22 line, matching the functions runtime). Later steps add `firebase-tools`, `@firebase/rules-unit-testing`, `@playwright/test`, `happy-dom`, `@testing-library/*` and `@axe-core/playwright`. `typescript` stays on the newest release that typescript-eslint supports: TypeScript 7 is the native compiler and has no JavaScript API for typescript-eslint, so the repo stays on the latest 6.x until typescript-eslint supports 7. The web workspace's own devDependencies (`wouter`, `@tailwindcss/vite`, `vite-plugin-pwa` with its `workbox-*`) are declared in `apps/web/package.json` per LLD 7. Test isolation: `happy-dom`'s global registration (the `--preload`) must not leak into engine and functions tests, so `test` excludes `apps/web/src` and `test:web` runs web tests in a separate Bun process (LLD 7 conflict 10); a guard test in `packages/engine/test` fails if DOM globals ever reach the root `test` process. `test:web` preloads `@happy-dom/global-registrator` (the package that provides global registration; `happy-dom` itself comes with it). The `fast-check` devDependency of the engine is added to the P5 allowlist (`lint-test/engine-deps.ts`); `FC_SEED` and `FC_NUM_RUNS` are read by `packages/engine/test/support/fc.ts` (P11).

Each workspace `package.json` uses `"name": "@dc/<dir>"`, internal deps as `"workspace:*"`, and (for `engine` and `contracts`) `"exports": { ".": "./src/index.ts" }`. Packages are consumed as TypeScript source and are never built on their own; Vite and the functions bundler compile them in place.

`functions/package.json` is the single source of truth for runtime versions:

```json
{
  "name": "@dc/functions",
  "private": true,
  "scripts": { "build": "bun scripts/build.ts", "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json" },
  "dependencies": { "firebase-admin": "<pinned>", "firebase-functions": "<pinned>" },
  "devDependencies": { "@dc/engine": "workspace:*", "@dc/contracts": "workspace:*", "@types/node": "<pinned, 22 line>" }
}
```

`build` arrived with #11. `firebase-functions` stays on the latest stable until decision issue #7 says otherwise. `engine` and `contracts` are devDependencies on purpose: they are bundled, not installed in the cloud. `zod` is a dependency of `contracts` and is bundled too.

## 4. Functions bundling

The Firebase CLI uploads the `source` directory and runs `npm install` in Cloud Build. It cannot resolve `workspace:*` and ignores `bun.lock` (tech-stack section 8), so `source` is `functions/dist`, a self-contained package.

`functions/scripts/build.ts` exports `build(root, { env?, check? })` (`root` is the functions directory; `env` is the environment of the `npm install` child, which tests use to put a fake `npm` first on `PATH`; `check` defaults to true). A thin `import.meta.main` wrapper calls it for the real `functions` directory, prints `build: ok` and exits 1 with the message on failure. In order:

1. Read `package.json`. Each of `RUNTIME_DEPS` (`firebase-admin`, `firebase-functions`) must be an exact version: `x.y.z`, optionally with a `-prerelease` or `+build` suffix; no ranges, `^`, `~`, dist-tags or aliases (the error message says so), and no other runtime dependency may exist; otherwise throw.
2. Remove `dist/index.cjs`, so a failed build never leaves a stale bundle, then `Bun.build` `src/index.ts` as `cjs` for `target: "node"`, unminified, with no sourcemap, and `RUNTIME_DEPS` and `RUNTIME_DEPS/*` external. Workspace packages (`@dc/contracts`, `@dc/engine`) and `zod` are bundled.
3. Write `dist/package.json` (`name`, `private`, `main: "index.cjs"`, `engines.node: "22"`, the pinned `dependencies`) only when its content changed.
4. Install stamp. `.install-ok` holds the sha256 of `dist/package.json`. `npm install --omit=dev --no-audit --no-fund` runs in `dist` unless the stamp matches and both `dist/node_modules` and `dist/package-lock.json` exist. The stamp is removed before installing and written only after success, so a failed install is retried on the next build (the failure throws `npm install failed with exit code N`). It creates `package-lock.json` (used by Cloud Build's `npm ci`) and `node_modules` (needed locally for the CLI's function discovery and the Functions emulator).
5. Mirror `functions/.env*` (names matching `^\.env(\..+)?$`, so `.env.local` is included) into `dist` byte for byte: copies in `dist` without a source are removed, changed or missing ones are copied, identical ones are left alone, so a second build touches nothing. The CLI reads `.env`, `.env.<projectId>` and `.env.local` from the functions source directory, which is `dist`. The mirrored `.env.local` and `.env.*.local` are never uploaded: `firebase.json` lists them in `ignore` (issue #11; #17 confirms the CLI's behaviour on the first deploy).
6. Run `checkBundle(root)` and throw if it reports anything.

`build.ts` and `check-bundle.ts` run under Bun; the output they produce runs only under Node. They use `Bun.*` legitimately because the script is not shipped (P7 scopes the ban accordingly).

`functions/scripts/check-bundle.ts` exports `checkBundle(root)`, which returns one message per problem (an empty list means good); the CLI wrapper prints them and exits 1, and `build` throws on a non-empty list. The bundle is bad unless all of these hold:

1. `dist/index.cjs` contains no `bun:` string, no `Bun.` global use, and no `@dc/` specifier.
2. Every `require("...")`, `__require("...")` and dynamic `import("...")` target is a Node builtin (`node:` prefix) or starts with a name in `dist/package.json` `dependencies`.
3. The bundle loads under plain Node (a `node -e` child doing `require('./dist/index.cjs')` with `GCLOUD_PROJECT=demo-deepcuts`; the child gets only `PATH`, `HOME` and `GCLOUD_PROJECT`; a load failure reports the first lines of Node's stderr; a missing `node`, or a Node that is not major 22, is reported as a problem) and exports every name in a checked-in `functions/exports.json` (the callables and triggers LLDs 3 to 6 declare: the LLD 5 callables plus `beforeEmailSent` when implemented, LLD 4's `identityOutbox`, LLD 3's deletion runner trigger `deletionRunner`, LLD 6's `notifyOutbox`, `reminderSweep` and `housekeeping`). A function added in code but missing from the list, or the reverse, fails (the `__esModule` marker is not a function). `exports.json` is `[]` until #12 adds `ping` and `diag`. That the callable `REGISTRY` of `defineCallable` equals the callable subset of the list (LLD 5 API1) is a separate check owned by #12.

- P6. `bun run build:functions` produces `functions/dist` deterministically from `bun.lock` plus sources, and `check-bundle` passes. `dist/package.json` lists exactly the exact-pinned `RUNTIME_DEPS` and nothing else. A build after a failed `npm install` reinstalls (the `.install-ok` stamp is written only on success), and `dist/.env*` equals the set of `functions/.env*` files byte for byte.
- P7. The bundle loads and registers its functions under Node 22 with no Bun present on `PATH` (the CI integration job removes Bun from `PATH` after building).
- Pinning: direct deps are exact; transitive deps are fixed by the committed-per-build `dist/package-lock.json`. The lockfile is generated, not committed; two builds a day apart can differ in transitive versions. Decision: accept this for v1 and upgrade to committing `functions/package-lock.json` copied into `dist` if it ever bites (see Open questions).

`firebase.json` (only the `functions` block exists so far, from issue #11; the Firestore, Hosting and emulator blocks arrive with #12 to #14; `bun test functions/scripts` asserts the functions block):

```json
{
  "functions": [{
    "source": "functions/dist",
    "codebase": "default",
    "runtime": "nodejs22",
    "ignore": ["node_modules", "*.log", ".install-ok", ".env.local", ".env.*.local"],
    "predeploy": ["bun run build:functions"]
  }],
  "firestore": { "rules": "firestore.rules", "indexes": "firestore.indexes.json" },
  "hosting": {
    "public": "apps/web/dist",
    "rewrites": [{ "source": "**", "destination": "/index.html" }],
    "headers": [
      { "source": "/assets/**", "headers": [{ "key": "Cache-Control", "value": "public,max-age=31536000,immutable" }] },
      { "source": "/{index.html,sw.js,manifest.webmanifest}", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] },
      { "source": "**", "headers": [{ "key": "Referrer-Policy", "value": "no-referrer" }] }
    ]
  },
  "emulators": {
    "auth": { "port": 9099 }, "functions": { "port": 5001 }, "firestore": { "port": 8080 },
    "hosting": { "port": 5000 }, "ui": { "enabled": true, "port": 4000 }, "singleProjectMode": true
  }
}
```

`.firebaserc`: `{ "projects": { "default": "deepcuts-staging", "staging": "deepcuts-staging", "prod": "deepcuts-prod" } }`. Deploys always pass `--project` explicitly in CI; the default is for humans and is never `prod`.

The `Referrer-Policy: no-referrer` header keeps the rejoin URL (and any path carrying a game id) from leaking in `Referer` (LLD 4, LLD 7 conflict 12); the SPA rewrite must exclude `/__/` (Firebase Auth helper paths). The service worker is the single `/sw.js` (vite-plugin-pwa `injectManifest`), which also handles FCM background messages; there is no `/firebase-messaging-sw.js`.

The Functions emulator reads `source` from `firebase.json`, so it runs the same `functions/dist` bundle that deploys (P9). A `--no-install`-style shortcut does not exist: `build:functions` is a prerequisite of every emulator script.

## 5. Lint and TypeScript policy

**ESLint** (flat config, typescript-eslint). Chosen over Biome because per-path `no-restricted-imports`, `no-restricted-globals` and `no-restricted-syntax` overrides are mature and the engine rules need all three.

```js
// eslint.config.js (abridged: the shipped file also lists every test tsconfig under parserOptions.project)
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
// Base restrictions for all of functions/src. A later flat-config block that sets the same rule key
// replaces the earlier options instead of merging them, so every narrower functions/src block below
// spreads these in rather than restating (or dropping) them.
const FN_IMPORT_PATTERNS = [...BUN, "@dc/web"];
const FN_IMPORT_PATHS = [{ name: "firebase-functions/v2/https", importNames: ["onCall", "onRequest"], message: "Use defineCallable() from api/callable." }];
const FN_GLOBALS = ["Bun"];
const TESTS = ["**/*.test.ts", "**/*.test.tsx"];

export default [
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  // Every TypeScript file: type-aware rules (explicit `project` list, because projectService only finds the nearest tsconfig.json and would reject *.test.ts).
  { files: ["**/*.ts", "**/*.tsx"], /* parser, parserOptions.project, reportUnusedDisableDirectives: "warn" */ rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error" } },

  { files: ["packages/engine/src/**/*.ts"], ignores: TESTS, rules: {
      "no-restricted-imports": ["error", { patterns: [...FIREBASE, ...NODE_IO, ...BUN, "@dc/functions", "@dc/web"] }],
      "no-restricted-globals": ["error", "process", "Buffer", "fetch", "setTimeout", "setInterval", "performance", "crypto", "Bun", "window", "document"],
      "no-restricted-syntax": ["error", ...CLOCK_AND_ENTROPY] } },
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
  // A `patterns` array is all strings or all objects, so the base strings go in as one group. The second store group
  // allows only the two names; the first bans every other module under store/ outright (so ../store/tx cannot supply them either).
  { files: ["functions/src/notify/sweep.ts"], rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: FN_IMPORT_PATTERNS },
        { group: ["@dc/engine", "@dc/engine/*"] },
        { group: ["**/store/*", "!**/store/index", "!**/store/index.*"], message: "The sweep may import only listWaitingOn and runCommand, from the store index." },
        { group: ["**/store", "**/store/index", "**/store/index.*"], allowImportNames: ["listWaitingOn", "runCommand"], message: "The sweep may import only listWaitingOn and runCommand from the store." },
      ], paths: FN_IMPORT_PATHS }] } },
  // No block for *.test.ts, functions/test-integration and rules-test: the BUN ban is not applied to them, so bun:test is allowed there and nowhere else.
];
```

- P5. `bun run lint` fails on: any `firebase*`, `@firebase/*`, `node:*`/Node I/O module, `bun`, `bun:*` import, or the globals `process`, `Buffer`, `fetch`, `setTimeout`, `performance`, `crypto`, `Bun` in `packages/engine/src`; any `Date.now()`, `new Date()`, `Math.random()` there; any workspace import that violates the direction rule of section 3. `packages/engine` additionally has a test that parses its `package.json` and asserts `dependencies` is a subset of `{"@dc/contracts"}` plus an allowlisted pure-library list (`zod`).
- P12. `onCall` and `onRequest` are imported only in `functions/src/api/callable.ts`, whose `defineCallable` wrapper (`callable` is a deprecated alias exported from the same file) sets `region`, `serviceAccount`, `enforceAppCheck: true`, `consumeAppCheckToken: false` and the per-callable `runtime` options, and implements the LLD 5 section 4.2 pipeline from its spec options: `allow` (explicit principal kinds, no default), `limits`, `gameIdOf` (seat liveness check), strict `output` parsing, and the `sv` contract-version stamp, with typed structured logging and no body logging. Every callable therefore enforces App Check and never forgets to (A1, LLD 5 API1).
- P21. `functions/src/store/**` imports no Auth, FCM, identity or notify module and uses neither `fetch` nor `Math.random` (ST2); `functions/src/notify/**` uses no `Date.now()` or `new Date()` (T3); `functions/src/notify/sweep.ts` imports neither the Engine nor any Store module, except the names `listWaitingOn` and `runCommand` from the store index (T1; enforced by name with `allowImportNames`, and probed against `../store`, `../store/index.js` and `@dc/engine/sub`). Enforced by the lint blocks above; ST2 and T3 also keep their own tests in LLDs 3 and 6. Because flat config replaces (does not merge) a rule key set again by a later matching block, the Store and sweep blocks re-include the base `functions/src` options (`FN_IMPORT_PATTERNS`, `FN_IMPORT_PATHS`, `FN_GLOBALS`), so the `onCall`/`onRequest` import ban (P12) and the Bun ban (P7) still apply inside `functions/src/store` and `functions/src/notify/sweep.ts`. The fixture suite in `lint-test/` (`bun run test:lint`) asserts that an `onCall` import, a `bun:*` import and a `Bun` global in a Store file and in `sweep.ts` are all reported, and that each block fires and stays quiet where it should (issue #10).
- P7 (lint half). `Bun`, `bun`, `bun:*` appear in no shipped code (`packages/*/src`, `functions/src`, `apps/web/src`). `bun:test` imports are allowed only in `*.test.ts`, `functions/test-integration`, `rules-test`. Build and ops scripts (`functions/scripts`, `scripts`) may use `Bun.*`. `api/callable.ts` is exempt only from the `onCall`/`onRequest` import ban (P12), not from the Bun ban; it has its own block.
- Warnings are errors (`--max-warnings 0`; unused `eslint-disable` directives are warnings). Type-aware rules enabled: `no-floating-promises`, `no-misused-promises`, `consistent-type-imports`. `*.test.ts` files are exempt from the per-package import and global bans (they run under Bun); the type-aware rules still apply to them.
- `parserOptions.project` lists the tsconfigs that exist (packages, functions, web, `lint-test`). A step that adds TypeScript outside them (`functions/scripts`, `apps/web/vite.config.ts`, `rules-test`, `e2e`, repo-level `scripts`) adds a tsconfig for it and lists it in the same change, or `bun run lint` fails on that file. The clock and entropy bans are member selectors, so aliasing (`const f = Date.now`) is caught; `globalThis.Date.now()` is not (the engine bans no such receiver, and typecheck isolation covers `window`).
- Policy tests (`lint-test/`, `bun run test:lint`): feed snippets under virtual file paths to the real `eslint.config.js` (`ESLint.lintText`) and to `tsc -p` on throwaway configs that extend the package configs, and assert each forbidden construct is reported and each permitted one is not. P5's `package.json` dependency check lives there too (`lint-test/engine-deps.ts`).

**TypeScript.** One strict base, per-package `lib` and `types` so the compiler also enforces isolation (an engine file that touches `process` or `setTimeout` fails typecheck, not only lint).

```jsonc
// tsconfig.base.json
{ "compilerOptions": {
    "target": "ES2023", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true, "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true, "isolatedModules": true, "skipLibCheck": true,
    "noEmit": true, "resolveJsonModule": true } }
```

| Package | `lib` | `types` | Notes |
|---|---|---|---|
| `packages/engine`, `packages/contracts` | `["ES2023"]` | `[]` | No DOM, no Node: `process`, `Buffer`, `setTimeout`, `fetch` do not exist |
| `functions` | `["ES2023"]` | `["node"]` | `@types/node` on the 22 line matches the runtime |
| `apps/web` | `["ES2023","DOM","DOM.Iterable"]` | `[]` now, `["vite/client"]` once #14 installs Vite | `jsx: react-jsx` |
| tests | per package | adds `["bun"]` | `tsconfig.test.json` per package extends the package config, includes `**/*.test.ts` and `test-integration`; the main config excludes them so `bun-types` cannot leak into shipped code |

- P8. `bun run typecheck` runs `tsc --noEmit` for each package config and each test config, plus `lint-test/tsconfig.json` (the policy suite is typechecked and linted like everything else). A test config needs at least one input, so each package carries a small `src/index.test.ts` smoke test until it has real tests. A CI step asserts `git diff --exit-code` after `bun install --frozen-lockfile`, `lint`, and `build:functions` so no generated file is silently out of date.

## 6. Test pyramid and emulator setup

| Level | Command | Runs where | Gate |
|---|---|---|---|
| Engine unit and property (fast-check; E1 to E18, V2 to V5) | `bun test packages` (in `bun run test`) | Bun | every PR |
| Functions unit | `bun test functions/src` (in `bun run test`) | Bun | every PR |
| Functions build scripts (`build`, `check-bundle`; fixtures and a fake `npm`) | `bun test functions/scripts` (in `bun run test`) | Bun | every PR |
| Lint and compiler policy | `bun test lint-test` (in `bun run test`; `test:lint` alone) | Bun | every PR |
| Web unit (happy-dom, Testing Library) | `bun run test:web` | Bun, separate process so `happy-dom` globals never reach engine or functions tests | every PR |
| Rules | `bun run test:rules` | Firestore emulator (needs Java; developed on a newer JDK, CI pins 21 in #16). Until #32 the one suite passes inline deny-all rules; `firestore.rules` and the P10 checks are #32 | every PR |
| Function integration | `bun run test:integration` | Auth + Firestore + Functions emulators, **Node bundle** (Firestore added in #13; needs Java; one Admin SDK write and read, real collections from #32) | every PR |
| End to end (Playwright, chromium) | `bun run test:e2e` (a placeholder that exits 0 and prints "NO SUITE" until #14 onward) | Same emulators, `vite preview` built with `--mode emulator` (`apps/web/.env.emulator`) | every PR |
| Post-deploy smoke | `bun scripts/smoke.ts` | Real staging or prod | after each deploy |

- P9. Integration and e2e suites run against `functions/dist/index.cjs` through the Functions emulator, never against `functions/src` imported under Bun. `test:integration` rebuilds the bundle first, and the CI job runs it under Node with Bun absent from `PATH` for the emulator process (the test runner itself is Bun). This is the control for the "Bun-built functions deployed to Node" risk in tech-stack section 10.
- P10. Rules suites cover every denial in tech-stack section 5 (aggregate, drafts, outbox, events, idem, `joinIdem`, `roomCodes`, `pushSubs`, another player's view, `views/spectator` when `enabled` is false) and fail if any of them reads or writes successfully. A CI step lists the collections named in `firestore.rules` and the suites fail if one has no denial test.
- P11. Tests use deterministic seeds: engine property tests take `FC_SEED` from the environment and print it on failure, so a CI failure is reproducible locally.
- Emulator specifics. The Firestore emulator needs Java 21 (`actions/setup-java`, temurin); emulator binaries are cached at `~/.cache/firebase/emulators`. Integration tests connect with `FIRESTORE_EMULATOR_HOST` and `FIREBASE_AUTH_EMULATOR_HOST` (set by `emulators:exec`). The Functions emulator runs with `skipTokenVerification`: it does not verify an App Check token, but with `enforceAppCheck: true` it still rejects (`unauthenticated`) a request that carries no `X-Firebase-AppCheck` header (found in issue #12; the emulator is not blind to enforcement, only to token validity). Integration tests therefore attach a well-formed unsigned token through the SDK's `CustomProvider`. The suite cannot prove real enforcement (a forged or expired token is accepted); that is covered by P12 plus the post-deploy smoke test (a call with no App Check token must be rejected).
- Integration tests are Bun-run `bun:test` files that call the callables over HTTP with the Firebase JS SDK (`connectFunctionsEmulator`), so the real request path (callable protocol, auth context, custom-token rejoin) is exercised. Seeding uses the Admin SDK against the emulator.
- Clock and randomness in integration: functions read `now` from a single `clock()` in `functions/src` that tests can set through an env var honored only when `FUNCTIONS_EMULATOR === "true"`.

## 7. Secrets and configuration

| Kind | Where | Examples |
|---|---|---|
| Public client config | Committed `apps/web/.env.staging`, `.env.production`, `.env.emulator` (Vite's own `.env.[mode]` names in the default `envDir`, the web workspace root), loaded by `vite build --mode <mode>`. `*.local` env files are gitignored and never used by CI | Firebase web config, reCAPTCHA Enterprise site key, functions region, `VITE_APP_ENV` |
| Function parameters (non-secret) | `defineString`/`defineInt`/`defineBoolean` params with committed `functions/.env.deepcuts-staging`, `functions/.env.deepcuts-prod`. The CLI reads `.env.<projectId>` (or `.env.<alias>`) from the functions source directory, which is `functions/dist`, so `build.ts` copies every `functions/.env*` into `dist` (section 4). Files are named by project id because CI always passes `--project <projectId>` | `REMINDER_SWEEP_CRON`, rate-limit numbers (LLD 5 7.3), `APP_ORIGIN` (per env; base of invite and rejoin URLs), `CODE_WINDOW_MS` (default 72 h), `CODE_LOOKUP_ENABLED` (kill switch, default true), `TRUSTED_HOPS` (proxy hops for IP derivation, LLD 5 7.2), `COMMAND_MIN_INSTANCES` (0 staging, 1 prod) |
| Secrets | Secret Manager via `defineSecret`, bound per function that needs it | `RATE_LIMIT_HASH_SALT` (IP hashing for counters, R2/A4), `LOG_HASH_SALT` (the id hash in logs), `SEAT_DERIVATION_KEY` (32 random bytes, stored base64-encoded as text, so code must base64-decode it; derives seat secrets, LLD 4; rotating it invalidates every outstanding rejoin link, so it is rotated only deliberately) |
| CI credentials | None stored. GitHub OIDC to Workload Identity Federation (P3) | Repository variables hold only the provider and service account names: `WIF_PROVIDER_STAGING`, `DEPLOYER_SA_STAGING` (set; prod equivalents in M8). GitHub environments: `staging` (exists, holds `APPCHECK_DEBUG_TOKEN`), `production` (M8) |
| App Check debug tokens | GitHub environment secrets (`staging`, `production`) | `APPCHECK_DEBUG_TOKEN` used by `scripts/smoke.ts`; the preview job's web build step exposes the `staging` value to Vite as `VITE_APPCHECK_DEBUG_TOKEN` (step `env`, never an env file) |

- P13. No secret value is committed. CI runs `betterleaks` (config `.betterleaks.toml`) on every PR; Secret Manager secrets are created out of band (`gcloud secrets create`) and read only by `fn-runtime`. Firebase web config and reCAPTCHA site keys are public by design and are the only credential-shaped values in the repo.
- P14. Staging and prod secrets are distinct values. Function code has no `if (project === ...)` branches; behavior differences come only from params.
- Preview builds are public URLs on the staging project, so they embed the staging App Check debug token via `VITE_APPCHECK_DEBUG_TOKEN`. Only the preview build sets it; the `deploy-staging` live build and every prod build leave it unset and rely on reCAPTCHA Enterprise. Staging data is disposable and the token is rotatable; this is accepted (see Open questions).

## 8. CI/CD (GitHub Actions)

One workflow, `.github/workflows/ci.yml`. Pull requests from forks run `verify` and `emulator` only (no secrets, no preview).

| Trigger | Jobs |
|---|---|
| `pull_request` | `verify`, `emulator`, then `preview` (same-repo PRs only) |
| push to `main` | `verify`, `emulator`, then `deploy-staging` |
| push tag `v*.*.*` | `verify`, `emulator`, `check-tag`, then `deploy-prod` (environment `production`, required reviewer) |
| `workflow_dispatch` with input `ref` (an existing release tag, e.g. `v1.4.2`) | Rollback or redeploy: same as a tag push, built from that tag: `verify`, `emulator`, `check-tag`, then `deploy-prod` behind the same `production` approval |

```yaml
name: ci
on:
  pull_request:
  push: { branches: [main], tags: ["v*.*.*"] }
  workflow_dispatch:
    inputs:
      ref: { description: "Release tag to deploy to prod (rollback), e.g. v1.4.2", required: true, type: string }
env:
  # Every job checks out this ref: the dispatched tag, or the pushed ref / PR merge ref.
  DEPLOY_REF: ${{ github.event_name == 'workflow_dispatch' && format('refs/tags/{0}', inputs.ref) || github.ref }}
concurrency:
  group: ci-${{ inputs.ref || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}   # never cancel a deploy
permissions: { contents: read }

jobs:
  verify:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with: { ref: "${{ env.DEPLOY_REF }}" }
      - uses: oven-sh/setup-bun@v2
        with: { bun-version-file: .bun-version }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun test packages functions/src
      - run: bun run test:web
      - run: bun run build:functions
      - run: bun run build:web
      - run: bun scripts/check-web-size.ts   # entry for /g/:id within 300 KB (LLD 7 WC16, 300 KB gzip)
      - run: git diff --exit-code
      - uses: gitleaks/gitleaks-action@v2
      - uses: actions/upload-artifact@v4
        with: { name: web-dist, path: apps/web/dist }

  emulator:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with: { ref: "${{ env.DEPLOY_REF }}" }
      - uses: oven-sh/setup-bun@v2
        with: { bun-version-file: .bun-version }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: 21 }
      - uses: actions/cache@v4
        with: { path: ~/.cache/firebase/emulators, key: "emulators-${{ hashFiles('bun.lock') }}" }
      - run: bun install --frozen-lockfile
      - run: bun run test:rules
      - run: bun run test:integration
      - run: bunx playwright install --with-deps chromium
      - run: bun run test:e2e

  preview:
    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository
    needs: [verify, emulator]
    runs-on: ubuntu-24.04
    environment: staging
    permissions: { contents: read, id-token: write, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version-file: .bun-version }
      - run: bun install --frozen-lockfile
      - run: bun run --cwd apps/web build --mode staging
        env: { VITE_APPCHECK_DEBUG_TOKEN: "${{ secrets.APPCHECK_DEBUG_TOKEN }}" }   # preview only (section 7)
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.WIF_PROVIDER_STAGING }}
          service_account: ${{ vars.DEPLOYER_SA_STAGING }}
      - run: bunx firebase hosting:channel:deploy pr-${{ github.event.number }} --project deepcuts-staging --expires 7d
      # a follow-up step comments the channel URL on the PR

  deploy-staging:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: [verify, emulator]
    runs-on: ubuntu-24.04
    environment: staging
    permissions: { contents: read, id-token: write }
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version-file: .bun-version }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: bun install --frozen-lockfile
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.WIF_PROVIDER_STAGING }}
          service_account: ${{ vars.DEPLOYER_SA_STAGING }}
      - run: bun run build:functions && bun run --cwd apps/web build --mode staging
      # order matters (P16): rules and indexes, wait for READY, then functions, then hosting
      - run: bunx firebase deploy --only firestore --project deepcuts-staging --non-interactive
      - run: bun scripts/wait-indexes.ts --project deepcuts-staging --timeout-min 30
      - run: bunx firebase deploy --only functions --project deepcuts-staging --non-interactive
      - run: bunx firebase deploy --only hosting --project deepcuts-staging --non-interactive
      - run: bun scripts/ops-apply.ts --project deepcuts-staging
      - run: bun scripts/smoke.ts --project deepcuts-staging
        env: { APPCHECK_DEBUG_TOKEN: "${{ secrets.APPCHECK_DEBUG_TOKEN }}" }

  check-tag:
    if: startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'
    needs: [verify, emulator]
    runs-on: ubuntu-24.04
    steps:
      - run: '[[ "$DEPLOY_REF" =~ ^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a release tag: $DEPLOY_REF"; exit 1; }'
      - uses: actions/checkout@v4
        with: { ref: "${{ env.DEPLOY_REF }}", fetch-depth: 0 }
      - run: git merge-base --is-ancestor "$(git rev-parse HEAD)" origin/main

  deploy-prod:
    needs: [check-tag]
    runs-on: ubuntu-24.04
    environment: production
    concurrency: { group: deploy-prod, cancel-in-progress: false }   # a tag push and a rollback never deploy at once
    permissions: { contents: read, id-token: write }
    # same steps as deploy-staging (including wait-indexes) with checkout `ref: ${{ env.DEPLOY_REF }}`,
    # --project deepcuts-prod, --mode production and prod WIF variables
```

- P15. Deploys use `--non-interactive`, an explicit `--project`, and no `--force` (so a deploy that would delete a function fails and a human decides).
- P16. Deploy order is Firestore rules and indexes, then functions, then Hosting. Between the Firestore and functions steps, `scripts/wait-indexes.ts` polls `gcloud firestore indexes composite list` and `gcloud firestore indexes fields list` (every 30 s) until every index and field override is `READY`, and fails the deploy after its timeout (30 min) without deploying functions. The wait is its own step; it does not rely on the later `ops-apply` step.
- P17. Prod deploys only from a tag whose commit is an ancestor of `main` and only after an approval on the `production` environment. This holds for both prod paths: a tag push and a `workflow_dispatch` rollback both go through `check-tag` (the ref must match `refs/tags/v*.*.*` and its commit must be an ancestor of `origin/main`) and the `production` environment gate. Prod is rebuilt from the tag with the same `bun.lock`, not copied from staging; the web build differs by `--mode` anyway.
- P18. Third-party actions are pinned to a major version at minimum; the workflow has `permissions: contents: read` by default and grants `id-token: write` only on deploy jobs.
- PR previews run the staging backend as it stands on `main`. A PR that changes function or contract behavior is verified by the emulator jobs, not by its preview (see Open questions).
- Rollback: run the `ci` workflow by hand (`workflow_dispatch`, Actions tab or `gh workflow run ci -f ref=v1.4.1`) with `ref` set to the previous release tag. The workflow checks out that tag in every job, reruns `verify` and `emulator`, then `check-tag` and `deploy-prod` behind the same `production` approval, so functions, web, Firestore rules and indexes all return to that tag's versions. A rollback across a contract or data-shape change still has to respect the LLD 5 version policy. Data is never rolled back by CI. Staging has no dispatch path; it is rolled back by reverting on `main`.
- Node and Bun are both pinned (`node-version: 22`, `.bun-version`); `firebase-tools` is a pinned root devDependency so CLI behavior is identical locally and in CI.

## 9. Observability

Mirrors HLD 4.5 and tech-stack section 9; this LLD fixes the conventions.

**Logger.** `functions/src/log.ts` (minimal since #12: the `api.done` event and the API line fields; #17 adds the rest of the table below) wraps `firebase-functions/logger` and is the only logging path (lint forbids `console.*` in `functions/src`). It takes a typed field set; unknown keys are a type error and are dropped at runtime.

| Field | Meaning |
|---|---|
| `event` | Dotted name. Store: `command.done`, `command.rejected`, `txn.retry`, `store.size.warn`, `deletion.stuck`, `roomcode.collision`. API (LLD 5): `api.done`, `api.gate`, `api.detail.stripped`, `rate.limited`, `ip.unresolved`. Identity (LLD 4): `auth.join`, `auth.rejoin`, `auth.reissue`, `auth.revoke`, `auth.purge.partial`. Notifications (LLD 6): `notify.row.done`, `notify.dedupe`, `notify.payload_invalid`, `notify.poison`, `push.result`, `push.register`, `push.unregister`, `reminder.sweep.done`, `reminder.sweep.game_failed`, `outbox.redrive`. An event not in this list is a type error; there is no `outbox.sent` (nothing emits it; `notify.row.done` replaces it) |
| `callable`, `principalKind` (`host`\|`seat`\|`spectator`\|`guest`\|`none`), `clientV` | API lines (LLD 5 section 9) |
| `gameId`, `version` | Always present on game-scoped lines. `version` is the version read (and, on success, written) |
| `commandType`, `outcome` (`ok`\|`rejected`\|`error`), `reason` (an `ErrorCode`, or the log-only codes of LLD 5 section 9) | Command and API lines |
| `playerId` | Opaque id only (allowed; it carries no name) |
| `latencyMs`, `attempts` | Timing and transaction attempts (retry rate = lines with `attempts > 1`) |
| `replay` | Boolean; true when the call was served from the idempotency ledger |
| `bucket`, `retryAfterMs` | Rate-limit lines (`rate.limited`) |
| `rowId`, `kind` | Outbox row id (`v{n}_{i}`; carries no player data) and its event or notification kind |
| `recipients`, `devices`, `eventToFcmMs` | Notification fan-out: recipient and device counts, and `now - row.at` at the end of the first send |
| `result` | `sent`, `failed` or `pruned` on `push.result` |
| `ipHash`, `uidHash` | HMAC with `LOG_HASH_SALT`, truncated to 12 hex chars; never raw IPs |
| `count`, `sent`, `pruned`, `failed`, `skipped`, `pages`, `listed`, `replayed`, `noop` | Notification and sweep volumes (the superset of LLD 6 section 7.2) |

**Forbidden in any log line, error message or `HttpsError` detail** (P19): card text and drafts; display names; emails; seat tokens, rejoin secrets or anything from a URL fragment; Firebase ID tokens and custom tokens; FCM tokens and push endpoints; raw IPs; pitch text; and anything linking a submission to its owner before the result is committed (no `cardId` paired with `playerId` for `confirmSubmission`, no `revealOrder`, no `submissionId` to owner mapping). Unhandled errors are logged as `Error` objects (so Error Reporting groups them) with the message scrubbed of request payloads.

- P19. An integration test plays a full game with sentinel strings in every user-supplied field (display names `NAME-SENTINEL-*`, card text `CARD-SENTINEL-*`, an email `sentinel@example.test`), captures all Functions emulator log output, and fails if any sentinel appears. This is the log half of R1.

**Log-based metrics** (definitions in `ops/metrics/*.yaml`, applied idempotently by `scripts/ops-apply.ts`):

| Metric | Source | Labels |
|---|---|---|
| `dc_command_total` | counter, `event="command.done" or "command.rejected"` | `commandType`, `outcome`, `reason` |
| `dc_command_latency_ms` | distribution of `latencyMs` on `command.done` | `commandType` |
| `dc_txn_retry_total` | counter, `event="txn.retry"` | none |
| `dc_push_total` | counter, `event="push.result"` | `result` (`sent`, `failed`, `pruned`) |
| `dc_reminder_sent_total` | counter, `event="reminder.sweep.done"` weighted by `sent` | none |
| `dc_roomcode_collision_total` | counter, `event="roomcode.collision"` (LLD 3 createGame retry) | none |
| LLD 5 metrics | `dc_api_total`, `dc_api_latency_ms`, `dc_ratelimit_total`, `dc_api_invalid_total`, `dc_client_outdated_total`, `dc_idem_replay_total`, `dc_appcheck_denied_total` | as defined in LLD 5 section 9 |
| LLD 6 metrics | `dc_push_pruned_total`, `dc_reminder_push_total`, `dc_notify_dedupe_total`, `dc_notify_latency_ms`, `dc_notify_poison_total` | as defined in LLD 6 section 7.3 |

**Dashboard** (`ops/dashboards/main.json`, one per project): command rate and rejection rate by `reason`; p50/p95/p99 latency by `commandType`; transaction retry ratio; function instance count and cold starts for `command`; push sent/failed/pruned; reminders per sweep; Firestore reads/writes.

**Alert policies** (`ops/alerts/*.json`, notification channel is the owner's email; prod and staging both, staging at warning severity):

| Alert | Condition |
|---|---|
| `command` error rate | `outcome=error` above 2% over 10 min (rejections are not errors) |
| `command` latency | p95 above 3 s for 15 min (cold starts alone must not fire it) |
| Transaction contention | retry ratio above 20% for 15 min |
| Sweep missed | no `reminder.sweep.done` for 3 h (hourly job) |
| Push health | failed share above 50% over 1 h with at least 20 attempts |
| Function failure | any new Error Reporting group for a function |
| Stuck deletion | any `deletion.stuck` line (LLD 3) |
| Store size | any `store.size.warn` line (LLD 3) |
| Identity | `auth.revoke` retries above 5 in an hour; any `auth.purge.partial` repeating for the same game (LLD 4) |
| Notification pipeline | any `notify.poison` or `notify.payload_invalid`; `dc_notify_latency_ms` p95 above 60 s for 30 min; an `outbox.redrive` run processing more than 20 rows (LLD 6) |
| API health | the LLD 5 section 9 alerts (invalid-request share, `CLIENT_OUTDATED`, `ip.unresolved`, `api.detail.stripped`, `code_ip` spike, App Check denials) |
| Budget | thresholds in section 2 |

- P20. `ops-apply` is idempotent and runs on every staging and prod deploy; a metric or alert present in `ops/` but absent in the project after the run fails the deploy. Log retention uses the default 30-day bucket.

## 10. Production readiness checks (rolled up)

Checked by CI where marked: P5 and P21 lint (CI), P6 and P7 bundle and `exports.json` (CI), P9 to P11 test suites including `test:web` (CI), P12 `defineCallable` wrapper (CI lint, LLD 5 registry tests), P13 secret scan (CI), WC16 web size via `check-web-size.ts` (CI), P15 to P18 workflow (review), P19 log sentinels (CI), P1, P3, P4, P20 and the section 2 table including Identity Platform, the six TTL groups and the FCM APIs (manual checklist at project creation, re-verified by the walkthrough below).

## 11. First staging deploy, step by step

Goal: prove the riskiest seam (Bun monorepo, bundle, Node runtime, IAM custom tokens, App Check, rules, Hosting) with a trivial system before any real code exists. Use a throwaway `ping` callable and a throwaway `diag` callable.

**A. Cloud setup (once, about 45 minutes).** Implemented by `scripts/provision-staging.sh` (one function per step, noted below); proven by `scripts/verify-staging.sh` (section 2.1). Run `BILLING_ACCOUNT=<id> scripts/provision-staging.sh all`; the billing account id is never committed.
1. *(script step `project`, then `firebase`; V1, V2, V14)* Create project `deepcuts-staging` (the script uses `gcloud projects create`; the console is not needed). Attach billing and upgrade to Blaze. Create the budget and alerts (section 2).
2. *(step `firestore`; V3, V4)* Create Firestore in Native mode at `nam5`. Add the TTL policies for all six groups: `for g in idem outbox notifLog rateLimits deletions joinIdem; do gcloud firestore fields ttls update expiresAt --collection-group=$g --enable-ttl --project deepcuts-staging; done`. This is also the fallback if `firebase deploy --only firestore` (step 12) rejects `"ttl": true` in `fieldOverrides`; if it accepts it, confirm with `gcloud firestore fields ttls list` (there is no `fields list`; the state starts at `CREATING` and becomes `ACTIVE` after a few minutes) and keep only the file.
3. *(step `apis`; V5; batched, `gcloud services enable` takes at most 20 services per call)* Enable APIs: `gcloud services enable cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com iamcredentials.googleapis.com recaptchaenterprise.googleapis.com firebaseappcheck.googleapis.com fcm.googleapis.com fcmregistrations.googleapis.com identitytoolkit.googleapis.com --project deepcuts-staging`.
4. *(step `auth`; V6)* Auth: upgrade to Identity Platform (`POST identitytoolkit.googleapis.com/v2/projects/<p>/identityPlatform:initializeAuth`, then `PATCH admin/v2/projects/<p>/config`); enable Email link and Anonymous, anonymous-account auto-cleanup and App Check enforcement for Auth; add authorized domains.
5. *(steps `webapp`, `appcheck`, `config`; V7, V12)* Register the web app; copy its config into `apps/web/.env.staging`. Create a reCAPTCHA Enterprise key, register it under App Check, and put the site key in the env file. Generate an App Check debug token, register it, and store it as the `APPCHECK_DEBUG_TOKEN` secret in the GitHub `staging` environment.
6. *(step `iam`; V8, V9)* Create service accounts `fn-runtime` and `ci-deployer` with the roles in section 2, including the **self-grant**: `gcloud iam service-accounts add-iam-policy-binding fn-runtime@deepcuts-staging.iam.gserviceaccount.com --member=serviceAccount:fn-runtime@deepcuts-staging.iam.gserviceaccount.com --role=roles/iam.serviceAccountTokenCreator`.
7. *(steps `wif`, `secrets`; V10, V11, V12)* Create the Workload Identity pool and provider restricted to this repository; set GitHub variables `WIF_PROVIDER_STAGING`, `DEPLOYER_SA_STAGING`. Create secrets `RATE_LIMIT_HASH_SALT`, `LOG_HASH_SALT` and `SEAT_DERIVATION_KEY` with random values, and set the params in `functions/.env.deepcuts-staging` (`APP_ORIGIN`, `CODE_WINDOW_MS`, `CODE_LOOKUP_ENABLED`, `TRUSTED_HOPS`, `COMMAND_MIN_INSTANCES`).

**B. Local proof (no cloud)**
8. Scaffold the workspace per section 3 with a minimal `functions/src/index.ts` exporting `ping` and `diag` through `defineCallable`; `ping` returns `{ ok: true, node: process.version }`; `diag` calls `getAuth().createCustomToken("seat:probe:probe")` and returns the token (staging-only, deleted in step 17).
9. `bun install`, `bun run lint`, `bun run typecheck`, `bun run build:functions` (it prints `build: ok` when `check-bundle` passes; run it twice, the second must not install). Confirm `functions/dist` contains `index.cjs`, `package.json`, `package-lock.json`, `node_modules/firebase-admin`, `.install-ok` and a copy of `.env.deepcuts-staging`.
10. `bun run test:integration` with a one-test suite calling `ping` through the emulator and asserting `node` starts with `v22` (landed in #12 with `diag`; #13 added Firestore, so it runs the Auth, Firestore and Functions emulators). This proves the Node bundle loads under the emulator. Also run `bun run test:web` and `bun scripts/check-web-size.ts` once the web scaffold exists.

**C. Deploy**
11. `firebase login:ci` is not used; authenticate locally with `gcloud auth application-default login` as a project owner for this first run.
12. `bunx firebase deploy --only firestore --project deepcuts-staging` (rules deny-all plus the empty indexes file), then `bun scripts/wait-indexes.ts --project deepcuts-staging` (returns at once with no indexes; proves the script and its `gcloud` access).
13. `bunx firebase deploy --only functions --project deepcuts-staging`. Expect: predeploy build, "Loading and analyzing source code" succeeds (needs `dist/node_modules`), Cloud Build runs `npm ci` against `dist/package-lock.json`, functions appear in `us-central1`, and the CLI reports loading `.env.deepcuts-staging` (params resolved, no interactive prompt for missing values). Verify the runtime options LLD 5 conflict 14 assumes (`cpu: 1` at 256MiB, `concurrency: 80`, `consumeAppCheckToken: false`, a `minInstances` param) by giving `ping` the same runtime shape as `command`.
14. `bun run --cwd apps/web build --mode staging && bunx firebase deploy --only hosting --project deepcuts-staging`.

**D. Verify the seams**
15. `bun scripts/smoke.ts --project deepcuts-staging` calls `ping` with the debug App Check token and expects `ok: true` and a Node 22 version. A second call without an App Check token must fail with `failed-precondition`/`unauthenticated`, which proves enforcement.
16. Call `diag` (same smoke script, extra flag), take the custom token, `signInWithCustomToken` from the client SDK, and confirm a signed-in uid `seat:probe:probe`; then delete that Auth user. Failure here with `iam.serviceAccounts.signBlob` denied means step 6 is wrong.
17. Remove `diag`, redeploy functions, run `bunx firebase functions:delete diag --project deepcuts-staging --force` if it lingers.
18. Run `bun scripts/ops-apply.ts --project deepcuts-staging`; confirm the dashboard and alert policies exist, and that `ping` produced a structured log line visible in Logs Explorer with `event` set.
19. Open a PR; confirm `verify`, `emulator`, `preview` pass and the preview URL loads. Merge; confirm `deploy-staging` repeats steps 12 to 15 from CI under Workload Identity Federation with no keys.

**Known failure modes**

| Symptom | Cause | Fix |
|---|---|---|
| `Failed to load function definition from source: Cannot find module 'firebase-functions'` | `dist/node_modules` missing at deploy time | `build.ts` must run `npm install` in `dist`; check `predeploy` ran |
| Cloud Build `npm ci` lockfile mismatch | `dist/package.json` and `package-lock.json` out of sync | Delete `dist` and rebuild; `build.ts` regenerates both together |
| `Cannot find module 'bun:...'` or `Bun is not defined` at runtime | Shipped code touched Bun | P5/P7 lint and `check-bundle` should have caught it; fix the import |
| `iam.serviceAccounts.signBlob` denied | Missing self-grant of `serviceAccountTokenCreator` | Step 6 |
| `The query requires an index` | Deploy order or index still building | P16 ordering; `wait-indexes.ts` must pass before functions deploy |
| Callable returns `unauthenticated` with App Check on | Missing or unregistered debug token, or domain not allowed in the reCAPTCHA key | Register the token; add the preview and live hosts |
| Secret access denied at cold start | `fn-runtime` lacks `secretAccessor` or the function did not bind the secret | Add the role; add the secret to the function's `secrets` option |
| Functions emulator exits "No functions found" | `dist` not built | Always run `build:functions` first |

## Open questions / conflicts

1. **Preview channels share the staging backend.** The HLD and tech-stack say "Hosting preview channels for each PR" but do not say which backend they call. Here previews hit staging functions from `main`, so a PR that changes the callable contract cannot be previewed end to end. Options: accept (chosen), or deploy per-PR function codebases (cost and cleanup overhead). Needs a decision before the first contract change.
2. **Lockfile for the generated functions package.** Tech-stack section 8 specifies only a minimal `package.json` with pinned direct deps. Transitive dependencies of `firebase-admin` and `firebase-functions` then resolve at build time and are not reviewed. This LLD generates `dist/package-lock.json` per build (not committed); committing it is a possible tightening.
3. **Debug App Check token in public preview builds.** Needed so preview and smoke traffic passes App Check, but it is visible in the bundle. Acceptable only because staging is disposable; prod never gets one in a web build (the prod smoke token lives only in the GitHub `production` environment).
4. **Firestore App Check enforcement.** Tech-stack section 7 mentions App Check on callables only. This LLD also enforces it on Firestore reads (the client's view-document listeners), which means the web client must initialize App Check before attaching listeners (LLD 7), and the emulator does not exercise it.
5. **Web may not import `packages/engine`.** Implied by HLD C1 but not stated; lint enforces it here. If the UI needs a derived value (for example cards-still-to-write), it must arrive in `GameView`, not be recomputed client-side.
6. **Runtime service account and roles.** The HLD and tech-stack name only the `serviceAccountTokenCreator` role. The dedicated `fn-runtime` account and its role list (notably `firebaseauth.admin` for seat Auth user disable, revoke and purge, FCM admin) are this LLD's proposal and should be verified against what LLDs 4 and 6 actually call. Partly confirmed: LLD 4 calls `createCustomToken`, `updateUser`, `revokeRefreshTokens` and `deleteUsers`; LLD 6 calls FCM send only. Final check at the first deploy. **Applied on staging (issue #9):** the role list is created as written and verified by V8.
7. **Reminder sweep schedule.** HLD 3.9 says "e.g., hourly" and tech-stack says hourly; the "sweep missed" alert here assumes hourly. If LLD 6 changes the cadence, the alert threshold moves with it.
8. **TTL.** **Resolved (LLD 3 sections 2 and 4):** field is `expiresAt` (a `Timestamp`) on six collection groups, `idem`, `outbox`, `notifLog`, `rateLimits`, `deletions`, and `joinIdem` (added with the join idempotency ledger, LLD 3/LLD 4); section 2 and walkthrough step 2 now configure all six. **Live on staging via gcloud** (all six groups ACTIVE, V4). Still open: whether the pinned `firebase-tools` accepts `"ttl": true` in `fieldOverrides` (unverified; gcloud fallback documented, LLD 3 open question 6).
9. **Dynamic Links.** Email-link sign-in must not depend on Firebase Dynamic Links (shut down). Standard web email-link flow with a `continueUrl` on an authorized domain is assumed; LLD 4 should confirm. **Resolved by LLD 4 (section 3 and its interface table):** SDK email-link flow with `continueUrl` on `APP_ORIGIN`; Identity Platform upgrade added to section 2.
10. **Wrapper path and name.** **Resolved by LLD 5 section 4.2:** `defineCallable` in `functions/src/api/callable.ts` (`callable` deprecated alias); P12, lint and file tree updated here. LLD 4's `guestOk` option is the spec's `allow` containing `"guest"`; LLD 4 sections 2.2 and 13 now use `allow`.
11. **Logger field and event set.** **Resolved:** section 9 is the superset of LLD 5 section 9 and LLD 6 section 7.2 plus LLD 3 and LLD 4 events. `outbox.sent` removed. LLD 3's `deletion.stuck` and `store.size.warn` alerts added.
12. **Runtime options and `beforeEmailSent`.** Partly answered (issue #12, `firebase-functions` 7.4.0): `cpu: 1` at 256MiB, `concurrency: 80`, `consumeAppCheckToken: false`, `enforceAppCheck: true`, `serviceAccount: "fn-runtime"` (reported as `serviceAccountEmail: "fn-runtime"`, the short name, in the manifest) and a `minInstances` param (`defineInt("COMMAND_MIN_INSTANCES", { default: 0 })`) compile, load in the Functions emulator and appear in each function's `__endpoint`. Deploy acceptance is still open until the first deploy (#15): `cpu: 1` at 256MiB, `concurrency: 80`, `consumeAppCheckToken: false` (LLD 5 conflict 14), and `beforeEmailSent` support in the pinned `firebase-functions` (LLD 5 8.1). If unsupported, `beforeEmailSent` leaves `exports.json` and Identity Platform is still needed for anonymous cleanup.
13. **Identity Platform cost. Resolved (issue #9).** The upgrade succeeded on `deepcuts-staging` with no console step. Per [Identity Platform pricing](https://cloud.google.com/identity-platform/pricing) the first 50,000 monthly active users are free for Tier 1 providers (Email and Anonymous), and anonymous users are not counted when automatic cleanup is enabled, which it is (V6). No fallback sweep is needed. Phone and MFA are billed per message and are not used.
14. **`deletionRunner` name. RESOLVED.** `deletionRunner` is assigned here for LLD 3's `onDocumentCreated("deletions/{gameId}")` export; LLD 3 section 6.4 now uses the name and it matches `exports.json`.

## Interfaces to other LLDs

| LLD | This LLD provides | This LLD expects |
|---|---|---|
| 1 Engine | `packages/engine` layout, tsconfig (`lib: ES2023`, `types: []`), isolation lint (P5), `bun test` and fast-check wiring, seeded `FC_SEED` runs (P11) | Pure `decide` and `project` exports from `src/index.ts`; clock only via `ctx.now`, randomness only via `Rng`; deps limited to `@dc/contracts` plus allowlisted pure libraries |
| 2 Projector | Same package rules as Engine; property test harness location and CI gate | Exports `project`/`projectFeed` from `@dc/engine`; no Node or Firebase imports |
| 3 Store & command transaction | Emulator integration harness against the Node bundle (P9); `fn-runtime` Firestore role; TTL policy setup for the six groups; lint block for `functions/src/store` (ST2); `firestore.rules`/`firestore.indexes.json` deploy path and order (P16); rules test harness (P10) | `expiresAt` (`Timestamp`) on `idem`, `outbox`, `notifLog`, `rateLimits`, `deletions`, `joinIdem` docs; `deletionRunner` export; every new collection gets a rules denial test; composite indexes declared in `firestore.indexes.json`; `command.done`, `command.rejected`, `txn.retry`, `store.size.warn`, `deletion.stuck`, `roomcode.collision` log events with `attempts`, `latencyMs` |
| 4 Identity | Custom-token IAM (self-granted `serviceAccountTokenCreator`), Auth provider setup, `diag` probe in the walkthrough, `fn-runtime` Auth admin role | Which Auth admin calls it makes (to confirm the role list); email-link `continueUrl` and authorized-domain needs; the `auth.*` log events without secrets; `SEAT_DERIVATION_KEY`, `APP_ORIGIN`, `CODE_WINDOW_MS`, `CODE_LOOKUP_ENABLED`; Identity Platform upgrade (section 2); `identityOutbox` in `exports.json` |
| 5 Command API & contracts | `defineCallable` wrapper (P12, `functions/src/api/callable.ts`) enforcing region, App Check, service account and error logging; `@dc/contracts` package rules; `functions/exports.json` check; smoke test call path | Every deployed function registered through `defineCallable`; params `COMMAND_MIN_INSTANCES`, `TRUSTED_HOPS`; logger fields and metrics of its section 9; a cheap `lobbyInfo` (or equivalent) usable by smoke tests; contract version policy for the web/functions deploy skew window |
| 6 Notifications & Scheduler | Scheduler API enablement, Secret Manager bindings, `fn-runtime` FCM role, `push.result` and `reminder.sweep.done` metrics and alerts | Declare `onSchedule` and outbox trigger exports in `exports.json`; emit the specified log fields (all in section 9); `housekeeping`, `notifyOutbox`, `reminderSweep` in `exports.json`; `sweep.ts` import lint (P21); sweep cadence stated if not hourly |
| 7 Web Client | Vite mode and env files, `test:web` script and CI step, `check-web-size.ts` step, web devDependencies, Hosting config and headers (`Referrer-Policy`, single `/sw.js`), preview channel flow, Playwright runner against emulators, App Check debug token for previews | Initializes App Check before any callable or listener; imports only `@dc/contracts`; reads all config from `apps/web/.env.<mode>` (`staging`, `production`, `emulator`) plus `VITE_APPCHECK_DEBUG_TOKEN` from the build environment in preview builds only; service worker and manifest served per the no-cache headers |
