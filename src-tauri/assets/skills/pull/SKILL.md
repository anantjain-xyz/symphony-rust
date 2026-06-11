---
name: pull
description: Sync the current branch with origin/main via merge (not rebase) and resolve any conflicts. Use whenever Symphony's workflow says "merge origin/main into the branch" — at Step 1 setup, before push, and as part of the Land procedure.
---

# Pull

## Goals

- Bring `origin/main` into the working branch with a real merge commit so reviewers can see the integration.
- Resolve conflicts in code (not by deleting state). Never use `git reset --hard`, `git push --force*`, or `git clean -f*` to "make it go away".
- After merging, the PR should report `MERGEABLE` and `CLEAN`/`HAS_HOOKS`/`UNSTABLE` — never `CONFLICTING`/`DIRTY`.

## Steps

1. Working tree must be clean. Either commit (`commit` skill) or `git stash` first.
2. Enable rerere once per workspace so repeated conflicts auto-resolve:
   ```sh
   git config rerere.enabled true
   git config rerere.autoupdate true
   ```
3. Fetch refs: `git fetch origin`.
4. If a remote feature branch is ahead (e.g. CI auto-formatted), fast-forward first:
   ```sh
   git pull --ff-only origin "$(git branch --show-current)" || true
   ```
5. Merge `origin/main` with a clearer conflict style:
   ```sh
   git -c merge.conflictstyle=zdiff3 merge origin/main
   ```
6. Resolve conflicts (see below), then `git add <files>` and `git merge --continue` (or `git commit` if the merge auto-paused).
7. Re-run validation (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`) before pushing.
8. Record the result in the workpad's `### Notes` (e.g. `merge origin/main: clean` or `conflicts resolved: <files>`) and the new short SHA.

## Resolving conflicts

- `git status` lists the conflicted files; `git diff` shows hunks.
- `merge.conflictstyle=zdiff3` produces `<<<<<<< ours`, `||||||| base`, `>>>>>>> theirs` markers with surrounding shared context trimmed — focus on the differing core.
- For each file, decide the *intent* of both sides before editing:
  - What is each side trying to do? (bugfix, refactor, rename, behavior change.)
  - Is one side strictly newer / superseding? Or are they orthogonal and both must be kept?
  - What invariant must hold after the merge?
- Prefer minimal, intent-preserving edits. Don't silently drop one side; if you intend to drop something, do it explicitly.
- For generated files, regenerate after resolving the source-of-truth files (don't hand-merge generated output).
- For import lists where intent is unclear, accept both sides, then let lint/typecheck strip what isn't used.
- After every file: `git diff --check` — if it complains about conflict markers, you missed one.
- Use `git checkout --ours <file>` / `--theirs <file>` only when you are certain one side wins entirely.

## Don't ask the human

The Symphony workflow runs unattended. Make the call from the diff + intent, document the rationale in the merge commit body, and proceed. Only escalate (move to `In Review` with a blocker brief in the workpad) when the conflict crosses a user-visible contract or an irreversible side effect with no obvious safe default.
