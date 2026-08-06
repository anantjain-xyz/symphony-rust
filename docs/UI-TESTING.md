# UI testing

Symphony has two materially different UI runtimes:

1. the browser preview served by Vite; and
2. the native Tauri desktop application.

They share React code but do not prove the same behavior. This document defines
which runtime to use, what current automation covers, and what evidence a UI
change should include.

## Status

**Current behavior** describes the checked-in test setup. **Proposed
invariants** are review requirements. Browser end-to-end tests do not currently
exercise Rust commands, SQLite, the keychain, updater installation, or native
window behavior.

## Runtime boundary

### Browser preview: current behavior

[`App.tsx`](../src/App.tsx) detects whether it is running inside Tauri. Outside
Tauri it dynamically loads [`preview/runtime.ts`](../src/preview/runtime.ts).
That runtime supplies fixture-backed dashboard data and local simulations for
selected interactions.

Browser preview is useful for:

- rendering and layout;
- navigation and selected-item UI;
- loading, empty, error, and populated component states represented by the
  preview;
- responsive behavior;
- light/dark theme bootstrapping;
- lazy loading and chunk-failure UX;
- interactions implemented by the preview runtime.

Browser preview does **not** exercise:

- Tauri `invoke` serialization or command registration;
- Rust handler behavior;
- SQLite opening, migrations, durability, or event delivery;
- the operating-system keychain;
- filesystem paths and opener permissions;
- real worker or agent processes;
- application menus, window lifecycle, or packaged assets;
- updater download, signature verification, installation, or process restart.

Some preview actions are simulated and some native-only actions are unavailable.
A successful browser test therefore proves only the browser contract it
actually observes.

### Native Tauri: current behavior

`pnpm tauri dev` starts the React frontend inside the desktop shell and uses
real Rust commands, storage, keychain, plugins, and worker integration. In a
debug build, startup also runs the Specta binding export described in
[`IPC-CONTRACT.md`](IPC-CONTRACT.md).

The development app uses the same macOS app-data directory and keychain entry as
a packaged build. Testing destructive storage or credential behavior in
`tauri dev` can therefore affect real local development data.

`pnpm tauri build --debug` validates desktop packaging more closely than
browser preview. Signed, notarized, and updater behavior requires the release
path in [`RELEASE-CHECKLIST.md`](RELEASE-CHECKLIST.md).

### Proposed invariant

Choose the least expensive runtime that can observe the contract being changed,
but never claim browser preview as proof of a native boundary:

| Change | Minimum evidence |
| --- | --- |
| Pure formatter, reducer, coordinator, or state machine | Vitest unit test |
| React rendering, keyboard/mouse interaction, theme, responsive layout, lazy chunk | Vitest component test and/or Playwright browser test |
| Tauri command name, arguments, result, or event payload | Rust test plus native Tauri verification |
| SQLite, migration, app-data path, keychain, opener, menu, window, worker process | Native Tauri or targeted Rust integration verification |
| Bundling, signing, notarization, updater feed, install, relaunch | Packaged release verification |

If a change spans rows in the table, test every boundary it crosses.

## Unit and component tests

### Current behavior

Vitest defaults to its Node environment. Component and DOM test files opt into
jsdom with per-file environment directives. Together the suites cover the main
application, updater UI, chunk boundaries, views, formatting, theme bootstrap,
and async controllers. Tauri modules and listeners are mocked in component
tests where browser JavaScript needs to exercise a caller.

[`main.tsx`](../src/main.tsx) enables React Strict Mode. Existing async tests
cover out-of-order resolution, disposal, and late work in the dashboard refresh,
polling, and settings-validation controllers.

### Proposed invariant

Prefer deterministic control of promises, clocks, and listener registration.
Do not add real sleeps to prove a race.

For async UI code, test:

- older success after newer success;
- older failure after newer success;
- unmount while registration or work is pending;
- Strict Mode mount/cleanup/remount;
- selection or visibility change in flight;
- usable prior data after refresh failure;
- exact settlement of an explicit Save or Retry action.

For components, assert semantic state before taking a screenshot: accessible
role/name, selected state, enabled state, status text, focus, or visible data.
A screenshot alone is weak proof because it does not explain what the test
expected.

See [`FRONTEND-ASYNC-INVARIANTS.md`](FRONTEND-ASYNC-INVARIANTS.md) for the
authority rules these tests must protect.

## Playwright browser tests

### Current behavior

[`playwright.config.ts`](../playwright.config.ts):

- serves an existing frontend build with Vite preview at `127.0.0.1:4173`;
- runs Chromium with desktop Chrome defaults;
- runs test files in parallel;
- retries twice in CI and not locally;
- retains traces on failure;
- reuses an existing preview server locally, but not in CI.

The checked-in suites are:

- [`theme-first-frame.e2e.ts`](../e2e/theme-first-frame.e2e.ts), covering
  pre-React theme application and light/dark captures;
- [`lazy-chunks.e2e.ts`](../e2e/lazy-chunks.e2e.ts), covering preview startup,
  cold loading, preloading, chunk relationships, key views, responsive states,
  hover behavior, and chunk failure.

CI builds the frontend once, installs Chromium in a separate setup step, runs
Playwright, and uploads PNGs under
`test-results/**/*.png`. The artifact is currently named
`theme-e2e-screenshots`, although it may contain captures from both suites.

Run locally:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

Use the CI form on a Linux machine that needs browser system dependencies:

```sh
pnpm exec playwright install --with-deps chromium
```

### Proposed invariant

Add Playwright coverage when a regression depends on a real browser: CSS
layout, theme first frame, viewport behavior, chunk loading, or browser event
ordering. Keep business logic in fast unit tests and use Playwright for the
smallest observable browser flow.

Each end-to-end test should:

1. enter the state through a user-visible route or controlled fixture;
2. wait on a semantic condition, not an arbitrary timeout;
3. assert the important state;
4. capture a screenshot only when visual evidence adds value;
5. write artifacts through Playwright's test output so CI collects them;
6. avoid depending on execution order or a reused local server's prior state.

The current project has one Chromium desktop configuration. A change that
claims mobile, other-engine, reduced-motion, or platform-specific support needs
explicit additional coverage or clearly labeled manual evidence.

## Native verification

### Current behavior

CI runs on Ubuntu and deliberately excludes the `symphony-desktop` crate from
Clippy and Rust tests to avoid WebKit system dependencies. Browser Playwright
tests then exercise preview mode. There is no automated native Tauri UI suite in
the current workflow.

### Proposed invariant

For native behavior, record:

- the exact command and build mode;
- operating system and architecture;
- whether development or copied test app data was used;
- the command/event path exercised;
- expected and observed state;
- relevant logs with secrets removed;
- a screenshot or short capture when visual behavior is part of the claim.

Before testing storage or credentials, back up app data or use a deliberately
isolated test configuration. Do not use a production signing identity or
updater key for ordinary UI iteration.

At minimum, an IPC-affecting change should start `pnpm tauri dev`, invoke the
changed path successfully, exercise its failure state, and verify that cleanup
or restart does not leave duplicate listeners or worker activity. Packaging
changes also require `pnpm tauri build --debug`.

## Visual proof for pull requests

### Current behavior

[`CONTRIBUTING.md`](../CONTRIBUTING.md) asks UI pull requests for before/after
screenshots in light and dark modes. CI preserves Playwright PNG output even
when a test fails.

### Proposed invariant

Visual proof should make the changed contract reviewable:

- use the same viewport and data state for before/after;
- include light and dark mode when shared colors or surfaces change;
- include the narrow/mobile layout when responsiveness changes;
- capture relevant loading, empty, error, disabled, hover, focus, or selected
  states;
- identify browser preview versus native Tauri in the caption;
- avoid secrets, API keys, local paths, private issue text, or unrelated user
  data.

Do not substitute a mocked preview screenshot for a native claim. Conversely,
do not require a signed release build for a pure CSS change that Playwright can
fully observe.

## Full local gate

For a frontend or UI pull request, run the current CI-equivalent frontend gate:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm check:bundle
pnpm test:bundle
pnpm test:e2e
```

Also run the Rust checks when the change crosses into desktop or storage code:

```sh
cargo fmt --all --check
cargo clippy --workspace --exclude symphony-desktop --all-targets -- -D warnings
cargo test --workspace --exclude symphony-desktop
```

These exclusions are a declared coverage boundary, not proof that
`symphony-desktop` compiles or behaves correctly on the target platform.

## Review checklist

- [ ] The selected runtime can observe the behavior being claimed.
- [ ] Async tests control out-of-order and cleanup paths deterministically.
- [ ] Semantic assertions explain the expected state.
- [ ] Browser-only and native-only evidence are labeled.
- [ ] Visual captures cover affected themes, viewports, and states.
- [ ] Sensitive local data is absent from artifacts.
- [ ] CI-equivalent checks pass.
- [ ] Native verification is included for IPC, storage, plugin, worker, or
      packaging changes.
