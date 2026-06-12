#!/usr/bin/env bash
set -euo pipefail

# Publish a signed macOS release to GitHub.
#
# Runs release-macos.sh (build + sign + notarize + verify), then tags
# v<version> (read from src-tauri/tauri.conf.json) and creates a GitHub
# release with the DMG attached twice:
#
#   Symphony_<version>_<arch>.dmg   the versioned artifact
#   Symphony.dmg                    stable name, so the README's
#                                   releases/latest/download/Symphony.dmg
#                                   link always serves the newest build
#
# Requires an authenticated GitHub CLI (`gh`) with push access.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
TAG="v$VERSION"

# Only publish what's actually on GitHub: clean main, in sync with origin.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "error: releases are cut from main (currently on $BRANCH)" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean" >&2
  exit 1
fi
git fetch origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "error: HEAD does not match origin/main — push or pull first" >&2
  exit 1
fi

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "error: release $TAG already exists — bump the version in src-tauri/tauri.conf.json" >&2
  exit 1
fi

bash "$ROOT/scripts/release-macos.sh"

shopt -s nullglob
DMGS=("$ROOT"/target/release/bundle/dmg/Symphony_"$VERSION"_*.dmg)
if (( ${#DMGS[@]} != 1 )); then
  echo "error: expected exactly one Symphony_${VERSION}_*.dmg in target/release/bundle/dmg, found ${#DMGS[@]}" >&2
  exit 1
fi
DMG="${DMGS[0]}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$DMG" "$STAGE/Symphony.dmg"

echo
echo "── creating GitHub release $TAG ──"
gh release create "$TAG" \
  --title "Symphony $TAG" \
  --generate-notes \
  "$DMG" "$STAGE/Symphony.dmg"

REPO_URL="$(gh repo view --json url -q .url)"
echo
echo "Published: $REPO_URL/releases/tag/$TAG"
echo "Stable download: $REPO_URL/releases/latest/download/Symphony.dmg"
