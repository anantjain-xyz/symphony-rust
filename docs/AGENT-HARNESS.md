# Agent harness contract

This document defines who owns Symphony's agent instructions and how those
instructions reach an issue workspace. It is a maintenance contract for the
embedded prompt, bundled skills, repository-installed skills, and runtime
fallbacks.

The important distinction is between content shipped by the Symphony binary
and content owned by a target repository. A repository copy must never become
an accidental second source of truth for the bundle, and a runtime fallback
must never be committed as if the repository had adopted it.

## Sources of truth

| Artifact | Source for the running app | Ownership and change rule |
| --- | --- | --- |
| Default prompt | `src-tauri/assets/default-prompt.md`, loaded by `default_prompt_template()` | Symphony-owned. It supplies the initial editable prompt in Settings. |
| Bundled skill bodies | `src-tauri/assets/skills/<short-name>/SKILL.md`, embedded by `bundled_skills()` | Symphony-owned runtime bundle. The code comment records `symphony-ts` as the upstream authoring source, but these checked-in assets are the exact bytes shipped by this binary. |
| Bundled skill inventory | `bundled_skills()` in `src-tauri/src/lib.rs` | Symphony-owned. Every consumer must agree with this list. |
| Repository-installed skills | `.agents/skills/symphony-<name>/SKILL.md` in the target repository | Target-repository-owned. These may contain the one adaptation described below. |
| Claude discovery entries | `.claude/skills` or `.claude/skills/symphony-<name>` | Compatibility links or copies pointing at the canonical `.agents/skills` manifests. They are not independent procedure sources. |
| Runtime fallback skills | Missing `.agents/skills/symphony-<name>/SKILL.md` files injected into an issue workspace | Symphony-owned, ephemeral, refreshed from the current bundle on every dispatch, and never intended for commit. |
| Repository workflow | `SYMPHONY-WORKFLOW.md` or `symphony-workflow.md` on the target repository's default branch | Target-repository-owned prompt override. It changes the run prompt, not the bundled skill procedures. |

The bundle currently contains:

- `symphony-commit`
- `symphony-land`
- `symphony-pr-feedback`
- `symphony-pull`
- `symphony-push`
- `symphony-screenshot`
- `symphony-workpad`

The inventory is repeated in the desktop UI and preview fixtures for
presentation. Those copies describe the bundle; they do not own it.

## Content flow

### 1. Build and default settings

Tauri embeds the prompt and skill assets with `include_str!`. The default
prompt becomes the initial `AppSettings.prompt_template`, but users may edit
that setting. Starting a worker takes a fresh `bundled_skills()` snapshot and
passes it to the worker.

Changing a file under this repository's `.agents/skills` directory does not
change what the app embeds. Conversely, changing an embedded asset does not
silently update repository-installed skills.

### 2. Default-branch detection

Settings checks a GitHub or GHE repository's default branch for
`.agents/skills/<name>/SKILL.md`. A directory alone is not an install; the
manifest must be a blob.

The status has four meanings:

- `installed`: every bundled manifest exists.
- `pr_open`: one or more manifests are missing and the well-known install
  branch already has an open PR.
- `missing`: detection succeeded and at least one manifest is missing.
- `unavailable`: the repository, authentication, `gh`, or response could not
  be used. This is not equivalent to "missing."

The Settings action "Mark installed" suppresses exact-bundle warnings for a
repository that intentionally uses a different skill set. It is a UI
acknowledgement only. It does not alter fallback injection during dispatch.

### 3. Install PR

The installer clones the repository's default branch into the dedicated
skills-install workspace and writes the complete bundle under
`.agents/skills`. On Unix, a new `.claude/skills` entry points to
`.agents/skills`; when a real Claude skills directory already exists, the
installer adds per-skill compatibility entries instead. Windows may use
copies where creating symlinks requires extra privileges.

The bootstrap agent may make exactly one semantic adaptation:

> Replace the generic validation gate in `symphony-pull` and
> `symphony-push` with the target repository's real validation commands.

The substitution must obey all of these rules:

1. Derive the gate from authoritative repository files such as CI,
   `package.json`, `Cargo.toml`, or a Makefile.
2. Put the same gate in both skills.
3. Preserve command order where order affects generated files or test setup.
4. Do not change any other procedure, guardrail, frontmatter field, or skill
   name.
5. If the repository has no complete gate, use the closest meaningful subset
   and state that choice in the install PR.

Procedure changes, new skills, renamed skills, and altered safety rules belong
in the embedded assets first. They are not repository adaptations.

The install branch is `symphony/install-skills`. Installation must never
force-push, rewrite history, or modify files outside `.agents/skills` and the
Claude discovery entries.

### 4. Dispatch-time fallback

Before the ready sentinel is written and again immediately before agent
launch, `ensure_workspace_skills()` checks the committed `HEAD` tree:

- A tracked manifest, tracked skill entry, or tracked parent blob wins. The
  worker does not overwrite repository-owned content.
- A missing manifest is recreated from the current bundle. A stale untracked
  fallback is therefore refreshed on each dispatch.
- Injected manifests are explicitly unstaged and added to the worktree's
  Git exclude file.
- Existing tracked Claude discovery paths win. Missing untracked discovery
  links or entries are created and excluded.
- Unsafe or unexpected symlinks are replaced before the worker writes
  fallback content, so a repository path cannot redirect writes outside the
  workspace.

Fallbacks make the procedures available before an install PR is accepted.
They are runtime support files, not evidence that the target repository has
adopted the bundle. Agents must ignore them in `git status` and must not stage
them unless the issue explicitly asks to install or change Symphony skills.

## Prompt precedence

The effective prompt for an issue run is selected in this order:

1. `AppSettings.prompt_template`, initially populated from the embedded
   default prompt.
2. A valid `SYMPHONY-WORKFLOW.md` on the target repository's default branch,
   if present.
3. The last-known-good cached default-branch workflow when a refresh fails.
4. The Settings prompt when no valid repository workflow is available.
5. A retry-context trailer for attempts after the first.

The issue branch does not override the workflow. Resolution reads a fetched or
cached default-branch ref so an in-progress issue cannot silently rewrite its
own instructions.

The default prompt assumes that:

- the worker already routed the issue to the current repository and changed
  into its workspace;
- the `after_create` hook initialized the repository and dependencies before
  the ready sentinel was written;
- `LINEAR_API_KEY` is injected from the keychain;
- GitHub authentication is inherited from `gh` or supplied through supported
  session variables;
- Symphony, not the agent, owns polling and redispatch cadence; and
- the named skills hold repeatable command-level procedures, while the prompt
  selects which procedure applies.

Changes to any of those runtime facts require a matching prompt update.

## Discovery and backend assumptions

`.agents/skills` is the runner-neutral canonical location in a target
repository.

- Codex and Cursor can discover repository skills there.
- Claude Code receives `.claude/skills` compatibility discovery in addition
  to the canonical manifests.
- Other adapters still receive the default prompt's explicit paths and skill
  names even when they do not provide native progressive-disclosure support.

Skill availability does not grant filesystem or network access. The selected
adapter's sandbox and permission flags remain authoritative. In particular:

- a skill that says to push cannot make a read-only session writable;
- a GitHub token does not itself give the Git transport credentials needed by
  `git push`;
- adding a discovery link must not broaden the adapter's allowed directories;
  and
- repository-local Codex or Claude configuration may further restrict a run.

The repository's own `.codex/config.toml` may configure Codex tooling that
honors repository-local settings. Symphony's native adapter also supplies
explicit per-run flags. Do not assume one file describes every backend's
effective permissions; use the adapter contract and the saved app settings
together.

## Authentication and secret handling

Skill files and prompts may name environment variables, but must never contain
credential values. The worker injects only the runtime coordinates and
configured session variables required by the run. When an explicit GitHub
token is supplied, the adapter removes inherited GitHub token variants before
applying the request environment, preventing a stale inherited credential
from taking precedence.

Detection can use authenticated `gh` or a supported API token. Clone and push
still require Git transport credentials. Report those cases separately:
"repository inaccessible," "API fallback available," and "Git push
credentials missing" lead to different recovery actions.

## Change checklist

When changing the harness:

1. Decide whether the change belongs to the default prompt, a bundled
   procedure, a target-repository workflow, or an adapter.
2. Update the embedded asset that the app actually ships.
3. Keep the bundled inventory synchronized with Settings, preview fixtures,
   prompt references, and frontmatter names.
4. Preserve the validation-gate substitution as the only allowed difference
   between a generic bundled `pull`/`push` skill and a repository-installed
   copy.
5. Exercise tracked manifests, missing fallbacks, stale fallbacks, linked
   worktrees, existing Claude directories, and hostile symlinks.
6. Confirm runtime fallback files remain unstaged and excluded.
7. If a procedure changed, update this repository's own installed
   `.agents/skills/symphony-*` copy separately; it is a consumer of the
   bundle, not an embedding source.
8. Review the default prompt for any runtime assumption that changed.
