# Frontend asynchronous invariants

This document describes the concurrency contract for Symphony's React
frontend. It is intended for changes to dashboard loading, event listeners,
polling, settings validation, and any other asynchronous path that can outlive
the render or user action that started it.

## Status and terminology

Sections labeled **Current behavior** describe code that exists today. Sections
labeled **Proposed invariant** are review rules for future changes; they are not
enforced by a repository-wide static verifier today.

- A **generation** is one execution of a dashboard refresh batch.
- A result is **authoritative** when its generation is still the newest
  generation allowed to publish for that resource.
- A request is **settled** when every resource generation it requested has
  finished, whether successfully or unsuccessfully.
- A resource is **visible** when the current view can render it.
- **Dirty** means an event indicates that the cached value may be obsolete.

The main implementation is split between
[`dashboardRefreshCoordinator.ts`](../src/dashboardRefreshCoordinator.ts),
[`dashboardResourceState.ts`](../src/dashboardResourceState.ts),
[`dashboardResources.ts`](../src/dashboardResources.ts),
[`pollController.ts`](../src/pollController.ts), and
[`settingsValidationController.ts`](../src/settingsValidationController.ts).
[`App.tsx`](../src/App.tsx) owns their integration.

## Refresh generations

### Current behavior

`createDashboardRefreshCoordinator` assigns a monotonically increasing
generation to each batch and records the authoritative generation separately
for every requested resource key.

- There is at most one active batch.
- A request made while a batch is active adds its keys to a set for one
  follow-up batch. Repeated requests for the same key coalesce.
- The active generation remains authoritative until the follow-up batch
  actually starts. Merely queuing new work does not invalidate the active
  result, which prevents continuous events from starving publication.
- The follow-up generation becomes authoritative for its keys immediately
  before its executor starts.
- `isAuthoritative(key)` becomes false after disposal, even if an abandoned
  promise eventually resolves.

The dashboard executor uses `Promise.allSettled`, allowing one resource to
publish even when a sibling request fails. It reports a batch failure after all
siblings settle so polling and foreground callers still observe failure.

### Proposed invariant

Every async write to dashboard state must pass an authority check at the point
of publication, not only when the request begins. Starting a newer generation
may invalidate an older result; queuing a possible future generation must not.

When adding a new resource:

1. Give it a stable `DashboardResourceKey`.
2. Fetch it through the coordinator rather than starting an untracked request.
3. Check `isAuthoritative(key)` before publishing data, failure, or loading
   cleanup.
4. Add a test in
   [`dashboardRefreshCoordinator.test.ts`](../src/dashboardRefreshCoordinator.test.ts)
   or [`App.test.tsx`](../src/App.test.tsx) that resolves generations out of
   order.

Do not replace `Promise.allSettled` with fail-fast aggregation: one failed
backend call must not discard successful sibling results.

## Settlement and caller promises

### Current behavior

Each coordinator waiter records the generation requested for every key. It
settles only after each corresponding settled-generation counter reaches that
request. This means:

- a coalesced request waits for the batch that actually owns its work;
- foreground requests can reject on batch failure;
- background invalidations can suppress user-facing failure reporting while
  still settling;
- queued work starts after a failed active batch;
- disposal resolves outstanding waiters instead of leaving callers hanging.

`reportFailure` controls whether the failure observer runs.
`rejectOnFailure` independently controls whether the requesting promise rejects.

### Proposed invariant

A promise returned to a caller must correspond to a precisely defined
generation. Never resolve a Save, Refresh, or Retry action merely because some
older request for the same resource completed.

Foreground actions should reject when their requested work fails. Background
refreshes should record resource failure without producing duplicate global
error UI. No path may leave a waiter unresolved after unmount or disposal.

## Stale results and local writes

### Current behavior

Dashboard commits, failures, and loading cleanup are authority-gated. Additional
identity checks protect selected details: a response for a run or retro may
publish only if the selected ID still matches the ID captured by the request.

The selected-run path also protects a narrower race. When an `agent_event`
listener appends an event while `get_run_detail` is in flight, the response is
merged with locally appended event IDs instead of replacing them.

Dirty versions protect invalidations that arrive during a request. A successful
response clears a dirty key only if its captured dirty version is still
current. Events received during bootstrap remain dirty and are replayed after
the initial snapshot, so bootstrap cannot overwrite newer information.

The resource-state reducer preserves prior data while refreshing. A failure
without prior data becomes `error`; a failure with prior data becomes `stale`.
Visible dirty data is also marked stale after 60 seconds.

### Proposed invariant

Resource generation and selected entity ID, when applicable, gate whether a
dashboard result may publish. Other versions control reconciliation rather than
publication:

- if a local-write or append version changed, merge the local data that the
  response did not observe;
- if a dirty version changed, the result may publish but must not clear the
  newer dirty marker;
- non-dashboard controllers must use their own request or revision ID as the
  publication gate.

Late success must not erase a newer failure, dirty marker, selected entity, or
locally appended event. Late failure must not replace newer data with an error.
When old data exists, preserve it and expose staleness rather than blanking the
screen.

## Visibility and dirty resources

### Current behavior

[`dashboardResources.ts`](../src/dashboardResources.ts) maps views, selections,
and database tables to resource keys.

- Overview and worker status can refresh in every view.
- Runs refresh in the active runs view.
- Issues refresh in the active issues view.
- Retro lists and batches refresh in the retro view.
- Selected details refresh only when their view is active and an ID is
  selected.
- Hidden resources remain dirty. A view-change effect requests the dirty
  resources that have become visible.
- An unknown database table uses a conservative broad-list fallback. It does
  not guess which selected detail changed.
- Worker-heartbeat changes map to no rendered resource.

The table-to-resource mapping is manual. It currently mirrors backend-emitted
table names, but no static check guarantees that parity.

### Proposed invariant

Visibility is a scheduling optimization, not permission to forget an
invalidation. If an event affects a hidden resource, mark it dirty and fetch it
when it becomes visible.

Any repository write that introduces a new emitted table name must be reviewed
with `resourcesForDbChange`. Add the most precise mapping possible and a test in
[`dashboardResources.test.ts`](../src/dashboardResources.test.ts). Keep the
unknown-table fallback conservative, but do not rely on it for known tables or
selected-detail correctness.

## Listener ordering and lifecycle

### Current behavior

`App.tsx` listens for `db_changed`, `agent_event`, and `rate_limit_changed`.
Database changes are coalesced for 300 ms. A typed `agent_event` for the visible
selected run is appended immediately and deduplicated by event ID; its matching
database change still refreshes overview data but skips an unnecessary immediate
detail fetch.

Listener registration itself is asynchronous. Cleanup:

1. marks the effect cancelled;
2. clears the coalescing timer;
3. waits for the aggregate registration promise;
4. calls every unlisten function only when all three registrations succeeded.

When all registrations succeed, this covers React Strict Mode remounts and
registration that completes after unmount. There is a partial-registration gap:
`Promise.all(...).catch(() => [])` is fail-fast, so one rejected registration
discards the unlisten functions from sibling registrations that already
succeeded or succeed later. Those listeners are not removed by the current
cleanup.

### Proposed invariant

Every listener effect must handle all three phases: registration pending,
listener active, and cleanup requested. Cleanup must be idempotent and must
remove every successfully registered listener, including listeners that finish
registering late and listeners whose sibling registration rejects.

Typed events may update the UI optimistically only when they are deduplicated
and paired with durable invalidation. Coalescing may reduce duplicate fetches,
but must not drop the final invalidation for a resource.

New listener code requires a Strict Mode test that mounts, unmounts or remounts,
then resolves registration and in-flight work late.

## Polling and document visibility

### Current behavior

[`pollController.ts`](../src/pollController.ts) permits one poll at a time.
Unchanged successful polls back off after three unchanged results. Failures use
delays of 2, 4, 8, 16, then 30 seconds, capped at 30 seconds.

When hidden-page pausing is enabled:

- no new poll starts while the document is hidden;
- if the page becomes hidden during a poll, the controller waits for settlement
  and remains paused;
- restoring visibility schedules an immediate poll;
- reset during an in-flight poll is deferred until settlement;
- disposal removes the visibility listener and ignores the late result.

### Proposed invariant

Polling must remain single-flight. Timers schedule work; they must not create a
second concurrent owner. Visibility, reset, and disposal transitions must be
recorded while work is in flight and applied after settlement.

Backoff is reset only by the state transition the controller defines as
progress. Do not treat a transport success with unchanged data as user-visible
progress.

## Debounced validation and exact Save semantics

### Current behavior

[`settingsValidationController.ts`](../src/settingsValidationController.ts)
uses revision IDs and a 350 ms debounce. It runs one validation at a time and
keeps at most the latest queued revision. Only the latest revision may publish
its result.

`validateNow` bypasses the debounce and waits for its exact revision. A
superseded queued revision resolves with an explicit unavailable/superseded
outcome instead of borrowing another revision's result. Preview mode,
disposal, and validation failure also produce explicit unavailable outcomes.
Disposal does not invalidate a Save waiter whose already-active revision is
still authoritative.

### Proposed invariant

Debouncing may coalesce speculative feedback, but an explicit Save must wait
for the exact settings revision being saved. Results from older revisions must
never enable Save or overwrite feedback for newer input.

Controllers should expose superseded, unavailable, disposed, and failed states
as distinct outcomes where caller behavior differs. Avoid a nullable result
that silently conflates them.

## Review and test checklist

For any frontend async change, answer these before merging:

- What identity makes the result authoritative?
- What invalidates that identity?
- Which caller promise settles, and on what generation or revision?
- Can a listener or local write modify the same state while the request runs?
- What happens if selection or visibility changes?
- What happens when the component unmounts before registration or resolution?
- Does a failure preserve usable prior data?
- Is the out-of-order path covered by a deterministic test?

Run at least:

```sh
pnpm typecheck
pnpm test
```

For browser-visible behavior, also follow
[`UI-TESTING.md`](UI-TESTING.md).
