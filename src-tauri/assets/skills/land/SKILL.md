---
name: land
description: Squash-merge the issue's PR once it's approved and green. Use only when the issue is in the `Merging` state — Symphony's status router gates entry.
---

# Land

## Preconditions

- Issue state is `Merging`.
- `gh auth status` succeeds.
- A PR is attached to the issue and is `OPEN` (not `CLOSED`/`MERGED`).

If the PR is already `MERGED` when entering this skill, skip the merge: record the merge SHA in the workpad and move the issue to `Done`.

## Steps

1. Inspect the PR:
   ```sh
   gh pr view --json number,state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
   ```
   Required: `state=OPEN`, `reviewDecision=APPROVED` (or no required reviewers).
2. Sync first — run the `pull` skill to merge `origin/main`. Conflicts must be resolved in code; never leave a `DIRTY`/`CONFLICTING` PR. Re-run validation after the merge.
3. Push the merge result with the `push` skill.
4. **Wait for CI to be green.** Don't rely on `gh pr merge --auto` — it only blocks on checks that branch protection marks as required, and many repos either configure no required checks or only a subset. Poll `gh pr checks` explicitly so the gate works the same whether the repo enforces checks at the GitHub level or not — every 30s, up to 30 minutes, before merging:
   ```sh
   for _ in $(seq 1 60); do
     gh pr checks
     rc=$?
     case "$rc" in
       0) break ;;       # all checks passed
       8) sleep 30 ;;    # checks still pending — keep waiting
       *) echo "PR checks failed (exit $rc)" >&2; exit 1 ;;
     esac
   done
   [ "$rc" -eq 0 ] || { echo "Timed out waiting for checks" >&2; exit 1; }
   ```
   `gh pr checks` exits 0 only when every check passed; 8 while any are pending; non-zero/non-8 if any failed. A failure or timeout falls into the failure-mode handler below: record the cause and move the issue to `Rework`.
5. Squash-merge:
   ```sh
   gh pr merge --squash
   ```
   `gh pr merge` returning success does **not** guarantee the PR is merged — if the repo has a merge queue (or any auto-merge path kicks in), the command can return after enqueueing and the PR will still be `OPEN` while the queue runs. Verify in step 6 before continuing.
6. Wait for the PR to reach terminal `MERGED` state — every 15s, up to 30 minutes:
   ```sh
   for _ in $(seq 1 120); do
     state=$(gh pr view --json state -q .state)
     case "$state" in
       MERGED) break ;;
       OPEN)   sleep 15 ;;
       *)      echo "PR ended in unexpected state: $state" >&2; exit 1 ;;
     esac
   done
   [ "$state" = "MERGED" ] || { echo "Timed out waiting for MERGED" >&2; exit 1; }
   ```
   A `CLOSED` (without `MERGED`) state or a timeout falls into the failure-mode handler below.
7. Capture the merge commit (only after `state=MERGED`):
   ```sh
   gh pr view --json mergeCommit -q .mergeCommit.oid
   ```
8. The remote head branch usually auto-deletes. If not, leave it — don't delete in scripts.
9. Record the merge SHA in the workpad's `### Notes` and move the issue to `Done`.

## Failure modes → Rework

If any of the following hit, record the cause in the workpad and move the issue to `Rework` with a brief blocker note:

- PR checks went red on the merge candidate and you can't fix locally.
- The `gh pr checks` wait loop times out (still pending after 30 min).
- The merge result reintroduces a conflict you can't resolve.
- `gh pr merge --squash` keeps failing (e.g., `mergeStateStatus` flips to `BLOCKED`/`DIRTY`, or the PR transitions to `CLOSED` without `MERGED`).
- The post-merge `state=MERGED` wait loop times out, or the PR ends in `CLOSED` without `MERGED` (e.g., merge queue rejected it).

Do not force-push, reset, or close-and-reopen the PR to escape the failure.
