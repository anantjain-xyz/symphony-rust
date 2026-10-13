# Architecture refactor waves

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

| PR | Items | Tests | Codex-reviewed head | Merge SHA |
| --- | --- | --- | --- | --- |
| [206](https://github.com/anantjain-xyz/symphony-rust/pull/206) | 4, 7 | Atomic completion fault/replay tests; event-lag resync; fast gate and full CI | `2dca4d84ff7934762561be4f51dbbaebfb1a6e1e` | `b3880491b3c652e11a602266285696a07301a745` |
| [207](https://github.com/anantjain-xyz/symphony-rust/pull/207) | 2 | 60 adapter tests, including 12 process lifecycle regressions; fast gate and full CI | `5feadb8c5efba80d615b5ccc43ca58b7aa2b3d2b` | `d5a41fd0c6ff4091e90b7158e5f098e866c6dfa7` |
| [208](https://github.com/anantjain-xyz/symphony-rust/pull/208) | 8, 9, 15 | 275 frontend tests; 5 Chromium acceptance tests; bundle checks; full CI | `03085f9ea4c196fca3ac170e5bb3f51e65a37db3` | `bb4d5927d10bfe43748d82df6e27c65bc08815e6` |
| [209](https://github.com/anantjain-xyz/symphony-rust/pull/209) | 1, 5, 10, 11 | 132 worker tests, including shutdown, claims, hook Unicode and quota gates; fast gate and full CI | `d67b5c7fa2323d8e5887c307527b52eedfd7ed55` | `d781821662ef3670ee8a595dbd1b40f48d6d8f12` |
| [211](https://github.com/anantjain-xyz/symphony-rust/pull/211) | 12 | 24 tracker tests, including 13 HTTP pagination fixtures; fast gate and full CI | `f2f9dc60ea8f93533e1691a7c7a352620bcdf463` | `d9c3b9ff30e2d1963a8c55e5609af02614838c5e` |
| [213](https://github.com/anantjain-xyz/symphony-rust/pull/213) | 14: frontend | 276 frontend tests; 5 Chromium acceptance tests; build/bundle checks; full CI | `ef7d6f85eed2f908ce64f1f32cbaf45f0cde2a60` | `09c648bef51d966674d5b499febe055441b96437` |
| [212](https://github.com/anantjain-xyz/symphony-rust/pull/212) | 6, 14: worker | 290 Rust tests + 1 doctest; sanitizer, quota and stderr regressions; fast gate and full CI | `3237e46e71041f9ba1cf77889e4c0aafb3063de2` | `85634e789630cfbb5dc5b7d6e4958a59fe6546fa` |

## Remaining acceptance

| Items | Owner / invariant | Delivery |
| --- | --- | --- |
| 3 | Revisioned settings, atomic replacement, recoverable credential transactions, ordered runtime effects | [PR 210](https://github.com/anantjain-xyz/symphony-rust/pull/210) in review |
| 6 | Sanitized, bounded output before persistence and delivery | Merged PR 212 |
| 12 | Complete labels/blockers with honest pagination failures | Merged PR 211 |
| 13 | Validated runtime config, typed storage/UI contracts, explicit provider records | [PR 214](https://github.com/anantjain-xyz/symphony-rust/pull/214) in review |
| 14: worker | Pure eligibility policy; one effects boundary | Merged PR 212 |
| 14: frontend | Dashboard, settings, and repository capability owners | Merged PR 213 |
| 14: retro | Framework-independent review/application/PR service | [PR 215](https://github.com/anantjain-xyz/symphony-rust/pull/215) in review |

## Acceptance map

| Item | Structural guarantee | Behavioral evidence |
| --- | --- | --- |
| 1 | A worker generation owns polling, recovery, and run children | Stop/start, slow cancellation, polling panic |
| 2 | One process owner pumps pipes and reaps the process group | Blocked stdin, stderr pressure, EOF wait, malformed protocol, dropped future |
| 3 | Settings revisions, atomic replacement, OS lock, recovery journal, owned ordered continuations | Concurrent Save/retro/migration, independent processes, fault states, caller disconnect, draft provenance, key edits during removal |
| 4 | One transaction commits outcome, retry/suppression, and live-session removal | Injected failures, database reopen, repeated completion |
| 5 | Dispatch and quarantine share a canonical workspace claim | Active-claim cleanup exclusion, cancellation and quarantine races |
| 6 | Output crosses a bounded sanitization boundary before persistence | Durable/UI/retry/hook canaries, escaped JSON, credential fragments, canonical quota metadata |
| 7 | Event lag produces a full resync and keeps delivery alive | Overflowed receiver followed by later events; selected-detail invalidation |
| 8 | Pointer cancellation only releases drag state | No move callback; focus and optimistic state preserved |
| 9 | Each pending operation owns its busy token | Overlapping operations and independent update locking |
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
| 212 | Text redaction changed quota policy inputs | Canonical operational metadata; sanitized display payloads; opaque unknown bucket identities |
| 214 | Incomplete drafts did not fence delayed starts | Observe every committed/loaded revision and invalidate older preflight continuations |
| 214 | A newer failed reconfiguration suppressed credential-removal shutdown | Stop on known credential absence; only an adopted newer runtime supersedes delayed removal |
| 214 | Nonblocking setup warning hid the blocking validation message | Select the first blocking issue before an incomplete-setup warning |

## Validation limits

- Provider lifecycle tests use bounded fake processes; tracker tests use local HTTP fixtures.
- Browser acceptance uses Chromium preview; native Tauri/WebKit smoke coverage remains item 20.
- New output and recovered retry context are sanitized; historical stored output is not rewritten.
- CI and behavioral tests establish the supported contracts; no live provider or Linear mutation is required by this scope.
