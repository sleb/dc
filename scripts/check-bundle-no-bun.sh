#!/usr/bin/env bash
# LLD 0 P7: the functions bundle must load under Node with no Bun on PATH.
# usage: check-bundle-no-bun.sh [functions-dir]   (default: functions; run after `bun run build:functions`)
# Node is resolved first, then the bundle is loaded with a minimal PATH (CLEAN_PATH, default /usr/bin:/bin). If bun is
# still reachable on that PATH the check would prove nothing, so it fails.
set -euo pipefail
exec </dev/null

ROOT="${1:-functions}"
CLEAN_PATH="${CLEAN_PATH:-/usr/bin:/bin}"
NODE="$(command -v node)" || { echo "check-bundle-no-bun: node not found" >&2; exit 2; }

[ -f "$ROOT/dist/index.cjs" ] || { echo "check-bundle-no-bun: $ROOT/dist/index.cjs is missing (run bun run build:functions)" >&2; exit 1; }

if PATH="$CLEAN_PATH" command -v bun >/dev/null 2>&1; then
  echo "check-bundle-no-bun: bun is still on PATH ($CLEAN_PATH); the check would prove nothing" >&2
  exit 1
fi

LOAD='const m = require("./dist/index.cjs"); console.log("node " + process.versions.node + " loaded the bundle; exports: " + Object.keys(m).filter((k) => k !== "__esModule").join(","));'
if ! OUT="$(cd "$ROOT" && env -i PATH="$CLEAN_PATH" HOME="${HOME:-/}" GCLOUD_PROJECT=demo-deepcuts "$NODE" -e "$LOAD" 2>&1)"; then
  echo "check-bundle-no-bun: the bundle does not load under Node without Bun on PATH:" >&2
  echo "$OUT" | head -8 >&2
  exit 1
fi
echo "check-bundle-no-bun: ok. $OUT"
