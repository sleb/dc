# Deep Cuts

A Bun workspace: a pure game engine, shared contracts, Firebase Cloud Functions and a React web app. Design lives in `docs/` (start with `docs/lld/00-platform-build-deploy.md` for the build, lint and deploy rules).

## Prerequisites

- [Bun](https://bun.sh), the version in `.bun-version`
- `firebase-tools` 15.37.0 (a devDependency, run as `bunx firebase` or through the scripts; Java 21 or newer for the Firestore emulator; developed with a newer JDK, CI pins temurin 21)
- `betterleaks` 1.10.1 and `actionlint` 1.7.12 for the secret scan and the workflow lint (`brew install betterleaks actionlint`, or `scripts/install-betterleaks.sh <dir>`); `jq` for the preview step
- Node 22 and npm (the Functions runtime; `build:functions` runs `npm install` in `functions/dist`; developed with Node 22.23 and npm 10.9)

## Setup and checks

```sh
bun install --frozen-lockfile   # exact versions from bun.lock
bun run lint                    # ESLint, warnings are errors
bun run typecheck               # tsc for every package, every test config and lint-test
bun run test                    # engine and contracts, functions unit and script tests, and the lint-policy tests, in one process
bun run test:lint               # just the policy tests (they prove each lint and tsconfig rule fires); also part of `test`
bun run test:web                # web tests under happy-dom, in a separate process
bun run test:rules              # Firestore emulator; inline deny-all rules until #32
bun run test:integration        # rebuild the bundle, run the Auth, Firestore and Functions emulators against it (ping, Admin write/read)
bun run test:hosting            # build apps/web in emulator mode, serve it on the Hosting emulator, assert headers, cache and the SPA rewrite
bun run test:integration:logs   # test:integration plus the P19 log-sentinel harness (what CI runs)
bun scripts/scan-secrets.ts     # P13 secret scan over the source tree (betterleaks 1.10.1; scripts/install-betterleaks.sh installs it)
bash scripts/check-bundle-no-bun.sh   # after build:functions: the bundle loads under Node with Bun off PATH
actionlint                      # lint .github/workflows (1.7.12)
bun run test:e2e                # placeholder: prints "NO SUITE" and exits 0 until Playwright lands (5.1, #45)
FC_SEED=<n> bun run test        # replay a failed property test; the seed is printed on failure
bun run build:functions         # bundle functions into functions/dist and check the bundle (see functions/README.md)
bun run build:web               # vite build --mode staging into apps/web/dist (see apps/web/README.md)
bun scripts/check-web-size.ts   # gzip budgets for the built apps/web/dist (run build:web first)
bun scripts/ops-apply.ts --project <id>   # apply and verify the ops/ tree (metrics, dashboard, alert policies; LLD 0 section 9, P20)
```

Dependencies are the latest stable at the time they were added, exact-pinned (`bunfig.toml` sets `exact = true`); `bun.lock` is committed.

## Layout

| Path | Package | Role |
|---|---|---|
| `packages/contracts` | `@dc/contracts` | zod schemas and types (ids, limits, error codes, settings pieces, the strict command envelope and `toEngineCommand`; view and callable schemas come with #27 and M4); depends only on zod, imports no other workspace package |
| `packages/engine` | `@dc/engine` | pure game core; depends only on `@dc/contracts` |
| `functions` | `@dc/functions` | Cloud Functions; `functions/scripts` builds the deployable bundle (see `functions/README.md`) |
| `apps/web` | `@dc/web` | React client (Vite, Tailwind 4); imports only `@dc/contracts` (see `apps/web/README.md`) |
| `lint-test` | | tests for the lint and compiler policy |
| `scripts` | | environment provisioning and verification, the secret scan, the log-sentinel harness, `check-web-size.ts` and the workflow policy test (see `scripts/README.md`) |
| `.github/workflows` | | `ci.yml`: verify, emulator, preview, deploy-staging, check-tag and a guarded deploy-prod stub (LLD 0 section 8) |
| `hosting-test` | | bun tests that run against the Hosting emulator (`bun run test:hosting`) |

The dependency direction and the lint rules that enforce it are in LLD 0 sections 3 and 5.
