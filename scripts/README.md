# scripts

Repo-level scripts that are not shipped. Plain bash, because they predate the Bun workspace.

| Script | What it does |
|---|---|
| `verify-staging.sh` | Read-only. Runs checks V1 to V14 (LLD 0 section 2.1) and exits 0 only if all pass. Prints reasons for each failure, never a secret value. |
| `provision-staging.sh` | Idempotent. Creates what the checks assert, one step at a time. |

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
- TTL policies show `CREATING` for a few minutes before `ACTIVE`; V4 fails until then.
- New projects take a minute or two before IAM is consistent; if a command fails with `USER_PROJECT_DENIED`, retry.
- Secret values (three Secret Manager secrets, the App Check debug token) are generated and piped over stdin; they are never printed, passed as command-line arguments, written to disk or committed. Rotating one means creating a new secret version by hand.
- Public client config (Firebase web config, reCAPTCHA site key) is committed in `apps/web/.env.staging`; `.betterleaks.toml` allowlists exactly that path.

## Prod (M8)

Parameters: `PROJECT=deepcuts-prod BUDGET_AMOUNT=25 ENV_NAME=production ENV_SUFFIX=PROD`. These now drive the budget, GitHub environment and variable names, and the env file names. Still staging-only, to do in M8: the WIF attribute condition in `provision-staging.sh` (P4 prod: `environment == 'production'` only) and the matching verify clauses in V10, and the `.firebaserc` alias. Do not run `provision-staging.sh wif` against prod until then.
