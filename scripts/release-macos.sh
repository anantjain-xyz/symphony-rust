#!/usr/bin/env bash
set -euo pipefail

# Build, sign, and notarize the macOS release bundle.
#
# Signing and notarization credentials are read from an env file kept outside
# the repo:
#
#   ~/.symphony-release.env   (override location with SYMPHONY_RELEASE_ENV)
#
# which must define:
#   APPLE_SIGNING_IDENTITY  e.g. "Developer ID Application: Jane Doe (TEAMID1234)",
#                           installed in the login keychain; Tauri signs with it
#   APPLE_API_ISSUER        App Store Connect issuer ID (UUID)
#   APPLE_API_KEY           API key ID, e.g. L3CH8VM55U
#   APPLE_API_KEY_PATH      absolute path to the AuthKey_<id>.p8 file
#
# The updater artifact is signed separately from the Apple bundle. By default
# the Tauri signing key is read from ~/.tauri/symphony.key; override with:
#   TAURI_SIGNING_PRIVATE_KEY_PATH  absolute path to the updater private key
# or TAURI_SIGNING_PRIVATE_KEY       the private key content itself
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  optional key password

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${SYMPHONY_RELEASE_ENV:-$HOME/.symphony-release.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: credentials file not found: $ENV_FILE (see header of this script)" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  TAURI_SIGNING_PRIVATE_KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/symphony.key}"
  if [[ ! -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]]; then
    echo "error: updater signing key not found: $TAURI_SIGNING_PRIVATE_KEY_PATH" >&2
    exit 1
  fi
  # The Tauri bundler accepts either key content or a file path through this
  # variable; normalize the friendlier *_PATH release setting into it.
  export TAURI_SIGNING_PRIVATE_KEY="$TAURI_SIGNING_PRIVATE_KEY_PATH"
fi

for var in APPLE_SIGNING_IDENTITY APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH; do
  value="${!var:-}"
  if [[ -z "$value" || "$value" == *"<"* ]]; then
    echo "error: $var is not filled in ($ENV_FILE)" >&2
    exit 1
  fi
done

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "error: configure TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH" >&2
  exit 1
fi

if [[ ! -f "$APPLE_API_KEY_PATH" ]]; then
  echo "error: API key file not found: $APPLE_API_KEY_PATH" >&2
  exit 1
fi

if ! security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY"; then
  echo "error: signing identity not in keychain: $APPLE_SIGNING_IDENTITY" >&2
  exit 1
fi

cd "$ROOT"
pnpm tauri build --config src-tauri/tauri.updater.conf.json

APP="$ROOT/target/release/bundle/macos/Symphony.app"
UPDATER_BUNDLE="$ROOT/target/release/bundle/macos/Symphony.app.tar.gz"
UPDATER_SIGNATURE="$UPDATER_BUNDLE.sig"
echo
echo "── verifying signature and notarization ──"
spctl -a -vv -t exec "$APP"
xcrun stapler validate "$APP"
if [[ ! -s "$UPDATER_BUNDLE" || ! -s "$UPDATER_SIGNATURE" ]]; then
  echo "error: Tauri did not produce the signed macOS updater artifacts" >&2
  exit 1
fi
cargo run --quiet --manifest-path "$ROOT/src-tauri/Cargo.toml" \
  --example verify-updater-signature -- \
  "$UPDATER_BUNDLE" "$UPDATER_SIGNATURE" "$ROOT/src-tauri/tauri.conf.json"

echo
echo "── artifacts ──"
ls -lh "$ROOT"/target/release/bundle/dmg/*.dmg
ls -lh "$UPDATER_BUNDLE" "$UPDATER_SIGNATURE"
