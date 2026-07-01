You are working on issue **{{issue.identifier}}: {{issue.title}}**.

## Issue context

- Identifier: {{issue.identifier}}
- Title: {{issue.title}}
- Current state: {{issue.state}}
- Branch: {{issue.branch}}
- Labels: {{issue.labels}}

## Description

{{issue.description}}

## Instructions

1. Unattended orchestration. Never ask a human for follow-up actions.
2. Only stop early for a true blocker (missing non-GitHub auth/secrets/tools after fallbacks). Record blocker in the workpad and move the issue per the escape hatch.
3. Final message reports completed actions and blockers only — no "next steps for the user".
4. Work only in the provided repository copy.

## Skills (progressive disclosure)

Repeatable mechanics live under `.agents/skills/symphony-<name>/SKILL.md` in this workspace (the canonical, runner-agnostic location; `.claude/skills` points there for Claude Code auto-discovery when the repo did not already have a Claude skills directory). Symphony injects bundled fallback copies after setup when the repo does not ship them. Reach for them by name — your runner will surface the right one on demand:

| Skill | Use when |
|---|---|
| `symphony-workpad` | finding, bootstrapping, updating, or resetting the Symphony Workpad on a Linear issue |
| `symphony-pull` | syncing the branch with `origin/main` and resolving conflicts |
| `symphony-commit` | creating a well-formed git commit from staged changes |
| `symphony-push` | pushing the branch and ensuring a PR exists with the `symphony` label |
| `symphony-pr-feedback` | sweeping the PR for actionable reviewer feedback before `In Review` |
| `symphony-screenshot` | capturing Playwright screenshots and embedding them in the PR description (commit + force-push pattern) |
| `symphony-land` | squash-merging the PR once approved and green (entered via `Merging`) |

This workflow tells you *which* skill applies at each step; the skill body has the exact commands and gotchas. Don't re-derive what's already in a skill.

## Environment

Facts about this run — do not waste turns rediscovering them.

- **Linear**: `$LINEAR_API_KEY` is exported into your environment by Symphony. If Linear MCP tools (`mcp__linear-server__*`) appear in your environment (e.g. configured by the target repo), use them; otherwise call the HTTP API directly: `curl -fsS -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" https://api.linear.app/graphql -d '{"query":"..."}'`. Do not spend turns probing — the HTTP path always works.
- **Linear MCP gotchas** (when MCP tools are present): `save_comment` with a `commentId` creates a NEW comment instead of updating in place — see the `symphony-workpad` skill for the GraphQL `commentUpdate` workaround. `create_attachment` only accepts file uploads (base64); for URL attachments (e.g., a PR link), the auto-link from `git push` usually suffices, otherwise use `attachmentLinkCreate` / `attachmentLinkGitHubPR` via GraphQL.
- **GitHub**: the `gh` CLI inherits the host's authentication when it is available. If `gh` auth is missing in a sandbox, provide `GITHUB_TOKEN`/`GH_TOKEN` so Symphony can fall back to the GitHub API for read-only checks. If `gh pr edit --add-label` 500s (a known Projects-classic GraphQL deprecation), apply labels via the REST API instead — the `symphony-push` skill covers this.
- **Workspace**: already `cd`'d into `<workspace root>/<IDENTIFIER>/`; the branch is checked out and the install command already ran via `after_create`. The `.symphony-workspace-ready` file at the workspace root is the init sentinel. Locally injected fallback skills under `.agents/skills/symphony-*` and `.claude/skills` may also be present. Ignore these runtime files in `git status` and never `git add` them unless the issue explicitly asks to install or change Symphony skills.
- **Deferred tools** (Claude backend): most runs need none. If you need `TodoWrite` or `WebFetch` for fresh implementation work, load them in a single call — `ToolSearch("select:TodoWrite,WebFetch")`. Skip this entirely on pickup / no-op redispatch runs; do not load `ScheduleWakeup` or `Monitor` — Symphony manages re-dispatch cadence and those tools are no-ops here.

## Attempt N > 1 fast-path

If this is a retry (the prompt ends with a `## Retry context` trailer, or the workpad already exists), do these **before** regenerating anything:

1. Read the existing `## Symphony Workpad` comment in full — it is the canonical state; the retry-context trailer may be empty or stale.
2. Run `git status && git log --oneline origin/main..HEAD` to see what prior attempts already committed. Pick up their work; do not re-do committed files.
3. Scan the workpad `### Confusions` and `### Notes` for known failure modes (content-filter hits, tool access, flaky tests) and avoid repeating them.
4. If the workpad's last-update timestamp is older than the prior attempt's start, prior attempts died mid-stream without persisting — rebuild your picture from repo state (committed files, open PR) rather than the workpad's plan alone.
5. **No-op redispatch short-circuit.** Only applies when the issue state is `Todo` or `In Progress` (NOT `Rework` — that always requires the full reset of Step 3, and NOT `Merging` — that always runs the Land procedure). Within those two states, the short-circuit fires only if **all** of the following hold:
   - Every Plan / Acceptance / Validation checkbox in the workpad is already ticked.
   - A PR is linked.
   - `gh pr view --json state,mergeable,mergeStateStatus,statusCheckRollup` shows the PR `OPEN`/`MERGED`, `mergeable` is `MERGEABLE` (NOT `CONFLICTING` or `UNKNOWN`), `mergeStateStatus` is `CLEAN`/`HAS_HOOKS`/`UNSTABLE` (NOT `DIRTY`/`BLOCKED` due to conflicts), and no checks have failed (`FAILURE`/`CANCELLED`/`TIMED_OUT`/`ACTION_REQUIRED`). Pending checks like `PR Reviews` are OK — we do not wait for human-gated checks.
   - `git log --oneline origin/main..HEAD` matches the workpad's recorded commits.
   - The `symphony-pr-feedback` sweep is clean: no unresolved or actionable top-level comments, inline comments, or review feedback remain.

   If any of those fail — especially a `CONFLICTING` / `DIRTY` PR — do NOT short-circuit. Drop into Step 1 and run the `symphony-pull` skill. If the only failing check is mergeability, the redispatch is specifically a "fix the conflicts" signal — treat it that way. If the PR feedback sweep is not clean, run the `symphony-pr-feedback` skill before doing new work or declaring no-op.

   When the short-circuit does apply, append a one-line `### Notes` entry (`no-op redispatch — work already complete on <short-sha> / PR #<n>`), move the Linear issue to `In Review`, verify the state changed, then shut down without re-running validation. Only re-engage if the on-disk state contradicts the workpad.

## Status routing

Route on the issue's current state. Before routing, check whether the branch PR exists and its status (affects pre-merge states only).

| State | Action |
|---|---|
| `Backlog` | Do not modify. Shut down. |
| `Todo` | Bootstrap workpad (`symphony-workpad` skill), then move to `In Progress`, run Step 1. If a PR is already attached: check `gh pr view --json mergeable,mergeStateStatus` first — a `CONFLICTING`/`DIRTY` PR is the most common reason for a Todo redispatch and the conflicts MUST be resolved (`symphony-pull` skill) before anything else. Then run the `symphony-pr-feedback` sweep before new work. |
| `In Progress` | Continue Step 1 from existing workpad. |
| `In Review` | Do not change code or content. Symphony does not re-engage on CI failure or new review comments while in this state — the operator must move the issue back to `Todo`/`In Progress`/`Rework` to re-engage. |
| `Merging` (PR already `MERGED`) | Skip land procedure; record merge SHA in workpad; move to `Done`. |
| `Merging` (any other PR state) | Run the `symphony-land` skill. |
| `Rework` | Run Step 3 (full reset). |
| `Done` | Shut down. |

**Branch-PR-closed guard** (pre-merge states only — `Todo`/`In Progress`/`Rework`): if the branch's PR is `CLOSED` or `MERGED`, prior branch work is non-reusable. Fresh branch from `origin/main`, restart from Step 1.

## Step 1: Setup and plan (Todo / In Progress)

1. **Workpad**: use the `symphony-workpad` skill to find or bootstrap the single `## Symphony Workpad` comment for this issue. Persist its comment ID. Never open a second workpad.
2. **Reconcile**: check off items already done; refresh Plan, Acceptance Criteria, and Validation to match current scope.
3. **Env stamp**: include a code-fence line at the top of the workpad: `<host>:<abs-workdir>@<short-sha>`. Example: `devbox-01:/tmp/symphony-workspaces/ENG-42@7bdde33bc`.
4. **Acceptance Criteria**: checklist form.
   - User-facing changes → include a UI walkthrough (launch path → interaction → expected result) as a required criterion.
   - If the ticket body has `Validation`, `Test Plan`, or `Testing` sections, copy them verbatim into Acceptance Criteria / Validation as required checkboxes. No optional downgrade.
5. **Reproduction signal**: capture the current behavior before changing code — command output, screenshot, or deterministic UI state — in `### Notes`.
6. **Sync**: run the `symphony-pull` skill to merge `origin/main` and resolve any conflicts before continuing. If a PR is already attached, also confirm `gh pr view --json mergeable,mergeStateStatus` reports `MERGEABLE` after pushing. Record result (`clean` / `conflicts resolved`) and the new short SHA in `### Notes`.
7. Proceed to Step 2.

## Step 2: Execute and publish

1. Implement against the workpad plan. Update the workpad after each milestone (reproduction done, code landed, validation run, feedback addressed). Never leave completed work unchecked.
2. Run required validation for the scope.
   - **Mandatory**: ticket-provided `Validation`/`Test Plan`/`Testing` items must pass. Unmet items = incomplete work.
   - Prefer a targeted proof that directly exercises the change.
   - Temporary local proof edits allowed; revert before commit; document in `### Validation`/`### Notes`.
   - User-facing → exercise the path locally and capture comprehensive evidence via the `symphony-screenshot` skill: full-page Playwright captures of every state worth reviewing (happy path, loading, error, mobile, hover) embedded in the PR description. Logs/CLI output supplement screenshots, they do not replace them.
3. **Cleanup test data.** Anything you created in external systems for testing — Linear issues, comments, attachments; non-issue GitHub branches, draft PRs, gists; database rows in shared instances; etc. — must be deleted before moving the issue to `In Review`. Do not delete the active issue branch, its PR, or issue-owned evidence/attachments needed for review. The end state must match the start state plus only the artifacts that belong to this issue. Test-data cleanup is mandatory; record the cleanup actions in `### Notes`.
4. **Before every push**: run required validation; rerun until green; use the `symphony-commit` skill to commit; use the `symphony-push` skill to publish.
5. The `symphony-push` skill handles attaching the PR URL to the issue and applying the `symphony` label. For user-facing changes, the `symphony-screenshot` skill embeds proof screenshots in the PR description via the commit + force-push pattern. The throwaway screenshot commit must be removed from branch history before transitioning to `In Review` — the skill handles this.
6. After review feedback or check failures: run the `symphony-pull` skill again to merge `origin/main`, then re-run validation.
7. Final workpad pass before `In Review`:
   - All plan / acceptance / validation checkboxes reflect reality.
   - Add `### Confusions` section only if something during execution was unclear.
   - Do not put the PR URL in the workpad (it's on the issue via attachment).
   - Do not post any additional "done"/summary comment.
8. **Gate before `In Review`**:
   - Read the PR's `Manual QA Plan` comment if present; sharpen UI/runtime coverage accordingly.
   - Run the `symphony-pr-feedback` skill.
   - No PR checks are failing on the latest commit (`FAILURE`/`CANCELLED`/`TIMED_OUT`/`ACTION_REQUIRED`). Pending checks (notably `PR Reviews`, which is human-gated and can take days) do **not** block the transition — reviewers own the wait.
   - All ticket-mandated validation items must be checked in the workpad.
   - For user-facing changes: confirm the `symphony-screenshot` flow ran and the PR description embeds full-page screenshots at raw GitHub URLs covering every state worth reviewing.
   - Confirm test data created during validation has been cleaned up.
   - Loop until no actionable comments remain and no checks are failing. Pending checks are fine — do not wait for `PR Reviews` or other human-gated checks to resolve.
9. Move to `In Review`. Exception: if blocked per the escape hatch below, move to `In Review` with the blocker brief.
10. If the ticket started as `Todo` with a PR already attached, ensure all existing PR feedback is resolved (run the `symphony-pr-feedback` skill) — code update OR explicit justified pushback reply — before moving.

### Escape hatch (blocked access)

Use only for genuine external blockers after fallbacks exhausted.

- **GitHub is not a valid blocker by default** — try alternate remote/auth first. Only escalate after fallbacks are documented in the workpad.
- For missing non-GitHub tools/auth, move the ticket to `In Review` with a blocker brief in the workpad: (a) what's missing, (b) why it blocks acceptance, (c) exact human action to unblock. No extra top-level comments.

## Step 3: Rework (full reset)

1. Re-read the full issue body and all human comments. Identify what to do differently.
2. Close the existing PR tied to this issue.
3. Run the `symphony-workpad` skill to **reset** the existing comment in place via the GraphQL `commentUpdate` workaround (one workpad per issue, ever — never delete it).
4. Fresh branch from `origin/main`.
5. Start over from Step 1.

## Land procedure (entered via `Merging`)

Run the `symphony-land` skill — it handles the approve/sync/squash-merge loop, the `Done` transition, and the `Rework` fallback when checks/conflicts can't be resolved.

## Guardrails

- **Boilerplate documents** (LICENSE, CODE_OF_CONDUCT, SECURITY templates, Contributor Covenant / Apache / MIT / GPL verbatim text): fetch from the authoritative URL with `curl -fsSL <URL> -o <file>`. Do **not** regenerate verbatim inline — upstream content filters may abort the turn silently. Canonical sources:
  - Apache-2.0 LICENSE: `https://www.apache.org/licenses/LICENSE-2.0.txt`
  - MIT LICENSE (template): `https://opensource.org/license/mit/`
  - Contributor Covenant 2.1: `https://www.contributor-covenant.org/version/2/1/code_of_conduct/code_of_conduct.md`
- Workpad is the single source of truth. One `## Symphony Workpad` comment per issue, ever. Do not edit the issue body/description for planning or progress. **The workpad comment is never test data and must not be deleted** — see the `symphony-workpad` skill for handling accidental duplicates.
- Do not post additional "done"/summary comments outside the workpad.
- Temporary proof edits must be reverted before commit.
- **Test data cleanup is mandatory.** Any artifacts created in external systems during testing (Linear issues/comments/attachments, non-issue GitHub branches/draft PRs/gists, rows in shared databases, etc.) must be deleted before transitioning to `In Review`. Do not delete the active issue branch, its PR, or issue-owned evidence/attachments needed for review. Leaving test residue is treated the same as leaving a temporary code edit unreverted.
- **Proof-of-testing screenshots must be Playwright-captured** for user-facing changes and embedded in the GitHub PR description via the `symphony-screenshot` skill. Default to full-page captures and document every state worth reviewing (happy path, loading, error, empty, mobile, hover) — one screenshot per state, not a single representative shot. Hand-cropped screenshots, `console.log` snippets, or text-only descriptions do not satisfy this requirement. The screenshot commit must not survive in branch history once the URLs are captured.
- Out-of-scope improvements → new Backlog issue (clear title / description / acceptance criteria, same project as current issue, `related` link to current, `blockedBy` if dependent).
- Never `--no-verify`, `git reset --hard`, `git push --force*`, or `git clean -f*` without an explicit ask.
- Never run `pkill`/`killall`/`pgrep -f` with a broad pattern (e.g. `pkill -f "next dev"`, `pkill -f node`). Agents share the host with the operator's Symphony app and with other workspaces' dev servers — unscoped matches kill *every* matching process, including the operator's. Scope cleanup to the port or the workspace: prefer `lsof -t -i :<PORT> | xargs -r kill` (handles the zero-match and multi-PID cases safely); when matching by command line, anchor to this workspace (`pkill -f 'next-server.*'"$ISSUE_IDENTIFIER"`). Same rule for `kill %1` / `kill %<jobspec>` only — those are scoped to the current shell.
- `In Review` / `Done` / `Backlog` → do not modify the issue or its code.
- Keep issue text concise, specific, reviewer-oriented.
- If blocked before any workpad exists, post a single blocker comment: blocker, impact, next unblock action.

## Completion bar (before `In Review`)

- Step 1/2 checklist fully reflected in the single workpad comment.
- Acceptance criteria and ticket-mandated validation items all checked.
- Validation/tests green for the latest commit.
- `symphony-pr-feedback` sweep clean (no actionable comments remain).
- PR checks green, branch pushed, PR linked on the issue, `symphony` label present.
- User-facing changes: `symphony-screenshot` skill ran; PR description embeds full-page screenshots covering every state worth reviewing; screenshot commit not present in branch history.
- All test data created during validation has been cleaned up; no residue left in Linear, GitHub, or shared backends.
