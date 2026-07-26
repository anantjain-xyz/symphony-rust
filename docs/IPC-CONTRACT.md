# Rust–TypeScript IPC contract

Symphony's desktop boundary consists of Tauri commands and events implemented
in Rust and consumed by TypeScript. This document records who owns each part of
that contract and what must change together.

## Status

**Current behavior** below describes the repository today. The static contract
suite makes generated types, command ownership, command argument names, storage
invalidation, and release projections fail closed in CI.

## Contract layers and ownership

| Layer | Current source of truth | Consumer |
| --- | --- | --- |
| Command implementation | `#[tauri::command]` functions in [`src-tauri/src/`](../src-tauri/src/) | Tauri runtime |
| Shared desktop DTOs | [`crates/symphony-contracts`](../crates/symphony-contracts) | Tauri commands and the headless binding exporter |
| Core and configuration DTOs | [`crates/symphony-core/src/types.rs`](../crates/symphony-core/src/types.rs) | Tauri commands, worker, and binding exporter |
| Persistence and event DTOs | [`crates/symphony-storage/src/repo.rs`](../crates/symphony-storage/src/repo.rs) and [`crates/symphony-storage/src/lib.rs`](../crates/symphony-storage/src/lib.rs) | Tauri commands, event forwarder, and React |
| Worker and workflow DTOs | [`crates/symphony-worker/src/manager.rs`](../crates/symphony-worker/src/manager.rs), [`crates/symphony-worker/src/skills.rs`](../crates/symphony-worker/src/skills.rs), and [`crates/symphony-worker/src/repo_workflow.rs`](../crates/symphony-worker/src/repo_workflow.rs) | Tauri commands and React |
| Command reachability | `tauri::generate_handler![...]` in [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) | Tauri runtime |
| Shared data type declarations | Rust types deriving `specta::Type`, explicitly listed by `symphony_contracts::export_bindings()` | [`src/bindings.ts`](../src/bindings.ts) |
| Frontend command call | Typed wrappers in [`src/desktop/commands.ts`](../src/desktop/commands.ts) | React code |
| Event wire shape | [`StorageEvent`](../crates/symphony-storage/src/lib.rs) and serde attributes | Tauri event forwarder and React listeners |
| Event name | `forward_events` in [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) | listener names in [`src/App.tsx`](../src/App.tsx) |

Rust owns the runtime contract. A TypeScript generic on `invoke<T>()` is only a
compile-time assertion by the caller; it does not validate a response at
runtime.

## Commands

### Current behavior

Desktop commands are ordinary `#[tauri::command]` functions. A function is
callable only when it also appears in the `tauri::generate_handler!` list.
Frontend code invokes commands through literal-name wrappers in
[`src/desktop/commands.ts`](../src/desktop/commands.ts).

The checked-in handler definitions and registration list currently agree. Most
registered commands are invoked by the frontend. `get_issue_detail` is a
registered backend-only command at present, so exact set equality between
registered and invoked names would need an explicit allowlist rather than
assuming every registered command has a caller.

Tauri serializes command arguments and results across the boundary. Rust
parameter names, serde renames, optionality, integer ranges, and enum tags are
therefore API behavior. Frontend argument objects use Tauri's JavaScript-facing
camel-case names where Rust parameters are snake case.

### Enforced workflow

Treat a command change as one atomic contract change:

1. Define or change the Rust DTO and command signature.
2. Register the command in `tauri::generate_handler!`.
3. Add every shared DTO to `symphony_contracts::export_bindings()`.
4. Run `pnpm generate:bindings` and review [`src/bindings.ts`](../src/bindings.ts).
5. Update every `invoke` name, argument object, and return type.
6. Add Rust tests for handler behavior and frontend tests for caller behavior.

Renaming a Rust function, argument, enum variant, or serde field is a breaking
wire change unless the old serialized name is deliberately preserved. Do not
make the TypeScript side compile by hand-editing a generated type while leaving
the Rust wire shape unchanged.

`pnpm check:ipc` distinguishes:

- implemented and registered commands;
- registered commands intentionally not called by this frontend;
- frontend command literals with no registered handler.

It scans all desktop Rust modules and frontend TypeScript modules, follows
imported invoke wrappers, and compares JavaScript-facing argument-object keys
with Rust command parameters. `pnpm test:static` exercises positive and
negative fixtures for these rules.

## Specta bindings

### Current behavior

`symphony-contracts` is a Tauri-free workspace crate with an explicit
`export-bindings` binary. `pnpm generate:bindings` runs that binary and writes
the checked-in [`src/bindings.ts`](../src/bindings.ts). The exporter:

- uses Specta's TypeScript exporter;
- exports big integers as TypeScript `number`;
- exports an explicit, manually maintained list of Rust types;
- concatenates successful exports;
- returns every export and file-write error.

`pnpm check:bindings` invokes the same exporter with `cargo --locked`, writes to
a temporary directory, and byte-compares the result with `src/bindings.ts`.
Linux CI runs that check without Tauri/WebKit dependencies. The generated
`StorageEvent` union is consumed directly by
[`src/desktop/events.ts`](../src/desktop/events.ts).

### Enforced invariant

Checked-in bindings should be reproducible output, not a second schema. A
binding-only edit should be rejected unless it is accompanied by the Rust
source change that produces it.

The generation check:

1. run the canonical exporter in a deterministic environment;
2. fail on any individual Specta export or file-write error;
3. compare the generated bytes with the checked-in file;
4. fail when the diff is non-empty.

`pnpm check:bindings` implements all four steps. Because `u64` values are
exported as `number`, values that can exceed JavaScript's safe integer range
still require an explicit design decision before crossing IPC.

## Events

### Current behavior

[`StorageEvent`](../crates/symphony-storage/src/lib.rs) is a serde-tagged enum
using a `type` discriminator and snake-case variant names:

- `db_changed`;
- `agent_event`;
- `rate_limit_changed`.

The storage event bus uses a bounded broadcast channel. `forward_events` maps
those variants to Tauri event names with the same strings. React registers
listeners for all three names.

`agent_event` and `rate_limit_changed` carry typed, narrow notifications.
Repository writes also emit `db_changed` invalidations. The frontend maps
database table strings to resource keys manually in
[`dashboardResources.ts`](../src/dashboardResources.ts). Unknown tables take a
conservative broad-list fallback, but selected-detail correctness still
requires a precise known-table mapping.

For event ordering, coalescing, and late-listener rules, see
[`FRONTEND-ASYNC-INVARIANTS.md`](FRONTEND-ASYNC-INVARIANTS.md).

### Proposed invariant

An event contract change must update all of the following in the same pull
request:

- Rust enum variant and payload;
- serde tag or field names;
- Tauri event-name mapping;
- TypeScript payload type;
- listener registration and cleanup;
- database-table invalidation mapping, when applicable;
- tests for both the event payload and the resulting refresh behavior.

Typed events may provide immediate UI updates, but durable `db_changed`
invalidation remains the recovery path if a typed event is missed or received
for a hidden resource.

`pnpm check:projections` compares backend-emitted table literals with the
frontend map, rejects unknown or orphaned names, and requires durable
repository writes to emit their matching invalidation.

## Error and compatibility rules

### Current behavior

Commands generally return `Result<T, String>`, which Tauri exposes as a
resolved value or rejected invocation. TypeScript callers decide whether an
error becomes inline state, a stale resource, a toast, or an unavailable
outcome. There is no version negotiation between the bundled frontend and
backend; they ship as one desktop artifact.

### Proposed invariant

- Return stable structured errors when callers need to branch on cause. Do not
  parse human-readable strings for control flow.
- Redact secrets, filesystem details, and backend diagnostics before rendering
  user-facing errors.
- Preserve backward-readable persisted data before changing an IPC type that
  is also stored in SQLite or settings JSON.
- Keep command side effects explicit. A command named as a read must not
  silently mutate durable state unless documented and tested.
- Do not assume compile-time TypeScript types make malformed runtime data
  impossible.

## Change checklist

Before merging an IPC change:

- [ ] The Rust command compiles and has handler-level tests.
- [ ] The command is deliberately registered or deliberately internal.
- [ ] Every frontend command literal and argument name matches the wire API.
- [ ] Shared DTOs derive `specta::Type` and appear in the export catalog.
- [ ] `src/bindings.ts` reflects the Rust source.
- [ ] Event names, tags, payloads, and table mappings change together.
- [ ] Frontend failure and stale-result behavior is covered.
- [ ] Native Tauri behavior is tested when browser preview cannot exercise the
      boundary.

Run:

```sh
cargo fmt --all --check
cargo clippy --workspace --exclude symphony-desktop --all-targets -- -D warnings
cargo test --workspace --exclude symphony-desktop
pnpm check:static
pnpm test:static
pnpm typecheck
pnpm test
```

The exclusions mirror current CI and therefore do **not** validate the desktop
handler crate. On a supported macOS development host, an IPC change should also
run:

```sh
cargo test -p symphony-desktop
```

Follow [`UI-TESTING.md`](UI-TESTING.md) for native verification when a change
touches Tauri IPC.
