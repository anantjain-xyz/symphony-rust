# Architecture refactor waves

**Audit items 1–15 are complete.** Ten implementation PRs merged after matching Codex no-findings reviews and green CI. Final integrated main passed validation.

## Definition of done

- Implement audit items **1–15** from [the architecture audit](ARCHITECTURE-AUDIT-2026-10-12.md).
- Prove each item's acceptance criteria with behavioral regression tests.
- Preserve supported provider protocols, per-run configuration, settings migrations, and dashboard reconciliation.
- Update affected generated bindings, boundary checks, and architecture contracts.
- Run `pnpm verify:fast` on every submitted head; relevant desktop/browser checks locally, full required CI remotely.
- Resolve reviewer findings through fixes or evidence-backed pushback.
- Merge only after Codex reviewer approval/no-findings confirmation for the current head and green checks; record the merge SHA.
- Complete a final validation of integrated main and stop. Audit items 16–20 remain follow-up scope.

## Waves

| Wave | Reviewable PR units | Audit items |
| --- | --- | --- |
| 1 | Agent subprocess supervision; worker/task/workspace ownership; board interaction and mutation ownership; atomic run transitions and resilient invalidation | 1, 2, 4, 5, 7, 8, 9, 10, 11, 15 |
| 2 | Revisioned atomic settings owner; output sanitization; complete tracker collections | 3, 6, 12 |
| 3 | Typed runtime/domain/UI boundaries; pure worker policy and framework-independent retro services; frontend feature controllers | 13, 14 |

Independent PRs may be developed concurrently. Integrate and revalidate dependencies before review or merge. Approval applies to the reviewed head; subsequent substantive changes require another review.

## Evidence ledger

| PR | Items | Tests | Reviewed head | Merge SHA |
| --- | --- | --- | --- | --- |
| [206](https://github.com/anantjain-xyz/symphony-rust/pull/206) | 4, 7 | Atomic completion fault/replay tests; event-lag resync; fast gate and full CI | `2dca4d84ff7934762561be4f51dbbaebfb1a6e1e` | `b3880491b3c652e11a602266285696a07301a745` |
| [207](https://github.com/anantjain-xyz/symphony-rust/pull/207) | 2 | 60 adapter tests, including 12 process lifecycle regressions; fast gate and full CI | `5feadb8c5efba80d615b5ccc43ca58b7aa2b3d2b` | `d5a41fd0c6ff4091e90b7158e5f098e866c6dfa7` |
| [208](https://github.com/anantjain-xyz/symphony-rust/pull/208) | 8, 9, 15 | 275 frontend tests; 5 Chromium general-browser tests; bundle checks; full CI | `03085f9ea4c196fca3ac170e5bb3f51e65a37db3` | `bb4d5927d10bfe43748d82df6e27c65bc08815e6` |
| [209](https://github.com/anantjain-xyz/symphony-rust/pull/209) | 1, 5, 10, 11 | 132 worker tests, including shutdown, claims, hook Unicode and quota gates; fast gate and full CI | `d67b5c7fa2323d8e5887c307527b52eedfd7ed55` | `d781821662ef3670ee8a595dbd1b40f48d6d8f12` |
| [211](https://github.com/anantjain-xyz/symphony-rust/pull/211) | 12 | 24 tracker tests, including 13 HTTP pagination fixtures; fast gate and full CI | `f2f9dc60ea8f93533e1691a7c7a352620bcdf463` | `d9c3b9ff30e2d1963a8c55e5609af02614838c5e` |
| [213](https://github.com/anantjain-xyz/symphony-rust/pull/213) | 14: frontend | 276 frontend tests; 5 Chromium general-browser tests; build/bundle checks; full CI | `ef7d6f85eed2f908ce64f1f32cbaf45f0cde2a60` | `09c648bef51d966674d5b499febe055441b96437` |
| [212](https://github.com/anantjain-xyz/symphony-rust/pull/212) | 6, 14: worker | 290 Rust tests + 1 doctest; sanitizer, quota and stderr regressions; fast gate and full CI | `3237e46e71041f9ba1cf77889e4c0aafb3063de2` | `85634e789630cfbb5dc5b7d6e4958a59fe6546fa` |
| [210](https://github.com/anantjain-xyz/symphony-rust/pull/210) | 3 | 292 headless Rust + 1 doctest; 112 desktop; 311 frontend; 5 Chromium general-browser tests; full CI | `c8046033c4f457a82536bc5ca3ad8750b437e109` | `694e9b1fba496a5ec5bd33daa8330c525509fb52` |
| [214](https://github.com/anantjain-xyz/symphony-rust/pull/214) | 13; 9 evidence | 314 headless Rust + 2 doctests; 118 desktop; 316 frontend; full CI | `c1a032eeb935d9281d83020b89007c98ad348718` | `7675d78c2ce0909cf81ecf9921816514d6766252` |
| [215](https://github.com/anantjain-xyz/symphony-rust/pull/215) | 14: retro | 322 headless Rust + 2 doctests; 133 desktop; 316 frontend; 5 Chromium general-browser tests; full CI | `0588332da417a014adcbc52d5a1c9a69eb04f4e0` | `4ef9d7365aaf9a8d46812c9ae82db3886ede8537` |

## Final validation and proof

| Gate | Result |
| --- | --- |
| Integrated main | `4ef9d7365aaf9a8d46812c9ae82db3886ede8537` |
| Rust | 322 headless + 133 desktop = **455 unit tests**; **2 doctests** passed |
| Frontend | **316 tests** passed |
| General browser gate | **5 Chromium general-browser tests** passed |
| Static/contracts | Strict workspace all-target Clippy, formatting, lint, typecheck, bindings, boundaries, assets, and documentation checks passed |
| Eager JavaScript | **81,713 / 82,000 normalized gzip bytes** |
| CSS | **4,978 / 7,000 gzip bytes** |

- Integrated main's source tree equals the approved service head `0588332da417a014adcbc52d5a1c9a69eb04f4e0`; dependent squash merges preserved their validated source trees.
- PRs 206–215: GitHub heads and merge SHAs match this ledger. Paginated review/comment sweeps and resolved-thread checks confirmed the recorded heads had no outstanding actionable feedback.
- All 13 final screenshot URLs linked from [PR 208](https://github.com/anantjain-xyz/symphony-rust/pull/208) (5 board images) and [PR 210](https://github.com/anantjain-xyz/symphony-rust/pull/210) (8 settings images) returned HTTP 200 on 2026-10-13. Production components use synthetic IPC; source provenance is recorded in the PRs.
- [PR 216](https://github.com/anantjain-xyz/symphony-rust/pull/216) publishes this completion record and documentation corrections. Its diff contains documentation only.

## Acceptance map

| Item | Structural guarantee | Behavioral evidence |
| --- | --- | --- |
| 1 | A worker generation owns polling, recovery, and run children | Stop/start, slow cancellation, polling panic |
| 2 | One process owner pumps pipes, stops the process group, and reaps its direct child | Blocked stdin, stderr pressure, EOF wait, malformed protocol, dropped future |
| 3 | Settings revisions, atomic replacement, OS lock, recovery journal, owned ordered continuations | Concurrent Save/retro/migration, independent processes, fault states, caller disconnect, draft provenance, key edits during removal |
| 4 | One transaction commits outcome, retry/suppression, and live-session removal | Injected failures, database reopen, repeated completion |
| 5 | Dispatch and quarantine share a canonical workspace claim | Active-claim cleanup exclusion, cancellation and quarantine races |
| 6 | Output crosses a bounded sanitization boundary before persistence | Durable/UI/retry/hook canaries, escaped JSON, credential fragments, canonical quota metadata |
| 7 | Event lag produces a full resync and keeps delivery alive | Overflowed receiver followed by later events; selected-detail invalidation |
| 8 | Pointer cancellation only releases drag state | No move callback; focus and optimistic state preserved |
| 9 | Each pending operation owns its busy token | Overlapping operations in both settlement orders; independent update locking |
| 10 | Hook stderr has a bounded UTF-8-safe capture | Large Unicode output and split-chunk redaction |
| 11 | Quota admission uses the selected provider | Normal/retry dispatch before, at, and after reset; provider switches |
| 12 | Required tracker collections are complete or explicitly fail | Five fetch APIs, nested continuation, malformed payloads, cursor cycles and caps |
| 13 | Runtime constructors, closed states, typed projections and provider records | Invalid config/records/storage rejected; typed arrays/events/session data; structured field focus; stale runtime revision fences |
| 14 | Policy and feature operations have capability owners | Pure dispatch cases; settings-session tests; retro service races; existing reconciliation/browser coverage |
| 15 | Keyboard movement uses the same mutation and confirmation path | Move/cancel, active-run restrictions, focus restoration |

## Review resolutions

| PR | Accepted finding | Resolution |
| --- | --- | --- |
| 210 | Cancellation skipped post-commit actions | Own the whole async mutation through reconfiguration, shutdown, or batch finalization |
| 210 | Process-local mutex admitted conflicting saves | Stable sidecar OS lock; two independent writer processes |
| 210 | Unrelated updates promoted dirty draft revisions | Explicit operation lineage acknowledgement; unrelated updates produce conflicts |
| 210 | Key removal cleared the only edit but left an old snapshot | Reconcile the full returned snapshot when clearing the key leaves no local form edits |
| 210 | Keyring failure blocked bootstrap | Read settings with separate credential-unavailability metadata; keep failed writes explicit |
| 210 | Keyring failure blocked unrelated settings edits | Preserve durable credential metadata and allow ordinary settings/prompt commits; report live credential availability separately |
| 210 | Key removal discarded input entered during its request | Capture key edit generation; clear only the original input and preserve later edits |
| 210 | Older post-commit effects could overwrite newer runtime settings | Serialize commit and worker continuation together; capture Start under the same gate; fence runtime effects by revision |
| 210 | Process interruption left credential/file state partially committed | Durable journal with salted credential fingerprints; recover old/new state under the OS lock and reconcile recovered runtime effects |
| 210 | Superseded journal lost its runtime-stop obligation | Stop a potentially stale worker before discarding superseded recovery evidence |
| 210 | Remote operations used unresolved saved credentials | Admit one locked settings/credential snapshot and reject recovery diagnostics before remote I/O |
| 210 | A skipped runtime update was presented as applied | Return admission diagnostics and retain the skipped status through unlock/reload until reconfiguration or restart |
| 210 | Reverting a draft during Save left it incorrectly clean | Recompute dirtiness against the acknowledged saved baseline |
| 210 | Unlock/reload changed the explanation of a skipped update | Retain the skip reason and expose the server-side diagnostic until reconfiguration or restart |
| 210 | Ordinary atomic replacement lacked rename durability | Sync the file and parent directory before acknowledging Save, prompt updates, or migrations |
| 210 | Windows recovery flushes lacked required write access | Open existing-file and directory flush handles with Windows write access; preserve Unix read-only recovery |
| 210 | An equal external snapshot left a stale draft revision | Adopt the complete external snapshot when its form state equals the draft; preserve unrelated edits and key input |
| 210 | A later successful refresh left a stale settings notice | Clear the retained reason after a subsequent healthy worker snapshot; fence older dashboard reads |
| 210 | Prompt save succeeded but runtime admission left a batch running | Persist the saved-prompt outcome and a terminal batch state before returning the refresh error |
| 210 | Draft edits later became equivalent without adopting the saved revision | Reconcile the full saved snapshot when edits converge to its form state |
| 210 | Runtime admission failure hid a successful durable Save | Return the committed settings receipt with a separate runtime-update error |
| 210 | A failed status read invented a skipped live update | Require an actual worker error or explicit Save outcome; leave unknown status unclassified |
| 210 | Credential unavailability during Load implied a skipped update | Keep read availability warnings separate from saved-update outcomes |
| 210 | Another application process retained a removed credential | Enforce one application instance before runtime setup; activate its existing window on macOS/Windows, and use the OS lease independently on Linux |
| 210 | Relaunch could reject the replacement while the old process held its lease | Wait for a bounded OS lease handoff; a replacement is admitted only after the old owner exits |
| 210 | Linux activation plugin could panic without session D-Bus | Use the OS lease independently on Linux; keep native activation on macOS/Windows |
| 212 | Text redaction changed quota policy inputs | Canonical operational metadata; sanitized display payloads; opaque unknown bucket identities |
| 214 | Incomplete drafts did not fence delayed starts | Observe every committed/loaded revision and invalidate older preflight continuations |
| 214 | A newer failed reconfiguration suppressed credential-removal shutdown | Stop on known credential absence; only an adopted newer runtime supersedes delayed removal |
| 214 | Nonblocking setup warning hid the blocking validation message | Select the first blocking issue before an incomplete-setup warning |
| 215 | PR admission used stale settings after waiting | Reread and validate the complete repository plan under the settings effects gate |
| 215 | Partial reservations left an incomplete PR plan | Reserve every accepted repository group in one transaction before starting any job |
| 215 | Caller disconnect interrupted retro deletion | Own deletion through generation cleanup and terminal persistence |
| 215 | Colliding workspace names bypassed PR admission | Apply the shared repository-name and workspace-collision validation before reservation |

## Validation limits

- Provider lifecycle tests use bounded fake processes; tracker tests use local HTTP fixtures.
- Browser acceptance uses Chromium preview; native Tauri/WebKit smoke coverage remains item 20. Native Windows/Linux GUI launch and packaged updater restart were not exercised. OS-lease exclusion and delayed restart handoff use real child processes on macOS.
- The Windows flush regression is included but was not executed on this macOS host or current Linux/macOS CI. Handle access follows the [Microsoft flush contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).
- New output and recovered retry context are sanitized; historical stored output is not rewritten.
- CI and behavioral tests establish the supported contracts; no live provider or Linear mutation is required by this scope.

## Deferred scope

| Item | Follow-up |
| --- | --- |
| 16 | Independent bootstrap and lazy loading of hidden resources |
| 17 | Bounded background refresh, history cursors, and retention |
| 18 | Replay-safe usage and event accounting |
| 19 | Offline ownership repair and an explicit hook-failure policy |
| 20 | Native Tauri/WebKit smoke coverage and remaining invariants |

These P3 items are outside this definition of done. Documentation required by the implemented changes is updated in this wave.
