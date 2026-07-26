# Rust–TypeScript IPC contract

Symphony's desktop boundary consists of Tauri commands and events implemented
in Rust and consumed by TypeScript. This document records who owns each part of
that contract and what must change together.

## Status

**Current behavior** below describes the repository today. **Proposed
invariants** are review requirements. The repository does not currently have a
single static verifier that proves command registration, frontend invocations,
generated types, and event mappings are all synchronized.

## Contract layers and ownership

| Layer | Current source of truth | Consumer |
| --- | --- | --- |
| Command implementation and serde wire shape | `#[tauri::command]` functions and Rust request/response types in [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) | Tauri runtime |
| Command reachability | `tauri::generate_handler![...]` in [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) | Tauri runtime |
| Shared data type declarations | Rust types deriving `specta::Type`, explicitly listed by `export_bindings()` | [`src/bindings.ts`](../src/bindings.ts) |
| Frontend command call | String literal and argument object passed to `invoke<T>()` | React code |
| Event wire shape | [`StorageEvent`](../crates/symphony-storage/src/lib.rs) and serde attributes | Tauri event forwarder and React listeners |
| Event name | `forward_events` in [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) | listener names in [`src/App.tsx`](../src/App.tsx) |

Rust owns the runtime contract. A TypeScript generic on `invoke<T>()` is only a
compile-time assertion by the caller; it does not validate a response at
runtime.

## Commands

### Current behavior

Desktop commands are ordinary `#[tauri::command]` functions. A function is
callable only when it also appears in the `tauri::generate_handler!` list.
Frontend code invokes commands by literal name in
[`App.tsx`](../src/App.tsx), [`AppUpdate.tsx`](../src/AppUpdate.tsx), and
[`SettingsView.tsx`](../src/views/SettingsView.tsx).

The checked-in handler definitions and registration list currently agree. Most
registered commands are invoked by the frontend. `get_issue_detail` is a
registered backend-only command at present, so exact set equality between
registered and invoked names would need an explicit allowlist rather than
assuming every registered command has a caller.

Tauri serializes command arguments and results across the boundary. Rust
parameter names, serde renames, optionality, integer ranges, and enum tags are
therefore API behavior. Frontend argument objects use Tauri's JavaScript-facing
camel-case names where Rust parameters are snake case.

### Proposed invariant

Treat a command change as one atomic contract change:

1. Define or change the Rust DTO and command signature.
2. Register the command in `tauri::generate_handler!`.
3. Add every shared DTO to `export_bindings()`.
4. Regenerate and review [`src/bindings.ts`](../src/bindings.ts).
5. Update every `invoke` name, argument object, and return type.
6. Add Rust tests for handler behavior and frontend tests for caller behavior.

Renaming a Rust function, argument, enum variant, or serde field is a breaking
wire change unless the old serialized name is deliberately preserved. Do not
make the TypeScript side compile by hand-editing a generated type while leaving
the Rust wire shape unchanged.

A future command verifier should distinguish:

- implemented and registered commands;
- registered commands intentionally not called by this frontend;
- frontend command literals with no registered handler;
- shared types returned by handlers but absent from the export catalog.

No such complete verifier is present today.

## Specta bindings

### Current behavior

`export_bindings()` is called during Tauri setup. Its body is compiled only in
debug builds, so starting a debug desktop app rewrites
[`src/bindings.ts`](../src/bindings.ts). It:

- uses Specta's TypeScript exporter;
- exports big integers as TypeScript `number`;
- exports an explicit, manually maintained list of Rust types;
- concatenates successful exports;
- writes the result to `src/bindings.ts`.

Export errors are filtered out and the write result is ignored. The checked-in
bindings can also be maintained manually without starting the desktop app.
Current CI type-checks the checked-in TypeScript but excludes the
`symphony-desktop` Rust crate, so CI does not regenerate the file or prove it is
fresh.

The export catalog currently includes `StorageEvent`, while the checked-in
bindings do not. Frontend event payloads are declared separately in
[`dashboardResources.ts`](../src/dashboardResources.ts). This is a concrete
example of the current split ownership; it is not evidence of runtime
validation.

### Proposed invariant

Checked-in bindings should be reproducible output, not a second schema. A
binding-only edit should be rejected unless it is accompanied by the Rust
source change that produces it.

The desired generation check is:

1. run the canonical exporter in a deterministic environment;
2. fail on any individual Specta export or file-write error;
3. compare the generated bytes with the checked-in file;
4. fail when the diff is non-empty.

That check is proposed, not implemented. Until it exists, reviewers must inspect
the Rust export catalog and `src/bindings.ts` together. Because `u64` values are
currently exported as `number`, values that can exceed JavaScript's safe integer
range require an explicit design decision before crossing IPC.

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

A future verifier should compare backend-emitted table literals against the
frontend's explicit table map and report unknown or orphaned names. That
verifier does not exist today.

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
