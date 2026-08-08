import type {
  AgentEventRow,
  AppSettings,
  IssueRow,
  Overview,
  RepoWorkflowStatus,
  RetroDetail,
  RetroReport,
  RetroRow,
  RetroStatus,
  RetroSuggestionRow,
  RunWithIssueRow,
  SkillsStatus,
} from "../bindings";
import { createEventStressFixture } from "./eventStressFixture";

const BUNDLED_SKILL_NAMES = [
  "symphony-commit",
  "symphony-land",
  "symphony-pr-feedback",
  "symphony-pull",
  "symphony-push",
  "symphony-screenshot",
  "symphony-workpad",
];

const previewSettings: AppSettings = {
  prompt_template:
    "# Workflow preview\n\nConnect through the Tauri desktop runtime to load and edit the saved default workflow.",
  repos: [
    {
      name: "widgets",
      url: "git@github.com:acme/widgets.git",
      install_cmd: null,
      is_default: true,
      skills_marked_installed: false,
    },
  ],
  workspace_root: null,
  tracker_workspace: "optimism-llc",
  tracker_team_keys: ["ENG"],
  tracker_project_ids: [],
  tracker_assigned_to_me: true,
  active_states: ["Todo", "In Progress", "Rework", "Merging"],
  terminal_states: ["Done", "Canceled"],
  polling_interval_ms: 30000,
  max_concurrent_agents: 3,
  max_retry_backoff_ms: 300000,
  hook_after_create:
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is literal shell parameter expansion.
    'git clone "$REPO_URL" .\ngit checkout -B "${ISSUE_BRANCH:-symphony/${ISSUE_IDENTIFIER}}"\neval "${SYMPHONY_INSTALL_CMD:-npm ci}"\n',
  hook_before_run: null,
  hook_after_run: null,
  hook_before_remove: null,
  hook_timeout_ms: 60000,
  agent_backend: "codex",
  codex_command: null,
  claude_command: null,
  turn_timeout_ms: 3600000,
  session_env: {},
  codex_permission_mode: "approve-for-me",
  codex_thread_sandbox: "workspace-write",
  codex_turn_sandbox_policy: "inherit",
  codex_network_access: true,
  claude_permission_mode: "auto",
  claude_allowed_tools: ["Bash(gh *)", "Bash(git status*)", "Bash(curl *)"],
  claude_disallowed_tools: [],
  claude_add_dirs: [],
  cursor_command: null,
  cursor_mode: "agent",
  cursor_force: true,
  cursor_trust: true,
  cursor_approve_mcps: false,
  cursor_sandbox: "enabled",
  cursor_model: null,
  opencode_command: null,
  opencode_model: null,
  opencode_agent: null,
  opencode_skip_permissions: true,
  linear_api_key_set: true,
};

const previewSkillsStatuses: Record<string, SkillsStatus> = {
  [previewSettings.repos[0].url.trim()]: {
    state: "missing",
    missing: BUNDLED_SKILL_NAMES,
    pr_url: null,
    detail: null,
  },
};

const previewWorkflowStatuses: Record<string, RepoWorkflowStatus> = {
  [previewSettings.repos[0].url.trim()]: {
    source: "default",
    filename: null,
    fallback_reason: "missing",
    detail: "No repository workflow was found on the default branch.",
    pr_url: null,
    can_transfer: true,
  },
};

function previewIso(offsetMs: number) {
  return new Date(Date.now() + offsetMs).toISOString();
}

const previewActiveStartedAt = previewIso(-18 * 60_000);
const previewActiveLastEventAt = previewIso(-90_000);
const previewFailureCreatedAt = previewIso(-3 * 60 * 60_000);
const previewFailureEndedAt = previewIso(-2 * 60 * 60_000);
const previewSuccessCreatedAt = previewIso(-26 * 60 * 60_000);
const previewSuccessEndedAt = previewIso(-25 * 60 * 60_000);
const previewRetryDueAt = previewIso(12 * 60_000);
const previewRateLimitResetAt = previewIso(38 * 60_000);
const previewUsageUpdatedAt = previewIso(-8 * 60_000);

const previewActiveRun: RunWithIssueRow = {
  id: "preview-run-active",
  issue_id: "preview-issue-sym-58",
  run_number: 4,
  workspace_path: "/tmp/symphony-workspaces/widgets/SYM-58",
  status: "running",
  started_at: previewActiveStartedAt,
  ended_at: null,
  error_class: null,
  error_message: null,
  worker_pid: 18422,
  session_info: JSON.stringify({
    model: "gpt-5",
    permission_mode: null,
    agent_version: null,
    output_style: null,
    fast_mode: null,
    thinking_tokens: 16400,
  }),
  repo_name: "widgets",
  created_at: previewActiveStartedAt,
  issue_identifier: "SYM-58",
  issue_title: "Ability to stop an individual run",
  issue_state: "In Progress",
};

const previewFailedRun: RunWithIssueRow = {
  id: "preview-run-failed",
  issue_id: "preview-issue-sym-61",
  run_number: 2,
  workspace_path: "/tmp/symphony-workspaces/widgets/SYM-61",
  status: "failure",
  started_at: previewFailureCreatedAt,
  ended_at: previewFailureEndedAt,
  error_class: "agent_failure",
  error_message: "Typecheck failed after applying the requested dashboard change.",
  worker_pid: null,
  session_info: JSON.stringify({
    model: "claude-sonnet-4-5",
    permission_mode: "auto",
    agent_version: "2.1.2",
    output_style: null,
    fast_mode: "on",
    thinking_tokens: 8200,
  }),
  repo_name: "widgets",
  created_at: previewFailureCreatedAt,
  issue_identifier: "SYM-61",
  issue_title: "Agent skills installation UX",
  issue_state: "Rework",
};

const previewSuccessRun: RunWithIssueRow = {
  id: "preview-run-success",
  issue_id: "preview-issue-sym-57",
  run_number: 1,
  workspace_path: "/tmp/symphony-workspaces/widgets/SYM-57",
  status: "success",
  started_at: previewSuccessCreatedAt,
  ended_at: previewSuccessEndedAt,
  error_class: null,
  error_message: null,
  worker_pid: null,
  session_info: null,
  repo_name: "widgets",
  created_at: previewSuccessCreatedAt,
  issue_identifier: "SYM-57",
  issue_title: "Install Symphony skills for routed repos",
  issue_state: "Done",
};

const previewStressRun: RunWithIssueRow = {
  ...previewSuccessRun,
  id: "preview-run-stress",
  issue_id: "preview-issue-stress",
  run_number: 1,
  workspace_path: "/tmp/symphony-workspaces/widgets/SYM-5000",
  status: "success",
  started_at: previewActiveStartedAt,
  ended_at: previewActiveLastEventAt,
  created_at: previewActiveStartedAt,
  issue_identifier: "SYM-5000",
  issue_title: "5,000-event performance stress fixture",
  issue_state: "In Review",
};

const previewRuns: RunWithIssueRow[] = [
  previewActiveRun,
  previewStressRun,
  previewFailedRun,
  previewSuccessRun,
];

const previewIssues: IssueRow[] = [
  {
    id: "preview-issue-sym-58",
    identifier: "SYM-58",
    title: "Ability to stop an individual run",
    description: "Add a per-run stop action while keeping the worker running.",
    priority: 2,
    state: "In Progress",
    branch: "codex/sym-58-stop-run",
    labels: JSON.stringify(["symphony", "ui"]),
    blockers: JSON.stringify([]),
    pr_urls: JSON.stringify([]),
    raw: JSON.stringify({
      id: "preview-issue-sym-58",
      identifier: "SYM-58",
      title: "Ability to stop an individual run",
      description: "Add a per-run stop action while keeping the worker running.",
      priority: 2,
      state: "In Progress",
      branch: "codex/sym-58-stop-run",
      labels: ["symphony", "ui"],
      blockers: [],
      pr_urls: [],
      project_id: null,
    }),
    last_seen_at: previewIso(-45_000),
  },
  {
    id: "preview-issue-sym-61",
    identifier: "SYM-61",
    title: "Agent skills installation UX",
    description: "Make the agent skills installation state clearer in Settings.",
    priority: 3,
    state: "Rework",
    branch: "codex/sym-61-skills-install-ux",
    labels: JSON.stringify(["ui", "skills"]),
    blockers: JSON.stringify(["SYM-60"]),
    pr_urls: JSON.stringify(["https://github.com/acme/widgets/pull/61"]),
    raw: JSON.stringify({
      id: "preview-issue-sym-61",
      identifier: "SYM-61",
      title: "Agent skills installation UX",
      description: "Make the agent skills installation state clearer in Settings.",
      priority: 3,
      state: "Rework",
      branch: "codex/sym-61-skills-install-ux",
      labels: ["ui", "skills"],
      blockers: ["SYM-60"],
      pr_urls: ["https://github.com/acme/widgets/pull/61"],
      project_id: null,
    }),
    last_seen_at: previewIso(-4 * 60_000),
  },
  {
    id: "preview-issue-sym-57",
    identifier: "SYM-57",
    title: "Install Symphony skills for routed repos",
    description: null,
    priority: 4,
    state: "Done",
    branch: "codex/sym-57-skills",
    labels: JSON.stringify(["skills"]),
    blockers: JSON.stringify([]),
    pr_urls: JSON.stringify(["https://github.com/acme/widgets/pull/57"]),
    raw: JSON.stringify({
      id: "preview-issue-sym-57",
      identifier: "SYM-57",
      title: "Install Symphony skills for routed repos",
      description: null,
      priority: 4,
      state: "Done",
      branch: "codex/sym-57-skills",
      labels: ["skills"],
      blockers: [],
      pr_urls: ["https://github.com/acme/widgets/pull/57"],
      project_id: null,
    }),
    last_seen_at: previewIso(-25 * 60 * 60_000),
  },
];

const previewEventsByRunId: Record<string, AgentEventRow[]> = {
  "preview-run-stress": createEventStressFixture(),
  "preview-run-active": [
    {
      id: 1,
      run_id: "preview-run-active",
      kind: "status",
      payload: JSON.stringify({ message: "Codex thread th_preview started" }),
      created_at: previewActiveStartedAt,
    },
    {
      id: 2,
      run_id: "preview-run-active",
      kind: "tool_call",
      payload: JSON.stringify({
        tool: "bash",
        args: { command: 'rg -n "stop_run|CancellationToken"' },
        call_id: "call-preview-search",
        result_summary: "exit 0",
      }),
      created_at: previewIso(-12 * 60_000),
    },
    {
      id: 3,
      run_id: "preview-run-active",
      kind: "humanized",
      payload: JSON.stringify({
        summary: "Wiring run-scoped cancellation through the worker manager.",
      }),
      created_at: previewIso(-7 * 60_000),
    },
    {
      id: 4,
      run_id: "preview-run-active",
      kind: "token_count",
      payload: JSON.stringify({
        input_tokens: 24800,
        output_tokens: 1900,
        total_tokens: 26700,
      }),
      created_at: previewActiveLastEventAt,
    },
  ],
  "preview-run-failed": [
    {
      id: 5,
      run_id: "preview-run-failed",
      kind: "error",
      payload: JSON.stringify({
        class: "agent_failure",
        message: "Typecheck failed after applying the requested dashboard change.",
      }),
      created_at: previewFailureEndedAt,
    },
  ],
  "preview-run-success": [
    {
      id: 6,
      run_id: "preview-run-success",
      kind: "status",
      payload: JSON.stringify({ message: "Run completed successfully" }),
      created_at: previewSuccessEndedAt,
    },
  ],
};

const previewOverview: Overview = {
  active_runs: [previewActiveRun],
  retry_queue: [
    {
      issue_id: "preview-issue-sym-61",
      run_number: 3,
      due_at: previewRetryDueAt,
      error_class: "agent_failure",
      error_message: "Typecheck failed after applying the requested dashboard change.",
      created_at: previewFailureEndedAt,
      issue_identifier: "SYM-61",
      issue_title: "Agent skills installation UX",
    },
  ],
  retry_count: 1,
  recent_failures: [previewFailedRun],
  failure_count: 1,
  workspace_cleanup_count: 2,
  live_sessions: [
    {
      run_id: "preview-run-active",
      session_id: "th_preview-tn_preview",
      thread_id: "th_preview",
      turn_id: "tn_preview",
      input_tokens: 24800,
      output_tokens: 1900,
      total_tokens: 26700,
      last_event_at: previewActiveLastEventAt,
      started_at: previewActiveStartedAt,
    },
  ],
  worker_heartbeat: {
    id: "worker",
    started_at: previewActiveStartedAt,
    last_beat_at: previewIso(-15_000),
    worker_pid: 18422,
  },
  rate_limits: [
    {
      source: "codex_primary",
      remaining: 210000,
      reset_at: previewRateLimitResetAt,
      updated_at: previewUsageUpdatedAt,
    },
  ],
  token_usage: [
    {
      source: "codex",
      input_tokens: 484200,
      output_tokens: 39200,
      total_tokens: 523400,
      run_count: 18,
      updated_at: previewUsageUpdatedAt,
    },
    {
      source: "claude",
      input_tokens: 211000,
      output_tokens: 26800,
      total_tokens: 237800,
      run_count: 7,
      updated_at: previewFailureEndedAt,
    },
  ],
};

const previewRetroReport: RetroReport = {
  id: "preview-retro-1",
  since_at: previewIso(-7 * 24 * 60 * 60_000),
  until_at: previewIso(-5 * 60_000),
  generated_at: previewIso(-4 * 60_000),
  run_count: 19,
  issue_count: 11,
  workpad_count: 10,
  repos: [
    {
      repo_name: "widgets",
      run_count: 12,
      issue_count: 7,
      workpad_count: 6,
      failure_count: 3,
      retry_count: 4,
      findings: [
        {
          title: "Workpad confusion: unclear whether screenshots are required",
          detail:
            "Agents repeatedly hesitated on whether UI evidence needed full-page Playwright screenshots or a shorter textual proof.",
          severity: "medium",
          occurrences: 3,
          evidence: [
            {
              issue_identifier: "SYM-61",
              run_id: null,
              run_number: null,
              event_id: null,
              kind: "workpad_confusion",
              summary: "unclear whether screenshots are required",
            },
            {
              issue_identifier: "SYM-58",
              run_id: "preview-run-active",
              run_number: 4,
              event_id: 3,
              kind: "humanized",
              summary: "Agent deferred screenshot proof until after implementation.",
            },
          ],
        },
        {
          title: "Runs failed with agent_failure",
          detail: "Typecheck failed after applying dashboard changes.",
          severity: "high",
          occurrences: 2,
          evidence: [
            {
              issue_identifier: "SYM-61",
              run_id: "preview-run-failed",
              run_number: 2,
              event_id: 5,
              kind: "error",
              summary: "Typecheck failed after applying the requested dashboard change.",
            },
          ],
        },
      ],
      suggestions: [
        {
          target_type: "skill",
          target_id: "symphony-screenshot",
          title: "Clarify screenshot evidence for widgets",
          body: "Add guidance to symphony-screenshot for when user-facing dashboard work requires full-page Playwright captures, including loading/error/mobile states.",
          rationale: "3 occurrences found in widgets with medium severity.",
          confidence: "high",
        },
        {
          target_type: "prompt",
          target_id: "common prompt",
          title: "Clarify validation timing for widgets",
          body: "Add guidance to the common prompt that typecheck/test validation should run before each push and after UI proof artifacts are cleaned up.",
          rationale: "2 occurrences found in widgets with high severity.",
          confidence: "high",
        },
      ],
    },
    {
      repo_name: "api",
      run_count: 7,
      issue_count: 4,
      workpad_count: 4,
      failure_count: 1,
      retry_count: 2,
      findings: [
        {
          title: "Workpad confusion: unclear auth setup for local API tests",
          detail:
            "Runs lost time rediscovering which environment variables were needed before integration tests could exercise authenticated routes.",
          severity: "low",
          occurrences: 1,
          evidence: [
            {
              issue_identifier: "API-24",
              run_id: null,
              run_number: null,
              event_id: null,
              kind: "workpad_confusion",
              summary: "unclear which auth token fixture should be used locally",
            },
            {
              issue_identifier: "API-27",
              run_id: "preview-run-api-retry",
              run_number: 2,
              event_id: 11,
              kind: "tool_call",
              summary: "test command failed because API_TEST_TOKEN was not set",
            },
          ],
        },
        {
          title: "Tool calls reported missing database migrations",
          detail:
            "The agent saw migration-related failures in repeated validation runs and had to infer the repo-specific setup order from shell output.",
          severity: "high",
          occurrences: 2,
          evidence: [
            {
              issue_identifier: "API-28",
              run_id: "preview-run-api-migrations",
              run_number: 1,
              event_id: 14,
              kind: "tool_call",
              summary: "cargo test failed until sqlx migrate run was executed",
            },
          ],
        },
      ],
      suggestions: [
        {
          target_type: "prompt",
          target_id: "common prompt",
          title: "Clarify repo setup discovery for api",
          body: "Add guidance that repo-specific validation prerequisites should be captured in the workpad after the first failed setup command, not repeatedly rediscovered on retries.",
          rationale: "1 occurrence found in api with low severity.",
          confidence: "low",
        },
        {
          target_type: "skill",
          target_id: "symphony-workpad",
          title: "Record validation prerequisites for api",
          body: "Add a workpad note pattern for persistent repo prerequisites such as auth fixtures, migration commands, or seeded services.",
          rationale: "2 occurrences found in api with high severity.",
          confidence: "high",
        },
      ],
    },
  ],
};

const previewRetros: RetroRow[] = [
  {
    id: previewRetroReport.id,
    since_at: previewRetroReport.since_at,
    until_at: previewRetroReport.until_at,
    status: "completed",
    run_count: previewRetroReport.run_count,
    issue_count: previewRetroReport.issue_count,
    report_json: JSON.stringify(previewRetroReport),
    error_message: null,
    created_at: previewRetroReport.generated_at,
    completed_at: previewRetroReport.generated_at,
  },
  {
    id: "preview-retro-0",
    since_at: previewIso(-14 * 24 * 60 * 60_000),
    until_at: previewRetroReport.since_at,
    status: "completed",
    run_count: 8,
    issue_count: 5,
    report_json: null,
    error_message: null,
    created_at: previewIso(-7 * 24 * 60 * 60_000),
    completed_at: previewIso(-7 * 24 * 60 * 60_000),
  },
];

const previewRetroStatus: RetroStatus = {
  state: "completed",
  retro_id: previewRetroReport.id,
  message: null,
  report: previewRetroReport,
  error: null,
};

const previewRetroSuggestions: RetroSuggestionRow[] = previewRetroReport.repos.flatMap(
  (repo, repoIndex) =>
    repo.suggestions.map((suggestion, findingIndex) => {
      const isPrompt = suggestion.target_type === "prompt";
      const targetPath = isPrompt
        ? "Settings → Prompt template"
        : `.agents/skills/${suggestion.target_id}/SKILL.md`;
      const guidance = `When this pattern occurs, resolve the root cause before completing the task and record the reusable validation step for ${repo.repo_name}.`;
      const documentTitle = isPrompt ? "Agent workflow" : "Skill guidance";
      const sectionTitle = isPrompt ? "Instructions" : "Steps";
      const existingInstruction = isPrompt
        ? "Implement the requested issue and validate the result."
        : "Follow the repository's established workflow.";
      const before = `# ${documentTitle}\n\n## ${sectionTitle}\n\n1. ${existingInstruction}\n`;
      const after = `${before.trimEnd()}\n2. ${guidance}\n`;
      return {
        id: `preview-suggestion-${repoIndex}-${findingIndex}`,
        retro_id: previewRetroReport.id,
        repo_name: repo.repo_name,
        repo_url: `https://github.com/acme/${repo.repo_name}.git`,
        finding_index: findingIndex,
        target_type: suggestion.target_type,
        target_id: suggestion.target_id,
        target_path: targetPath,
        title: suggestion.title,
        body: suggestion.body,
        rationale: suggestion.rationale,
        confidence: suggestion.confidence,
        guidance,
        before_content: before,
        after_content: after,
        unified_diff: [
          `--- a/${targetPath}`,
          `+++ b/${targetPath}`,
          "@@ -1,5 +1,6 @@",
          ` # ${documentTitle}`,
          " ",
          ` ## ${sectionTitle}`,
          " ",
          ` 1. ${existingInstruction}`,
          `+2. ${guidance}`,
        ].join("\n"),
        base_ref: "7c4a8d9preview",
        base_hash: "preview-base-hash",
        proposal_status: "ready",
        proposal_error: null,
        decision: "pending",
        decided_at: null,
        created_at: previewRetroReport.generated_at,
      };
    }),
);

const previewRetroDetail: RetroDetail = {
  row: previewRetros[0],
  report: previewRetroReport,
  suggestions: previewRetroSuggestions,
  batches: [],
};

function previewRetroDetailForId(id: string): RetroDetail | null {
  const row = previewRetros.find((retro) => retro.id === id);
  if (!row) return null;
  return {
    row,
    report: row.id === previewRetroReport.id ? previewRetroReport : null,
    suggestions: row.id === previewRetroReport.id ? previewRetroSuggestions : [],
    batches: [],
  };
}

export const previewRuntime = {
  settings: previewSettings,
  skillsStatuses: previewSkillsStatuses,
  workflowStatuses: previewWorkflowStatuses,
  eventsByRunId: previewEventsByRunId,
  retroStatus: previewRetroStatus,
  retros: previewRetros,
  retroDetail: previewRetroDetail,
  retroReportId: previewRetroReport.id,
  retroDetailForId: previewRetroDetailForId,
  dashboard: {
    overview: previewOverview,
    runs: previewRuns,
    issues: previewIssues,
    worker: {
      state: "running" as const,
      started_at: previewActiveStartedAt,
      last_error: null,
    },
    retroStatus: previewRetroStatus,
    retros: previewRetros,
    hasInProgressRetroBatches: previewRetroDetail.batches.some((batch) =>
      ["queued", "running"].includes(batch.state),
    ),
    requestedRunId: null,
    selectedRun: null,
    requestedRetroId: null,
    selectedRetroId: previewRetroReport.id,
    selectedRetro: previewRetroDetail,
  },
};
