#!/usr/bin/env bash
# Read-only verification of the staging Firebase project (issue #9, checks V1 to V14).
# Never prints a secret value; it only reads metadata and IAM.
#
#   scripts/verify-staging.sh            # exits 0 only if every check passes
#   PROJECT=deepcuts-prod ...            # same checks against another project (see scripts/README.md)
#
# Needs: gcloud (logged in), firebase, gh, jq, curl, betterleaks.

set -uo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1  # a prompt must fail the check, never hang it
exec </dev/null

PROJECT="${PROJECT:-deepcuts-staging}"
REPO="${REPO:-sleb/dc}"
ENV_NAME="${ENV_NAME:-staging}"
ENV_SUFFIX="${ENV_SUFFIX:-STAGING}"   # GitHub variable suffix: WIF_PROVIDER_<suffix>, DEPLOYER_SA_<suffix>
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
# Expected state (the single declarative block; provision-staging.sh mirrors it)
# ---------------------------------------------------------------------------
BUDGET_AMOUNT="${BUDGET_AMOUNT:-10}"
BUDGET_THRESHOLDS="0.5 0.9 1"
FIRESTORE_LOCATION="nam5"
TTL_GROUPS="idem outbox notifLog rateLimits deletions joinIdem"
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
# The default compute service account builds 2nd gen functions, so it keeps exactly the build roles (#15).
COMPUTE_BUILD_ROLES="roles/storage.objectViewer roles/artifactregistry.writer roles/logging.logWriter"
WIF_POOL="github"
WIF_PROVIDER="github"
SECRETS="RATE_LIMIT_HASH_SALT LOG_HASH_SALT SEAT_DERIVATION_KEY"
WEB_ENV_KEYS="VITE_FIREBASE_API_KEY VITE_FIREBASE_AUTH_DOMAIN VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET VITE_FIREBASE_MESSAGING_SENDER_ID VITE_FIREBASE_APP_ID
VITE_RECAPTCHA_SITE_KEY VITE_FUNCTIONS_REGION VITE_APP_ENV"
FN_ENV_KEYS="APP_ORIGIN CODE_WINDOW_MS CODE_LOOKUP_ENABLED TRUSTED_HOPS COMMAND_MIN_INSTANCES"

FN_SA="fn-runtime@${PROJECT}.iam.gserviceaccount.com"
CI_SA="ci-deployer@${PROJECT}.iam.gserviceaccount.com"

# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------
PASS=0; FAILED=0
REASONS=()

bad() { REASONS+=("$*"); }

check() { # check <id> <description> <function>
  REASONS=()
  "$3" >/dev/null 2>&1 || bad "check function errored unexpectedly"
  if [ ${#REASONS[@]} -eq 0 ]; then
    printf 'PASS  %-4s %s\n' "$1" "$2"; PASS=$((PASS + 1))
  else
    printf 'FAIL  %-4s %s\n' "$1" "$2"
    for r in "${REASONS[@]}"; do printf '        - %s\n' "$r"; done
    FAILED=$((FAILED + 1))
  fi
}

# Direct (non-check) tools. A missing tool is a clear failure, not a crash.
have() { command -v "$1" >/dev/null 2>&1; }

TOKEN=""
api() { # api <url>  -> JSON on stdout (error JSON if the call fails)
  [ -n "$TOKEN" ] || TOKEN="$(gcloud auth print-access-token 2>/dev/null)"
  curl -sS -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" "$1" 2>/dev/null \
    || echo '{"error":{"message":"curl failed"}}'
}

# jq that yields "" instead of failing on non-JSON
jqr() { jq -r "$@" 2>/dev/null || true; }

PROJECT_NUMBER=""
project_number() {
  [ -n "$PROJECT_NUMBER" ] || PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null)"
  echo "$PROJECT_NUMBER"
}

need_project() { # records a reason and returns 1 when the project is unreadable
  [ -n "$(project_number)" ] && return 0
  bad "project $PROJECT does not exist or is not readable"
  return 1
}

APP_ID=""
web_app_id() {
  [ -n "$APP_ID" ] || APP_ID="$(firebase apps:list WEB --project "$PROJECT" --json 2>/dev/null | jqr '.result[0].appId // empty')"
  echo "$APP_ID"
}

IAM_POLICY=""
iam_policy() {
  [ -n "$IAM_POLICY" ] || IAM_POLICY="$(gcloud projects get-iam-policy "$PROJECT" --format=json 2>/dev/null)"
  echo "$IAM_POLICY"
}

# roles_of <member> -> sorted role list on the project
roles_of() {
  iam_policy | jqr --arg m "$1" '[.bindings[]? | select(.members | index($m)) | .role] | sort | .[]'
}

# same_set <label> <actual> <expected...>
same_set() {
  local label="$1" actual="$2"; shift 2
  local want have_
  want="$(printf '%s\n' "$@" | grep . | sort)"
  have_="$(printf '%s\n' "$actual" | grep . | sort)"
  if [ "$want" != "$have_" ]; then
    local missing extra
    missing="$(comm -23 <(echo "$want") <(echo "$have_") | tr '\n' ' ')"
    extra="$(comm -13 <(echo "$want") <(echo "$have_") | tr '\n' ' ')"
    bad "$label: missing [${missing}] unexpected [${extra}]"
  fi
}

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
v1() {
  need_project || return 0
  local billing
  billing="$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null)"
  [ "$billing" = "True" ] || bad "billing is not enabled on $PROJECT (Blaze required)"
}

v2() {
  need_project || return 0
  local acct budgets match
  acct="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' 2>/dev/null | sed 's#billingAccounts/##')"
  [ -n "$acct" ] || { bad "no billing account attached, cannot look up budgets"; return 0; }
  budgets="$(gcloud billing budgets list --billing-project="$PROJECT" --billing-account "$acct" --format=json 2>/dev/null)"
  match="$(echo "$budgets" | jqr --arg p "projects/$(project_number)" \
    '[.[]? | select(.budgetFilter.projects // [] | index($p))] | .[0] // empty')"
  [ -n "$match" ] || { bad "no budget scoped to $PROJECT on billing account $acct"; return 0; }
  local amt cur
  amt="$(echo "$match" | jqr '.amount.specifiedAmount.units // empty')"
  cur="$(echo "$match" | jqr '.amount.specifiedAmount.currencyCode // empty')"
  [ "$amt" = "$BUDGET_AMOUNT" ] && [ "$cur" = "USD" ] || bad "budget amount is '${amt} ${cur}', want ${BUDGET_AMOUNT} USD"
  local got want
  got="$(echo "$match" | jqr '[.thresholdRules[]?.thresholdPercent | tonumber * 100 | round] | sort | map(tostring) | join(" ")')"
  want="$(printf '%s\n' $BUDGET_THRESHOLDS | awk '{printf "%d\n", $1 * 100 + 0.5}' | sort -n | tr '\n' ' ' | sed 's/ $//')"
  [ "$got" = "$want" ] || bad "budget thresholds are [$got], want [$want]"
}

v3() {
  need_project || return 0
  local db type loc
  db="$(gcloud firestore databases describe --database='(default)' --project "$PROJECT" --format=json 2>/dev/null)"
  type="$(echo "$db" | jqr '.type // empty')"
  loc="$(echo "$db" | jqr '.locationId // empty')"
  [ -n "$type" ] || { bad "no (default) Firestore database"; return 0; }
  [ "$type" = "FIRESTORE_NATIVE" ] || bad "Firestore type is $type, want FIRESTORE_NATIVE"
  [ "$loc" = "$FIRESTORE_LOCATION" ] || bad "Firestore location is $loc, want $FIRESTORE_LOCATION"
}

v4() {
  need_project || return 0
  local fields g state
  fields="$(gcloud firestore fields ttls list --project "$PROJECT" --format=json 2>/dev/null)"
  [ -n "$fields" ] || { bad "could not list Firestore fields (is Firestore created?)"; return 0; }
  for g in $TTL_GROUPS; do
    state="$(echo "$fields" | jqr --arg g "$g" \
      '[.[]? | select(.name | endswith("/collectionGroups/" + $g + "/fields/expiresAt")) | .ttlConfig.state] | .[0] // empty')"
    [ "$state" = "ACTIVE" ] || bad "TTL on $g.expiresAt is '${state:-absent}', want ACTIVE"
  done
}

v5() {
  need_project || return 0
  local enabled a
  enabled="$(gcloud services list --enabled --project "$PROJECT" --format='value(config.name)' 2>/dev/null)"
  [ -n "$enabled" ] || { bad "could not list enabled services"; return 0; }
  for a in $APIS; do
    echo "$enabled" | grep -qx "$a" || bad "API not enabled: $a"
  done
}

v6() {
  need_project || return 0
  local cfg
  cfg="$(api "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT/config")"
  [ "$(echo "$cfg" | jqr '.name // empty')" != "" ] || { bad "Identity Platform config unreadable (not upgraded?): $(echo "$cfg" | jqr '.error.message // "no response"')"; return 0; }
  [ "$(echo "$cfg" | jqr '.signIn.email.enabled')" = "true" ] || bad "Email sign-in is not enabled"
  [ "$(echo "$cfg" | jqr '.signIn.email.passwordRequired // false')" = "false" ] || bad "Email sign-in must be email link (passwordRequired=false)"
  [ "$(echo "$cfg" | jqr '.signIn.anonymous.enabled')" = "true" ] || bad "Anonymous sign-in is not enabled"
  [ "$(echo "$cfg" | jqr '.signIn.phoneNumber.enabled // false')" = "false" ] || bad "Phone sign-in must stay off"
  [ "$(echo "$cfg" | jqr '.autodeleteAnonymousUsers // false')" = "true" ] || bad "Anonymous-account auto-cleanup is not enabled"
  local d idps
  for d in "$PROJECT.web.app" "$PROJECT.firebaseapp.com"; do
    echo "$cfg" | jqr '.authorizedDomains[]?' | grep -qx "$d" || bad "authorized domain missing: $d"
  done
  idps="$(api "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT/defaultSupportedIdpConfigs" \
    | jqr '[.defaultSupportedIdpConfigs[]? | select(.enabled == true) | .name] | length')"
  [ "${idps:-0}" = "0" ] || bad "$idps social identity providers are enabled; only Email link and Anonymous allowed"
}

v7() {
  need_project || return 0
  local app svc mode token_count site
  app="$(web_app_id)"
  [ -n "$app" ] || { bad "no web app registered"; return 0; }
  site="$(api "https://firebaseappcheck.googleapis.com/v1/projects/$PROJECT/apps/$app/recaptchaEnterpriseConfig" | jqr '.siteKey // empty')"
  [ -n "$site" ] || bad "App Check provider is not reCAPTCHA Enterprise for app $app"
  for svc in firestore.googleapis.com identitytoolkit.googleapis.com; do
    mode="$(api "https://firebaseappcheck.googleapis.com/v1/projects/$PROJECT/services/$svc" | jqr '.enforcementMode // empty')"
    [ "$mode" = "ENFORCED" ] || bad "App Check enforcement on $svc is '${mode:-unset}', want ENFORCED"
  done
  token_count="$(api "https://firebaseappcheck.googleapis.com/v1/projects/$PROJECT/apps/$app/debugTokens" | jqr '.debugTokens | length // 0')"
  [ "${token_count:-0}" -ge 1 ] 2>/dev/null || bad "no App Check debug token registered"
}

v8() {
  need_project || return 0
  local fn ci
  fn="$(gcloud iam service-accounts describe "$FN_SA" --format='value(email)' 2>/dev/null)"
  ci="$(gcloud iam service-accounts describe "$CI_SA" --format='value(email)' 2>/dev/null)"
  [ -n "$fn" ] || bad "service account missing: $FN_SA"
  [ -n "$ci" ] || bad "service account missing: $CI_SA"
  if [ -n "$fn" ]; then
    same_set "fn-runtime project roles" "$(roles_of "serviceAccount:$FN_SA")" $FN_ROLES
    gcloud iam service-accounts get-iam-policy "$FN_SA" --format=json 2>/dev/null \
      | jqr --arg m "serviceAccount:$FN_SA" '.bindings[]? | select(.role == "roles/iam.serviceAccountTokenCreator") | .members[]' \
      | grep -qx "serviceAccount:$FN_SA" || bad "fn-runtime lacks the self-grant of roles/iam.serviceAccountTokenCreator"
    if [ -n "$ci" ]; then
      gcloud iam service-accounts get-iam-policy "$FN_SA" --format=json 2>/dev/null \
        | jqr '.bindings[]? | select(.role == "roles/iam.serviceAccountUser") | .members[]' \
        | grep -qx "serviceAccount:$CI_SA" || bad "ci-deployer lacks roles/iam.serviceAccountUser on fn-runtime"
    fi
  fi
  [ -z "$ci" ] || same_set "ci-deployer project roles" "$(roles_of "serviceAccount:$CI_SA")" $CI_ROLES
  local compute
  compute="serviceAccount:$(project_number)-compute@developer.gserviceaccount.com"
  if roles_of "$compute" | grep -qx 'roles/editor'; then
    bad "default compute service account still has roles/editor"
  fi
  same_set "default compute service account build roles" "$(roles_of "$compute")" $COMPUTE_BUILD_ROLES
}

v9() {
  need_project || return 0
  local sas sa keys
  sas="$(gcloud iam service-accounts list --project "$PROJECT" --format='value(email)' 2>/dev/null)"
  [ -n "$sas" ] || { bad "could not list service accounts"; return 0; }
  for sa in $sas; do
    keys="$(gcloud iam service-accounts keys list --iam-account "$sa" --managed-by=user --format='value(name)' 2>/dev/null)"
    [ -z "$keys" ] || bad "user-managed key exists on $sa"
  done
}

v10() {
  local prov cond issuer
  prov=""
  [ -z "$(project_number)" ] || prov="$(gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER" --workload-identity-pool="$WIF_POOL" \
    --location=global --project "$PROJECT" --format=json 2>/dev/null)"
  if [ -z "$prov" ]; then
    bad "WIF provider $WIF_POOL/$WIF_PROVIDER does not exist"
  else
    issuer="$(echo "$prov" | jqr '.oidc.issuerUri // empty')"
    cond="$(echo "$prov" | jqr '.attributeCondition // empty')"
    [ "$issuer" = "https://token.actions.githubusercontent.com" ] || bad "WIF issuer is '$issuer'"
    echo "$cond" | grep -q "assertion.repository == '$REPO'" || bad "WIF condition does not restrict to repository $REPO"
    echo "$cond" | grep -q "assertion.environment == '$ENV_NAME'" || bad "WIF condition lacks the P4 environment == '$ENV_NAME' clause"
    # A pull_request claim cannot express "same repository": GitHub sets `repository` to the base repo for fork PRs.
    echo "$cond" | grep -q "pull_request" && bad "WIF condition admits pull_request events, which fork PRs satisfy"
    gcloud iam service-accounts get-iam-policy "$CI_SA" --format=json 2>/dev/null \
      | jqr '.bindings[]? | select(.role == "roles/iam.workloadIdentityUser") | .members[]' \
      | grep -q "attribute.repository/$REPO\$" || bad "ci-deployer has no workloadIdentityUser binding for $REPO"
  fi
  have gh || { bad "gh not installed"; return 0; }
  gh api "repos/$REPO/environments/$ENV_NAME" >/dev/null 2>&1 || bad "GitHub environment '$ENV_NAME' does not exist on $REPO"
  local vars
  vars="$(gh variable list --repo "$REPO" --json name --jq '.[].name' 2>/dev/null)"
  echo "$vars" | grep -qx "WIF_PROVIDER_$ENV_SUFFIX" || bad "GitHub variable WIF_PROVIDER_$ENV_SUFFIX is not set"
  echo "$vars" | grep -qx "DEPLOYER_SA_$ENV_SUFFIX" || bad "GitHub variable DEPLOYER_SA_$ENV_SUFFIX is not set"
}

v11() {
  need_project || return 0
  local s members
  for s in $SECRETS; do
    if ! gcloud secrets describe "$s" --project "$PROJECT" >/dev/null 2>&1; then
      bad "secret missing: $s"; continue
    fi
    gcloud secrets versions list "$s" --project "$PROJECT" --filter='state=ENABLED' --format='value(name)' 2>/dev/null \
      | grep -q . || bad "secret $s has no enabled version"
    members="$(gcloud secrets get-iam-policy "$s" --project "$PROJECT" --format=json 2>/dev/null \
      | jqr '[.bindings[]? | select(.role == "roles/secretmanager.secretAccessor") | .members[]] | sort | join(" ")')"
    [ "$members" = "serviceAccount:$FN_SA" ] || bad "secret $s accessors are [$members], want only fn-runtime"
  done
  have gh || { bad "gh not installed"; return 0; }
  gh secret list --env "$ENV_NAME" --repo "$REPO" --json name --jq '.[].name' 2>/dev/null \
    | grep -qx APPCHECK_DEBUG_TOKEN || bad "APPCHECK_DEBUG_TOKEN is not set in GitHub environment '$ENV_NAME'"
}

env_has_keys() { # env_has_keys <file> <keys...>
  local f="$1"; shift
  [ -f "$ROOT/$f" ] || { bad "$f does not exist"; return 0; }
  local k
  for k in "$@"; do
    grep -Eq "^${k}=.+" "$ROOT/$f" || bad "$f is missing a value for $k"
  done
}

v12() {
  env_has_keys "apps/web/.env.$ENV_NAME" $WEB_ENV_KEYS
  env_has_keys "functions/.env.$PROJECT" $FN_ENV_KEYS
  if [ -f "$ROOT/.firebaserc" ]; then
    [ "$(jqr --arg p "$PROJECT" '.projects | to_entries | map(select(.value == $p)) | length' "$ROOT/.firebaserc")" -ge 1 ] 2>/dev/null \
      || bad ".firebaserc has no alias for $PROJECT"
  else
    bad ".firebaserc does not exist"
  fi
  if [ -f "$ROOT/apps/web/.env.$ENV_NAME" ]; then
    grep -Eq "^VITE_FIREBASE_PROJECT_ID=$PROJECT\$" "$ROOT/apps/web/.env.$ENV_NAME" || bad "apps/web/.env.$ENV_NAME VITE_FIREBASE_PROJECT_ID is not $PROJECT"
  fi
}

v13() {
  have betterleaks || { bad "betterleaks is not installed (brew install betterleaks)"; return 0; }
  # No --validate: detection only, no requests to credential providers.
  (cd "$ROOT" && betterleaks git -c .betterleaks.toml --no-banner --redact . >/dev/null 2>&1) || bad "betterleaks found a leak in the git history"
  (cd "$ROOT" && betterleaks dir -c .betterleaks.toml --no-banner --redact . >/dev/null 2>&1) || bad "betterleaks found a leak in the working tree"
}

v14() {
  need_project || return 0
  local sites
  sites="$(api "https://firebasehosting.googleapis.com/v1beta1/projects/$PROJECT/sites" | jqr '.sites[]?.name')"
  echo "$sites" | grep -qx "projects/$PROJECT/sites/$PROJECT" || bad "default Hosting site $PROJECT does not exist"
}

# Prime the caches in this shell (the helpers are called inside $(...) and cannot fill them).
TOKEN="$(gcloud auth print-access-token 2>/dev/null || true)"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null || true)"
if [ -n "$PROJECT_NUMBER" ]; then
  IAM_POLICY="$(gcloud projects get-iam-policy "$PROJECT" --format=json 2>/dev/null || true)"
  APP_ID="$(firebase apps:list WEB --project "$PROJECT" --json 2>/dev/null | jqr '.result[0].appId // empty')"
fi

# ---------------------------------------------------------------------------
echo "Verifying project: $PROJECT (repo $REPO)"
for t in gcloud firebase gh jq curl; do have "$t" || echo "WARNING: $t is not installed; dependent checks will fail"; done

check V1  "Project exists, Blaze billing attached" v1
check V2  "Budget \$${BUDGET_AMOUNT}/mo, alerts at 50/90/100%" v2
check V3  "Firestore Native at ${FIRESTORE_LOCATION}" v3
check V4  "TTL on expiresAt for the six groups, ACTIVE" v4
check V5  "All required APIs enabled" v5
check V6  "Identity Platform: Email link + Anonymous only, auto-cleanup, authorized domains" v6
check V7  "Web app, App Check reCAPTCHA Enterprise, enforcement, debug token" v7
check V8  "fn-runtime and ci-deployer roles, self-grant, compute SA has no Editor and only the build roles" v8
check V9  "No user-managed service account keys" v9
check V10 "WIF pool/provider restricted to repo, staging environment and variables" v10
check V11 "Secrets exist, fn-runtime is the only secret-level reader; APPCHECK_DEBUG_TOKEN in env" v11
check V12 "Committed config files have the required keys" v12
check V13 "No secret value committed (betterleaks)" v13
check V14 "Default Hosting site exists" v14

echo
echo "$PASS passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
