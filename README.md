# Deep Cuts

A Bun workspace: a pure game engine, shared contracts, Firebase Cloud Functions and a React web app. Design lives in `docs/` (start with `docs/lld/00-platform-build-deploy.md` for the build, lint and deploy rules).

## Prerequisites

- [Bun](https://bun.sh), the version in `.bun-version`
- Node 22 and npm (the Functions runtime; `build:functions` runs `npm install` in `functions/dist`; developed with Node 22.23 and npm 10.9)

## Setup and checks

```sh
bun install --frozen-lockfile   # exact versions from bun.lock
bun run lint                    # ESLint, warnings are errors
bun run typecheck               # tsc for every package, every test config and lint-test
bun run test:lint               # policy tests: prove each lint and tsconfig rule fires (and stays quiet where it should)
bun test functions/scripts      # tests for the functions build and check-bundle scripts
bun run build:functions         # bundle functions into functions/dist and check the bundle (see functions/README.md)
```

Dependencies are the latest stable at the time they were added, exact-pinned (`bunfig.toml` sets `exact = true`); `bun.lock` is committed.

## Layout

| Path | Package | Role |
|---|---|---|
| `packages/contracts` | `@dc/contracts` | zod schemas and types; imports no other workspace package |
| `packages/engine` | `@dc/engine` | pure game core; depends only on `@dc/contracts` |
| `functions` | `@dc/functions` | Cloud Functions; `functions/scripts` builds the deployable bundle (see `functions/README.md`) |
| `apps/web` | `@dc/web` | React client; imports only `@dc/contracts` |
| `lint-test` | | tests for the lint and compiler policy |
| `scripts` | | environment provisioning and verification (see `scripts/README.md`) |

The dependency direction and the lint rules that enforce it are in LLD 0 sections 3 and 5.
