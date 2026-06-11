# Symphony

**An autonomous engineering team for your Linear project.** Symphony is a desktop app that watches your Linear board and dispatches coding agents — [Codex](https://github.com/openai/codex) or [Claude Code](https://claude.com/claude-code) — to work on issues, each in its own freshly cloned workspace. You triage and review; Symphony orchestrates.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/overview-dark.png">
  <img alt="Symphony dashboard showing active agent runs, the retry queue, and provider rate limits" src="docs/overview-light.png">
</picture>

## How it works

1. **Poll** — a local worker polls Linear for issues in the states you mark as active (e.g. `Todo`, `In Progress`, `Rework`).
2. **Prepare** — for each issue, Symphony creates an isolated workspace and runs your `after_create` hook (typically `git clone` + dependency install).
3. **Dispatch** — it renders your prompt template with the issue's identifier, title, state, and description, then drives a Codex or Claude Code session natively over their structured event streams.
4. **Track** — every agent event, token count, retry, failure, and provider rate-limit signal is recorded in a local SQLite database and streamed live to the dashboard.
5. **Retry** — failed runs are retried with exponential backoff, and the retry prompt includes the previous run's error context.

Everything runs on your machine. The only network calls are to Linear's API and whatever your agents and hooks do.

## Requirements

- **macOS** (primary target; Tauri builds for other platforms are untested)
- A [Linear](https://linear.app) workspace and a [personal API key](https://linear.app/settings/account/security)
- At least one agent CLI installed and authenticated:
  - `codex` — OpenAI Codex CLI
  - `claude` — Claude Code CLI
- `git`, plus whatever your repository's install step needs

## Getting started

Build and run from source (a packaged download is planned):

```sh
git clone https://github.com/anantjain-xyz/symphony-rust.git
cd symphony-rust
pnpm install
pnpm tauri dev      # or: pnpm tauri build
```

On first launch the Overview shows a setup checklist:

1. **Connect Linear** — paste your API key in *Settings → Linear*. It is stored in the macOS keychain, never on disk.
2. **Add your repository** — the Git URL each run clones into its workspace.
3. **Start the worker** — the ▶ button in the top bar. Symphony begins polling and dispatching.

Optional Linear filters (workspace slug, project ID, identifier prefix like `ENG`) narrow which issues Symphony picks up. Use **Validate** in Settings to check your workflow file and confirm the agent CLIs are discoverable before starting.

## The workflow file

Symphony's behavior is defined by a single document you can edit in *Settings → Workflow*: YAML front matter for configuration, followed by the prompt template sent to the agent.

```yaml
---
tracker:
  kind: linear
  api_key: ${LINEAR_API_KEY}          # ${VARS} are interpolated from the app environment
  workspace: ${SYMPHONY_LINEAR_WORKSPACE}
  identifier_prefix: ${SYMPHONY_TRACKER_PREFIX}
  project_id: ${SYMPHONY_TRACKER_PROJECT_ID}
  active_states: [Todo, In Progress, Rework, Merging]   # issues here get an agent
  terminal_states: [Done, Canceled]                     # issues here are left alone
polling:
  interval_ms: 30000
workspace:
  root: ${TMPDIR}                     # where per-run workspaces are created
hooks:
  after_create: |                     # runs in the fresh workspace before the agent starts
    git clone "$REPO_URL" .
    ${SYMPHONY_INSTALL_CMD:-npm ci}
  timeout_ms: 60000
agent:
  backend: ${SYMPHONY_AGENT_BACKEND}  # codex | claude
  max_concurrent_agents: 3
  max_retry_backoff_ms: 300000
codex:
  command: ${SYMPHONY_CODEX_COMMAND:-codex}   # launch command — wrappers OK
  approval_policy: never              # agents run unattended
  thread_sandbox: workspace-write
  network_access: false
claude:
  command: ${SYMPHONY_CLAUDE_COMMAND:-claude} # launch command — wrappers OK
  permission_mode: acceptEdits
  turn_timeout_ms: 3600000
---
You are working on Linear issue {{issue.identifier}}.

Title: {{issue.title}}
State: {{issue.state}}

Description:
{{issue.description}}
```

Notes:

- `${VAR}` references are filled from the app's environment. Symphony injects `LINEAR_API_KEY` (from the keychain), `REPO_URL`, `SYMPHONY_LINEAR_WORKSPACE`, `SYMPHONY_TRACKER_PREFIX`, `SYMPHONY_TRACKER_PROJECT_ID`, `SYMPHONY_INSTALL_CMD`, `SYMPHONY_AGENT_BACKEND`, `SYMPHONY_CODEX_COMMAND`, and `SYMPHONY_CLAUDE_COMMAND` from your Settings. Unset variables become empty strings.
- **Hooks are the exception**: `hooks` values are *not* interpolated at parse time — they run as shell scripts with the same variables available in their environment, so `$REPO_URL` and `${SYMPHONY_INSTALL_CMD:-npm ci}` resolve at execution.
- Available hooks: `after_create`, `before_run`, `after_run`, `before_remove`.
- Prompt placeholders: `{{issue.id}}`, `{{issue.identifier}}`, `{{issue.title}}`, `{{issue.description}}`, `{{issue.state}}`, `{{issue.branch}}`.
- Retried runs automatically get a `## Retry context` section appended with the prior run's error and recent events.
- The `codex.command` / `claude.command` launch commands come from the Settings "Launch command" field and may be wrappers with arguments (e.g. `mycode --agent claude`); Symphony appends its own CLI flags after them.

## Data and security

- Your Linear API key lives in the **OS keychain**, not in any file.
- Runs, issues, and agent events are stored in a local **SQLite** database under the app data directory (`~/Library/Application Support/xyz.anantjain.symphony` on macOS), alongside daily-rotated logs and per-run workspaces.
- Agents run with the sandbox/permission settings you give them in the workflow file. The defaults (`approval_policy: never`, `permission_mode: acceptEdits`, no network for Codex) are tuned for unattended runs in disposable workspaces — review them before pointing Symphony at anything sensitive.

## Architecture

- `src-tauri/` — Tauri desktop shell, commands, keychain-backed settings, event forwarding
- `src/` — React dashboard (Overview, Runs, Issues, Settings)
- `crates/symphony-core` — domain types, workflow parsing, prompt rendering
- `crates/symphony-storage` — SQLite schema, repository, broadcast event bus
- `crates/symphony-tracker` — Linear GraphQL client and issue normalization
- `crates/symphony-agents` — native Codex and Claude process drivers
- `crates/symphony-worker` — recovery, polling loop, retries, hooks, workspace lifecycle

## Development

```sh
pnpm install
pnpm tauri dev            # run the app
pnpm typecheck && pnpm test && cargo test --workspace
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor guide, including bindings regeneration and packaging.

## License

[MIT](LICENSE)
