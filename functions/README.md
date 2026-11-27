# functions

`@dc/functions`: the Cloud Functions source (`src/`) and the scripts that turn it into a deployable package (`scripts/`). Design: LLD 0 section 4.

## Build

```sh
bun run build:functions     # from the repo root; same as `bun run build` here
```

Produces `functions/dist`, which is what `firebase.json` deploys (`source: functions/dist`): `index.cjs` (the bundle, Node only), `package.json` (the exact-pinned `RUNTIME_DEPS` only), `package-lock.json`, `node_modules`, `.install-ok` and byte-identical copies of every `functions/.env*` file. Then it runs `check-bundle`; the build fails if that fails. `dist` is gitignored.

- Needs `npm` and network on the first build (and whenever `dist/node_modules`, `dist/package-lock.json` or `.install-ok` is missing or the dependency versions changed). Otherwise it does not install, and a second build changes nothing.
- A failed `npm install` leaves no `.install-ok`, so the next build reinstalls.
- `.env*` files are copied as they are, including a gitignored `.env.local`; `firebase.json` ignores `.env.local` and `.env.*.local` at upload. Keep secrets out of them (secrets live in Secret Manager). Only non-secret params are committed.
- Runtime versions come from `functions/package.json`; any new runtime dependency must be added to `RUNTIME_DEPS` in `scripts/build.ts` first, or the build refuses.

## check-bundle

```sh
bun scripts/check-bundle.ts
```

Fails unless `dist/index.cjs` has no `bun:`, `Bun.` or `@dc/`, every `require`, `__require` and dynamic `import` target is a Node builtin or a `dist` dependency, and the bundle loads under Node and exports exactly the names in `exports.json` (in both directions). Add a function's name to `exports.json` in the same change that exports it. The bundle is loaded a second time with `FUNCTIONS_EMULATOR=true`, as the Functions emulator loads it: there it must export `exports.json` plus `exports.emulator.json`, the emulator-only names (`storeHarness`), which must be `undefined` (and so neither exported nor deployed) outside the emulator. No `.env*` file may set `FUNCTIONS_EMULATOR` (LLD 0 section 4, #33). It runs `node` (must be major 22) from `PATH` with a minimal environment; to prove the bundle needs no Bun, run it with Bun removed from `PATH` (CI does, #16).

## Callables

`src/api/callable.ts` is the only module that imports `onCall`. `defineCallable({ name, allow, runtime, handler })` builds a callable with region `us-central1`, service account `fn-runtime@` (the project-relative form the CLI resolves to `fn-runtime@<projectId>.iam.gserviceaccount.com`; a bare name is rejected at deploy time, #15), `enforceAppCheck: true`, `consumeAppCheckToken: false` and the given runtime shape (`RT.command`: 256MiB, cpu 1, concurrency 80, `minInstances` from the `COMMAND_MIN_INSTANCES` param, default 0), records it in `REGISTRY`, checks that the request is authenticated unless `allow` has `guest`, and logs one `api.done` line (`src/log.ts`, the typed logger). A handler that throws anything other than an `HttpsError` reaches the client as `internal` with a fixed message. This is the minimal wrapper of issue #12; #38 completes the pipeline (LLD 5 section 4).

Every export in `src/index.ts` is also listed in `exports.json`, except the emulator-only `storeHarness` (`exports.emulator.json`). Current deployed exports (one throwaway probe, kept until the real callables arrive):

- `ping` returns `{ ok: true, node }` (`node` is `process.version`).

The `diag` probe (a custom token for uid `seat:probe:probe`) was removed in #15 after proving on staging that `admin.auth().createCustomToken()` signs through IAM `signBlob` with the self-granted `roles/iam.serviceAccountTokenCreator`. Two things it taught, which the identity callables inherit:

- `firebase-functions` initializes its own *named* admin app (`__FIREBASE_FUNCTIONS_SDK__`), so `getApps().length === 0` is false in a deployed function even when there is no default app. Test for the default app (`getApps().some((app) => app.name === "[DEFAULT]")`) before calling `getAuth()` and friends.
- A new region's first deploy needs an Artifact Registry cleanup policy; see `scripts/README.md`.

## Store (`src/store/`)

The Game Store of LLD 3 (#33, #34, #35, #36): `runCommand(db, deps, input)` runs one command as one Firestore transaction, `load(db, gameId)` reads the aggregate, and `createGame(db, deps, input)` is the separate creation path: `create.ts`'s pure `planCreate` plus an 8-attempt room-code loop (`executeCreate`), with the replay ledger at `hosts/{uid}/idem/{hash}`. `findByRoomCode(db, code)` is one `get` of `roomCodes/{code}`, normalized and validated, returning `{gameId, createdAt}` with no time window (Identity owns the 72 h rule). `codes.ts` derives the code (`roomCodeFromSeed`, rejection sampling over the 20 consonants) and the host's `p_`+8 id (`playerIdFromSeed`) from the same attempt seed. `run.ts` is a thin shell (step-1 reads, then the pure planner `planCommand` in `plan.ts`, then the `WriteSet`'s writes buffered on the transaction); `plan.ts` also exports `withStore` and `planViews`, so creation and #35's rebuild share them. `waiting.ts` (#35) is the reminder query: `waitingPageQuery` builds the `waitingOn` registry entry plus its projection, limit and keyset cursor, `pageOf` maps one page to the seven-field `WaitingGame` items, and `listWaitingOn` defaults to 100. `rebuild.ts` (#35) is the repair path: the pure `planRebuild` (one aggregate update of `store.viewsRev`/`store.updatedAt` plus one merge per `viewersOf` doc at the unchanged version, or no writes for a missing/deleting game) and the `rebuildViews` transaction shell. `delete.ts` (#36) is the cascade: `newDeletionJob(gameId, game, now)` (phase-0 job builder), the ordered `DELETION_STAGES` and `runDeletion` (skip completed stages, commit progress after each, page the query stages, mark `done` with a 7-day `expiresAt`), with the injected `IdentityPort`, `DELETION_TTL_MS`/`STUCK_AFTER_MS`, `identityUids`/`isStuck`/`stuckLine`. The helpers are `idem.ts` (ledger ids), `writeset.ts` (one write per document, the 5.2a merge rules, `MAX_WRITES`), `outbox.ts`, `events.ts`, `redact.ts`, `size.ts` and `errors.ts` (`StoreError`, `mapStoreError`, including `ROOM_CODES_EXHAUSTED`). `queries.ts` (#32) is the registry of every production query. `test-support.ts` is an in-memory driver over `decide` for tests only. Production `Deps` (clock, CSPRNG seeds and card ids) are `src/deps.ts`; the lazy default Admin app is `src/firebase.ts`.

## The emulator-only store harness

`src/harness/store.ts` exports the `storeHarness` callable only under the Functions emulator (`FUNCTIONS_EMULATOR === "true"`) and refuses in its handler otherwise. It takes the actor from the request, a per-request `now`, per-attempt `seeds`, `faults` (`throwAt` a point, or ABORTED on listed attempts) and a test recipe for `extraWrites`, and returns `{ outcome, attempts, writes, seeds }`, or `{ loaded }` for `op: "load"`. Since #34 it also takes `op: "createGame"` (host, name, settings, key, `now`, `seeds`; returns `{ outcome, attempts, seeds }`) and `op: "findByRoomCode"` (one `get`; returns `{ code }` with `{gameId, createdAt}` or null). Since #35 it takes `op: "rebuildViews"` (`gameId`, `now`; returns `{ result }`, the typed `RebuildResult`) and `op: "listWaitingOn"` (`now`, optional `limit` and `after`; returns `{ page }`, the typed `WaitingPage`); both are validated before any Firestore read. Since #36 it takes `op: "runDeletion"` (`gameId`, optional `now`, `faults.afterStage {stage, point}` and `captureLog`; returns `{ result, purged, logs }`): it runs the cascade with a recording fake `IdentityPort` (`purged` carries `{gameId, uids, requested, deleted}` and writes nothing) and `logs` carries the captured `deletion.stuck` line. The deployed `deletionRunner` and the real `purgeSeats` are #43, the `deleteGame` callable is #40, and `exports.json` is unchanged. A `StoreError` reaches the client as an `HttpsError` with `details.kind`. It is the route the store suites (`test-integration/store/`) use until the real callables exist (#40-#43); it is never deployed (`check-bundle`).

## Tests

```sh
bun test functions/src functions/scripts   # unit and build-script tests
bun run test:integration                   # from the repo root
```

`bun test functions` alone also picks up `test-integration/`, which needs the emulators; use the paths above. `test:integration` rebuilds `dist`, starts the Auth, Firestore and Functions emulators (`firebase emulators:exec`; the Firestore emulator needs Java) and runs `test-integration/` against the Node bundle. The emulator does not verify App Check tokens but rejects a call with none, so the tests send a well-formed unsigned token; enforcement itself is proven only by the staging smoke test. `firestore.test.ts` writes and reads one document with the Admin SDK. `test-integration/store/` holds the LLD 3 section 10.3 suites: fresh lobbies are created by the real `createGame` (`#34`), while states advanced in Bun are still seeded with the Admin SDK (`support/seed.ts`, replaced by #37's fixtures); either way they drive the game only through `storeHarness`, and check documents independently (`support/inspect.ts`: snapshots with update times, the diff that is the oracle for the harness's write count, the PJ11 view check). `bun run test:integration` runs them all; one file: `bun run build:functions && firebase emulators:exec --only auth,firestore,functions --project demo-deepcuts 'bun test functions/test-integration/store/drafts.test.ts'`.

### Build script tests

```sh
bun test functions/scripts
```

Fixture tests for both scripts. `npm` is faked with a shim on `PATH` so install, retry and idempotence are tested without a network; `build:functions` itself is the real-install check.
