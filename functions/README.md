# functions

`@dc/functions`: the Cloud Functions source (`src/`) and the scripts that turn it into a deployable package (`scripts/`). Design: LLD 0 section 4.

## Build

```sh
bun run build:functions     # from the repo root; same as `bun run build` here
```

Produces `functions/dist`, which is what `firebase.json` deploys (`source: functions/dist`): `index.cjs` (the bundle, Node only), `package.json` (the exact-pinned `RUNTIME_DEPS` only), `package-lock.json`, `node_modules`, `.install-ok` and byte-identical copies of every `functions/.env*` file. Then it runs `check-bundle`; the build fails if that fails. `dist` is gitignored.

- Needs `npm` and network on the first build (and whenever `dist/node_modules`, `dist/package-lock.json` or `.install-ok` is missing or the dependency versions changed). Otherwise it does not install, and a second build changes nothing.
- A failed `npm install` leaves no `.install-ok`, so the next build reinstalls.
- `.env*` files are copied as they are, including a gitignored `.env.local`; keep secrets out of them (secrets live in Secret Manager). Only non-secret params are committed.
- Runtime versions come from `functions/package.json`; any new runtime dependency must be added to `RUNTIME_DEPS` in `scripts/build.ts` first, or the build refuses.

## check-bundle

```sh
bun scripts/check-bundle.ts
```

Fails unless `dist/index.cjs` has no `bun:`, `Bun.` or `@dc/`, every `require` target is a Node builtin or a `dist` dependency, and the bundle loads under Node and exports exactly the names in `exports.json` (in both directions). Add a function's name to `exports.json` in the same change that exports it. It runs `node` from `PATH`; to prove the bundle needs no Bun, run it with Bun removed from `PATH` (CI does, #16).

## Tests

```sh
bun test functions/scripts
```

Fixture tests for both scripts. `npm` is faked with a shim on `PATH` so install, retry and idempotence are tested without a network; `build:functions` itself is the real-install check.
