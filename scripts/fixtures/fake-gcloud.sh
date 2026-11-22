#!/bin/sh
# Stand-in for `gcloud` in the wait-indexes tests (scripts/wait-indexes.test.ts); never talks to Google.
# Copy it onto PATH as `gcloud` (the tests do) and point FAKE_GCLOUD_STATE at a state directory holding:
#   composite.json / composite.<n>.json   stdout of the nth `firestore indexes composite list` (falls back to the unsuffixed file)
#   ttls.json / ttls.<n>.json             the same for `gcloud firestore fields ttls list`
#   composite.exit / ttls.exit            exit code for that kind of call (default 0)
set -u
state="${FAKE_GCLOUD_STATE:?fake gcloud: set FAKE_GCLOUD_STATE}"
case "$*" in
  "firestore indexes composite list"*) kind=composite ;;
  "firestore fields ttls list"*) kind=ttls ;;
  *)
    echo "fake gcloud: unexpected arguments: $*" >&2
    exit 64
    ;;
esac
n=$(($(cat "$state/$kind.calls" 2>/dev/null || echo 0) + 1))
echo "$n" >"$state/$kind.calls"
file="$state/$kind.$n.json"
[ -f "$file" ] || file="$state/$kind.json"
[ -f "$file" ] && cat "$file"
if [ -f "$state/$kind.exit" ]; then
  echo "fake gcloud: simulated failure for $kind" >&2
  exit "$(cat "$state/$kind.exit")"
fi
exit 0
