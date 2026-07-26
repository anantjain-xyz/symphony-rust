# Architecture

This is a navigation map, not an inventory of every module. Start with the row
that matches the change, inspect its direct dependencies, and widen the search
only when a boundary below requires it.

## Just-in-time repository map

| Change area | Start here | Read next when needed |
| --- | --- | --- |
| Domain types, prompt rendering, issue routing | `crates/symphony-core/src/` | Callers in `symphony-worker`, then IPC exports in `src-tauri/src/lib.rs` |
| Linear queries and response normalization | `crates/symphony-tracker/src/lib.rs` | `symphony-core::Issue` and worker polling in `crates/symphony-worker/src/manager.rs` |
| Codex, Claude, Cursor, or opencode process protocols | `crates/symphony-agents/src/lib.rs` | Agent configuration in `symphony-core`, dispatch in `symphony-worker` |
| SQLite schema, queries, run history, or storage events | `crates/symphony-storage/src/` | Consumers in `symphony-worker`, Tauri commands, then dashboard invalidation |
| Polling, routing, retries, hooks, workspaces, repository workflows, or skills | `crates/symphony-worker/src/` | Domain contracts in `symphony-core` and state transitions in `symphony-storage` |
| App startup, settings, keychain, commands, event forwarding, or retros | `src-tauri/src/` | The owning Rust crate, `src/bindings.ts`, and the invoking React code |
| Dashboard shell, refresh coordination, or settings orchestration | `src/App.tsx` and `src/dashboard*.ts` | Feature views in `src/views/`, IPC types in `src/bindings.ts` |
| One visible frontend feature | `src/views/` and its colocated test/CSS | Lazy-loading ownership in `src/App.tsx`; bundle constraints in `scripts/check-bundle-budget.mjs` |
| Browser-level behavior | `e2e/` and `playwright.config.ts` | Preview fixtures in `src/preview/` and the production build graph |
| Packaging, updates, or releases | `src/AppUpdate.tsx`, `src-tauri/tauri.conf.json`, `scripts/` | Version manifests, release workflow, and updater tests |
| CI or build policy | `.github/workflows/ci.yml` and `package.json` | Root `Cargo.toml`, package manifests, and build-check scripts |

## Dependency direction

An arrow means “depends on.” The reusable Rust crates point inward toward
`symphony-core`; the Tauri crate is the composition root.

```text
symphony-tracker ─┐
symphony-agents  ─┼──> symphony-core
symphony-storage ─┘

symphony-worker ─────> symphony-core
       ├─────────────> symphony-tracker
       ├─────────────> symphony-agents
       └─────────────> symphony-storage

symphony-desktop (src-tauri) ──> all Rust crates
React (src) ⇄ symphony-desktop via Tauri commands, events, and Specta types
```

The crate/package names are `symphony-core`, `symphony-tracker`,
`symphony-agents`, `symphony-storage`, `symphony-worker`, and
`symphony-desktop`. The frontend package is `symphony-rust`.

## Ownership and boundaries

### `crates/symphony-core`

Owns serializable domain contracts and deterministic policy: workflow
configuration, issue/repository types, routing, prompt validation/rendering, and
agent-event types. It has no dependency on the tracker, database, process
drivers, worker, Tauri, or React. Put logic here when it can be expressed
without I/O.

### `crates/symphony-tracker`

Owns the `TrackerClient` boundary, Linear GraphQL requests, pagination, viewer
lookups, workpad comments, and conversion of responses into core issue types.
It does not decide repository routes, dispatch agents, or persist runs.

### `crates/symphony-agents`

Owns the `AgentDriver` boundary and the native CLI protocols for Codex, Claude,
Cursor, and opencode: command construction, structured stream parsing,
cancellation, outcomes, token/rate-limit events, and mock drivers. It does not
poll Linear or own retry and workspace policy.

### `crates/symphony-storage`

Owns SQLite setup and numbered migrations, repository queries, durable run and
retro state, and the in-process `EventBus`. SQL and persisted row shapes belong
here. Higher layers consume `Repository`; they should not issue ad hoc SQL.

### `crates/symphony-worker`

Owns orchestration. `WorkerManager` combines tracker, storage, agent, and core
contracts into polling, recovery, routing, concurrency, retries, cancellation,
hooks, workspace lifecycle, repository workflow resolution, and skill
installation. It should not contain desktop UI or keychain behavior.

The main files are deliberately split by operational concern:

- `manager.rs` — worker state, polling, dispatch, recovery, and retries.
- `workspace.rs` — per-issue workspace creation and cleanup.
- `hooks.rs` — lifecycle hook execution and environment.
- `repo_workflow.rs` — workflow discovery, caching, and transfer PRs.
- `skills.rs` — bundled-skill checks, injection, and install PRs.
- `backoff.rs` — retry delay policy.

### `src-tauri`

The `symphony-desktop` package is the composition and OS boundary.
`src-tauri/src/lib.rs` opens storage, constructs managers, registers Tauri
commands, forwards storage events, initializes logging, and exports debug
Specta bindings. `settings.rs` owns settings serialization/defaults and their
translation into core workflow configuration; secrets are read through the OS
keychain. `retro.rs` owns the desktop-hosted retro generation and reviewed
change-batch flow.

Reusable domain or orchestration behavior should stay in a crate rather than
growing the command layer.

### `src`

React owns presentation and client-side interaction state. `App.tsx` is the
shell and IPC coordinator: it bootstraps dashboard resources, invokes Tauri
commands, listens for `db_changed`, `agent_event`, and `rate_limit_changed`, and
lazy-loads feature views. `dashboardResources.ts`,
`dashboardResourceState.ts`, and `dashboardRefreshCoordinator.ts` define which
signals invalidate which reads and how concurrent refreshes settle.

Feature rendering belongs in `src/views/`. Browser-only preview data belongs in
`src/preview/`; it is a deterministic substitute when Tauri is unavailable, not
a second backend.

`src/bindings.ts` is reproducible generated IPC output. The Tauri-free
`symphony-contracts` crate owns the shared DTOs and explicit export catalog;
`pnpm generate:bindings` rewrites the file, while `pnpm check:bindings`
regenerates it in a temporary directory and rejects drift.

## Runtime flows

### Startup and dashboard reads

1. Tauri repairs the GUI process `PATH`, creates the app-data directory, opens
   and migrates SQLite, and constructs `Repository`, `WorkerManager`, and the
   long-running install/retro managers.
2. The desktop registers commands and forwards storage-bus messages as Tauri
   events. Binding generation is an explicit development/CI step, not a
   startup side effect.
3. React loads settings and an initial dashboard snapshot through commands.
   Later storage events mark the affected resource keys dirty and schedule
   selective refreshes.

### Issue dispatch

1. `symphony-tracker` fetches and normalizes active Linear issues.
2. `symphony-core` selects a configured repository.
3. `symphony-worker` prepares the issue workspace, runs hooks, resolves the
   repository workflow, renders the prompt, and starts the selected agent
   driver.
4. `symphony-agents` maps the child process stream into core agent events.
5. `symphony-storage` records issue, run, retry, token, rate-limit, and event
   state. Its event bus wakes the desktop, which notifies React.

### Settings and secrets

Application settings are stored as JSON under the app-data directory. The Linear
API key is stored separately in the OS keychain. The Tauri layer builds runtime
configuration and environment maps. Repository install and workflow-transfer
agents start with the repaired `PATH`. For `github.com` and
`ghe.com`/`*.ghe.com` repositories, they also allowlist the host process
credentials `GH_TOKEN` and `GITHUB_TOKEN`; `GH_ENTERPRISE_TOKEN` and
`GITHUB_ENTERPRISE_TOKEN` are not forwarded. Explicit session variables are
applied last and therefore override `PATH` and host credentials. If the session
environment provides either nonblank allowlisted token, both host/base token
candidates are suppressed before the session values are applied. These agents
do not receive the keychain-derived Linear key. Issue agents receive their
configured session and runtime variables.

## Change-impact map

| If you change… | Inspect and update… | Minimum focused evidence |
| --- | --- | --- |
| A core config or issue field | Core type/defaults and policy; settings parsing; worker consumers; Specta export and `src/bindings.ts`; affected UI | Core tests, owning crate tests, targeted frontend test, typecheck |
| A persisted field or state transition | Next storage migration; row/query methods; event emission; worker/command consumers; IPC types | Storage migration/repository tests plus consumer tests |
| Linear filters or issue data | Tracker query/decoding; core `TrackerConfig`/`Issue`; routing or settings; fixtures | Tracker tests and core routing/prompt tests |
| An agent backend or event | Core config/event contracts; agent driver; worker request mapping; settings validation/UI; persisted event display | Agent parser/command tests, worker tests, frontend event-format tests |
| Dispatch, retry, hooks, or workspace behavior | The owning worker module; storage transitions/suppressions; desktop command/status; visible dashboard effects | Focused worker tests and any affected storage/frontend tests |
| A Tauri command or IPC payload | Rust command and `generate_handler!`; Specta derives/export list; generated bindings; every string-based `invoke` call | Desktop tests, typecheck, targeted Vitest |
| A storage event or dashboard read | Storage event/table name; `dashboardResources.ts`; refresh coordinator/state; `App.tsx`; selected view | Dashboard resource/coordinator tests and affected App test |
| A frontend view or lazy boundary | View/CSS/test; `App.tsx` lazy import; bundle manifest allowlists/budgets when entry ownership changes; E2E flow | Targeted Vitest, build, bundle checks, relevant Playwright test |
| Updater or release behavior | `AppUpdate*`; Tauri updater config; version manifests; release scripts and tests | Updater tests, build, and release-script validation appropriate to the change |

Use [Development](DEVELOPMENT.md) for exact package filters and validation
commands.
