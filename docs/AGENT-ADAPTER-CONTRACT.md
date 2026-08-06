# Agent adapter contract

Symphony supports Codex, Claude Code, Cursor, and OpenCode through one native
driver boundary in `crates/symphony-agents`. This document describes the
behavior Symphony depends on without reproducing provider transcripts or
rollout data.

The contract has two purposes:

- keep provider-specific CLI protocols from leaking into worker lifecycle
  code; and
- make success, failure, cancellation, usage, and permissions comparable
  enough for storage and the UI.

## Common interface

`AgentDriver::run` receives:

- the selected backend and configured command;
- the worker-supplied workspace path;
- the fully rendered prompt;
- adapter-specific sandbox, permission, model, and tool settings;
- a turn timeout;
- explicit runtime/session environment variables;
- a normalized event channel; and
- a cancellation token.

It returns `AgentRunResult` with stable thread/turn identifiers, an
`AgentOutcome`, and optional error class/message.

The default desktop workspace root and roots beginning with a standalone `~`
make that path absolute. Other nonempty configured workspace roots are retained
verbatim and may be relative. Adapters must not rely on `cwd` being absolute
until configuration normalizes or rejects every relative root.

The worker must know nothing about provider JSON field names. Adapters map
their streams into:

- `status`
- `tool_call`
- `approval`
- `token_count`
- `error`
- `rate_limit`
- session metadata

The storage layer persists normalized payloads and separately generated
human-readable summaries. It does not persist each provider stdout line as an
opaque transcript.

## Process contract

All native adapters share these process rules:

1. The configured command is launched through `/bin/sh -lc`; Symphony appends
   shell-quoted adapter arguments. A configured command may therefore be a
   wrapper plus its own fixed arguments.
2. The working directory is the issue workspace.
3. The prompt is written through stdin, not placed in argv. This supports
   large issue prompts and keeps prompt text out of process listings.
4. Stdout is the structured event channel. A missing stdout pipe is a missing
   result.
5. The process inherits the app environment plus the request overlay.
   `LINEAR_API_KEY`, repository coordinates, supported GitHub credentials,
   and configured session variables are injected by the worker.
6. When the request includes a nonempty GitHub token, all inherited GitHub
   token variants are removed before the request values are applied. This
   prevents stale inherited credentials from winning by provider-specific
   precedence.
7. On Unix, the shell leads a dedicated process group. Timeout and
   cancellation signal the entire group with `TERM`, wait briefly, then use
   `KILL` for survivors.
8. Child processes use Tokio kill-on-drop as a last resort, but that mechanism
   kills only the immediate shell. Unlike the explicit timeout and
   cancellation paths, it does not signal the process group, so dropping a
   driver future can currently leave an agent descendant, tool server, or
   language server alive. The proposed invariant is for drop to terminate the
   whole group as well.

Cancellation returns `AgentOutcome::Cancelled` with class `cancelled`.
Timeout is an `AgentError::Timeout`, not a provider-reported result. Spawn,
I/O, JSON parsing, and missing-result failures are also `AgentError` variants.

## Backend matrix

| Backend | Structured mode | Completion boundary | Identifier source | Permission/sandbox source |
| --- | --- | --- | --- | --- |
| Codex | `exec --json` | `turn.completed` or `turn.failed` selects a result; stdout EOF and process exit complete the run | Symphony fallback IDs; provider thread ID is surfaced in status | Normalized Codex thread/turn sandbox |
| Claude Code | print mode with `stream-json --verbose` | `result` selects a result; stdout EOF and process exit complete the run | Preallocated session ID | Claude permission mode plus allowed/disallowed tools and additional directories |
| Cursor | print mode with `stream-json` | `result` completes the run and triggers process-group cleanup; stdout EOF enters an unbounded process-exit fallback | `system/init` session ID or Symphony fallback | Cursor mode, `--force`, trust, MCP approval, and sandbox |
| OpenCode | `run --format json` | Process exit; error events record failure | Event `sessionID` or Symphony fallback | `--dangerously-skip-permissions` and optional agent/model |

Codex and Claude protocol result records are not early process-termination
signals in the current adapters. They save the parsed result, continue reading
until stdout closes, and then await the shell's exit. If a configured wrapper
or descendant keeps stdout open past the turn deadline, timeout wins and the
saved result is discarded. Cursor deliberately differs: its `result` record
stops reading, terminates the process group, and returns immediately.

## Codex

The Codex adapter invokes:

```text
codex exec --json --skip-git-repo-check -C <workspace> <sandbox flags>
```

The configured command may replace `codex`.

Sandbox normalization applies the per-turn policy first and the thread policy
when the turn inherits:

- `danger-full-access` adds
  `--dangerously-bypass-approvals-and-sandbox`;
- `workspace-write` adds `--full-auto`, exposes external Git metadata
  directories required by linked worktrees, and optionally enables network
  access in the workspace-write sandbox;
- `read-only` adds `-s read-only`.

`ThreadSandbox::None` inherits as read-only unless the turn explicitly selects
a different policy. The current `AgentRunRequest` does not carry
`ApprovalPolicy`; effective approval behavior comes from the flags above. Do
not assume the saved Codex approval setting is independently forwarded until
the request and adapter explicitly support it.

The adapter maps command execution items into `tool_call` events. Agent message
content becomes bounded status text. A completed turn emits one token total
and any structured rate-limit buckets before success.

Codex already reports cached input and reasoning output as subsets of its
input/output totals. The adapter must not add those fields again.

`turn.failed` is failure. A leading usage-limit notice is classified as
`rate_limited`, with a locally interpreted reset time when Codex supplies one.
Other failures preserve the provider error type when available.

If the process exits without a protocol result, exit zero is success and a
nonzero exit is `nonzero_exit`. A `turn.completed` or `turn.failed` result is
returned only after stdout closes and the process exits before the timeout.

## Claude Code

The Claude adapter invokes print mode with:

```text
claude -p --output-format stream-json --verbose --session-id <id>
```

It also forwards:

- `--permission-mode`;
- comma-separated `--allowedTools` and `--disallowedTools` when configured;
- the workspace `.git` path via `--add-dir`; and
- each configured additional directory.

The worker preallocates the session ID before launch so a live session can be
shown before Claude emits `system/init`.

Claude's init event supplies model, permission mode, CLI version, output
style, and fast-mode metadata. A reported permission mode different from the
requested mode makes the session unusable: the adapter emits
`permission_mode_dropped`, terminates the process group, and returns failure.

Some Claude versions omit the effective mode from init. In that case, the
adapter watches workspace write denials for auto-accepting modes:

- if every attempted workspace write is denied and none succeeds, the run
  fails as `write_permission_denied`;
- a confirmed mode or any successful write disarms that heuristic, because a
  later denial may be legitimate repository policy.

Tool-use and tool-result records share the provider call ID. Permission
failures also emit an `approval` event for visibility.

On `result`, cache creation and cache read tokens are added to input tokens.
Output tokens remain the provider output total. Thinking-token estimates are
session metadata updates and are persisted even when a run later times out or
is cancelled.

Claude can report a subscription limit in a nominally successful result or an
API limit in text. Anchored limit notices are classified as `rate_limited`.
A result subtype of success is still failure when the final assistant text is
a leading API error or when the permission checks above fail.

Malformed JSON is an adapter protocol error. If no result record arrives,
process exit is the fallback outcome. A parsed `result` is still provisional
until stdout closes and the process exits before the timeout.

## Cursor

The Cursor adapter invokes:

```text
agent -p --output-format stream-json --workspace <workspace>
```

The configured command may replace `agent`. Depending on settings it adds:

- `--force`;
- `--trust`;
- `--approve-mcps`;
- `--mode plan` or `--mode ask` (agent mode is the default);
- `--sandbox enabled|disabled`; and
- `--model <model>`.

Agent mode is the writable workflow mode. Plan and Ask are intended for
read-only work. `--force` and `--trust` avoid interactive approval and
workspace-trust prompts; MCP approval is separate.

`system/init` may replace Symphony's fallback session ID and supplies model
and permission metadata. Assistant text becomes bounded status. Both Cursor's
wrapped `<name>ToolCall` shape and the function-call fallback shape map to
normalized `tool_call` events.

Cursor reports cache read/write buckets separately, so both are added to input
tokens. A successful `result` with `is_error` false is success. Anchored API
or usage-limit text is `rate_limited`; other result subtypes become failure.

The result record is terminal even if `cursor-agent` remains alive waiting on
an MCP subprocess. The adapter stops reading, kills the process group, and
returns the parsed result. This prevents a completed turn from being
misclassified as a timeout.

If stdout closes without a result, the process exit status is the fallback.
The current implementation leaves the timeout/cancellation `select!` as soon
as stdout closes and then awaits `child.wait()` outside that arbitration. A
wrapper that closes stdout but keeps the shell alive can therefore hold the
run and its concurrency slot indefinitely; turn timeout and later Stop
requests do not interrupt this wait. Keeping the exit fallback inside the
same timeout/cancellation arbitration is an intended invariant, not current
behavior. Malformed JSON is an adapter protocol error.

## OpenCode

The OpenCode adapter invokes:

```text
opencode run --dir <workspace> --format json
```

It optionally adds `--model` and `--agent`. By default it also adds
`--dangerously-skip-permissions`; noninteractive OpenCode otherwise
auto-rejects permission requests and cannot perform an unattended writable
run.

OpenCode's verbose log mode is intentionally not enabled. The adapter drains
stderr so a chatty provider or plugin cannot fill the pipe and block stdout.

OpenCode may print human-readable warnings to stdout despite JSON mode. The
adapter ignores non-JSON lines except an "agent not found; falling back"
diagnostic. Silently replacing a configured restricted agent with a writable
default would violate operator intent, so that diagnostic becomes
`agent_not_found` and terminates the process.

There is no terminal JSON event in this mode. Text, reasoning, tool use, step
finish, and error records update stream state; process exit determines when
the run is complete. A recorded error wins over the exit fallback.

Each `step_finish` carries step-local usage. The adapter accumulates all steps
and emits one run total after stdout drains:

- input = input + cache read + cache write;
- output = output + reasoning.

This prevents the storage layer from counting steps as separate runs or
overwriting a run total with only the final step.

A 429 status or anchored usage-limit message is `rate_limited`. Other error
records preserve their provider error name. A clean exit with no recorded
error is success; a nonzero exit is `nonzero_exit`.

## Outcome precedence

Adapters and the worker apply outcomes in this order:

1. User/worker cancellation observed before commit.
2. Adapter timeout or transport/protocol error.
3. Provider terminal failure, including rate limits and permission integrity
   failures.
4. Provider terminal success.
5. Process exit fallback when the protocol has no usable terminal result.

Normalized events sent immediately before an adapter returns must be drained
and persisted before the run is finished. In particular, token and rate-limit
events must not be lost at the terminal boundary.

Provider text that merely discusses rate limits must not change the outcome.
Text detectors are anchored to known leading notices; structured status codes
take precedence when available.

## Adding or changing an adapter

An adapter change is incomplete until it demonstrates:

1. Prompts use stdin and all appended arguments are shell-quoted.
2. The configured wrapper command still works.
3. Success, explicit failure, nonzero exit, missing result, malformed output,
   timeout, and cancellation have deterministic outcomes.
4. Cancellation kills descendants, not only the parent shell.
5. Future-drop behavior is tested separately from explicit cancellation and
   cannot orphan descendants.
6. Session identifiers remain stable after the first provider identifier is
   observed.
7. Tool calls have stable names, call IDs where available, bounded summaries,
   and no invented success.
8. Token accounting documents whether cache/reasoning buckets are subsets or
   additional buckets.
9. Rate-limit detection cannot be triggered by ordinary prose.
10. Permission or sandbox settings are verified when the provider reports
   their effective value.
11. Terminal events are not lost when the provider keeps a subprocess alive
    or exits immediately afterward.
12. Request environment precedence cannot leak an inherited credential over
    an explicit session credential.
13. Tests use synthetic provider events and sanitized fixtures rather than
    copied private transcripts.
