# Release checklist

This checklist covers Symphony's current macOS release path: versioning,
building, code signing, notarization, updater signing, GitHub publication, and
recovery from partial failures.

## Status and release shape

**Current behavior** describes checked-in scripts and configuration.
**Proposed invariants** are release rules. Version equality across checked-in
surfaces is enforced by `pnpm check:release` (also part of `pnpm check:static`
and the validation profiles).

The supported publish script produces an Apple Silicon macOS release and an
updater feed for `darwin-aarch64`. It must run on Apple Silicon macOS from a
clean `main` commit that exactly matches `origin/main`.

Microsoft Store packaging is not supported. Standard Windows bundles continue
to use `icons/icon.ico` from the Tauri bundle icon list; Store-specific logo
assets are not kept in the repository.

## Version surfaces

### Current behavior

One release version is duplicated across these checked-in surfaces:

| Surface | Meaning |
| --- | --- |
| [`Cargo.toml`](../Cargo.toml) `[workspace.package].version` | Version inherited by `symphony-agents`, `symphony-core`, `symphony-storage`, `symphony-tracker`, and `symphony-worker` |
| [`src-tauri/Cargo.toml`](../src-tauri/Cargo.toml) `package.version` | Desktop crate version; currently explicit rather than inherited |
| [`package.json`](../package.json) `version` | Frontend/package metadata |
| [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json) `version` | Tauri bundle version and the version read by the publish script |
| [`Cargo.lock`](../Cargo.lock) local package entries | Generated lockfile copies of every Rust package version |

`pnpm-lock.yaml` does not currently duplicate the root package version.
[`bump-version`](../.codex/skills/bump-version/SKILL.md) documents the
repository's assisted bump workflow, but using that skill is not a CI check.

The release tag, title, artifact filenames, and updater-feed version are derived
from `src-tauri/tauri.conf.json` at publish time.

### Proposed invariant

All checked-in version surfaces must change in one release-preparation commit.
Do not hand-edit only the Tauri version to make a tag, or only the Cargo
workspace version to make crates compile.

After a bump:

1. inspect the diff for unrelated dependency changes;
2. ensure every local `symphony-*` package in `Cargo.lock` has the new version;
3. ensure `package.json`, both Cargo manifests, and Tauri config agree;
4. run Cargo metadata with the lockfile enforced;
5. choose a version whose `v<version>` tag and GitHub release do not already
   represent a different commit.

[`scripts/check-release.mjs`](../scripts/check-release.mjs) (`pnpm check:release`)
reads structured JSON/TOML/lockfile data and compares these surfaces. Run it
locally and in CI before treating a bump as release-ready.

## Release identities and secrets

### Current behavior

The application identity is `xyz.anantjain.symphony`. The release uses two
independent trust chains:

1. **Apple application signing and notarization**, proving the `.app` and DMG
   to macOS.
2. **Tauri updater signing**, proving `Symphony.app.tar.gz` to already-installed
   Symphony applications.

[`scripts/release-macos.sh`](../scripts/release-macos.sh) loads a credential
file from `~/.symphony-release.env`, overridable with
`SYMPHONY_RELEASE_ENV`. It requires:

- `APPLE_SIGNING_IDENTITY`;
- `APPLE_API_ISSUER`;
- `APPLE_API_KEY`;
- `APPLE_API_KEY_PATH`.

The Apple signing identity must exist in the login keychain and the App Store
Connect `.p8` key file must exist at the configured path.

Updater signing uses either `TAURI_SIGNING_PRIVATE_KEY` or
`TAURI_SIGNING_PRIVATE_KEY_PATH`. The path defaults to
`~/.tauri/symphony.key`. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional.
The matching public key is embedded in
[`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json).

The private updater key, its password, Apple credentials, and `.p8` file must
remain outside the repository and release artifacts.

### Proposed invariant

- Back up the updater private key and password in an access-controlled recovery
  system before relying on auto-update.
- Never rotate the embedded public key without a transition plan for installed
  versions. Losing the matching private key prevents those versions from
  trusting future updater bundles.
- Use least-privilege GitHub credentials capable of pushing the release tag and
  creating the release.
- Inspect logs before sharing them; credential paths and tool output can contain
  sensitive information.
- Do not use release credentials for routine UI or debug-build testing.

## Updater configuration

### Current behavior

[`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json) points the updater
to:

```text
https://github.com/anantjain-xyz/symphony-rust/releases/latest/download/latest.json
```

[`src-tauri/tauri.updater.conf.json`](../src-tauri/tauri.updater.conf.json)
enables updater artifact creation for release builds.
[`src-tauri/capabilities/default.json`](../src-tauri/capabilities/default.json)
allows the main window to check, download, and install updates and to restart
the process.

[`AppUpdate.tsx`](../src/AppUpdate.tsx) checks immediately and every six hours.
It does not download until the user asks. Before installation it checks for:

- active runs;
- in-progress background work, including retro batches;
- unsaved settings;
- transient application work.

The UI rechecks safety before install and asks again if unsafe work changed.
When the worker is not already stopped, it stops the worker and waits up to 30
seconds for worker shutdown and active runs to clear. If installation fails, it
restores the worker and keeps the update available. If installation succeeds
but relaunch fails, it offers a restart path without reinstalling the update.

### Proposed invariant

The updater public key, generated signature, updater bundle, feed URL, feed
version, platform key, and release tag are one contract. Publish them from the
same verified build. Never assemble `latest.json` from artifacts produced by
different commits or signing keys.

Keep the GitHub release as a draft until all updater assets are present and
verified. Publishing is the operation that makes the release eligible for the
`releases/latest` endpoint.

## Preflight checklist

- [ ] Release notes and user-visible migration/recovery notes are ready.
- [ ] The intended version is consistent across all version surfaces.
- [ ] The worktree is clean on `main`.
- [ ] `HEAD` equals `origin/main` after fetching `main` and tags.
- [ ] The current GitHub repository equals the repository in
      `scripts/contracts/release.json`.
- [ ] No conflicting `v<version>` tag or GitHub release exists.
- [ ] The host is Apple Silicon macOS.
- [ ] Node, pnpm, stable Rust, Xcode command-line tools, and authenticated `gh`
      are available.
- [ ] The Apple signing identity is present in the keychain.
- [ ] Apple notarization variables and the `.p8` path are valid.
- [ ] The updater private key and optional password are available.
- [ ] The updater private key has a tested backup.

Validate version data without relying on a text-only search:

```sh
node -e 'const p=require("./package.json"); const t=require("./src-tauri/tauri.conf.json"); console.log({package:p.version,tauri:t.version})'
cargo metadata --locked --no-deps --format-version 1
```

Inspect the workspace, desktop manifest, and local `Cargo.lock` package entries
as part of that review.

## Validation gate

Before publishing, run the current repository checks:

```sh
pnpm install --frozen-lockfile
cargo fmt --all --check
cargo clippy --workspace --exclude symphony-desktop --all-targets -- -D warnings
cargo test --workspace --exclude symphony-desktop
pnpm typecheck
pnpm test
pnpm build
pnpm check:bundle
pnpm test:bundle
pnpm exec playwright install chromium
pnpm test:e2e
```

Current CI excludes `symphony-desktop`; the release build is the required
desktop compilation and packaging gate. Review migration requirements in
[`STORAGE-AND-MIGRATIONS.md`](STORAGE-AND-MIGRATIONS.md) and UI/runtime coverage
in [`UI-TESTING.md`](UI-TESTING.md).

## Build, sign, notarize, and verify

### Current behavior

For a full publish, run:

```sh
pnpm release:publish
```

This calls [`scripts/publish-macos.sh`](../scripts/publish-macos.sh), which in
turn calls [`scripts/release-macos.sh`](../scripts/release-macos.sh).

The release build uses
`pnpm tauri build --config src-tauri/tauri.updater.conf.json`. On macOS,
[`scripts/tauri.mjs`](../scripts/tauri.mjs) sets `CI=true` for build/bundle
commands unless explicitly overridden, selecting Tauri's deterministic DMG path
instead of Finder automation.

After building, `release-macos.sh` verifies:

- Gatekeeper acceptance with `spctl`;
- the notarization staple with `xcrun stapler validate`;
- presence of `Symphony.app.tar.gz` and its `.sig`;
- the updater signature against the public key embedded in Tauri config, using
  the `verify-updater-signature` Rust example.

The expected build outputs are:

- a versioned `Symphony_<version>_aarch64.dmg`;
- `Symphony.app.tar.gz`;
- `Symphony.app.tar.gz.sig`.

### Proposed invariant

Do not continue to publication after any signing, notarization, stapling, or
updater-signature check fails. The fact that a DMG exists is not proof that it
is distributable or update-compatible.

Retain the build log and artifact checksums for the release record without
publishing secrets.

## GitHub publication

### Current behavior

`publish-macos.sh` verifies the configured GitHub repository, branch, clean
state, fetched commit, tag, and release before building. It requires exactly
one versioned aarch64 DMG.

It then prepares:

- the versioned DMG;
- `Symphony.dmg`, a stable-name copy;
- `Symphony.app.tar.gz`;
- `Symphony.app.tar.gz.sig`;
- `latest.json` with a `darwin-aarch64` URL and signature.

The script creates a draft GitHub release targeted at the exact built commit.
It verifies all five asset names through GitHub before changing the release from
draft to published. The resulting tag is `v<version>`.

### Publication checklist

- [ ] The draft targets the exact commit that was built.
- [ ] The versioned DMG name ends in `_aarch64.dmg`.
- [ ] `Symphony.dmg` and the versioned DMG are the same build.
- [ ] The updater bundle and `.sig` are non-empty.
- [ ] The signature verifies against the embedded public key.
- [ ] `latest.json.version` equals the Tauri version and the tag's version
      without its leading `v`.
- [ ] `latest.json` uses `darwin-aarch64`.
- [ ] Its URL points to this tag's `Symphony.app.tar.gz`.
- [ ] All five assets are present before the draft is published.
- [ ] After publication, the stable DMG and updater-feed URLs resolve.
- [ ] An installed prior build can check, download, install, and restart safely.

## Recovery from failure

### Build, signing, or notarization fails

No release has been created because publication happens after the verified
build. Fix credentials, certificate/keychain state, source, or Apple service
failure; clean only known generated build outputs if necessary; then rerun from
a clean, synchronized `main`.

Do not weaken or skip `spctl`, stapler, or updater-signature verification to
force publication.

### The version tag already exists

Determine whether the local and remote tag point at the exact intended release
commit. If it points elsewhere, prefer bumping the version. Delete a tag only
after confirming it belongs to a failed, unpublished attempt and coordinating
with anyone who could have fetched it. Never silently move a published release
tag.

### A GitHub release already exists

Inspect it before acting. If it is a published release, bump the version. If it
is an incomplete draft from this exact commit and artifact set, verify every
asset and signature before resuming. Do not create a second release with mixed
or partially replaced artifacts.

### Draft creation succeeds but asset verification fails

The script deliberately leaves the release as a draft. Keep it private from the
`latest` endpoint while investigating.

Either:

1. upload the missing correct artifact from the same verified build, recheck all
   assets and feed contents, then publish; or
2. delete the failed draft and its unpublished tag after verifying their scope,
   then rerun the complete publish from a clean commit.

Do not publish a draft merely because the human-facing DMG is present; updater
clients also require the tarball, signature, and valid feed.

### The updater feed or signature is bad after publication

Existing installations should continue running, but update checks cannot
complete safely. Stop promoting the release. Compare the published
`latest.json`, tag, tarball, signature, embedded public key, and local verified
artifacts. Repair the GitHub assets only with a coherent set from the same
commit, or publish a new version.

Do not point `releases/latest` at an unsigned bundle and do not reuse a signature
for different bytes.

### Installation fails in the app

The current UI attempts to restore the worker and leaves the downloaded update
available. Confirm the worker and active runs are safe, collect redacted logs,
then retry the Update action.

If installation succeeded but relaunch failed, use the offered Restart action.
If restart still fails, quit and reopen Symphony manually before attempting a
new download; do not repeatedly reinstall the same candidate.

## Post-release checks

- [ ] GitHub shows the expected published tag and exact target commit.
- [ ] All five assets have plausible non-zero sizes.
- [ ] The stable DMG download works on a clean machine.
- [ ] Gatekeeper accepts the installed application.
- [ ] The application reports the intended version.
- [ ] A prior supported version sees the update.
- [ ] Unsafe active work triggers confirmation.
- [ ] The worker stops before install and the app relaunches.
- [ ] Settings, database contents, and keychain-backed credentials survive.
- [ ] Logs contain no signing or updater secrets.
- [ ] Any schema upgrade passes the integrity checks in
      [`STORAGE-AND-MIGRATIONS.md`](STORAGE-AND-MIGRATIONS.md).
