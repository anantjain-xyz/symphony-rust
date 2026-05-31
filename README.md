# Symphony Rust

Rust/Tauri desktop port of Symphony. This project is initialized separately from
`symphony-ts`; the TypeScript repo is only a behavioral reference.

## Architecture

- `src-tauri/` — Tauri desktop shell, commands, keychain-backed settings, event forwarding.
- `src/` — React/Vite operator dashboard.
- `crates/symphony-core` — shared domain types, workflow parsing, prompt rendering.
- `crates/symphony-storage` — embedded SQLite schema, repository, broadcast event bus.
- `crates/symphony-tracker` — Linear GraphQL client and issue normalization.
- `crates/symphony-agents` — native Rust Codex and Claude process drivers.
- `crates/symphony-worker` — recovery, polling loop, retries, hooks, workspace lifecycle.

## Development

```sh
pnpm install
cargo check --workspace
pnpm typecheck
pnpm test
pnpm tauri dev
```

The app stores its SQLite database, logs, settings, and default workspaces in
the Tauri app data directory. The Linear API key is stored in the OS keychain.

## Packaging

```sh
pnpm tauri build --debug
```

On macOS, the package script runs Tauri builds with `CI=true` so DMG creation
uses Tauri's deterministic `--skip-jenkins` path instead of Finder AppleScript
window decoration, which can time out in non-interactive shells.
