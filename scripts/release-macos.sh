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

for var in APPLE_SIGNING_IDENTITY APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH; do
  value="${!var:-}"
  if [[ -z "$value" || "$value" == *"<"* ]]; then
    echo "error: $var is not filled in ($ENV_FILE)" >&2
    exit 1
  fi
done

if [[ ! -f "$APPLE_API_KEY_PATH" ]]; then
  echo "error: API key file not found: $APPLE_API_KEY_PATH" >&2
  exit 1
fi

if ! security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY"; then
  echo "error: signing identity not in keychain: $APPLE_SIGNING_IDENTITY" >&2
  exit 1
fi

cd "$ROOT"
pnpm tauri build

APP="$ROOT/target/release/bundle/macos/Symphony.app"
echo
echo "── verifying signature and notarization ──"
spctl -a -vv -t exec "$APP"
xcrun stapler validate "$APP"

echo
echo "── artifacts ──"
ls -lh "$ROOT"/target/release/bundle/dmg/*.dmg
