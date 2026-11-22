#!/bin/sh
# Stand-in for `gcloud` in the script tests (scripts/wait-indexes.test.ts, scripts/ops-apply.test.ts, and through the
# `api` helper of provision-staging.sh, scripts/provision-channel.test.ts); never talks to Google.
# Copy it onto PATH as `gcloud` (the tests do) and point FAKE_GCLOUD_STATE at a state directory holding:
#   <kind>.json / <kind>.<n>.json   stdout of the nth call of that kind (falls back to the unsuffixed file)
#   <kind>.exit                    exit code for that kind of call (default 0)
#   <kind>.argv                    this script appends every call of that kind, one argv line per call
# `auth print-access-token` prints a fixed fake token and touches no state.
set -u
state="${FAKE_GCLOUD_STATE:?fake gcloud: set FAKE_GCLOUD_STATE}"
case "$*" in
  "auth print-access-token"*) echo "fake-access-token"; exit 0 ;;
  "firestore indexes composite list"*) kind=composite ;;
  "firestore fields ttls list"*) kind=ttls ;;
  "logging metrics list"*) kind=metrics-list ;;
  "logging metrics create"*) kind=metrics-create ;;
  "logging metrics update"*) kind=metrics-update ;;
  "monitoring dashboards list"*) kind=dashboards-list ;;
  "monitoring dashboards create"*) kind=dashboards-create ;;
  "monitoring dashboards update"*) kind=dashboards-update ;;
  "monitoring policies list"*) kind=policies-list ;;
  "monitoring policies create"*) kind=policies-create ;;
  "monitoring policies update"*) kind=policies-update ;;
  *)
    echo "fake gcloud: unexpected arguments: $*" >&2
    exit 64
    ;;
esac
n=$(($(cat "$state/$kind.calls" 2>/dev/null || echo 0) + 1))
echo "$n" >"$state/$kind.calls"
printf '%s\n' "$*" >>"$state/$kind.argv"
case "$kind" in
  *-create | *-update) ;;
  *)
    file="$state/$kind.$n.json"
    [ -f "$file" ] || file="$state/$kind.json"
    [ -f "$file" ] && cat "$file"
    ;;
esac
if [ -f "$state/$kind.exit" ]; then
  echo "fake gcloud: simulated failure for $kind" >&2
  exit "$(cat "$state/$kind.exit")"
fi
exit 0
