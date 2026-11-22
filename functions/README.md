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

Fails unless `dist/index.cjs` has no `bun:`, `Bun.` or `@dc/`, every `require`, `__require` and dynamic `import` target is a Node builtin or a `dist` dependency, and the bundle loads under Node and exports exactly the names in `exports.json` (in both directions). Add a function's name to `exports.json` in the same change that exports it. It runs `node` (must be major 22) from `PATH` with a minimal environment; to prove the bundle needs no Bun, run it with Bun removed from `PATH` (CI does, #16).

## Callables

`src/api/callable.ts` is the only module that imports `onCall`. `defineCallable({ name, allow, runtime, handler })` builds a callable with region `us-central1`, service account `fn-runtime@` (the project-relative form the CLI resolves to `fn-runtime@<projectId>.iam.gserviceaccount.com`; a bare name is rejected at deploy time, #15), `enforceAppCheck: true`, `consumeAppCheckToken: false` and the given runtime shape (`RT.command`: 256MiB, cpu 1, concurrency 80, `minInstances` from the `COMMAND_MIN_INSTANCES` param, default 0), records it in `REGISTRY`, checks that the request is authenticated unless `allow` has `guest`, and logs one `api.done` line (`src/log.ts`, the typed logger). A handler that throws anything other than an `HttpsError` reaches the client as `internal` with a fixed message. This is the minimal wrapper of issue #12; #38 completes the pipeline (LLD 5 section 4).

Every export in `src/index.ts` is also listed in `exports.json`. Current exports (one throwaway probe, kept until the real callables arrive):

- `ping` returns `{ ok: true, node }` (`node` is `process.version`).

The `diag` probe (a custom token for uid `seat:probe:probe`) was removed in #15 after proving on staging that `admin.auth().createCustomToken()` signs through IAM `signBlob` with the self-granted `roles/iam.serviceAccountTokenCreator`. Two things it taught, which the identity callables inherit:

- `firebase-functions` initializes its own *named* admin app (`__FIREBASE_FUNCTIONS_SDK__`), so `getApps().length === 0` is false in a deployed function even when there is no default app. Test for the default app (`getApps().some((app) => app.name === "[DEFAULT]")`) before calling `getAuth()` and friends.
- A new region's first deploy needs an Artifact Registry cleanup policy; see `scripts/README.md`.

## Tests

```sh
bun test functions/src functions/scripts   # unit and build-script tests
bun run test:integration                   # from the repo root
```

`bun test functions` alone also picks up `test-integration/`, which needs the emulators; use the paths above. `test:integration` rebuilds `dist`, starts the Auth, Firestore and Functions emulators (`firebase emulators:exec`; the Firestore emulator needs Java) and runs `test-integration/` against the Node bundle. The emulator does not verify App Check tokens but rejects a call with none, so the tests send a well-formed unsigned token; enforcement itself is proven only by the staging smoke test. `firestore.test.ts` writes and reads one document with the Admin SDK; real collections come with #32.

### Build script tests

```sh
bun test functions/scripts
```

Fixture tests for both scripts. `npm` is faked with a shim on `PATH` so install, retry and idempotence are tested without a network; `build:functions` itself is the real-install check.
