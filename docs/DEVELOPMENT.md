# Development

The authoritative setup and validation sources are `Cargo.toml`, `package.json`,
`vite.config.ts`, `playwright.config.ts`, `src-tauri/tauri.conf.json`, and
`.github/workflows/ci.yml`. This guide describes their current contracts.

## Prerequisites and install

- Rust stable. Install the `rustfmt` and `clippy` components for the full gate.
- Node.js `^20.19.0 || >=22.12.0`, matching Vite's supported engine range.
  CI currently uses Node.js 22.
- pnpm 11.5.2, pinned by the `packageManager` field in `package.json`.
- On macOS, Xcode Command Line Tools for the Tauri desktop build.
- Chromium from Playwright for browser end-to-end tests.

From a new checkout:

```sh
pnpm install
pnpm exec playwright install chromium
```

CI uses `pnpm install --frozen-lockfile` and installs Chromium with Linux system
dependencies via `pnpm exec playwright install --with-deps chromium`.

## Run the app

For the desktop application with frontend hot reload:

```sh
pnpm tauri dev
```

This is the complete local runtime: it compiles `symphony-desktop`, starts Vite,
opens the Tauri window, initializes SQLite and the keychain-backed settings
layer, and regenerates debug IPC bindings.

For the browser-only deterministic preview:

```sh
pnpm dev
```

The browser preview exercises the React shell and `src/preview/` fixtures. It
does not provide live Tauri commands, the worker, SQLite, or keychain access.

### Ports

| Process | Current port | Source |
| --- | --- | --- |
| Vite development server | `1420` | `vite.config.ts`; Tauri's `devUrl` is `http://localhost:1420` |
| Remote-host HMR websocket | `1421` | Used when `TAURI_DEV_HOST` is set |
| Vite preview used by Playwright | `4173` | `playwright.config.ts` |

`PORT` overrides Vite's `1420` default, which is useful for a second
browser-only preview:

```sh
PORT=1422 pnpm dev
```

It does not update Tauri's fixed `devUrl`, so use the default port for
`pnpm tauri dev` unless the corresponding Tauri configuration is changed too.

## Rust packages and focused tests

| Path | Cargo package | Owns |
| --- | --- | --- |
| `crates/symphony-core` | `symphony-core` | Domain types, routing, prompts, workflow parsing |
| `crates/symphony-tracker` | `symphony-tracker` | Linear client and normalization |
| `crates/symphony-agents` | `symphony-agents` | Agent CLI drivers and event mapping |
| `crates/symphony-storage` | `symphony-storage` | SQLite migrations, queries, rows, storage events |
| `crates/symphony-worker` | `symphony-worker` | Polling, dispatch, retries, hooks, workspaces, repo workflows, skills |
| `src-tauri` | `symphony-desktop` | Tauri composition, commands, settings/keychain, retros |

Run one package:

```sh
cargo test -p symphony-core
cargo test -p symphony-worker
```

Add a substring after the package selector to run one Rust test or related
group:

```sh
cargo test -p symphony-core renders_basic_issue_fields
cargo test -p symphony-storage failed_migrations_roll_back_atomically
```

The Linux CI gate excludes `symphony-desktop` from Clippy and tests because the
Tauri shell requires WebKit system packages there. Run desktop Rust tests on a
configured local platform with:

```sh
cargo test -p symphony-desktop
```

## Frontend tests

The frontend package name is `symphony-rust`. `pnpm test` runs the complete
Vitest suite once. For a file or named test, invoke Vitest directly:

```sh
pnpm exec vitest run src/format.test.ts
pnpm exec vitest run src/App.test.tsx -t "saves successfully under StrictMode effect remounts"
```

Run TypeScript checking separately because Vitest and Vite do not replace it:

```sh
pnpm typecheck
```

## IPC bindings

Rust types crossing the desktop/frontend boundary derive Specta `Type` and are
listed in `export_bindings` in `src-tauri/src/lib.rs`. Debug desktop startup
rewrites `src/bindings.ts`.

After changing an exported Rust type:

1. Update its Rust definition and the export list if it is a new type.
2. Run `pnpm tauri dev` and wait for the desktop to finish startup.
3. Inspect and commit the generated `src/bindings.ts` diff.
4. Update string-based frontend `invoke` calls and run `pnpm typecheck`.

Do not treat a manual edit to `src/bindings.ts` as the source of truth; the next
debug startup can replace it.

## Playwright

`pnpm test:e2e` runs `playwright test`. The checked-in configuration:

- discovers `e2e/**/*.e2e.ts`;
- builds the frontend, then serves `pnpm preview` at
  `http://127.0.0.1:4173`;
- uses the Desktop Chrome profile against the browser preview;
- runs fully parallel, with two retries only in CI;
- retains traces on failure and writes screenshots/artifacts under
  `test-results/`.

Run all or one file:

```sh
pnpm test:e2e
pnpm exec playwright test e2e/theme-first-frame.e2e.ts
pnpm exec playwright test --grep "theme toggle"
```

These tests validate the production frontend bundle and preview fixtures, not a
native Tauri window.

## Parallel work with Git worktrees

Worktrees keep each task on its own branch and index while sharing the
repository's Git object database. Create one from an up-to-date remote base:

```sh
git fetch origin
git worktree add -b <branch> ../symphony-rust-<topic> origin/main
cd ../symphony-rust-<topic>
pnpm install
```

Each worktree has its own ignored `node_modules`, `dist`, `target`, and test
artifacts, so install dependencies and run validation inside that worktree.
Use `git worktree list` before acting when several tasks are open; a branch can
be checked out in only one worktree.

Only one default `pnpm tauri dev` can own port `1420`. Use a distinct `PORT`
for additional browser-only `pnpm dev` sessions. Stop processes by their
worktree or port rather than with broad process-name matches.

After a branch is integrated and the worktree is clean, remove it from another
checkout with:

```sh
git worktree remove ../symphony-rust-<topic>
```

## Exact CI gate

The `validate` job in `.github/workflows/ci.yml` runs on Ubuntu with Node.js 22
and Rust stable plus `rustfmt` and `clippy`. After
`pnpm install --frozen-lockfile`, it runs the canonical full validation profile:

```sh
pnpm verify:full
```

`validation/contract.json` owns the ordered commands behind that entrypoint,
including the contract checks that keep CI, documentation, bundled agent
assets, frontend boundaries, build output, bundle inspection, and browser
validation synchronized.

`pnpm check:bundle` reads the Vite manifest and enforces eager JavaScript/CSS,
lazy-view size, and import-boundary budgets.
`pnpm test:bundle` tests the checker and expected chunk topology. Playwright
also verifies lazy-chunk and theme behavior and uploads its screenshots in CI.

During development, start with the smallest package, test file, or E2E file
that owns the behavior. Before submitting a pull request, run the canonical
full gate above.
