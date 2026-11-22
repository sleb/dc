#!/bin/sh
# Stand-in for `curl` in scripts/provision-channel.test.ts, i.e. for the `api` helper of provision-staging.sh, which
# always calls: -sS --fail-with-body -X <method> -H ... --data-binary @- <url> with the body on stdin.
# Copy it onto PATH as `curl` (the test does) and point FAKE_CURL_STATE at a state directory holding:
#   channels.json   the GET .../notificationChannels response (default: no channels); channels.<n>.json answers
#                   the nth GET instead, which is how a paginated listing is scripted
#   calls           this script appends "<method> <url>", one line per call
#   created.json    written from stdin on the first POST; absent means no channel was created
set -u
state="${FAKE_CURL_STATE:?fake curl: set FAKE_CURL_STATE}"
method=GET
url=""
previous=""
for arg in "$@"; do
  [ "$previous" = "-X" ] && method="$arg"
  previous="$arg"
  url="$arg"
done
printf '%s %s\n' "$method" "$url" >>"$state/calls"
body="$(cat)"
case "$method $url" in
  "GET "*notificationChannels*)
    n=$(($(cat "$state/channels.calls" 2>/dev/null || echo 0) + 1))
    echo "$n" >"$state/channels.calls"
    page="$state/channels.$n.json"
    [ -f "$page" ] || page="$state/channels.json"
    if [ -f "$page" ]; then cat "$page"; else printf '{"notificationChannels":[]}'; fi
    ;;
  "POST "*notificationChannels*)
    printf '%s' "$body" >"$state/created.json"
    printf '{"name":"projects/fake/notificationChannels/1"}'
    ;;
  *)
    echo "fake curl: unexpected request $method $url" >&2
    exit 64
    ;;
esac
exit 0
