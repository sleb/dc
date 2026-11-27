# apps/web

The Deep Cuts client: React 19, Vite 8, Tailwind 4, the Firebase web SDK. Design is LLD 7 (`docs/lld/07-web-client.md`). Today it is a scaffold: a placeholder `<App/>`, config, App Check and the build; routes, sessions and screens arrive with 5.1.

## Commands (from the repo root)

| Command | What it does |
|---|---|
| `bun run build:web` | `vite build --mode staging` into `apps/web/dist`. Pass another mode with `bun run --cwd apps/web build --mode <mode>`. |
| `bun scripts/check-web-size.ts` | Gzip budgets on `apps/web/dist` (run `build:web` first). |
| `bun run test:web` | Component tests under happy-dom and Testing Library, in their own process. |
| `bun run test:hosting` | Builds in `emulator` mode and runs `hosting-test/` against the Hosting emulator (port 5002). |

## Env modes

Public config is committed as Vite `.env.<mode>` files in this directory and read with `vite build --mode <mode>`.

| File | `VITE_APP_ENV` | Notes |
|---|---|---|
| `.env.staging` | `staging` | Real staging Firebase web config and reCAPTCHA Enterprise site key (public by design). The API key is restricted to the client services by `scripts/provision-staging.sh apikey` (V15). |
| `.env.emulator` | `emulator` | Project `demo-deepcuts` with placeholder keys. App Check is skipped. |
| `.env.production` | `production` | Not created yet (M8). `vite build --mode production` fails (no `VITE_APP_ENV`) until it exists. |

`firebase/config.ts` `readConfig` validates the keys and names a missing one.

## App Check debug token

For preview builds only, set `VITE_APPCHECK_DEBUG_TOKEN` in the build environment (never in a file). It is used only by `staging` builds. `vite build` in any other mode (production, emulator) fails if the variable is non-empty, so the token cannot ship in those bundles. Never paste a token value into docs, issues or commits.

## Layout notes

- `tsconfig.json` covers `src` (no Node or Bun types), `tsconfig.test.json` the tests and `test/`, `tsconfig.node.json` only `vite.config.ts`.
- `test/setup.ts` registers happy-dom and is preloaded by `test:web` only (the root `test` process must stay DOM-free; a leak guard enforces it).
