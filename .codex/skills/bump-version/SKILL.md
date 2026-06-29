---
name: bump-version
description: Safely bump repository release versions across manifests and lockfiles. Use when Codex is asked to bump, set, release, or prepare a version for projects with Cargo/Rust workspaces, Tauri apps, package.json/npm/pnpm/yarn metadata, pyproject.toml, or other multi-file version surfaces.
---

# Bump Version

## Objective

Update the project release version consistently while avoiding dependency upgrades, unrelated formatting churn, and broad search-and-replace mistakes.

## Workflow

1. Inspect the repo state first.
   - Run `git status --short`.
   - Locate likely version files with `rg --files -g 'Cargo.toml' -g 'Cargo.lock' -g 'package.json' -g '*lock*' -g 'pyproject.toml' -g 'VERSION' -g '*version*'`.
   - Search for release-version declarations with `rg -n '^version\s*=|"version"\s*:|__version__|VERSION'`.

2. Determine the target version.
   - Use the user-provided target version when present.
   - If the user only says to bump the version, default to the next patch version and say that assumption in an update or final response.
   - If discovered release surfaces disagree and the correct source of truth is not obvious, stop and ask before editing.

3. Identify release surfaces.
   - Prefer explicit project/app/package versions: `Cargo.toml` `[workspace.package]` or `[package]`, Tauri `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, root `package.json`, `pyproject.toml`, standalone `VERSION` files, and release scripts that embed the app version.
   - Include lockfiles only for local package entries or root importer metadata that represent the project version.
   - Do not update dependency versions, checksums, generated build outputs, bundle artifacts, or release tags unless the user explicitly asks.

4. Apply the smallest consistent edit.
   - Use `apply_patch` for hand edits.
   - Avoid blind repo-wide replacement. Exact old-version matches can include dependency versions such as `0.1.65`.
   - For Cargo, update workspace and package manifest versions, then keep `Cargo.lock` local package entries in sync. Running `cargo metadata --locked --no-deps --format-version 1` is a good validation pass.
   - For JavaScript package lockfiles, prefer the repo package manager's lockfile-only command only if it will not upgrade dependencies; inspect the diff afterward.

5. Validate before finishing.
   - Search intended version files for the old version and inspect any remaining hits.
   - Confirm canonical manifests report the target version, for example with `node -p "require('./package.json').version"` and `node -p "require('./src-tauri/tauri.conf.json').version"` when those files exist.
   - Run ecosystem metadata checks that do not build or upgrade dependencies, such as `cargo metadata --locked --no-deps --format-version 1`.
   - Review `git diff --stat` and `git diff` to ensure only version surfaces changed.

6. Report the result.
   - State the old and new versions.
   - List changed files.
   - Mention validation commands run.
   - Call out any remaining old-version hits that were intentionally left alone.
