#!/usr/bin/env bash
# Installs the pinned betterleaks (LLD 0 P13) into <dest-dir>, verifying the download against the pinned sha256.
# usage: install-betterleaks.sh <dest-dir>
# The checksums are the ones in the v1.10.1 release's checksums.txt (also the digest GitHub shows per asset).
# BETTERLEAKS_BASE_URL overrides the download location (tests only; the checksum still applies).
set -euo pipefail
exec </dev/null

VERSION="1.10.1"
BASE_URL="${BETTERLEAKS_BASE_URL:-https://github.com/betterleaks/betterleaks/releases/download/v${VERSION}}"

DEST="${1:-}"
[ -n "$DEST" ] || { echo "usage: install-betterleaks.sh <dest-dir>" >&2; exit 2; }

case "$(uname -s)_$(uname -m)" in
  Linux_x86_64) ASSET="linux_x64"; SHA="c174b42d7aa60caf58c0c3e555c0e4bed01fe6b0d99a412bce777b5af4ce913e" ;;
  Linux_aarch64 | Linux_arm64) ASSET="linux_arm64"; SHA="62a63199f9f61a6b5e5a6f58f048493db20fbc8c770014f4d903a4d97886e1bf" ;;
  Darwin_arm64) ASSET="darwin_arm64"; SHA="ca91eb3b006f15478411f235b5e2712fb15cea74f6701ebadc2364efe0af1403" ;;
  Darwin_x86_64) ASSET="darwin_x64"; SHA="1ae2e3885d161918d8ad2e911e205e73f0d9ffba52c85b38126586c52d355ef4" ;;
  *) echo "install-betterleaks: unsupported platform $(uname -s) $(uname -m)" >&2; exit 2 ;;
esac

if [ -x "$DEST/betterleaks" ] && [ "$("$DEST/betterleaks" version 2>/dev/null | tr -d '[:space:]')" = "$VERSION" ]; then
  echo "betterleaks $VERSION already installed in $DEST"
  exit 0
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FILE="betterleaks_${VERSION}_${ASSET}.tar.gz"
curl -fsSL --retry 3 -o "$WORK/$FILE" "$BASE_URL/$FILE"
GOT="$(sha256_of "$WORK/$FILE")"
if [ "$GOT" != "$SHA" ]; then
  echo "install-betterleaks: sha256 mismatch for $FILE (expected $SHA, got $GOT); nothing installed" >&2
  exit 1
fi
tar -xzf "$WORK/$FILE" -C "$WORK" betterleaks
mkdir -p "$DEST"
install -m 0755 "$WORK/betterleaks" "$DEST/betterleaks"
echo "betterleaks $("$DEST/betterleaks" version | tr -d '[:space:]') installed in $DEST"
