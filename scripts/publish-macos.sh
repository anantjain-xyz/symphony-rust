#!/usr/bin/env bash
set -euo pipefail

# Publish a signed macOS release to GitHub.
#
# Runs release-macos.sh (build + sign + notarize + verify), then tags
# v<version> (read from src-tauri/tauri.conf.json) and creates a GitHub
# draft release with all assets attached and verified before publication:
#
#   Symphony_<version>_<arch>.dmg   the versioned artifact
#   Symphony.dmg                    stable name, so the README's
#                                   releases/latest/download/Symphony.dmg
#                                   link always serves the newest build
#   Symphony.app.tar.gz             updater bundle
#   Symphony.app.tar.gz.sig         updater signature
#   latest.json                     updater feed metadata
#
# Requires an authenticated GitHub CLI (`gh`) with push access.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
if [[ "$HOST_OS" != "Darwin" || "$HOST_ARCH" != "arm64" ]]; then
  echo "error: updater releases must be built on Apple Silicon macOS (found $HOST_OS/$HOST_ARCH)" >&2
  exit 1
fi

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
TAG="v$VERSION"
RELEASE_REPOSITORY="$(node -p "require('./scripts/contracts/release.json').repository")"
REPO_URL="$(gh repo view --json url -q .url)"
REPO_SLUG="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
if [[ "$REPO_SLUG" != "$RELEASE_REPOSITORY" ]]; then
  echo "error: current repository $REPO_SLUG does not match release contract $RELEASE_REPOSITORY" >&2
  exit 1
fi

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
git fetch origin main --tags
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "error: HEAD does not match origin/main — push or pull first" >&2
  exit 1
fi
COMMIT="$(git rev-parse HEAD)"

# gh release create reuses an existing tag instead of tagging the verified
# commit, so a stale v<version> tag (failed publish, manual push) must not
# slip through unless it already points at HEAD.
if git rev-parse -q --verify "refs/tags/$TAG^{commit}" >/dev/null; then
  if [[ "$(git rev-parse "refs/tags/$TAG^{commit}")" != "$COMMIT" ]]; then
    echo "error: tag $TAG already exists and does not point at HEAD — bump the version or delete the tag" >&2
    exit 1
  fi
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
if [[ "$(basename "$DMG")" != "Symphony_${VERSION}_aarch64.dmg" ]]; then
  echo "error: updater feed targets darwin-aarch64, but the built DMG is $(basename "$DMG")" >&2
  exit 1
fi
UPDATER_BUNDLE="$ROOT/target/release/bundle/macos/Symphony.app.tar.gz"
UPDATER_SIGNATURE="$UPDATER_BUNDLE.sig"
if [[ ! -s "$UPDATER_BUNDLE" || ! -s "$UPDATER_SIGNATURE" ]]; then
  echo "error: signed updater artifacts are missing" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$DMG" "$STAGE/Symphony.dmg"
UPDATER_URL="https://github.com/$REPO_SLUG/releases/download/$TAG/Symphony.app.tar.gz"
SIGNATURE="$(<"$UPDATER_SIGNATURE")"
VERSION="$VERSION" UPDATER_URL="$UPDATER_URL" SIGNATURE="$SIGNATURE" \
  node -e '
    const feed = {
      version: process.env.VERSION,
      platforms: {
        "darwin-aarch64": {
          url: process.env.UPDATER_URL,
          signature: process.env.SIGNATURE,
        },
      },
    };
    process.stdout.write(`${JSON.stringify(feed, null, 2)}\n`);
  ' > "$STAGE/latest.json"
node -e '
  const fs = require("node:fs");
  const feed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const platform = feed.platforms?.["darwin-aarch64"];
  if (!feed.version || !platform?.url || !platform?.signature) process.exit(1);
' "$STAGE/latest.json"

echo
echo "── creating draft GitHub release $TAG ──"
# Keep the release out of /releases/latest until every updater asset has been
# uploaded and verified. --target pins the tag to the commit that was built.
gh release create "$TAG" \
  --target "$COMMIT" \
  --title "Symphony $TAG" \
  --generate-notes \
  --draft \
  "$DMG" \
  "$STAGE/Symphony.dmg" \
  "$UPDATER_BUNDLE" \
  "$UPDATER_SIGNATURE" \
  "$STAGE/latest.json"

for asset in \
  "$(basename "$DMG")" \
  Symphony.dmg \
  Symphony.app.tar.gz \
  Symphony.app.tar.gz.sig \
  latest.json; do
  if ! gh release view "$TAG" --json assets --jq '.assets[].name' | grep -qxF "$asset"; then
    echo "error: draft release is missing $asset; leaving $TAG as a draft" >&2
    exit 1
  fi
done

echo
echo "── publishing verified release $TAG ──"
gh release edit "$TAG" --draft=false

echo
echo "Published: $REPO_URL/releases/tag/$TAG"
echo "Stable download: $REPO_URL/releases/latest/download/Symphony.dmg"
echo "Updater feed: $REPO_URL/releases/latest/download/latest.json"
