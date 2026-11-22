# scripts

Repo-level scripts that are not shipped. Plain bash, because they predate the Bun workspace.

| Script | What it does |
|---|---|
| `verify-staging.sh` | Read-only. Runs checks V1 to V14 (LLD 0 section 2.1) and exits 0 only if all pass. Prints reasons for each failure, never a secret value. |
| `provision-staging.sh` | Idempotent. Creates what the checks assert, one step at a time. |
| `wait-indexes.ts` | Bun. `bun scripts/wait-indexes.ts --project <id> [--timeout-min 30]`. Polls every 30 s until every composite index is `READY` and the TTL field config on `expiresAt` for the six collection groups is `ACTIVE`, then exits 0. A `CREATING` state is retried; `NEEDS_REPAIR`, a missing field config, a non-zero `gcloud` exit or the timeout fails at once, naming the offender. Exit 2 on bad arguments. It reads Firestore through `gcloud` only (ADC). Tested by `wait-indexes.test.ts`, whose fake `gcloud` lives in `fixtures/fake-gcloud.sh`. |
| `smoke.ts` | Bun. `bun scripts/smoke.ts --project <id>`. Post-deploy checks against the real project: `ping` returns `ok` on Node 22 with an App Check token, and the same call without a token is rejected (`unauthenticated`/`failed-precondition`), which is what proves enforcement. The App Check token comes from `APPCHECK_DEBUG_TOKEN` when set (CI); otherwise one is minted, registered and deleted in the same run. The debug token is exchanged for an App Check JWT first (`:exchangeDebugToken`) because the callables verify a real JWT. Prints outcome lines only and redacts every value it sent from any error it reports, so no token reaches stdout or stderr. Exit 0 pass, 1 fail, 2 usage. Custom-token sign-in is not covered here: the probe moved to the identity step (LLD 4 section 13). Tested by `smoke.test.ts` with injected effects. |
| `check-web-size.ts` | Bun. `bun scripts/check-web-size.ts [dist]` (default `apps/web/dist`, so run `bun run build:web` first). Fails if gzip sizes exceed LLD 7 section 10.1: entry 300 KB, lazy chunk 60 KB, CSS 20 KB, service worker 40 KB (a KB is 1000 bytes). Tested by `check-web-size.test.ts`, which also holds `web-build.test.ts` (builds per mode, the no-referrer meta tag, the App Check debug-token guard); both run in `bun run test`. |

## Prerequisites

`gcloud` (logged in, `gcloud auth login`), `firebase` (`firebase login`), `gh` (logged in with `repo` and admin scope on the repository), `jq`, `curl`, `openssl`, `betterleaks`. Pinned at setup: `firebase-tools` 15.37.0, Google Cloud CLI 594.0.0, betterleaks 1.10.1.

## Running

```sh
scripts/verify-staging.sh                      # all 14 checks
BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX scripts/provision-staging.sh all
scripts/provision-staging.sh iam wif           # or any subset of steps
```

Steps, in dependency order: `project firebase apis firestore iam wif secrets webapp auth appcheck config`. Each is safe to re-run. `BILLING_ACCOUNT` is needed only by `project` and is never committed. Budget alerts email the billing account's admins.

## Notes

- Nothing needs the console. The only human decision is which billing account to use.
- The six TTL policies are declared in `firestore.indexes.json`, not created by `provision-staging.sh`: `firebase deploy --only firestore` applies them (proven in #15). A new or re-enabled policy shows `CREATING` for a few minutes before `ACTIVE`; `wait-indexes.ts` and V4 fail until then.
- The deploy order is LLD 0 P16: `firebase deploy --only firestore`, `wait-indexes.ts`, functions, hosting, `smoke.ts`.
- 2nd gen functions build as the default compute service account, whose `roles/editor` is removed (V8). It needs `roles/storage.objectViewer`, `roles/artifactregistry.writer` and `roles/logging.logWriter` for the build; without them `firebase deploy --only functions` fails in Cloud Build with "missing permission on the build service account" (found in #15).
- The first functions deploy in a region asks for an Artifact Registry cleanup policy; `bunx firebase functions:artifacts:setpolicy --project <id> --location <region>` sets it (1 day) and keeps later deploys exiting 0 (found in #15).
- New projects take a minute or two before IAM is consistent; if a command fails with `USER_PROJECT_DENIED`, retry.
- Secret values (three Secret Manager secrets, the App Check debug token) are generated and piped over stdin; they are never printed, passed as command-line arguments, written to disk or committed. Rotating one means creating a new secret version by hand.
- Public client config (Firebase web config, reCAPTCHA site key) is committed in `apps/web/.env.staging`; `.betterleaks.toml` allowlists exactly that path.

## Prod (M8)

Parameters: `PROJECT=deepcuts-prod BUDGET_AMOUNT=25 ENV_NAME=production ENV_SUFFIX=PROD`. These now drive the budget, GitHub environment and variable names, and the env file names. Still staging-only, to do in M8: the WIF attribute condition in `provision-staging.sh` (P4 prod: `environment == 'production'` only) and the matching verify clauses in V10, and the `.firebaserc` alias. Do not run `provision-staging.sh wif` against prod until then.
