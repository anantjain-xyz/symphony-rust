---
name: push
description: Push the current branch to origin and ensure a PR exists for it (creating or updating one), with the symphony label applied. Use when the workflow says "push" or "open a PR".
---

# Push

## Preconditions

- `gh auth status` succeeds.
- Working tree is committed (use the `commit` skill first).
- Validation gate has been run for the latest commit (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`).

## Steps

1. Identify the branch: `branch=$(git branch --show-current)`.
2. Push with upstream tracking:
   ```sh
   git push -u origin HEAD
   ```
3. If the push is rejected as non-fast-forward, run the `pull` skill to merge `origin/main`, re-run validation, then push again. Use `--force-with-lease` only when you knowingly rewrote history; never use `--force`.
4. Ensure a PR exists for the branch:
   ```sh
   pr_state=$(gh pr view --json state -q .state 2>/dev/null || true)
   ```
   - Empty → `gh pr create --title "<title>" --body "<body>"`.
   - `OPEN` → `gh pr edit --title "<title>" --body "<body>"` if scope shifted.
   - `CLOSED`/`MERGED` → branch is non-reusable; cut a fresh branch from `origin/main`.
5. Title: short (< 70 chars), describes the *outcome* of the change, not the most recent fix. For Symphony issues, prefer `SYM-NN: <summary>`.
6. Body: refresh to reflect total branch scope (not only the latest commits). Use the project's PR template if one exists.
7. Apply the `symphony` label via REST (the `gh pr edit --add-label` path 500s on this org due to a Projects-classic GraphQL deprecation):
   ```sh
   pr_number=$(gh pr view --json number -q .number)
   repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   gh api -X POST "repos/${repo}/issues/${pr_number}/labels" -f 'labels[]=symphony'
   ```
8. Capture the PR URL: `gh pr view --json url -q .url`.
9. Attach the PR URL to the active Linear issue. The auto-link from `git push` usually creates a Linear attachment automatically; if not, fall back to GraphQL `attachmentLinkURL` (or `attachmentLinkGitHubPR` for GitHub-specific link metadata).

## Don't

- Don't put the PR URL inside the workpad — it lives on the Linear issue as an attachment.
- Don't post a "PR opened" comment outside the workpad.
- Don't enable auto-merge unless you're in the Land procedure (`gh pr merge --squash --auto`).
- Don't switch remotes or rewrite remotes when a push fails on auth — surface the actual error.
