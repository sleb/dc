#!/usr/bin/env bash
# Idempotent provisioning for the staging Firebase project (issue #9).
# Every step is safe to re-run. Prove each step with scripts/verify-staging.sh.
#
#   BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX scripts/provision-staging.sh project
#   scripts/provision-staging.sh apis firestore iam
#   scripts/provision-staging.sh all          # every scripted step, in order
#
# BILLING_ACCOUNT is supplied at run time and never committed. Steps that cannot be
# scripted (console only) are listed in scripts/README.md.

set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT="${PROJECT:-deepcuts-staging}"
REPO="${REPO:-sleb/dc}"
ENV_NAME="${ENV_NAME:-staging}"
ENV_SUFFIX="${ENV_SUFFIX:-STAGING}"   # GitHub variable suffix: WIF_PROVIDER_<suffix>, DEPLOYER_SA_<suffix>
BUDGET_AMOUNT="${BUDGET_AMOUNT:-10}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FIRESTORE_LOCATION="nam5"
APIS="cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com
artifactregistry.googleapis.com eventarc.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com
iamcredentials.googleapis.com recaptchaenterprise.googleapis.com firebaseappcheck.googleapis.com
fcm.googleapis.com fcmregistrations.googleapis.com identitytoolkit.googleapis.com
firestore.googleapis.com firebase.googleapis.com firebasehosting.googleapis.com
cloudresourcemanager.googleapis.com iam.googleapis.com serviceusage.googleapis.com
sts.googleapis.com cloudbilling.googleapis.com billingbudgets.googleapis.com"
FN_ROLES="roles/datastore.user roles/firebaseauth.admin roles/firebasecloudmessaging.admin
roles/secretmanager.secretAccessor roles/logging.logWriter roles/cloudtrace.agent"
CI_ROLES="roles/firebase.admin roles/cloudfunctions.developer roles/cloudscheduler.admin
roles/artifactregistry.writer roles/serviceusage.serviceUsageConsumer
roles/monitoring.editor roles/logging.configWriter"
# 2nd gen function builds run as the default compute service account, so it keeps the build roles even though our code
# never uses it and its roles/editor is removed (#15).
COMPUTE_BUILD_ROLES="roles/storage.objectViewer roles/artifactregistry.writer roles/logging.logWriter"
WIF_POOL="github"
WIF_PROVIDER="github"
SECRETS="RATE_LIMIT_HASH_SALT LOG_HASH_SALT SEAT_DERIVATION_KEY"

FN_SA="fn-runtime@${PROJECT}.iam.gserviceaccount.com"
CI_SA="ci-deployer@${PROJECT}.iam.gserviceaccount.com"

log() { printf '==> %s\n' "$*"; }

# ---------------------------------------------------------------------------
step_project() { # V1, V2
  : "${BILLING_ACCOUNT:?set BILLING_ACCOUNT (billing account id) to run this step}"
  if gcloud projects describe "$PROJECT" >/dev/null 2>&1; then
    log "project $PROJECT exists"
  else
    log "creating project $PROJECT"
    gcloud projects create "$PROJECT" --name="$PROJECT"
  fi
  log "linking billing account"
  gcloud billing projects link "$PROJECT" --billing-account="$BILLING_ACCOUNT" >/dev/null
  gcloud services enable billingbudgets.googleapis.com cloudbilling.googleapis.com --project "$PROJECT"

  local number
  number="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
  if gcloud billing budgets list --billing-project="$PROJECT" --billing-account="$BILLING_ACCOUNT" --format=json \
      | jq -e --arg p "projects/$number" '[.[] | select(.budgetFilter.projects // [] | index($p))] | length > 0' >/dev/null; then
    log "budget already exists"
  else
    log "creating \$$BUDGET_AMOUNT budget (alerts 50/90/100%; emails go to billing account admins)"
    gcloud billing budgets create --billing-project="$PROJECT" --billing-account="$BILLING_ACCOUNT" \
      --display-name="$PROJECT" \
      --filter-projects="projects/$number" \
      --budget-amount="${BUDGET_AMOUNT}USD" \
      --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
  fi
}

# Adds Firebase to the GCP project (creates the default Hosting site, V14).
step_firebase() {
  if firebase projects:list --json 2>/dev/null | jq -e --arg p "$PROJECT" '.result[]? | select(.projectId == $p)' >/dev/null; then
    log "Firebase already enabled on $PROJECT"
  else
    log "adding Firebase to $PROJECT"
    firebase projects:addfirebase "$PROJECT"
  fi
}

step_apis() { # V5
  log "enabling APIs"
  # serviceusage accepts at most 20 services per call
  # shellcheck disable=SC2086
  printf '%s\n' $APIS | xargs -n 10 gcloud services enable --project "$PROJECT"
}

step_firestore() { # V3, V4
  if gcloud firestore databases describe --database='(default)' --project "$PROJECT" >/dev/null 2>&1; then
    log "Firestore database exists"
  else
    log "creating Firestore (Native, $FIRESTORE_LOCATION)"
    gcloud firestore databases create --location="$FIRESTORE_LOCATION" --type=firestore-native --project "$PROJECT"
  fi
  # The TTL policies are not set here: `firestore.indexes.json` declares them and `firebase deploy --only firestore`
  # applies them (#15 proved the deploy honours "ttl": true; see LLD 0 section 11 step 12).
}

step_iam() { # V8, V9
  local sa
  for sa in fn-runtime ci-deployer; do
    gcloud iam service-accounts describe "$sa@$PROJECT.iam.gserviceaccount.com" --project "$PROJECT" >/dev/null 2>&1 \
      || gcloud iam service-accounts create "$sa" --display-name="$sa" --project "$PROJECT"
  done
  local r
  for r in $FN_ROLES; do
    gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$FN_SA" --role="$r" --condition=None >/dev/null
  done
  for r in $CI_ROLES; do
    gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$CI_SA" --role="$r" --condition=None >/dev/null
  done
  log "fn-runtime self-grant of serviceAccountTokenCreator"
  gcloud iam service-accounts add-iam-policy-binding "$FN_SA" --member="serviceAccount:$FN_SA" \
    --role=roles/iam.serviceAccountTokenCreator --project "$PROJECT" >/dev/null
  log "ci-deployer may act as fn-runtime"
  gcloud iam service-accounts add-iam-policy-binding "$FN_SA" --member="serviceAccount:$CI_SA" \
    --role=roles/iam.serviceAccountUser --project "$PROJECT" >/dev/null
  local number compute
  number="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
  compute="serviceAccount:${number}-compute@developer.gserviceaccount.com"
  if gcloud projects get-iam-policy "$PROJECT" --format=json \
      | jq -e --arg m "$compute" '.bindings[]? | select(.role == "roles/editor" and (.members | index($m)))' >/dev/null; then
    log "removing Editor from the default compute service account"
    gcloud projects remove-iam-policy-binding "$PROJECT" --member="$compute" --role=roles/editor --condition=None >/dev/null
  fi
  # The functions build runs as this account; without these roles Cloud Build fails "missing permission on the build
  # service account" (#15).
  for r in $COMPUTE_BUILD_ROLES; do
    gcloud projects add-iam-policy-binding "$PROJECT" --member="$compute" --role="$r" --condition=None >/dev/null
  done
}

step_wif() { # V10
  gcloud iam workload-identity-pools describe "$WIF_POOL" --location=global --project "$PROJECT" >/dev/null 2>&1 \
    || gcloud iam workload-identity-pools create "$WIF_POOL" --location=global --display-name="GitHub Actions" --project "$PROJECT"
  # P4: this repository, through the named GitHub environment. A `pull_request` claim cannot express "same repository"
  # (GitHub sets `repository` to the base repo for fork PRs), so previews must enter the `staging` environment too (#16).
  local cond="assertion.repository == '$REPO' && assertion.environment == '$ENV_NAME'"
  local action=create-oidc
  gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER" --workload-identity-pool="$WIF_POOL" \
    --location=global --project "$PROJECT" >/dev/null 2>&1 && action=update-oidc
  gcloud iam workload-identity-pools providers "$action" "$WIF_PROVIDER" --workload-identity-pool="$WIF_POOL" \
    --location=global --project "$PROJECT" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.environment=assertion.environment" \
    --attribute-condition="$cond" \
    $( [ "$action" = create-oidc ] && echo "--display-name=GitHub" || true )
  local number
  number="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
  gcloud iam service-accounts add-iam-policy-binding "$CI_SA" \
    --member="principalSet://iam.googleapis.com/projects/$number/locations/global/workloadIdentityPools/$WIF_POOL/attribute.repository/$REPO" \
    --role=roles/iam.workloadIdentityUser --project "$PROJECT" >/dev/null
  log "GitHub environment and variables"
  gh api -X PUT "repos/$REPO/environments/$ENV_NAME" >/dev/null
  local provider="projects/$number/locations/global/workloadIdentityPools/$WIF_POOL/providers/$WIF_PROVIDER"
  gh variable set "WIF_PROVIDER_$ENV_SUFFIX" --repo "$REPO" --body "$provider"
  gh variable set "DEPLOYER_SA_$ENV_SUFFIX" --repo "$REPO" --body "$CI_SA"
}

api() { # api <METHOD> <url> [json-body]; prints the response, fails on an HTTP error
  local token
  token="$(gcloud auth print-access-token)"
  # The body goes over stdin so a secret in it never appears in the process list.
  printf '%s' "${3:-}" | curl -sS --fail-with-body -X "$1" -H "Authorization: Bearer $token" \
    -H "x-goog-user-project: $PROJECT" -H "Content-Type: application/json" --data-binary @- "$2"
}

step_webapp() { # V7 (web app)
  if [ -n "$(firebase apps:list WEB --project "$PROJECT" --json | jq -r '.result[0].appId // empty')" ]; then
    log "web app exists"
  else
    log "registering web app"
    firebase apps:create WEB "$PROJECT-web" --project "$PROJECT"
  fi
}

step_auth() { # V6. Upgrading to Identity Platform needs billing (done in step project).
  local base="https://identitytoolkit.googleapis.com"
  log "Identity Platform upgrade (idempotent)"
  local out
  if ! out="$(api POST "$base/v2/projects/$PROJECT/identityPlatform:initializeAuth" '{}' 2>&1)"; then
    # Re-running on an upgraded project is expected to be refused; anything else must be visible.
    echo "$out" | grep -qi "already" || { echo "initializeAuth failed: $out" >&2; return 1; }
    log "already upgraded"
  fi
  log "providers, anonymous auto-cleanup"
  api PATCH "$base/admin/v2/projects/$PROJECT/config?updateMask=signIn.email,signIn.anonymous,autodeleteAnonymousUsers" \
    '{"signIn":{"email":{"enabled":true,"passwordRequired":false},"anonymous":{"enabled":true}},"autodeleteAnonymousUsers":true}' >/dev/null
}

step_appcheck() { # V7. Debug token value is generated here, piped to GitHub, never printed.
  local app site
  app="$(firebase apps:list WEB --project "$PROJECT" --json | jq -r '.result[0].appId // empty')"
  [ -n "$app" ] || { echo "run the webapp step first" >&2; return 1; }
  site="$(gcloud recaptcha keys list --project "$PROJECT" --format=json | jq -r '.[] | select(.displayName == "'"$PROJECT"'-web") | .name' | head -1 | sed 's#.*/##')"
  if [ -z "$site" ]; then
    log "creating reCAPTCHA Enterprise key"
    site="$(gcloud recaptcha keys create --display-name="$PROJECT-web" --web --integration-type=score \
      --domains="$PROJECT.web.app,$PROJECT.firebaseapp.com,localhost" --project "$PROJECT" --format='value(name)' | sed 's#.*/##')"
  fi
  local ac="https://firebaseappcheck.googleapis.com/v1/projects/$PROJECT"
  log "App Check provider: reCAPTCHA Enterprise"
  api PATCH "$ac/apps/$app/recaptchaEnterpriseConfig?updateMask=siteKey" "{\"siteKey\":\"$site\"}" >/dev/null
  local svc
  for svc in firestore.googleapis.com identitytoolkit.googleapis.com; do
    log "App Check enforcement: $svc"
    api PATCH "$ac/services/$svc?updateMask=enforcementMode" '{"enforcementMode":"ENFORCED"}' >/dev/null
  done
  # The token has two halves and the value's only copy is the GitHub secret, so check them separately: a run that
  # stored the secret and then failed to register (or the reverse) must be recoverable, and a value that App Check does
  # not know is useless to both smoke and preview builds.
  local has_secret=false registrations
  gh secret list --env "$ENV_NAME" --repo "$REPO" --json name --jq '.[].name' 2>/dev/null | grep -qx APPCHECK_DEBUG_TOKEN && has_secret=true
  registrations="$(api GET "$ac/apps/$app/debugTokens" 2>/dev/null \
    | jq -r '[.debugTokens[]? | select(.displayName == "ci-smoke") | .name] | .[]' 2>/dev/null || true)"
  if [ "$has_secret" = true ] && [ -n "$registrations" ]; then
    log "debug token: stored in GitHub environment $ENV_NAME and registered with App Check"
    return 0
  fi
  if [ "$has_secret" = true ]; then
    log "App Check does not know the stored debug token (its value cannot be read back); rotating it"
  fi
  if [ -n "$registrations" ]; then
    log "removing ci-smoke debug token registrations that have no matching GitHub secret"
    for n in $registrations; do api DELETE "https://firebaseappcheck.googleapis.com/v1/$n" >/dev/null; done
  fi
  log "creating a debug token, storing it in GitHub environment $ENV_NAME and registering it with App Check"
  # A debug token must be a UUID v4 (App Check rejects anything else); openssl is already a prerequisite, uuidgen is not.
  local h tok variant
  h="$(openssl rand -hex 16)"
  variant=$(( (0x${h:16:1} & 0x3) | 0x8 ))
  h="${h:0:12}4${h:13:3}$(printf '%x' "$variant")${h:17:15}"
  tok="${h:0:8}-${h:8:4}-${h:12:4}-${h:16:4}-${h:20:12}"
  gh api -X PUT "repos/$REPO/environments/$ENV_NAME" >/dev/null
  printf '%s' "$tok" | gh secret set APPCHECK_DEBUG_TOKEN --env "$ENV_NAME" --repo "$REPO"
  api POST "$ac/apps/$app/debugTokens" "{\"displayName\":\"ci-smoke\",\"token\":\"$tok\"}" >/dev/null
}

step_config() { # V12. Public client config only (P13): web config and reCAPTCHA site key are public by design.
  local app cfg site
  app="$(firebase apps:list WEB --project "$PROJECT" --json | jq -r '.result[0].appId')"
  cfg="$(firebase apps:sdkconfig WEB "$app" --project "$PROJECT" --json | jq '.result.sdkConfig // .result')"
  site="$(gcloud recaptcha keys list --project "$PROJECT" --format=json | jq -r '.[] | select(.displayName == "'"$PROJECT"'-web") | .name' | head -1 | sed 's#.*/##')"
  [ -n "$site" ] || { echo "no reCAPTCHA key found; run the appcheck step first" >&2; return 1; }
  mkdir -p "$ROOT/apps/web" "$ROOT/functions"
  # Never overwrite a committed file: values may have been tuned since it was generated.
  write_once() { # write_once <path>  (content on stdin)
    if [ -e "$1" ]; then log "$1 exists, leaving it"; cat >/dev/null; else cat > "$1"; fi
  }
  write_once "$ROOT/apps/web/.env.$ENV_NAME" <<EOF
VITE_APP_ENV=$ENV_NAME
VITE_FUNCTIONS_REGION=us-central1
VITE_FIREBASE_API_KEY=$(jq -r .apiKey <<<"$cfg")
VITE_FIREBASE_AUTH_DOMAIN=$(jq -r .authDomain <<<"$cfg")
VITE_FIREBASE_PROJECT_ID=$(jq -r .projectId <<<"$cfg")
VITE_FIREBASE_STORAGE_BUCKET=$(jq -r .storageBucket <<<"$cfg")
VITE_FIREBASE_MESSAGING_SENDER_ID=$(jq -r .messagingSenderId <<<"$cfg")
VITE_FIREBASE_APP_ID=$(jq -r .appId <<<"$cfg")
VITE_RECAPTCHA_SITE_KEY=$site
EOF
  write_once "$ROOT/functions/.env.$PROJECT" <<EOF
APP_ORIGIN=https://$PROJECT.web.app
CODE_WINDOW_MS=259200000
CODE_LOOKUP_ENABLED=true
TRUSTED_HOPS=0
COMMAND_MIN_INSTANCES=0
EOF
  write_once "$ROOT/.firebaserc" <<EOF
{
  "projects": {
    "default": "$PROJECT",
    "staging": "$PROJECT"
  }
}
EOF
}

step_secrets() { # V11. Values are generated and piped; they are never printed or stored.
  local s
  for s in $SECRETS; do
    if ! gcloud secrets describe "$s" --project "$PROJECT" >/dev/null 2>&1; then
      log "creating secret $s"
      openssl rand -base64 32 | gcloud secrets create "$s" --data-file=- --replication-policy=automatic --project "$PROJECT"
    fi
    # Only fn-runtime may read: drop every other secretAccessor binding, then add fn-runtime.
    gcloud secrets get-iam-policy "$s" --project "$PROJECT" --format=json \
      | jq -r '.bindings[]? | select(.role == "roles/secretmanager.secretAccessor") | .members[]' \
      | grep -vx "serviceAccount:$FN_SA" \
      | while read -r m; do
          gcloud secrets remove-iam-policy-binding "$s" --member="$m" --role=roles/secretmanager.secretAccessor --project "$PROJECT" >/dev/null
        done || true
    gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$FN_SA" \
      --role=roles/secretmanager.secretAccessor --project "$PROJECT" >/dev/null
  done
}

# ---------------------------------------------------------------------------
[ $# -gt 0 ] || { echo "usage: $0 <step...|all>   steps: project firebase apis firestore iam wif secrets webapp auth appcheck config" >&2; exit 2; }
steps=("$@")
[ "$1" = all ] && steps=(project firebase apis firestore iam wif secrets webapp auth appcheck config)
for s in "${steps[@]}"; do
  declare -F "step_$s" >/dev/null || { echo "unknown step: $s" >&2; exit 2; }
  log "step: $s"
  "step_$s"
done
