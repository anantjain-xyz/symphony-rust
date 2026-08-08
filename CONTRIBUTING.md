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
pnpm tauri dev  # run the desktop app with hot reload
```

Before pushing or opening a pull request, run the fast local gate:

```sh
pnpm verify:fast
```

CI blocks merges on the broader full gate. To run it locally, first install its
external tools once, then run the profile:

```sh
pnpm setup:validation
pnpm verify:full
```

`scripts/run-validation.mjs` contains the two short, ordered command lists and
prints elapsed time for every command. Validation profiles never install
external tools. CI performs setup explicitly before `pnpm verify:full`.

Run `pnpm format:check` (or `pnpm biome format .`) to verify formatting. Fix
drift with `pnpm biome format --write <file>` or `pnpm biome format --write .`.

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

- Keep PRs focused; run `pnpm verify:fast` before submitting.
- For UI changes, include before/after screenshots (light and dark).
- Significant behavior changes should update the README.
