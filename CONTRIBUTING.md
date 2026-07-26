# Contributing to Symphony

Thanks for your interest in improving Symphony! This guide covers the development workflow; see the [README](README.md) for what the app does and how it's put together.

## Prerequisites

- **Rust** (stable) — `rustup` recommended
- **Node.js** ≥ 20 and **pnpm**
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Optional, for end-to-end runs: the `codex` and/or `claude` CLIs, authenticated

## Development

```sh
pnpm install
pnpm install:hygiene-tools  # pinned actionlint + ShellCheck binaries
pnpm tauri dev        # run the desktop app with hot reload
```

Useful checks (CI runs all of these):

```sh
cargo check --workspace   # Rust workspace
cargo test --workspace    # Rust tests
pnpm typecheck            # TypeScript
pnpm test                 # frontend unit tests (vitest)
pnpm check:hygiene        # formatting, lint, workflows, shell, and Markdown links
pnpm test:hygiene         # focused tests for the hygiene tooling
```

The external hygiene tools are installed in `.cache/hygiene-tools` from exact,
checksum-verified GitHub release assets for macOS or Linux on arm64/x64.

Biome formatting is adopted incrementally. Existing unformatted files are
hash-pinned in `scripts/biome-format-baseline.json`; format any file you change
with `pnpm biome format --write <file>` and remove its stale baseline entry.

### TypeScript bindings

`src/bindings.ts` is regenerated from the Rust Specta types every time the app starts in dev mode (`export_bindings` in `src-tauri/src/lib.rs`). If you change a type that crosses the IPC boundary, run `pnpm tauri dev` once — or mirror the change by hand — and commit the result.

### App data during development

The dev app uses the same OS keychain entry and app data directory as a packaged build (`~/Library/Application Support/xyz.anantjain.symphony` on macOS). Settings → the storage footnote shows the exact paths, with buttons to reveal the database and logs.

## Packaging

```sh
pnpm tauri build --debug
```

On macOS, the package script runs Tauri builds with `CI=true` so DMG creation uses Tauri's deterministic `--skip-jenkins` path instead of Finder AppleScript window decoration, which can time out in non-interactive shells.

For signed, notarized release builds (`pnpm release:mac`), see [Building](README.md#building) in the README.

## Pull requests

- Keep PRs focused; run the checks above before submitting.
- For UI changes, include before/after screenshots (light and dark).
- Significant behavior changes should update the README.
