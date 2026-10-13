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
| Pending | — | — | — | — |
