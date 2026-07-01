import { getVersion } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { InputHTMLAttributes } from "react";
import type {
  AgentEventRow,
  AppSettings,
  IssueRow,
  LinearViewerProfile,
  Overview,
  RepoConfig,
  RetroDetail,
  RetroReport,
  RetroRow,
  RetroStatus,
  RunDetail,
  RunWithIssueRow,
  SkillsInstallStatus,
  SkillsStatus,
  TrackerTestResult,
  ValidationResult,
  WorkerStatus,
} from "./bindings";
import {
  describeEvent,
  formatTokens,
  nullable,
  parseSessionInfo,
  prettyPayload,
  priorityLabel,
  providerRateLimits,
  providerTokenUsage,
  relativeTime,
  shortTime,
  statusSlug,
  timeOnly,
} from "./format";
import {
  MarkdownText,
  countMarkdownMatches,
  countMatches,
  highlightMatches,
} from "./MarkdownText";
import "./App.css";

type View = "overview" | "runs" | "issues" | "retro" | "settings";
type Theme = "light" | "dark";
type IssueViewMode = "list" | "dependencies";

const DEPENDENCY_NODE_WIDTH = 216;
const DEPENDENCY_NODE_HEIGHT = 86;
const DEPENDENCY_LAYER_GAP = 92;
const DEPENDENCY_ROW_GAP = 18;
const DEPENDENCY_PADDING = 24;

const THEME_STORAGE_KEY = "symphony-theme";
const GITHUB_URL = "https://github.com/anantjain-xyz/symphony-rust";
const SETTINGS_FORM_ID = "settings-form";
const IS_LOCAL_DEV = import.meta.env.DEV;
const literalInputProps = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "none",
  spellCheck: false,
} as const;

type SettingsNumberInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "type" | "value"
> & {
  emptyValue?: number;
  minValue: number;
  value: number;
  onValidChange: (value: number) => void;
};

function SettingsNumberInput({
  value,
  emptyValue = 0,
  minValue,
  onValidChange,
  onBlur,
  onFocus,
  ...inputProps
}: SettingsNumberInputProps) {
  const formattedValue = String(value);
  const [draft, setDraft] = useState(formattedValue);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(formattedValue);
  }, [focused, formattedValue]);

  const commitIfValid = (input: HTMLInputElement, { allowEmpty = false } = {}) => {
    if (input.value.trim() === "") {
      if (!allowEmpty) return false;
      onValidChange(emptyValue);
      setDraft(String(emptyValue));
      return true;
    }
    const n = input.valueAsNumber;
    if (!Number.isFinite(n) || n < minValue) return false;
    onValidChange(n);
    return true;
  };

  return (
    <input
      {...literalInputProps}
      {...inputProps}
      type="number"
      required
      value={draft}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onChange={(event) => {
        setDraft(event.currentTarget.value);
        commitIfValid(event.currentTarget);
      }}
      onBlur={(event) => {
        setFocused(false);
        if (!commitIfValid(event.currentTarget, { allowEmpty: true })) {
          setDraft(formattedValue);
        }
        onBlur?.(event);
      }}
    />
  );
}
const BUNDLED_SKILL_NAMES = [
  "symphony-commit",
  "symphony-land",
  "symphony-pr-feedback",
  "symphony-pull",
  "symphony-push",
  "symphony-screenshot",
  "symphony-workpad",
];
const BUNDLED_SKILL_COUNT = BUNDLED_SKILL_NAMES.length;
const BUNDLED_SKILL_EXAMPLES = "symphony-workpad, symphony-commit, symphony-push";

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const toggle = () => setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  return [theme, toggle];
}

const emptyOverview: Overview = {
  active_runs: [],
  retry_queue: [],
  recent_failures: [],
  live_sessions: [],
  worker_heartbeat: null,
  rate_limits: [],
  token_usage: [],
};

const emptyRetroStatus: RetroStatus = {
  state: "idle",
  retro_id: null,
  message: null,
  report: null,
  error: null,
};

const previewSettings: AppSettings = {
  prompt_template:
    "# Prompt preview\n\nConnect through the Tauri desktop runtime to load and edit the saved prompt template.",
  repos: [
    {
      name: "widgets",
      url: "git@github.com:acme/widgets.git",
      install_cmd: null,
      team_prefixes: ["ENG"],
      project_ids: [],
      is_default: true,
      skills_marked_installed: false,
    },
  ],
  workspace_root: null,
  tracker_workspace: "optimism-llc",
  tracker_prefix: null,
  tracker_project_id: null,
  tracker_assigned_to_me: false,
  active_states: ["Todo", "In Progress", "Rework", "Merging"],
  terminal_states: ["Done", "Canceled"],
  polling_interval_ms: 30000,
  max_concurrent_agents: 3,
  max_retry_backoff_ms: 300000,
  hook_after_create:
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
  codex_approval_policy: "never",
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

const previewRuns: RunWithIssueRow[] = [
  previewActiveRun,
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
        args: { command: "rg -n \"stop_run|CancellationToken\"" },
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
  recent_failures: [previewFailedRun],
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
          body:
            "Add guidance to symphony-screenshot for when user-facing dashboard work requires full-page Playwright captures, including loading/error/mobile states.",
          rationale: "3 occurrences found in widgets with medium severity.",
          confidence: "high",
        },
        {
          target_type: "prompt",
          target_id: "common prompt",
          title: "Clarify validation timing for widgets",
          body:
            "Add guidance to the common prompt that typecheck/test validation should run before each push and after UI proof artifacts are cleaned up.",
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
          severity: "medium",
          occurrences: 2,
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
          body:
            "Add guidance that repo-specific validation prerequisites should be captured in the workpad after the first failed setup command, not repeatedly rediscovered on retries.",
          rationale: "2 occurrences found in api with medium severity.",
          confidence: "medium",
        },
        {
          target_type: "skill",
          target_id: "symphony-workpad",
          title: "Record validation prerequisites for api",
          body:
            "Add a workpad note pattern for persistent repo prerequisites such as auth fixtures, migration commands, or seeded services.",
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

const previewRetroDetail: RetroDetail = {
  row: previewRetros[0],
  report: previewRetroReport,
};

function previewRetroDetailForId(id: string): RetroDetail | null {
  const row = previewRetros.find((retro) => retro.id === id);
  if (!row) return null;
  return {
    row,
    report: row.id === previewRetroReport.id ? previewRetroReport : null,
  };
}

// Mirrors PROMPT_VARIABLES in symphony-core (crates/symphony-core/src/prompt.rs).
const PROMPT_VARIABLES: { name: string; description: string; example: string }[] = [
  { name: "issue.identifier", description: "Issue key", example: "SYM-42" },
  { name: "issue.title", description: "Issue title", example: "Add user login" },
  { name: "issue.description", description: "Full issue body; empty if none", example: "" },
  { name: "issue.state", description: "Current Linear state", example: "Todo" },
  { name: "issue.branch", description: "Git branch from Linear; may be empty", example: "symphony/SYM-42" },
  { name: "issue.labels", description: "Labels, comma-separated", example: "bug, ui" },
  { name: "issue.blockers", description: "Blocking issues, one bullet per line", example: "- SYM-41" },
  { name: "issue.id", description: "Internal Linear ID", example: "" },
  { name: "repo.name", description: "Name of the repo this issue routed to", example: "widgets" },
  { name: "repo.url", description: "Git URL of the routed repo", example: "git@github.com:org/repo.git" },
];

function anyRepoConfigured(settings: AppSettings): boolean {
  return settings.repos.some((repo) => repo.url.trim() !== "");
}

// Unique trimmed URLs of the configured repos — the key space for per-repo
// skills statuses (two cards with the same URL share one status).
function configuredRepoUrls(settings: AppSettings): string[] {
  return Array.from(
    new Set(settings.repos.map((repo) => repo.url.trim()).filter((url) => url !== "")),
  );
}

// linear_api_key_set is server-derived, not part of the editable form.
function formSnapshot(settings: AppSettings) {
  const { linear_api_key_set: _ignored, ...form } = settings;
  return JSON.stringify(form);
}

function App() {
  const runtimeAvailable = isTauri();
  const [theme, toggleTheme] = useTheme();
  const [view, setView] = useState<View>("overview");
  const [settings, setSettings] = useState<AppSettings | null>(
    runtimeAvailable ? null : previewSettings,
  );
  const [linearKey, setLinearKey] = useState("");
  const [linearViewer, setLinearViewer] = useState<LinearViewerProfile | null>(null);
  const [linearViewerLoading, setLinearViewerLoading] = useState(false);
  const [linearViewerError, setLinearViewerError] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview>(
    runtimeAvailable ? emptyOverview : previewOverview,
  );
  const [runs, setRuns] = useState<RunWithIssueRow[]>(
    runtimeAvailable ? [] : previewRuns,
  );
  const [issues, setIssues] = useState<IssueRow[]>(
    runtimeAvailable ? [] : previewIssues,
  );
  const [retros, setRetros] = useState<RetroRow[]>(
    runtimeAvailable ? [] : previewRetros,
  );
  const [retroStatus, setRetroStatus] = useState<RetroStatus>(
    runtimeAvailable ? emptyRetroStatus : previewRetroStatus,
  );
  const [worker, setWorker] = useState<WorkerStatus>({
    state: runtimeAvailable ? "stopped" : "running",
    started_at: runtimeAvailable ? null : previewActiveStartedAt,
    last_error: null,
  });
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [selectedRetro, setSelectedRetro] = useState<RetroDetail | null>(
    runtimeAvailable ? null : previewRetroDetail,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [savedLiveConfigKept, setSavedLiveConfigKept] = useState(false);
  const [trackerTest, setTrackerTest] = useState<TrackerTestResult | null>(null);
  const [skillsStatuses, setSkillsStatuses] = useState<Record<string, SkillsStatus>>(
    runtimeAvailable ? {} : previewSkillsStatuses,
  );
  const [skillsChecking, setSkillsChecking] = useState<Record<string, boolean>>({});
  const [skillsInstall, setSkillsInstall] = useState<SkillsInstallStatus | null>(null);
  const [stoppingRunIds, setStoppingRunIds] = useState<Set<string>>(() => new Set());
  const [triggeringRetryIds, setTriggeringRetryIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [confirmStop, setConfirmStop] = useState(false);
  const confirmStopTimer = useRef<number | null>(null);
  const savedFlashTimer = useRef<number | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!runtimeAvailable) return;
    getVersion().then(setAppVersion).catch(() => undefined);
  }, [runtimeAvailable]);

  const selectedRunIdRef = useRef<string | null>(null);
  const selectedRetroIdRef = useRef<string | null>(
    runtimeAvailable ? null : previewRetroReport.id,
  );
  const autoStartDone = useRef(false);
  const skillsCheckSeq = useRef<Record<string, number>>({});
  const linearViewerSeq = useRef(0);

  // Dashboard data refreshes on worker events; settings load separately so
  // in-progress edits are never overwritten by background activity.
  async function refreshDashboard() {
    if (!runtimeAvailable) return;
    const detailId = selectedRunIdRef.current;
    const retroDetailId = selectedRetroIdRef.current;
    const [
      nextOverview,
      nextRuns,
      nextIssues,
      nextWorker,
      nextDetail,
      nextRetroStatus,
      nextRetros,
      nextRetroDetail,
    ] =
      await Promise.all([
        invoke<Overview>("get_overview"),
        invoke<RunWithIssueRow[]>("list_runs"),
        invoke<IssueRow[]>("list_issues"),
        invoke<WorkerStatus>("get_worker_status"),
        detailId
          ? invoke<RunDetail | null>("get_run_detail", { id: detailId })
          : Promise.resolve(null),
        invoke<RetroStatus>("get_retro_status"),
        invoke<RetroRow[]>("list_retros"),
        retroDetailId
          ? invoke<RetroDetail | null>("get_retro_detail", { id: retroDetailId })
          : Promise.resolve(null),
      ]);
    setOverview(nextOverview);
    setRuns(nextRuns);
    setIssues(nextIssues);
    setWorker(nextWorker);
    setRetroStatus(nextRetroStatus);
    setRetros(nextRetros);
    if (detailId && detailId === selectedRunIdRef.current) {
      setSelectedRun(nextDetail);
      if (!nextDetail) selectedRunIdRef.current = null;
    }
    if (retroDetailId && retroDetailId === selectedRetroIdRef.current) {
      setSelectedRetro(nextRetroDetail);
      if (!nextRetroDetail) selectedRetroIdRef.current = null;
    } else if (!retroDetailId && nextRetros.length > 0) {
      const newest = nextRetros[0];
      selectedRetroIdRef.current = newest.id;
      const detail = await invoke<RetroDetail | null>("get_retro_detail", {
        id: newest.id,
      });
      setSelectedRetro(detail);
    }
  }

  useEffect(() => {
    setStoppingRunIds((prev) => {
      if (prev.size === 0) return prev;
      const cancellable = new Set(
        runs
          .filter((run) => run.status === "pending" || run.status === "running")
          .map((run) => run.id),
      );
      const next = new Set([...prev].filter((id) => cancellable.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [runs]);

  useEffect(() => {
    if (!runtimeAvailable) return;

    const boot = async () => {
      const loaded = await invoke<AppSettings>("load_settings");
      setSettings(loaded);
      setSavedSnapshot(formSnapshot(loaded));
      await refreshDashboard();
      // The worker should be running whenever the app is open, so start it
      // on launch once setup is complete; the topbar toggle stops it.
      if (autoStartDone.current) return;
      autoStartDone.current = true;
      if (!loaded.linear_api_key_set || !anyRepoConfigured(loaded)) return;
      const status = await invoke<WorkerStatus>("get_worker_status");
      if (status.state !== "stopped" || status.last_error) return;
      setWorker(await invoke<WorkerStatus>("start_worker"));
    };
    boot().catch((err) => setError(formatError(err)));

    // Agent events arrive in bursts; coalesce them into a single refresh.
    let timer: number | null = null;
    const scheduleRefresh = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        refreshDashboard().catch(() => undefined);
      }, 300);
    };
    const unsubs = Promise.all([
      listen("db_changed", scheduleRefresh),
      listen("agent_event", scheduleRefresh),
      listen("rate_limit_changed", scheduleRefresh),
    ]).catch((err) => {
      setError(formatError(err));
      return [];
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubs.then((items) => items.forEach((unlisten) => unlisten()));
    };
  }, [runtimeAvailable]);

  useEffect(() => {
    if (!runtimeAvailable || worker.state === "stopped") return;

    let cancelled = false;
    const refreshWorker = () => {
      invoke<WorkerStatus>("get_worker_status")
        .then((nextWorker) => {
          if (!cancelled) {
            setWorker(nextWorker);
          }
        })
        .catch(() => undefined);
    };

    refreshWorker();
    const interval = window.setInterval(
      refreshWorker,
      worker.state === "stopping" ? 500 : 2000,
    );

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [runtimeAvailable, worker.state]);

  const activeRunIds = useMemo(
    () => new Set(overview.active_runs.map((run) => run.id)),
    [overview.active_runs],
  );

  // Repo badges and the runs filter only earn their space when runs can
  // actually differ by repo: several repos configured, or history spanning
  // more than one (e.g. after a repo was removed).
  const multiRepo = useMemo(
    () =>
      (settings?.repos.length ?? 0) > 1 ||
      new Set(runs.map((run) => run.repo_name).filter(Boolean)).size > 1,
    [settings, runs],
  );

  useEffect(() => {
    setValidation(null);
  }, [settings]);

  useEffect(() => {
    if (!runtimeAvailable || !settings?.tracker_assigned_to_me) {
      linearViewerSeq.current += 1;
      setLinearViewer(null);
      setLinearViewerLoading(false);
      setLinearViewerError(null);
      return;
    }

    const typedKey = linearKey.trim();
    if (!settings.linear_api_key_set && typedKey === "") {
      linearViewerSeq.current += 1;
      setLinearViewer(null);
      setLinearViewerLoading(false);
      setLinearViewerError("Add a Linear API key to show the current user.");
      return;
    }

    const seq = linearViewerSeq.current + 1;
    linearViewerSeq.current = seq;
    setLinearViewerLoading(true);
    setLinearViewerError(null);
    invoke<LinearViewerProfile>("get_linear_viewer", {
      request: {
        settings,
        linear_api_key: typedKey ? typedKey : null,
      },
    })
      .then((viewer) => {
        if (linearViewerSeq.current !== seq) return;
        setLinearViewer(viewer);
      })
      .catch((err) => {
        if (linearViewerSeq.current !== seq) return;
        setLinearViewer(null);
        setLinearViewerError(formatError(err));
      })
      .finally(() => {
        if (linearViewerSeq.current !== seq) return;
        setLinearViewerLoading(false);
      });
  }, [
    runtimeAvailable,
    settings?.tracker_assigned_to_me,
    settings?.linear_api_key_set,
    linearKey,
  ]);

  // Keep relative timestamps fresh while the dashboard is otherwise idle.
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);

  async function call<T>(fn: () => Promise<T>) {
    if (!runtimeAvailable) {
      setError("Connect through the Symphony desktop app to run this action.");
      return undefined as T;
    }
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(formatError(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    if (!settings) return;
    // Validate first, but only abort on a genuine configuration mistake. An
    // unfinished setup (e.g. saving a Linear key before any repo exists) is
    // tracked by the setup checklist and must stay saveable, so a non-blocking
    // validation error still proceeds to save.
    const result = await validate();
    if (!result || result.workflow_blocking) return;
    const saved = await call(() =>
      invoke<AppSettings>("save_settings", {
        request: {
          settings,
          linear_api_key: linearKey.trim() ? linearKey : null,
        },
      }),
    );
    setSettings(saved);
    setSavedSnapshot(formSnapshot(saved));
    setLinearKey("");
    let refreshedWorker: WorkerStatus | null = null;
    try {
      refreshedWorker = await invoke<WorkerStatus>("get_worker_status");
      setWorker(refreshedWorker);
    } catch {
      // Settings are saved even if this status refresh fails; the next dashboard
      // refresh will reconcile worker state.
    }
    const liveWorkerState = refreshedWorker?.state ?? worker.state;
    setSavedLiveConfigKept(
      liveWorkerState === "running" &&
        (!result.workflow_ok || refreshedWorker?.last_error !== null),
    );
    refreshSkillsStatus(saved);
    setSavedFlash(true);
    if (savedFlashTimer.current !== null) {
      window.clearTimeout(savedFlashTimer.current);
    }
    savedFlashTimer.current = window.setTimeout(() => {
      setSavedFlash(false);
      setSavedLiveConfigKept(false);
    }, 2500);
  }

  async function validate() {
    if (!settings) return;
    const result = await call(() =>
      invoke<ValidationResult>("validate_settings", { settings }),
    );
    setValidation(result);
    return result;
  }

  async function testConnection() {
    if (!settings) return;
    const result = await call(() =>
      invoke<TrackerTestResult>("test_tracker_connection", {
        request: {
          settings,
          linear_api_key: linearKey.trim() ? linearKey : null,
        },
      }),
    );
    setTrackerTest(result);
  }

  // Skill detection talks to GitHub via `gh`, so it runs outside the global
  // busy flag and never blocks the rest of the form. It checks the URL as the
  // user sees it (including unsaved edits), not the saved file. Statuses are
  // keyed by the trimmed URL — a response always describes the URL it was
  // asked about, so out-of-order responses cannot mislabel another repo's
  // status — and a per-URL sequence guards overlapping checks for the SAME
  // repo: only the newest one may apply, or a slow pre-install check could
  // overwrite the post-install refresh that already saw the PR (and a stale
  // failure could delete a good status from the catch path).
  function checkRepoSkills(url: string) {
    const repoUrl = url.trim();
    if (!runtimeAvailable || repoUrl === "") return;
    const seq = (skillsCheckSeq.current[repoUrl] ?? 0) + 1;
    skillsCheckSeq.current[repoUrl] = seq;
    setSkillsChecking((prev) => ({ ...prev, [repoUrl]: true }));
    invoke<SkillsStatus>("get_skills_status", { repoUrl })
      .then((status) => {
        if (skillsCheckSeq.current[repoUrl] !== seq) return;
        setSkillsStatuses((prev) => ({ ...prev, [repoUrl]: status }));
        // A fresh check supersedes a finished install for the same repo —
        // without this, a completed install keeps showing its PR forever.
        setSkillsInstall((prev) =>
          prev?.state !== "running" && prev?.repo_url === repoUrl ? null : prev,
        );
      })
      .catch(() => {
        if (skillsCheckSeq.current[repoUrl] !== seq) return;
        setSkillsStatuses((prev) => {
          const next = { ...prev };
          delete next[repoUrl];
          return next;
        });
      })
      .finally(() => {
        if (skillsCheckSeq.current[repoUrl] !== seq) return;
        setSkillsChecking((prev) => ({ ...prev, [repoUrl]: false }));
      });
  }

  function refreshSkillsStatus(forSettings?: AppSettings) {
    const target = forSettings ?? settings;
    if (!target) return;
    for (const url of configuredRepoUrls(target)) checkRepoSkills(url);
  }

  async function startSkillsInstall(url: string) {
    if (!settings) return;
    const status = await call(() =>
      invoke<SkillsInstallStatus>("install_skills", {
        settings,
        repoUrl: url.trim(),
      }),
    );
    setSkillsInstall(status);
  }

  // Check every configured URL once edits settle (covers the initial settings
  // load, a newly added card, and an edited URL). Debounced so typing doesn't
  // spam gh; URLs that drop out of the config simply leave unused cache keys.
  const repoUrlsKey = settings === null ? null : configuredRepoUrls(settings).join("\n");
  useEffect(() => {
    if (!runtimeAvailable || repoUrlsKey === null || repoUrlsKey === "") return;
    const handle = window.setTimeout(() => {
      for (const url of repoUrlsKey.split("\n")) checkRepoSkills(url);
    }, 600);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoUrlsKey, runtimeAvailable]);

  // While the install session runs, poll its progress; when it lands, re-check
  // its repo so that card's status flips to "PR open" with the link.
  useEffect(() => {
    if (!runtimeAvailable || skillsInstall?.state !== "running") return;
    let cancelled = false;
    const interval = window.setInterval(() => {
      invoke<SkillsInstallStatus>("get_skills_install_status")
        .then((status) => {
          if (cancelled) return;
          setSkillsInstall(status);
          if (status.state === "completed" && status.repo_url) {
            checkRepoSkills(status.repo_url);
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeAvailable, skillsInstall?.state]);

  async function removeLinearKey() {
    if (!settings) return;
    const fromDisk = await call(() =>
      invoke<AppSettings>("remove_linear_api_key"),
    );
    // Keep in-progress form edits; only the key flag changed.
    setSettings({ ...settings, linear_api_key_set: fromDisk.linear_api_key_set });
    setLinearKey("");
    setTrackerTest(null);
  }

  async function resetPrompt() {
    if (!settings) return;
    const prompt = await call(() => invoke<string>("get_default_prompt"));
    setSettings({ ...settings, prompt_template: prompt });
  }

  async function startWorker() {
    const status = await call(() => invoke<WorkerStatus>("start_worker"));
    setWorker(status);
  }

  async function stopWorker() {
    const status = await call(() => invoke<WorkerStatus>("stop_worker"));
    setWorker(status);
  }

  async function openRun(id: string) {
    if (!runtimeAvailable) {
      const run = runs.find((candidate) => candidate.id === id);
      if (!run) return;
      selectedRunIdRef.current = id;
      setSelectedRun({ run, events: previewEventsByRunId[id] ?? [] });
      setView("runs");
      return;
    }
    const detail = await call(() =>
      invoke<RunDetail | null>("get_run_detail", { id }),
    );
    selectedRunIdRef.current = detail?.run.id ?? null;
    setSelectedRun(detail);
    setView("runs");
  }

  async function stopRun(id: string) {
    setStoppingRunIds((prev) => new Set(prev).add(id));
    if (!runtimeAvailable) {
      window.setTimeout(() => {
        const endedAt = new Date().toISOString();
        const cancelRun = (run: RunWithIssueRow): RunWithIssueRow =>
          run.id === id
            ? {
                ...run,
                status: "cancelled",
                ended_at: endedAt,
                error_class: "cancelled",
                error_message: "run cancelled",
              }
            : run;
        const event: AgentEventRow = {
          id: Date.now(),
          run_id: id,
          kind: "status",
          payload: JSON.stringify({ message: "Run cancellation requested" }),
          created_at: endedAt,
        };
        setRuns((prev) => prev.map(cancelRun));
        setOverview((prev) => ({
          ...prev,
          active_runs: prev.active_runs.filter((run) => run.id !== id),
          live_sessions: prev.live_sessions.filter((session) => session.run_id !== id),
        }));
        setSelectedRun((prev) =>
          prev?.run.id === id
            ? { run: cancelRun(prev.run), events: [...prev.events, event] }
            : prev,
        );
        setStoppingRunIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 800);
      return;
    }
    try {
      const detail = await call(() =>
        invoke<RunDetail | null>("stop_run", { id }),
      );
      if (selectedRunIdRef.current === id) setSelectedRun(detail);
      await refreshDashboard();
    } catch {
      setStoppingRunIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function triggerRetryNow(issueId: string) {
    setTriggeringRetryIds((prev) => new Set(prev).add(issueId));
    try {
      await call(() => invoke<boolean>("trigger_retry_now", { issueId }));
      await refreshDashboard();
    } catch {
      // call() has already surfaced the error banner.
    } finally {
      setTriggeringRetryIds((prev) => {
        const next = new Set(prev);
        next.delete(issueId);
        return next;
      });
    }
  }

  async function startRetro() {
    if (!settings) return;
    if (!runtimeAvailable) {
      setRetroStatus(previewRetroStatus);
      setRetros(previewRetros);
      setSelectedRetro(previewRetroDetail);
      selectedRetroIdRef.current = previewRetroReport.id;
      setView("retro");
      return;
    }
    const status = await call(() =>
      invoke<RetroStatus>("start_retro", { settings }),
    );
    setRetroStatus(status);
    selectedRetroIdRef.current = status.retro_id;
    setSelectedRetro(null);
    await refreshDashboard();
    setView("retro");
  }

  async function openRetro(id: string) {
    if (!runtimeAvailable) {
      selectedRetroIdRef.current = id;
      setSelectedRetro(previewRetroDetailForId(id));
      setView("retro");
      return;
    }
    const detail = await call(() =>
      invoke<RetroDetail | null>("get_retro_detail", { id }),
    );
    selectedRetroIdRef.current = detail?.row.id ?? null;
    setSelectedRetro(detail);
    setView("retro");
  }

  useEffect(() => {
    if (!runtimeAvailable || retroStatus.state !== "running") return;
    let cancelled = false;
    const interval = window.setInterval(() => {
      refreshDashboard().catch(() => {
        if (!cancelled) {
          // The command wrapper will surface explicit action errors; polling
          // failures are transient and should not pin a banner over the app.
        }
      });
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeAvailable, retroStatus.state]);

  // `blocked` covers the hard requirements without which runs cannot work;
  // it gates the worker-start affordances, overview onboarding, and matches
  // the boot auto-start condition. Skills are recommended only and live in
  // Settings, so they must not keep the overview onboarding visible.
  const setupBlocked =
    settings !== null &&
    (!settings.linear_api_key_set || !anyRepoConfigured(settings));
  const setup = {
    blocked: setupBlocked,
    linearConnected: settings?.linear_api_key_set ?? false,
    repoConfigured: settings !== null && anyRepoConfigured(settings),
  };

  const dirty =
    settings !== null &&
    savedSnapshot !== null &&
    (formSnapshot(settings) !== savedSnapshot || linearKey.trim() !== "");
  const liveReconfigureSkipped =
    worker.state === "running" &&
    ((validation?.workflow_ok === false && !validation.workflow_blocking) ||
      (savedFlash && savedLiveConfigKept));

  // Revalidate when entering Settings (or once settings finish loading there),
  // so CLI detection and workflow status are visible without a manual click.
  useEffect(() => {
    if (!runtimeAvailable || view !== "settings" || !settings) return;
    invoke<ValidationResult>("validate_settings", { settings })
      .then(setValidation)
      .catch(() => undefined);
    refreshSkillsStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, runtimeAvailable, settings !== null]);

  function requestStop() {
    if (overview.active_runs.length > 0 && !confirmStop) {
      setConfirmStop(true);
      if (confirmStopTimer.current !== null) {
        window.clearTimeout(confirmStopTimer.current);
      }
      confirmStopTimer.current = window.setTimeout(
        () => setConfirmStop(false),
        4000,
      );
      return;
    }
    if (confirmStopTimer.current !== null) {
      window.clearTimeout(confirmStopTimer.current);
    }
    setConfirmStop(false);
    stopWorker();
  }

  const workerTitle =
    worker.state === "running"
      ? confirmStop
        ? `${overview.active_runs.length} active ${overview.active_runs.length === 1 ? "run" : "runs"} will be interrupted — click again to stop`
        : worker.started_at
          ? `Running since ${shortTime(worker.started_at)} — click to stop`
          : "Stop worker"
      : worker.state === "stopping"
        ? "Worker is stopping"
        : "Start worker";

  return (
    <main className="app">
      {IS_LOCAL_DEV ? (
        <div className="dev-environment-banner" role="status">
          <strong>Local development instance</strong>
          <span>Connected to this checkout, not the installed Symphony app.</span>
        </div>
      ) : null}
      <header className="topbar">
        <div className="topbar-primary">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              <WaveMark />
            </div>
            <div>
              <div className="brand-title-row">
                <h1>Symphony</h1>
                {IS_LOCAL_DEV ? <span className="dev-brand-badge">Local dev</span> : null}
              </div>
            </div>
          </div>

          <nav className="topnav" aria-label="Primary">
            {(["overview", "runs", "issues", "retro", "settings"] as View[]).map((item) => (
              <button
                key={item}
                className={view === item ? "nav-active" : ""}
                aria-current={view === item ? "page" : undefined}
                onClick={() => setView(item)}
              >
                {label(item)}
              </button>
            ))}
          </nav>
        </div>

        <div className="topbar-actions">
          {view === "settings" && settings ? (
            <SettingsHeaderActions
              validation={validation}
              dirty={dirty}
              savedFlash={savedFlash}
              workerRunning={worker.state === "running"}
              workerConfigError={worker.state === "running" && worker.last_error !== null}
              liveReconfigureSkipped={liveReconfigureSkipped}
              busy={busy}
              runtimeAvailable={runtimeAvailable}
            />
          ) : null}
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            type="button"
            className={`worker-toggle ${worker.state}${confirmStop ? " confirm" : ""}`}
            disabled={busy || !runtimeAvailable || worker.state === "stopping"}
            onClick={worker.state === "running" ? requestStop : startWorker}
            title={workerTitle}
            aria-label={workerTitle}
            aria-live="polite"
          >
            <span className={`status-dot ${worker.state}`} aria-hidden="true" />
            {worker.state === "running" && !confirmStop ? (
              <>
                <span className="worker-toggle-label rest">Running</span>
                <span className="worker-toggle-label on-hover">Stop</span>
              </>
            ) : (
              <span className="worker-toggle-label">
                {worker.state === "running"
                  ? `Stop ${overview.active_runs.length} ${overview.active_runs.length === 1 ? "run" : "runs"}?`
                  : worker.state === "stopping"
                    ? "Stopping…"
                    : "Start"}
              </span>
            )}
          </button>
        </div>
      </header>

      <section
        className={view === "runs" ? "content content-viewport" : "content"}
      >
        {!runtimeAvailable ? (
          <RuntimeBanner
            title="Desktop runtime unavailable"
            message="This browser preview is disconnected from Tauri commands. Launch the desktop app to load live data, save settings, and start the worker."
          />
        ) : null}
        {error ? <div className="banner error">{error}</div> : null}
        {worker.last_error ? (
          <div className="banner error">
            <strong>
              {worker.state === "running" ? "Worker configuration" : "Worker stopped"}
            </strong>
            <span>{friendlyError(worker.last_error)}</span>
          </div>
        ) : null}

        {view === "overview" ? (
          <OverviewView
            overview={overview}
            canStartWorker={runtimeAvailable && !busy && worker.state === "stopped"}
            canTriggerRetry={runtimeAvailable && !busy && worker.state === "running"}
            workerRunning={worker.state === "running"}
            setup={setup}
            multiRepo={multiRepo}
            onOpenRun={openRun}
            onStartWorker={startWorker}
            onTriggerRetryNow={triggerRetryNow}
            triggeringRetryIds={triggeringRetryIds}
            onOpenSettings={() => setView("settings")}
            onOpenIssues={() => setView("issues")}
          />
        ) : null}
        {view === "runs" ? (
          <RunsView
            runs={runs}
            selected={selectedRun}
            activeRunIds={activeRunIds}
            multiRepo={multiRepo}
            onOpenRun={openRun}
            onStopRun={stopRun}
            canTriggerRetry={runtimeAvailable && !busy && worker.state === "running"}
            onTriggerRetryNow={triggerRetryNow}
            triggeringRetryIds={triggeringRetryIds}
            stoppingRunIds={stoppingRunIds}
          />
        ) : null}
        {view === "issues" ? (
          <IssuesView
            issues={issues}
            linearWorkspace={settings?.tracker_workspace ?? null}
            onOpenSettings={() => setView("settings")}
          />
        ) : null}
        {view === "retro" ? (
          <RetroView
            retros={retros}
            status={retroStatus}
            selected={selectedRetro}
            runtimeAvailable={runtimeAvailable}
            busy={busy}
            setupBlocked={setup.blocked}
            onStartRetro={startRetro}
            onOpenRetro={openRetro}
          />
        ) : null}
        {view === "settings" && settings ? (
          <SettingsView
            settings={settings}
            setSettings={setSettings}
            linearKey={linearKey}
            setLinearKey={setLinearKey}
            linearViewer={linearViewer}
            linearViewerLoading={linearViewerLoading}
            linearViewerError={linearViewerError}
            validation={validation}
            trackerTest={trackerTest}
            skillsStatuses={skillsStatuses}
            skillsChecking={skillsChecking}
            skillsInstall={skillsInstall}
            workerRunning={worker.state === "running"}
            workerConfigError={worker.state === "running" && worker.last_error !== null}
            liveReconfigureSkipped={liveReconfigureSkipped}
            activeRunCount={overview.active_runs.length}
            busy={busy}
            runtimeAvailable={runtimeAvailable}
            appVersion={appVersion}
            onSave={saveSettings}
            onTestConnection={testConnection}
            onRemoveKey={removeLinearKey}
            onResetPrompt={resetPrompt}
            onRefreshSkills={checkRepoSkills}
            onInstallSkills={startSkillsInstall}
          />
        ) : null}
      </section>
    </main>
  );
}

function SettingsHeaderActions({
  validation,
  dirty,
  savedFlash,
  workerRunning,
  workerConfigError,
  liveReconfigureSkipped,
  busy,
  runtimeAvailable,
}: {
  validation: ValidationResult | null;
  dirty: boolean;
  savedFlash: boolean;
  workerRunning: boolean;
  workerConfigError: boolean;
  liveReconfigureSkipped: boolean;
  busy: boolean;
  runtimeAvailable: boolean;
}) {
  // Only surface blocking validation errors here. Incomplete-setup messages
  // (e.g. no repo configured yet) are shown by the setup checklist, not flagged
  // red next to Save while the user is still working through setup.
  const validationError = validation?.workflow_blocking ? validation.workflow_error : null;
  const status =
    validationError ??
    (savedFlash
      ? workerRunning
        ? workerConfigError || liveReconfigureSkipped
          ? "Saved; worker kept previous config"
          : "Saved; future runs use changes"
        : "Saved"
      : dirty
        ? "Unsaved changes"
        : "");
  const statusClass =
    validationError || (savedFlash && (workerConfigError || liveReconfigureSkipped))
    ? "save-status invalid"
    : savedFlash
      ? "save-status ok"
      : "save-status";

  return (
    <div className="settings-header-actions" aria-label="Settings actions">
      <div className="settings-action-row">
        <span className={statusClass} aria-live="polite">
          {status}
        </span>
        <button
          disabled={busy || !runtimeAvailable || !dirty}
          className="primary"
          form={SETTINGS_FORM_ID}
          type="submit"
        >
          Save
        </button>
      </div>
    </div>
  );
}

type SetupState = {
  blocked: boolean;
  linearConnected: boolean;
  repoConfigured: boolean;
};

function OverviewView({
  overview,
  canStartWorker,
  canTriggerRetry,
  workerRunning,
  setup,
  multiRepo,
  onOpenRun,
  onStartWorker,
  onTriggerRetryNow,
  triggeringRetryIds,
  onOpenSettings,
  onOpenIssues,
}: {
  overview: Overview;
  canStartWorker: boolean;
  canTriggerRetry: boolean;
  workerRunning: boolean;
  setup: SetupState;
  multiRepo: boolean;
  onOpenRun: (id: string) => void;
  onStartWorker: () => void;
  onTriggerRetryNow: (issueId: string) => void;
  triggeringRetryIds: Set<string>;
  onOpenSettings: () => void;
  onOpenIssues: () => void;
}) {
  // A run gets a live_sessions row only while it is actively streaming tokens.
  // Use that to pulse streaming rows and show their last-activity heartbeat in
  // the Active runs table (the panel this data used to live in on its own).
  const liveRunIds = new Set(
    overview.live_sessions.map((session) => session.run_id),
  );
  const lastActivity = new Map<string, string>(
    overview.live_sessions.map(
      (session): [string, string] => [session.run_id, session.last_event_at],
    ),
  );
  return (
    <>
      <header className="page-header">
        <div>
          <h2>Overview</h2>
          <p>Local worker state, retries, failures, and provider limits and usage.</p>
        </div>
        <div className="kpis">
          <Kpi label="Active" value={overview.active_runs.length} />
          <Kpi
            label={overview.retry_queue.length === 1 ? "Retry" : "Retries"}
            value={overview.retry_queue.length}
          />
          <Kpi
            label={overview.recent_failures.length === 1 ? "Failure" : "Failures"}
            value={overview.recent_failures.length}
          />
        </div>
      </header>

      {setup.blocked ? (
        <SetupChecklist setup={setup} onOpenSettings={onOpenSettings} />
      ) : null}

      <div className="grid">
        <Panel title="Active runs">
          <RunTable
            runs={overview.active_runs}
            onOpenRun={onOpenRun}
            activeRunIds={liveRunIds}
            lastActivity={lastActivity}
            showRepo={multiRepo}
            emptyTitle="No active runs"
            emptyText={
              setup.blocked
                ? "Finish setup before starting the worker."
                : workerRunning
                  ? "The worker is polling Linear. Move an issue to an active state (like Todo) to dispatch an agent."
                  : "Start the worker when you are ready to dispatch agent work."
            }
            actionLabel={
              setup.blocked
                ? "Open settings"
                : workerRunning
                  ? "View issues"
                  : "Start worker"
            }
            actionDisabled={setup.blocked || workerRunning ? false : !canStartWorker}
            onAction={
              setup.blocked
                ? onOpenSettings
                : workerRunning
                  ? onOpenIssues
                  : onStartWorker
            }
          />
        </Panel>
      </div>

      <div className="grid two">
        <Panel title="Recent failures">
          <RunTable
            runs={overview.recent_failures.slice(0, 5)}
            onOpenRun={onOpenRun}
            showRepo={multiRepo}
            emptyTitle="No recent failures"
            emptyText="Worker failures will be collected here for triage."
          />
        </Panel>
        <Panel title="Retry queue">
          {overview.retry_queue.length === 0 ? (
            <Empty
              title="No scheduled retries"
              text="Failed runs with retry windows will appear here."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Run</th>
                  <th>Due</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {overview.retry_queue.map((retry) => (
                  <tr key={retry.issue_id}>
                    <td>
                      <strong>{retry.issue_identifier}</strong>
                      <small>{retry.issue_title}</small>
                    </td>
                    <td>#{retry.run_number}</td>
                    <td className="tnum" title={shortTime(retry.due_at)}>
                      {relativeTime(retry.due_at)}
                    </td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="link-button outlined"
                        disabled={!canTriggerRetry || triggeringRetryIds.has(retry.issue_id)}
                        title={
                          workerRunning
                            ? "Run this scheduled retry now"
                            : "Start the worker to retry now"
                        }
                        onClick={() => onTriggerRetryNow(retry.issue_id)}
                      >
                        {triggeringRetryIds.has(retry.issue_id)
                          ? "Retrying..."
                          : "Retry now"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="grid two">
        <Panel title="Rate limits">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Remaining</th>
                <th>Reset</th>
              </tr>
            </thead>
            <tbody>
              {providerRateLimits(overview.rate_limits).map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.label}</strong>
                    {row.limit ? (
                      <small title={shortTime(row.limit.updated_at)}>
                        signal {relativeTime(row.limit.updated_at)}
                      </small>
                    ) : (
                      <small>no limits hit</small>
                    )}
                  </td>
                  <td className="tnum">{row.limit?.remaining ?? "—"}</td>
                  <td
                    className="tnum"
                    title={
                      row.limit?.reset_at
                        ? shortTime(row.limit.reset_at)
                        : undefined
                    }
                  >
                    {row.limit
                      ? row.limit.reset_at
                        ? `resets ${relativeTime(row.limit.reset_at)}`
                        : "no reset reported"
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Token usage">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Input</th>
                <th>Output</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {providerTokenUsage(overview.token_usage).map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.label}</strong>
                    {row.usage ? (
                      <small title={shortTime(row.usage.updated_at)}>
                        {row.usage.run_count}{" "}
                        {row.usage.run_count === 1 ? "run" : "runs"} · last{" "}
                        {relativeTime(row.usage.updated_at)}
                      </small>
                    ) : (
                      <small>no usage yet</small>
                    )}
                  </td>
                  <td className="tnum">
                    {row.usage ? formatTokens(row.usage.input_tokens) : "—"}
                  </td>
                  <td className="tnum">
                    {row.usage ? formatTokens(row.usage.output_tokens) : "—"}
                  </td>
                  <td className="tnum">
                    {row.usage ? formatTokens(row.usage.total_tokens) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}

function SetupChecklist({
  setup,
  onOpenSettings,
}: {
  setup: SetupState;
  onOpenSettings: () => void;
}) {
  return (
    <section className="setup-panel">
      <div className="setup-intro">
        <h3>Welcome to Symphony</h3>
        <p>
          Symphony watches your Linear project and dispatches Codex, Claude Code, or Cursor
          agents to work on issues in isolated workspaces. Finish the first two
          setup steps to start the worker.
        </p>
      </div>
      <ol className="setup-steps">
        <SetupStep
          done={setup.linearConnected}
          step={1}
          title="Connect Linear"
          text="Add your Linear API key so Symphony can read issues from your project."
        />
        <SetupStep
          done={setup.repoConfigured}
          step={2}
          title="Add your repositories"
          text="Each run clones the repo its issue routes to into a fresh workspace."
        />
      </ol>
      <div className="setup-actions">
        <button className="primary" type="button" onClick={onOpenSettings}>
          Open settings
        </button>
      </div>
    </section>
  );
}

function SetupStep({
  done,
  step,
  title,
  text,
}: {
  done: boolean;
  step: number;
  title: string;
  text: string;
}) {
  return (
    <li className={done ? "setup-step done" : "setup-step"}>
      <span className="setup-step-marker" aria-hidden="true">
        {done ? "✓" : step}
      </span>
      <div>
        <strong>{title}</strong>
        <small>{text}</small>
      </div>
    </li>
  );
}

function SessionChips({ raw }: { raw: string | null }) {
  const info = parseSessionInfo(raw);
  if (!info) return null;
  const chips: { label: string; title: string; mono?: boolean }[] = [];
  if (info.model) {
    chips.push({ label: info.model, title: "Model", mono: true });
  }
  if (info.permission_mode) {
    chips.push({ label: info.permission_mode, title: "Permission mode" });
  }
  if (info.fast_mode === "on") {
    chips.push({ label: "fast mode", title: "Fast mode enabled" });
  }
  if (info.output_style && info.output_style !== "default") {
    chips.push({ label: `${info.output_style} style`, title: "Output style" });
  }
  if (info.thinking_tokens) {
    chips.push({
      label: `${formatTokens(info.thinking_tokens)} thinking`,
      title: "Estimated thinking tokens",
    });
  }
  if (info.agent_version) {
    chips.push({ label: `Claude Code ${info.agent_version}`, title: "Agent version" });
  }
  if (chips.length === 0) return null;
  return (
    <div className="run-meta-row session-chips">
      {chips.map((chip) => (
        <span
          key={chip.title}
          className={chip.mono ? "session-chip mono" : "session-chip"}
          title={chip.title}
        >
          {chip.label}
        </span>
      ))}
    </div>
  );
}

function RunsView({
  runs,
  selected,
  activeRunIds,
  multiRepo,
  onOpenRun,
  onStopRun,
  canTriggerRetry,
  onTriggerRetryNow,
  triggeringRetryIds,
  stoppingRunIds,
}: {
  runs: RunWithIssueRow[];
  selected: RunDetail | null;
  activeRunIds: Set<string>;
  multiRepo: boolean;
  onOpenRun: (id: string) => void;
  onStopRun: (id: string) => void;
  canTriggerRetry: boolean;
  onTriggerRetryNow: (issueId: string) => void;
  triggeringRetryIds: Set<string>;
  stoppingRunIds: Set<string>;
}) {
  const [repoFilter, setRepoFilter] = useState("");
  // Repos that actually appear in the loaded history; a filter for a repo
  // with no runs would only ever show an empty table.
  const repoOptions = useMemo(
    () =>
      Array.from(
        new Set(runs.map((run) => run.repo_name).filter((name): name is string => !!name)),
      ).sort(),
    [runs],
  );
  useEffect(() => {
    if (repoFilter !== "" && !repoOptions.includes(repoFilter)) setRepoFilter("");
  }, [repoFilter, repoOptions]);
  const visibleRuns =
    repoFilter === "" ? runs : runs.filter((run) => run.repo_name === repoFilter);
  return (
    <>
      <header className="page-header">
        <div>
          <h2>Runs</h2>
          <p>Dispatch history and live agent event stream.</p>
        </div>
        {multiRepo && repoOptions.length > 0 ? (
          <div className="actions">
            <RepoFilterSelect
              value={repoFilter}
              repos={repoOptions}
              onChange={setRepoFilter}
            />
          </div>
        ) : null}
      </header>
      <div className="split">
        <Panel title="Run history">
          <div className="panel-scroll">
            <RunTable
              runs={visibleRuns}
              onOpenRun={onOpenRun}
              emptyTitle={repoFilter === "" ? "No runs yet" : "No runs for this repo"}
              emptyText={
                repoFilter === ""
                  ? "Runs will appear after the worker dispatches the first issue."
                  : `No loaded runs were dispatched to ${repoFilter}.`
              }
              activeRunIds={activeRunIds}
              selectedRunId={selected?.run.id}
              showRepo={multiRepo}
            />
          </div>
        </Panel>
        <Panel
          title={
            selected
              ? `${selected.run.issue_identifier} · Run #${selected.run.run_number}`
              : "Event stream"
          }
        >
          {!selected ? (
            <Empty
              title="Select a run"
              text="Choose a run from the history table to inspect its event stream."
            />
          ) : (
            <>
              <div className="run-meta">
                <div className="run-meta-head">
                  <div className="run-meta-row">
                    <Badge status={selected.run.status} />
                    {selected.run.repo_name ? (
                      <span className="repo-badge">{selected.run.repo_name}</span>
                    ) : null}
                    <span>{selected.run.issue_title}</span>
                  </div>
                  <div className="run-meta-actions">
                    {selected.run.status === "cancelled" ? (
                      <button
                        type="button"
                        className="link-button outlined"
                        disabled={
                          !canTriggerRetry || triggeringRetryIds.has(selected.run.issue_id)
                        }
                        title={
                          canTriggerRetry
                            ? "Dispatch this issue again"
                            : "Start the worker to retry this run"
                        }
                        onClick={() => onTriggerRetryNow(selected.run.issue_id)}
                      >
                        {triggeringRetryIds.has(selected.run.issue_id)
                          ? "Retrying..."
                          : "Retry run"}
                      </button>
                    ) : null}
                    {selected.run.status === "pending" || selected.run.status === "running" ? (
                      <button
                        type="button"
                        className="link-button danger outlined"
                        disabled={stoppingRunIds.has(selected.run.id)}
                        onClick={() => onStopRun(selected.run.id)}
                      >
                        {stoppingRunIds.has(selected.run.id) ? "Stopping..." : "Stop run"}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="run-meta-row muted">
                  <span>Created {shortTime(selected.run.created_at)}</span>
                  {selected.run.ended_at ? (
                    <span>Ended {shortTime(selected.run.ended_at)}</span>
                  ) : null}
                </div>
                <SessionChips raw={selected.run.session_info} />
                <code
                  className="run-meta-path"
                  title={selected.run.workspace_path}
                >
                  {selected.run.workspace_path}
                </code>
                {selected.run.error_message ? (
                  <div className="run-error">
                    <strong>{selected.run.error_class ?? "Error"}</strong>
                    <span>{selected.run.error_message}</span>
                  </div>
                ) : null}
              </div>
              <EventStream
                events={selected.events}
                live={selected.run.status === "running"}
              />
            </>
          )}
        </Panel>
      </div>
    </>
  );
}

function RepoFilterSelect({
  value,
  repos,
  onChange,
}: {
  value: string;
  repos: string[];
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
  const options = useMemo(
    () => [
      { value: "", label: "All repos" },
      ...repos.map((repo) => ({ value: repo, label: repo })),
    ],
    [repos],
  );
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex];

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, options.length - 1));
  }, [options.length]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function openList() {
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function commit(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        openList();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(options.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(activeIndex);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div className="icon-select repo-filter-select" ref={rootRef}>
      <button
        type="button"
        className="icon-select-trigger repo-filter-trigger"
        role="combobox"
        aria-label="Filter runs by repository"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? "repo-filter-listbox" : undefined}
        aria-activedescendant={open ? `repo-filter-option-${activeIndex}` : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={handleKeyDown}
      >
        <span className="repo-filter-label">{selected.label}</span>
        <svg className="chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <ul className="icon-select-list repo-filter-list" id="repo-filter-listbox" role="listbox">
          {options.map((option, index) => (
            <li
              key={option.value || "all"}
              id={`repo-filter-option-${index}`}
              role="option"
              aria-selected={option.value === value}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              className={
                index === activeIndex ? "icon-select-option active" : "icon-select-option"
              }
              title={option.label}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => commit(index)}
            >
              <span className="icon-select-check" aria-hidden="true">
                {option.value === value ? (
                  <svg viewBox="0 0 16 16" width="12" height="12">
                    <path
                      d="M3 8.5l3.5 3.5L13 4.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </span>
              <span className="repo-filter-option-label">{option.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function IssuesView({
  issues,
  linearWorkspace,
  onOpenSettings,
}: {
  issues: IssueRow[];
  linearWorkspace: string | null;
  onOpenSettings: () => void;
}) {
  const [mode, setMode] = useState<IssueViewMode>("list");
  const dependencyGraph = useMemo(() => buildDependencyGraph(issues), [issues]);

  return (
    <>
      <header className="page-header">
        <div>
          <h2>Issues</h2>
          <p>The Linear issues Symphony is watching, refreshed on every poll.</p>
        </div>
        <div className="issue-view-toggle" role="tablist" aria-label="Issue view">
          {(["list", "dependencies"] as IssueViewMode[]).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={mode === item}
              aria-controls="issues-panel"
              className={mode === item ? "active" : undefined}
              onClick={() => setMode(item)}
            >
              {item === "list" ? "List" : "Dependencies"}
            </button>
          ))}
        </div>
      </header>
      <section id="issues-panel" role="tabpanel">
        <Panel title={mode === "list" ? "Watched issues" : "Dependency graph"}>
          {issues.length === 0 ? (
            <Empty
              title="No issues yet"
              text="Once the worker connects to Linear, issues in your active states will appear here."
              actionLabel="Open settings"
              onAction={onOpenSettings}
            />
          ) : mode === "dependencies" ? (
            <DependencyGraphView graph={dependencyGraph} />
          ) : (
            <IssuesTable issues={issues} linearWorkspace={linearWorkspace} />
          )}
        </Panel>
      </section>
    </>
  );
}

function IssuesTable({
  issues,
  linearWorkspace,
}: {
  issues: IssueRow[];
  linearWorkspace: string | null;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Issue</th>
          <th>State</th>
          <th>Priority</th>
          <th>Last seen</th>
          {linearWorkspace ? <th /> : null}
        </tr>
      </thead>
      <tbody>
        {issues.map((issue) => (
          <tr key={issue.id}>
            <td>
              <strong>{issue.identifier}</strong>
              <small>{issue.title}</small>
            </td>
            <td>
              <Badge status={issue.state} />
            </td>
            <td>{priorityLabel(issue.priority)}</td>
            <td className="tnum" title={shortTime(issue.last_seen_at)}>
              {relativeTime(issue.last_seen_at)}
            </td>
            {linearWorkspace ? (
              <td className="row-actions">
                <button
                  type="button"
                  className="link-button"
                  aria-label={`Open ${issue.identifier} in Linear`}
                  onClick={() =>
                    openUrl(
                      `https://linear.app/${linearWorkspace}/issue/${issue.identifier}`,
                    ).catch(() => undefined)
                  }
                >
                  Open in Linear ↗
                </button>
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type DependencyGraph = {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  width: number;
  height: number;
  issueCount: number;
  blockedIssueCount: number;
  externalBlockerCount: number;
};

type DependencyNode = {
  identifier: string;
  issue: IssueRow | null;
  external: boolean;
  layer: number;
  row: number;
  x: number;
  y: number;
  blocksCount: number;
  blockedByCount: number;
};

type DependencyEdge = {
  from: string;
  to: string;
  external: boolean;
};

function DependencyGraphView({ graph }: { graph: DependencyGraph }) {
  if (graph.edges.length === 0) {
    return (
      <Empty
        title="No blocking dependencies"
        text="None of the watched issues currently list an open blocker."
      />
    );
  }

  const nodesByIdentifier = new Map(graph.nodes.map((node) => [node.identifier, node]));

  return (
    <div className="dependency-view">
      <div className="dependency-summary" aria-label="Dependency summary">
        <DependencyStat label="Watched issues" value={graph.issueCount} />
        <DependencyStat label="Blocked issues" value={graph.blockedIssueCount} />
        <DependencyStat label="Blocking links" value={graph.edges.length} />
        <DependencyStat label="External blockers" value={graph.externalBlockerCount} />
      </div>
      <div
        className="dependency-graph-shell"
        role="group"
        aria-label={`Dependency graph with ${graph.nodes.length} nodes and ${graph.edges.length} blocking links`}
      >
        <div
          className="dependency-graph-canvas"
          style={{ width: graph.width, height: graph.height }}
        >
          <svg
            className="dependency-edges"
            viewBox={`0 0 ${graph.width} ${graph.height}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id="dependency-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {graph.edges.map((edge) => {
              const from = nodesByIdentifier.get(edge.from);
              const to = nodesByIdentifier.get(edge.to);
              if (!from || !to) return null;
              const startX = from.x + DEPENDENCY_NODE_WIDTH;
              const startY = from.y + DEPENDENCY_NODE_HEIGHT / 2;
              const endX = to.x - 8;
              const endY = to.y + DEPENDENCY_NODE_HEIGHT / 2;
              const control = Math.max(44, Math.abs(endX - startX) / 2);
              const path =
                endX > startX
                  ? `M ${startX} ${startY} C ${startX + control} ${startY} ${endX - control} ${endY} ${endX} ${endY}`
                  : `M ${startX} ${startY} C ${startX + control} ${startY} ${startX + control} ${endY} ${endX} ${endY}`;
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  className={edge.external ? "dependency-edge external" : "dependency-edge"}
                  d={path}
                  markerEnd="url(#dependency-arrow)"
                />
              );
            })}
          </svg>
          {graph.nodes.map((node) => (
            <DependencyNodeCard key={node.identifier} node={node} />
          ))}
        </div>
      </div>
      <div className="dependency-links">
        <h4>Blocking links</h4>
        <ul aria-label="Blocking links">
          {graph.edges.map((edge) => (
            <li key={`${edge.from}->${edge.to}`} aria-label={`${edge.from} blocks ${edge.to}`}>
              <strong>{edge.from}</strong>
              <span>blocks</span>
              <strong>{edge.to}</strong>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function DependencyStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="dependency-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function DependencyNodeCard({ node }: { node: DependencyNode }) {
  const className = [
    "dependency-node",
    node.external ? "external" : "watched",
    node.blockedByCount > 0 ? "blocked" : "",
    node.blocksCount > 0 ? "blocker" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      className={className}
      style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
      aria-label={
        node.external
          ? `${node.identifier}, external blocker`
          : `${node.identifier}, ${node.issue?.title ?? "watched issue"}`
      }
    >
      <div className="dependency-node-head">
        <strong>{node.identifier}</strong>
        {node.issue ? <Badge status={node.issue.state} /> : <span>External</span>}
      </div>
      <small className="dependency-node-title">
        {node.issue?.title ?? "Outside current issue filters"}
      </small>
      <div className="dependency-node-meta">
        {node.blockedByCount > 0 ? <span>Blocked by {node.blockedByCount}</span> : null}
        {node.blocksCount > 0 ? <span>Blocks {node.blocksCount}</span> : null}
        {node.blockedByCount === 0 && node.blocksCount === 0 ? (
          <span>No blockers</span>
        ) : null}
      </div>
    </article>
  );
}

function RetroView({
  retros,
  status,
  selected,
  runtimeAvailable,
  busy,
  setupBlocked,
  onStartRetro,
  onOpenRetro,
}: {
  retros: RetroRow[];
  status: RetroStatus;
  selected: RetroDetail | null;
  runtimeAvailable: boolean;
  busy: boolean;
  setupBlocked: boolean;
  onStartRetro: () => void;
  onOpenRetro: (id: string) => void;
}) {
  const activeReport = selected ? selected.report : status.report;
  const canStart =
    !busy && status.state !== "running" && (!runtimeAvailable || !setupBlocked);
  return (
    <>
      <header className="page-header">
        <div>
          <h2>Retro</h2>
          <p>
            Finds repeated confusion in runs and workpads, then suggests prompt or
            skill changes per repo.
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={!canStart}
            onClick={onStartRetro}
            title={
              setupBlocked && runtimeAvailable
                ? "Connect Linear and configure a repository before running a retro."
                : undefined
            }
          >
            {status.state === "running" ? "Generating..." : "Generate retro"}
          </button>
        </div>
      </header>

      {status.state === "running" ? (
        <div className="banner info">
          <strong>Retro running</strong>
          <span>{status.message ?? "Analyzing recent runs..."}</span>
        </div>
      ) : null}
      {status.state === "failed" && status.error ? (
        <div className="banner error">
          <strong>Retro failed</strong>
          <span>{status.error}</span>
        </div>
      ) : null}

      <div className="split retro-layout">
        <Panel title="Retro history">
          {retros.length === 0 ? (
            <Empty
              title="No retros yet"
              text="Generate the first retro to create a durable marker for the next run window."
              actionLabel="Generate retro"
              actionDisabled={!canStart}
              onAction={onStartRetro}
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Window</th>
                  <th>Status</th>
                  <th>Runs</th>
                  <th>Issues</th>
                </tr>
              </thead>
              <tbody>
                {retros.map((retro) => (
                  <tr
                    key={retro.id}
                    className={
                      selected?.row.id === retro.id
                        ? "clickable-row selected"
                        : "clickable-row"
                    }
                    tabIndex={0}
                    role="button"
                    aria-label={`Open retro from ${shortTime(retro.since_at)}`}
                    onClick={() => onOpenRetro(retro.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenRetro(retro.id);
                      }
                    }}
                  >
                    <td>
                      <strong>{relativeTime(retro.created_at)}</strong>
                      <small>
                        {shortTime(retro.since_at)} to {shortTime(retro.until_at)}
                      </small>
                      {retro.error_message ? (
                        <small className="row-error">{retro.error_message}</small>
                      ) : null}
                    </td>
                    <td>
                      <Badge status={retro.status} />
                    </td>
                    <td className="tnum">{retro.run_count}</td>
                    <td className="tnum">{retro.issue_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Findings and suggestions">
          {!activeReport ? (
            <Empty
              title="No report selected"
              text="Generate or select a retro to inspect repo-level confusion patterns."
            />
          ) : activeReport.repos.length === 0 ? (
            <Empty
              title="No runs in this window"
              text="The retro marker was advanced, but no terminal runs finished in the selected period."
            />
          ) : (
            <div className="retro-report">
              {activeReport.repos.map((repo) => (
                <RetroRepoCard key={repo.repo_name} repo={repo} />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

function RetroRepoCard({ repo }: { repo: RetroReport["repos"][number] }) {
  return (
    <article className="retro-repo-card">
      <header>
        <div className="retro-repo-title">
          <span className="repo-badge">{repo.repo_name}</span>
        </div>
        <div className="retro-mini-stats">
          <span>{repo.run_count} runs</span>
          <span>{repo.failure_count} failures</span>
          <span>{repo.retry_count} retries</span>
        </div>
      </header>
      <div className="retro-columns">
        <section>
          <h5>Confusion patterns</h5>
          {repo.findings.length === 0 ? (
            <small>No repeated confusion found for this repo.</small>
          ) : (
            <div className="retro-list">
              {repo.findings.map((finding) => (
                <div className="retro-item" key={`${finding.title}-${finding.detail}`}>
                  <div className="retro-item-head">
                    <strong>{finding.title}</strong>
                    <Badge status={finding.severity} />
                  </div>
                  <p>{finding.detail}</p>
                  <small>
                    {finding.occurrences} occurrence
                    {finding.occurrences === 1 ? "" : "s"}
                  </small>
                  <ul className="retro-evidence">
                    {finding.evidence.map((evidence) => (
                      <li
                        key={`${evidence.issue_identifier}-${evidence.run_id ?? evidence.kind}-${evidence.event_id ?? evidence.summary}`}
                      >
                        <code>{evidence.issue_identifier}</code>
                        <span>
                          {evidence.run_number ? `Run #${evidence.run_number}` : evidence.kind}
                        </span>
                        <small>{evidence.summary}</small>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
        <section>
          <h5>Suggested changes</h5>
          {repo.suggestions.length === 0 ? (
            <small>No prompt or skill changes suggested.</small>
          ) : (
            <div className="retro-list">
              {repo.suggestions.map((suggestion) => (
                <div className="retro-item" key={`${suggestion.target_id}-${suggestion.title}`}>
                  <div className="retro-item-head">
                    <strong>{suggestion.title}</strong>
                    <span className="retro-target">
                      {suggestion.target_type}: {suggestion.target_id}
                    </span>
                  </div>
                  <p>{suggestion.body}</p>
                  <small>
                    {suggestion.confidence} confidence · {suggestion.rationale}
                  </small>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </article>
  );
}

function buildDependencyGraph(issues: IssueRow[]): DependencyGraph {
  const issueByIdentifier = new Map<string, IssueRow>();
  const order = new Map<string, number>();
  const blockersByIssue = new Map<string, string[]>();

  issues.forEach((issue, index) => {
    issueByIdentifier.set(issue.identifier, issue);
    order.set(issue.identifier, index);
    blockersByIssue.set(issue.identifier, []);
  });

  const edgeMap = new Map<string, DependencyEdge>();
  let nextOrder = issues.length;

  for (const issue of issues) {
    const blockers = uniqueIdentifiers(parseIssueStringList(issue.blockers)).filter(
      (identifier) => identifier !== issue.identifier,
    );
    blockersByIssue.set(issue.identifier, blockers);
    for (const blocker of blockers) {
      if (!order.has(blocker)) {
        order.set(blocker, nextOrder);
        nextOrder += 1;
      }
      edgeMap.set(`${blocker}\u0000${issue.identifier}`, {
        from: blocker,
        to: issue.identifier,
        external: !issueByIdentifier.has(blocker),
      });
    }
  }

  const edges = Array.from(edgeMap.values());
  const blocksCount = new Map<string, number>();
  const blockedByCount = new Map<string, number>();
  for (const edge of edges) {
    blocksCount.set(edge.from, (blocksCount.get(edge.from) ?? 0) + 1);
    blockedByCount.set(edge.to, (blockedByCount.get(edge.to) ?? 0) + 1);
  }

  const identifiers = new Set<string>([
    ...issues.map((issue) => issue.identifier),
    ...edges.flatMap((edge) => [edge.from, edge.to]),
  ]);
  const layerCache = new Map<string, number>();
  const visiting = new Set<string>();

  const layerFor = (identifier: string): number => {
    const cached = layerCache.get(identifier);
    if (cached !== undefined) return cached;
    if (visiting.has(identifier)) return 0;

    visiting.add(identifier);
    const upstream = blockersByIssue.get(identifier) ?? [];
    const layer =
      upstream.length === 0
        ? 0
        : Math.max(...upstream.map((blocker) => layerFor(blocker) + 1));
    visiting.delete(identifier);
    layerCache.set(identifier, layer);
    return layer;
  };

  const layered = Array.from(identifiers, (identifier) => ({
    identifier,
    issue: issueByIdentifier.get(identifier) ?? null,
    external: !issueByIdentifier.has(identifier),
    layer: layerFor(identifier),
    row: 0,
    x: 0,
    y: 0,
    blocksCount: blocksCount.get(identifier) ?? 0,
    blockedByCount: blockedByCount.get(identifier) ?? 0,
  }));

  const layers = new Map<number, DependencyNode[]>();
  for (const node of layered) {
    const nodes = layers.get(node.layer) ?? [];
    nodes.push(node);
    layers.set(node.layer, nodes);
  }

  const positioned: DependencyNode[] = [];
  for (const [layer, nodes] of layers) {
    nodes.sort((a, b) => {
      if (a.external !== b.external) return a.external ? -1 : 1;
      return (order.get(a.identifier) ?? 0) - (order.get(b.identifier) ?? 0);
    });
    nodes.forEach((node, row) => {
      positioned.push({
        ...node,
        row,
        x: DEPENDENCY_PADDING + layer * (DEPENDENCY_NODE_WIDTH + DEPENDENCY_LAYER_GAP),
        y: DEPENDENCY_PADDING + row * (DEPENDENCY_NODE_HEIGHT + DEPENDENCY_ROW_GAP),
      });
    });
  }

  const maxLayer = Math.max(0, ...positioned.map((node) => node.layer));
  const maxRows = Math.max(
    1,
    ...Array.from(layers.values(), (nodes) => Math.max(1, nodes.length)),
  );

  return {
    nodes: positioned.sort((a, b) => {
      if (a.layer !== b.layer) return a.layer - b.layer;
      return a.row - b.row;
    }),
    edges: edges.sort(
      (a, b) =>
        (order.get(a.from) ?? 0) - (order.get(b.from) ?? 0) ||
        (order.get(a.to) ?? 0) - (order.get(b.to) ?? 0),
    ),
    width:
      DEPENDENCY_PADDING * 2 +
      (maxLayer + 1) * DEPENDENCY_NODE_WIDTH +
      maxLayer * DEPENDENCY_LAYER_GAP,
    height:
      DEPENDENCY_PADDING * 2 +
      maxRows * DEPENDENCY_NODE_HEIGHT +
      Math.max(0, maxRows - 1) * DEPENDENCY_ROW_GAP,
    issueCount: issues.length,
    blockedIssueCount: issues.filter((issue) => (blockedByCount.get(issue.identifier) ?? 0) > 0)
      .length,
    externalBlockerCount: positioned.filter((node) => node.external).length,
  };
}

function parseIssueStringList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function uniqueIdentifiers(identifiers: string[]): string[] {
  return Array.from(new Set(identifiers));
}

function SettingsView({
  settings,
  setSettings,
  linearKey,
  setLinearKey,
  linearViewer,
  linearViewerLoading,
  linearViewerError,
  validation,
  trackerTest,
  skillsStatuses,
  skillsChecking,
  skillsInstall,
  workerRunning,
  workerConfigError,
  liveReconfigureSkipped,
  activeRunCount,
  busy,
  runtimeAvailable,
  appVersion,
  onSave,
  onTestConnection,
  onRemoveKey,
  onResetPrompt,
  onRefreshSkills,
  onInstallSkills,
}: {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  linearKey: string;
  setLinearKey: (value: string) => void;
  linearViewer: LinearViewerProfile | null;
  linearViewerLoading: boolean;
  linearViewerError: string | null;
  validation: ValidationResult | null;
  trackerTest: TrackerTestResult | null;
  skillsStatuses: Record<string, SkillsStatus>;
  skillsChecking: Record<string, boolean>;
  skillsInstall: SkillsInstallStatus | null;
  workerRunning: boolean;
  workerConfigError: boolean;
  liveReconfigureSkipped: boolean;
  activeRunCount: number;
  busy: boolean;
  runtimeAvailable: boolean;
  appVersion: string | null;
  onSave: () => void;
  onTestConnection: () => void;
  onRemoveKey: () => void;
  onResetPrompt: () => void;
  onRefreshSkills: (repoUrl: string) => void;
  onInstallSkills: (repoUrl: string) => void;
}) {
  const activeStatesEmpty = settings.active_states.every((state) => state.trim() === "");
  const [expandedRepoIndex, setExpandedRepoIndex] = useState<number | null>(
    settings.repos.length > 0 ? 0 : null,
  );

  useEffect(() => {
    setExpandedRepoIndex((index) => {
      if (settings.repos.length === 0) return null;
      if (index === null) return 0;
      return Math.min(index, settings.repos.length - 1);
    });
  }, [settings.repos.length]);

  const updateRepo = (index: number, patch: Partial<RepoConfig>) => {
    setExpandedRepoIndex(index);
    setSettings({
      ...settings,
      repos: settings.repos.map((repo, i) => (i === index ? { ...repo, ...patch } : repo)),
    });
  };
  const addRepo = () => {
    setExpandedRepoIndex(settings.repos.length);
    setSettings({
      ...settings,
      repos: [
        ...settings.repos,
        {
          name: "",
          url: "",
          install_cmd: null,
          team_prefixes: [],
          project_ids: [],
          // The first repo starts as the fallback, but users can clear it.
          is_default: settings.repos.length === 0,
          skills_marked_installed: false,
        },
      ],
    });
  };
  const removeRepo = (index: number) => {
    setExpandedRepoIndex((current) => {
      const nextLength = settings.repos.length - 1;
      if (nextLength <= 0) return null;
      if (current === null) return 0;
      if (current === index) return Math.min(index, nextLength - 1);
      if (current > index) return current - 1;
      return Math.min(current, nextLength - 1);
    });
    setSettings({ ...settings, repos: settings.repos.filter((_, i) => i !== index) });
  };
  const setDefaultRepo = (index: number, enabled: boolean) => {
    setExpandedRepoIndex(index);
    setSettings({
      ...settings,
      repos: settings.repos.map((repo, i) => ({
        ...repo,
        is_default: enabled && i === index,
      })),
    });
  };
  return (
    <form
      className="settings-form"
      id={SETTINGS_FORM_ID}
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <header className="page-header">
        <div>
          <h2>Settings</h2>
          <p>Linear connection, repository, agent backend, and the prompt that drives runs.</p>
        </div>
      </header>

      {!runtimeAvailable ? (
        <div className="banner info">
          Settings are shown in preview mode. Open Symphony as a Tauri desktop app to edit, validate, and save configuration.
        </div>
      ) : null}
      {runtimeAvailable && workerRunning ? (
        <div className="banner info">
          <strong>
            {workerConfigError || liveReconfigureSkipped
              ? "Worker configuration"
              : "Live worker"}
          </strong>
          <span>
            {workerConfigError
              ? "Settings save to disk, but the live worker reported a configuration error and may keep its previous runtime config until the error is fixed."
              : liveReconfigureSkipped
                ? "Settings save to disk, but this configuration is incomplete, so the live worker keeps its previous runtime config until setup is runnable."
              : `Saved settings apply to future dispatches without restarting the worker. ${
                  activeRunCount > 0
                    ? `${activeRunCount} active ${
                        activeRunCount === 1 ? "run keeps" : "runs keep"
                      } the config ${activeRunCount === 1 ? "it" : "they"} started with.`
                    : "No active runs are using an older config."
                }`}
          </span>
        </div>
      ) : null}

      <div className="settings-grid">
        <section className="settings-section">
          <h3>Repositories</h3>
          <small className="hint">
            Each issue routes to one repo: a <code>repo:&lt;name&gt;</code> or matching
            bare label in Linear wins, then the repo claiming the issue's project,
            then its team, then the default. Clear the default to require an
            explicit route.
          </small>
          {settings.repos.map((repo, index) => {
            const repoTitle = repo.name.trim() || `Repository ${index + 1}`;
            const repoSummary = repo.url.trim() || "No URL configured";
            const expanded = expandedRepoIndex === index;
            const bodyId = `repo-card-body-${index}`;
            const toggleLabel = `${expanded ? "Collapse" : "Edit"} ${repoTitle} repository`;
            return (
              <fieldset
                className={expanded ? "repo-card expanded" : "repo-card collapsed"}
                key={index}
              >
                <div className="repo-card-head">
                  <button
                    type="button"
                    className="repo-card-toggle"
                    aria-expanded={expanded}
                    aria-controls={expanded ? bodyId : undefined}
                    aria-label={toggleLabel}
                    title={toggleLabel}
                    onClick={() => setExpandedRepoIndex(index)}
                  >
                    <svg className="chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                      <path
                        d="M6 4l4 4-4 4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="repo-card-title">
                      <strong>{repoTitle}</strong>
                      <small>{repoSummary}</small>
                    </span>
                  </button>
                  <div className="repo-card-actions">
                    <label className="repo-default">
                      <input
                        type="checkbox"
                        checked={repo.is_default}
                        disabled={!runtimeAvailable}
                        onChange={(event) => setDefaultRepo(index, event.currentTarget.checked)}
                      />
                      Default
                    </label>
                    <button
                      type="button"
                      className="link-button"
                      disabled={!runtimeAvailable}
                      onClick={() => removeRepo(index)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                {expanded ? (
                  <div className="repo-card-body" id={bodyId}>
                    <label>
                      Name
                      <input
                        {...literalInputProps}
                        value={repo.name}
                        disabled={!runtimeAvailable}
                        onChange={(e) => updateRepo(index, { name: e.currentTarget.value })}
                        placeholder="widgets"
                      />
                      <small className="hint">
                        Label an issue <code>repo:{repo.name.trim() || "<name>"}</code> in Linear
                        to send it here.
                      </small>
                    </label>
                    <label>
                      Repo URL
                      <input
                        {...literalInputProps}
                        value={repo.url}
                        disabled={!runtimeAvailable}
                        onChange={(e) => {
                          const url = e.currentTarget.value;
                          updateRepo(index, {
                            url,
                            skills_marked_installed:
                              url.trim() === repo.url.trim()
                                ? repo.skills_marked_installed
                                : false,
                          });
                        }}
                        placeholder="git@github.com:org/repo.git"
                      />
                      <small className="hint">
                        SSH or HTTPS Git URL. Each run clones it into a fresh workspace.
                      </small>
                    </label>
                    <label>
                      Install command
                      <input
                        {...literalInputProps}
                        value={repo.install_cmd ?? ""}
                        disabled={!runtimeAvailable}
                        onChange={(e) =>
                          updateRepo(index, { install_cmd: nullable(e.currentTarget.value) })
                        }
                        placeholder="npm ci"
                      />
                      <small className="hint">
                        Runs in the workspace after cloning. Leave blank for <code>npm ci</code>.
                      </small>
                    </label>
                    <label>
                      Linear teams
                      <ListInput
                        value={repo.team_prefixes}
                        disabled={!runtimeAvailable}
                        separator="comma"
                        placeholder="ENG, WAL"
                        onChange={(next) => updateRepo(index, { team_prefixes: next })}
                      />
                      <small className="hint">
                        Optional. Issues from these team keys land here unless a label or
                        project rule says otherwise.
                      </small>
                    </label>
                    <label>
                      Linear projects
                      <ListInput
                        value={repo.project_ids}
                        disabled={!runtimeAvailable}
                        separator="comma"
                        placeholder="Project URLs or IDs"
                        onChange={(next) => updateRepo(index, { project_ids: next })}
                      />
                      <small className="hint">
                        Optional. Paste Linear project URLs or IDs; beats the team rule.
                      </small>
                    </label>
                    <SkillsBlock
                      status={skillsStatuses[repo.url.trim()] ?? null}
                      checking={skillsChecking[repo.url.trim()] ?? false}
                      manuallyInstalled={repo.skills_marked_installed}
                      install={
                        skillsInstall?.repo_url === repo.url.trim() ? skillsInstall : null
                      }
                      installRunning={skillsInstall?.state === "running"}
                      busy={busy}
                      runtimeAvailable={runtimeAvailable}
                      repoConfigured={repo.url.trim() !== ""}
                      onRefresh={() => onRefreshSkills(repo.url)}
                      onInstall={() => onInstallSkills(repo.url)}
                      onMarkInstalled={() =>
                        updateRepo(index, { skills_marked_installed: true })
                      }
                      onUseAutomaticCheck={() => {
                        updateRepo(index, { skills_marked_installed: false });
                        onRefreshSkills(repo.url);
                      }}
                    />
                  </div>
                ) : null}
              </fieldset>
            );
          })}
          <button
            type="button"
            className="self-start"
            disabled={!runtimeAvailable}
            onClick={addRepo}
          >
            Add repository
          </button>
          <label>
            Workspace root
            <input
              {...literalInputProps}
              value={settings.workspace_root ?? ""}
              disabled={!runtimeAvailable}
              onChange={(e) =>
                setSettings({ ...settings, workspace_root: nullable(e.currentTarget.value) })
              }
              placeholder="App data directory"
            />
            <small className="hint">
              Where per-run workspaces are created (one folder per repo, then per
              issue). Leave blank to use the app data directory.
            </small>
          </label>
          <small className="hint">
            Agent skills are procedural guides (symphony-workpad,
            symphony-commit, symphony-push, …) that Symphony agents follow. Each
            run gets bundled fallback copies locally when a repo does not ship
            them. Each card above shows whether its repo has checked-in skills;
            installing starts an agent session that opens a PR adding them under{" "}
            <code>.agents/skills/</code>, with validation commands adapted to
            that repo's toolchain.
          </small>
        </section>

        <section className="settings-section">
          <h3>Linear</h3>
          <label>
            API key
            <input
              {...literalInputProps}
              value={linearKey}
              disabled={!runtimeAvailable}
              type="password"
              onChange={(e) => setLinearKey(e.currentTarget.value)}
              placeholder={settings.linear_api_key_set ? "Stored in keychain" : "lin_api_..."}
            />
            <small className="hint">
              Create a personal API key under{" "}
              <ExternalLink href="https://linear.app/settings/account/security">
                Linear security settings
              </ExternalLink>
              . It is stored in the OS keychain, never on disk.
            </small>
          </label>
          {settings.linear_api_key_set ? (
            <button
              type="button"
              className="link-button outlined self-start"
              disabled={busy || !runtimeAvailable}
              onClick={onRemoveKey}
            >
              Remove saved key
            </button>
          ) : null}
          <label>
            Workspace
            <input
              {...literalInputProps}
              value={settings.tracker_workspace ?? ""}
              disabled={!runtimeAvailable}
              onChange={(e) =>
                setSettings({ ...settings, tracker_workspace: nullable(e.currentTarget.value) })
              }
              placeholder="acme"
            />
            <small className="hint">
              Your workspace slug — the first path segment in linear.app URLs. Enables issue links.
            </small>
          </label>
          <label>
            Project ID
            <input
              {...literalInputProps}
              value={settings.tracker_project_id ?? ""}
              disabled={!runtimeAvailable}
              onChange={(e) =>
                setSettings({ ...settings, tracker_project_id: nullable(e.currentTarget.value) })
              }
            />
            <small className="hint">
              Optional. Watch a single project by pasting its Linear URL or project ID.
            </small>
          </label>
          <label>
            Team prefix
            <input
              {...literalInputProps}
              value={settings.tracker_prefix ?? ""}
              disabled={!runtimeAvailable}
              onChange={(e) =>
                setSettings({ ...settings, tracker_prefix: nullable(e.currentTarget.value) })
              }
              placeholder="ENG"
            />
            <small className="hint">
              Optional. Watch only issues whose identifier starts with this team key.
            </small>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.tracker_assigned_to_me}
              disabled={!runtimeAvailable}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  tracker_assigned_to_me: e.currentTarget.checked,
                })
              }
            />
            <span>
              Only pick issues assigned to me{" "}
              {settings.tracker_assigned_to_me ? (
                <span className="inline-meta">
                  {linearViewerLoading
                    ? "Checking Linear..."
                    : linearViewer
                      ? linearViewer.username
                      : ""}
                </span>
              ) : null}
            </span>
            <small className="hint">
              When enabled, Symphony dispatches matching active issues only from
              the Linear user tied to the configured API key.
            </small>
            {settings.tracker_assigned_to_me && linearViewerError ? (
              <small className="test-result err">{linearViewerError}</small>
            ) : null}
          </label>
          <label>
            Active states
            <ListInput
              value={settings.active_states}
              disabled={!runtimeAvailable}
              separator="comma"
              placeholder="Todo, In Progress, Rework, Merging"
              onChange={(next) => setSettings({ ...settings, active_states: next })}
            />
            <small className="hint">
              Comma-separated Linear states the worker picks issues up from.
            </small>
            {activeStatesEmpty ? (
              <small className="test-result err">
                Required — without at least one state the worker never runs.
              </small>
            ) : null}
          </label>
          <label>
            Terminal states
            <ListInput
              value={settings.terminal_states}
              disabled={!runtimeAvailable}
              separator="comma"
              placeholder="Done, Canceled"
              onChange={(next) => setSettings({ ...settings, terminal_states: next })}
            />
            <small className="hint">
              States that mean an issue is finished; its workspace can be cleaned up.
            </small>
          </label>
          <div className="section-row">
            <button
              type="button"
              disabled={busy || !runtimeAvailable}
              onClick={onTestConnection}
            >
              Test connection
            </button>
            {trackerTest ? (
              <small
                className={trackerTest.ok ? "test-result ok" : "test-result err"}
                role="status"
              >
                {trackerTest.message}
              </small>
            ) : null}
          </div>
        </section>

        <section className="settings-section">
          <h3>Agent</h3>
          {/* Not a <label>: label activation would forward option clicks back
              to the trigger button and reopen the popup right after selecting. */}
          <div className="field-group">
            Backend
            <BackendSelect
              value={settings.agent_backend}
              disabled={!runtimeAvailable}
              onChange={(backend) => setSettings({ ...settings, agent_backend: backend })}
            />
            <small className="hint">
              The CLI that works on issues. Must be installed and authenticated on this machine.
            </small>
          </div>
          <label>
            Launch command
            <input
              {...literalInputProps}
              className="mono-input"
              value={
                settings.agent_backend === "codex"
                  ? (settings.codex_command ?? "")
                  : settings.agent_backend === "claude"
                    ? (settings.claude_command ?? "")
                    : settings.agent_backend === "cursor"
                      ? (settings.cursor_command ?? "")
                      : (settings.opencode_command ?? "")
              }
              disabled={!runtimeAvailable}
              onChange={(e) => {
                const value = nullable(e.currentTarget.value);
                if (settings.agent_backend === "codex") {
                  setSettings({ ...settings, codex_command: value });
                } else if (settings.agent_backend === "claude") {
                  setSettings({ ...settings, claude_command: value });
                } else if (settings.agent_backend === "cursor") {
                  setSettings({ ...settings, cursor_command: value });
                } else {
                  setSettings({ ...settings, opencode_command: value });
                }
              }}
              placeholder={
                settings.agent_backend === "cursor" ? "agent" : settings.agent_backend
              }
            />
            <small className="hint">
              Optional. How the agent is launched — e.g. a wrapper like{" "}
              <code className="command-example">
                {`mycode --agent ${settings.agent_backend}`}
              </code>
              . Leave blank to run <code>{settings.agent_backend}</code> directly.
            </small>
          </label>
          {validation ? (
            <small className="hint">
              Codex CLI
              {validation.codex_command === "codex" ? "" : ` (${validation.codex_command})`}:{" "}
              <span className={validation.codex_found ? "detect ok" : "detect missing"}>
                {validation.codex_found ? "found" : "not found"}
              </span>
              {" · "}
              Claude CLI
              {validation.claude_command === "claude" ? "" : ` (${validation.claude_command})`}:{" "}
              <span className={validation.claude_found ? "detect ok" : "detect missing"}>
                {validation.claude_found ? "found" : "not found"}
              </span>
              {" · "}
              Cursor CLI
              {validation.cursor_command === "agent" ? "" : ` (${validation.cursor_command})`}:{" "}
              <span className={validation.cursor_found ? "detect ok" : "detect missing"}>
                {validation.cursor_found ? "found" : "not found"}
              </span>
              {" · "}
              opencode CLI
              {validation.opencode_command === "opencode"
                ? ""
                : ` (${validation.opencode_command})`}
              :{" "}
              <span className={validation.opencode_found ? "detect ok" : "detect missing"}>
                {validation.opencode_found ? "found" : "not found"}
              </span>
            </small>
          ) : null}
          <label>
            Turn timeout (seconds)
            <SettingsNumberInput
              min={0}
              minValue={0}
              step="any"
              value={settings.turn_timeout_ms / 1000}
              disabled={!runtimeAvailable}
              onValidChange={(n) =>
                setSettings({ ...settings, turn_timeout_ms: Math.round(n * 1000) })
              }
            />
            <small className="hint">
              Max time for one agent turn. 3600 = 1 hour.
            </small>
          </label>
          <label>
            Session environment
            <EnvInput
              value={settings.session_env}
              disabled={!runtimeAvailable}
              onChange={(next) => setSettings({ ...settings, session_env: next })}
            />
            <small className="hint">
              Optional. One <code>KEY=value</code> per line, injected into the agent process
              (e.g. <code>CURSOR_API_KEY</code> for Cursor). Values are saved in settings.
            </small>
          </label>
          {settings.agent_backend === "codex" ? (
            <>
              <label>
                Approval policy
                <select
                  value={settings.codex_approval_policy}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      codex_approval_policy: e.currentTarget
                        .value as AppSettings["codex_approval_policy"],
                    })
                  }
                >
                  <option value="never">Never (unattended)</option>
                  <option value="on-request">On request</option>
                  <option value="on-failure">On failure</option>
                  <option value="always">Always</option>
                </select>
                <small className="hint">
                  When Codex pauses for approval. Runs are unattended — keep <code>Never</code>.
                </small>
              </label>
              <label>
                Thread sandbox
                <select
                  value={settings.codex_thread_sandbox}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      codex_thread_sandbox: e.currentTarget
                        .value as AppSettings["codex_thread_sandbox"],
                    })
                  }
                >
                  <option value="workspace-write">Workspace write</option>
                  <option value="read-only">Read only</option>
                  <option value="none">None</option>
                </select>
              </label>
              <label>
                Turn sandbox policy
                <select
                  value={settings.codex_turn_sandbox_policy}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      codex_turn_sandbox_policy: e.currentTarget
                        .value as AppSettings["codex_turn_sandbox_policy"],
                    })
                  }
                >
                  <option value="inherit">Inherit</option>
                  <option value="workspace-write">Workspace write</option>
                  <option value="read-only">Read only</option>
                  <option value="danger-full-access">Danger: full access</option>
                </select>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.codex_network_access}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({ ...settings, codex_network_access: e.currentTarget.checked })
                  }
                />
                Network access
                <small className="hint">
                  Runs push branches and call GitHub/Linear — keep this on.
                </small>
              </label>
            </>
          ) : settings.agent_backend === "claude" ? (
            <>
              <label>
                Permission mode
                <select
                  value={settings.claude_permission_mode}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      claude_permission_mode: e.currentTarget
                        .value as AppSettings["claude_permission_mode"],
                    })
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="acceptEdits">Accept edits</option>
                  <option value="default">Default</option>
                  <option value="dontAsk">Don't ask</option>
                  <option value="bypassPermissions">Bypass permissions</option>
                  <option value="plan">Plan</option>
                </select>
                <small className="hint">
                  How Claude Code handles tool permissions during unattended runs.
                </small>
              </label>
              <label>
                Allowed tools
                <ListInput
                  value={settings.claude_allowed_tools}
                  disabled={!runtimeAvailable}
                  separator="newline"
                  rows={8}
                  placeholder={"Bash(gh *)\nBash(git status*)"}
                  onChange={(next) => setSettings({ ...settings, claude_allowed_tools: next })}
                />
                <small className="hint">
                  One rule per line. The target repo's <code>.claude/settings.json</code> can add
                  repo-specific extras on top.
                </small>
              </label>
              <label>
                Disallowed tools
                <ListInput
                  value={settings.claude_disallowed_tools}
                  disabled={!runtimeAvailable}
                  separator="newline"
                  rows={3}
                  onChange={(next) => setSettings({ ...settings, claude_disallowed_tools: next })}
                />
                <small className="hint">One rule per line. Takes precedence over allowed tools.</small>
              </label>
              <label>
                Additional directories
                <ListInput
                  value={settings.claude_add_dirs}
                  disabled={!runtimeAvailable}
                  separator="newline"
                  rows={2}
                  onChange={(next) => setSettings({ ...settings, claude_add_dirs: next })}
                />
                <small className="hint">
                  One path per line, made available to the agent beyond the workspace.
                </small>
              </label>
            </>
          ) : settings.agent_backend === "cursor" ? (
            <>
              <label>
                Mode
                <select
                  value={settings.cursor_mode}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      cursor_mode: e.currentTarget.value as AppSettings["cursor_mode"],
                    })
                  }
                >
                  <option value="agent">Agent</option>
                  <option value="plan">Plan (read-only design)</option>
                  <option value="ask">Ask (read-only exploration)</option>
                </select>
                <small className="hint">
                  Agent mode can edit files. Plan and Ask are read-only — use Agent for issue runs.
                </small>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.cursor_force}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({ ...settings, cursor_force: e.currentTarget.checked })
                  }
                />
                Force auto-approve
                <small className="hint">
                  Maps to <code>--force</code>. Required for unattended runs.
                </small>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.cursor_trust}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({ ...settings, cursor_trust: e.currentTarget.checked })
                  }
                />
                Trust workspace
                <small className="hint">
                  Maps to <code>--trust</code>. Skips workspace trust prompts in headless mode.
                </small>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.cursor_approve_mcps}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({ ...settings, cursor_approve_mcps: e.currentTarget.checked })
                  }
                />
                Approve MCPs
                <small className="hint">
                  Maps to <code>--approve-mcps</code>. Auto-approves MCP servers for this run.
                </small>
              </label>
              <label>
                Sandbox
                <select
                  value={settings.cursor_sandbox}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      cursor_sandbox: e.currentTarget.value as AppSettings["cursor_sandbox"],
                    })
                  }
                >
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
              <label>
                Model
                <input
                  {...literalInputProps}
                  value={settings.cursor_model ?? ""}
                  disabled={!runtimeAvailable}
                  placeholder="Optional, e.g. composer-2.5"
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      cursor_model: nullable(e.currentTarget.value),
                    })
                  }
                />
                <small className="hint">Leave blank for the CLI default.</small>
              </label>
            </>
          ) : (
            <>
              <label>
                Model
                <input
                  {...literalInputProps}
                  value={settings.opencode_model ?? ""}
                  disabled={!runtimeAvailable}
                  placeholder="Optional, e.g. anthropic/claude-sonnet-4-5"
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      opencode_model: nullable(e.currentTarget.value),
                    })
                  }
                />
                <small className="hint">
                  <code>provider/model</code> passed to <code>--model</code>. Leave blank for the
                  CLI default.
                </small>
              </label>
              <label>
                Agent
                <input
                  {...literalInputProps}
                  value={settings.opencode_agent ?? ""}
                  disabled={!runtimeAvailable}
                  placeholder="Optional, e.g. build"
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      opencode_agent: nullable(e.currentTarget.value),
                    })
                  }
                />
                <small className="hint">
                  Primary agent passed to <code>--agent</code>. Leave blank for the default.
                </small>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.opencode_skip_permissions}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      opencode_skip_permissions: e.currentTarget.checked,
                    })
                  }
                />
                Skip permissions
                <small className="hint">
                  Maps to <code>--dangerously-skip-permissions</code>. Required for unattended runs —
                  without it opencode auto-rejects every tool call.
                </small>
              </label>
            </>
          )}
        </section>

        <section className="settings-section">
          <h3>Worker</h3>
          <label>
            Polling interval (seconds)
            <SettingsNumberInput
              min={0}
              minValue={0}
              step="any"
              value={settings.polling_interval_ms / 1000}
              disabled={!runtimeAvailable}
              onValidChange={(n) =>
                setSettings({ ...settings, polling_interval_ms: Math.round(n * 1000) })
              }
            />
            <small className="hint">
              How often Linear is polled for issues. Applies after Save; the live
              worker wakes and uses the new interval on its next loop.
            </small>
          </label>
          <label>
            Max concurrent agents
            <SettingsNumberInput
              min={0}
              minValue={0}
              value={settings.max_concurrent_agents}
              disabled={!runtimeAvailable}
              onValidChange={(n) =>
                setSettings({ ...settings, max_concurrent_agents: Math.trunc(n) })
              }
            />
            <small className="hint">
              Issues worked on in parallel. Applies to future dispatch decisions;
              already-running agents continue.
            </small>
          </label>
          <label>
            Max retry backoff (seconds)
            <SettingsNumberInput
              min={0}
              minValue={0}
              step="any"
              value={settings.max_retry_backoff_ms / 1000}
              disabled={!runtimeAvailable}
              onValidChange={(n) =>
                setSettings({ ...settings, max_retry_backoff_ms: Math.round(n * 1000) })
              }
            />
            <small className="hint">
              Cap on the delay between retries of a failed run. 300 = 5 min.
            </small>
          </label>
          <label>
            Hook timeout (seconds)
            <SettingsNumberInput
              min={0}
              minValue={0}
              step="any"
              value={settings.hook_timeout_ms / 1000}
              disabled={!runtimeAvailable}
              onValidChange={(n) =>
                setSettings({ ...settings, hook_timeout_ms: Math.round(n * 1000) })
              }
            />
            <small className="hint">
              Max time for each hook script. Applies to hooks that start after
              Save; a hook already running keeps its current timeout.
            </small>
          </label>
          <details className="hooks-details">
            <summary>Hooks (advanced)</summary>
            <small className="hint">
              Shell scripts run at workspace lifecycle points. They receive{" "}
              <code>$REPO_URL</code>, <code>$ISSUE_IDENTIFIER</code>, <code>$ISSUE_BRANCH</code>,{" "}
              <code>$SYMPHONY_INSTALL_CMD</code>, and the hook name as{" "}
              <code>$SYMPHONY_HOOK</code>. <code>after_create</code> only runs for
              fresh workspaces, so existing ready workspaces are not reinitialized
              by saving hook changes.
            </small>
            <label>
              After create
              <textarea
                {...literalInputProps}
                className="mono-input"
                rows={4}
                value={settings.hook_after_create ?? ""}
                disabled={!runtimeAvailable}
                onChange={(e) =>
                  setSettings({ ...settings, hook_after_create: nullable(e.currentTarget.value) })
                }
              />
              <small className="hint">
                Runs once per fresh workspace — clone, branch, install. Changes affect
                the next new workspace, not an existing ready workspace.
              </small>
            </label>
            <label>
              Before run
              <textarea
                {...literalInputProps}
                className="mono-input"
                rows={2}
                value={settings.hook_before_run ?? ""}
                disabled={!runtimeAvailable}
                onChange={(e) =>
                  setSettings({ ...settings, hook_before_run: nullable(e.currentTarget.value) })
                }
              />
            </label>
            <label>
              After run
              <textarea
                {...literalInputProps}
                className="mono-input"
                rows={2}
                value={settings.hook_after_run ?? ""}
                disabled={!runtimeAvailable}
                onChange={(e) =>
                  setSettings({ ...settings, hook_after_run: nullable(e.currentTarget.value) })
                }
              />
            </label>
            <label>
              Before remove
              <textarea
                {...literalInputProps}
                className="mono-input"
                rows={2}
                value={settings.hook_before_remove ?? ""}
                disabled={!runtimeAvailable}
                onChange={(e) =>
                  setSettings({ ...settings, hook_before_remove: nullable(e.currentTarget.value) })
                }
              />
            </label>
          </details>
        </section>
      </div>

      <Panel title="Prompt template">
        <PromptEditor
          value={settings.prompt_template}
          disabled={!runtimeAvailable}
          onChange={(next) => setSettings({ ...settings, prompt_template: next })}
        />
        <div className="section-row">
          <button
            type="button"
            disabled={busy || !runtimeAvailable}
            onClick={onResetPrompt}
          >
            Reset to default
          </button>
          <small className="hint">
            Replaces the editor with the bundled default prompt. Nothing changes until you save.
          </small>
        </div>
      </Panel>

      {validation && runtimeAvailable ? (
        <div className="settings-footer">
          <div className="storage-actions">
            <button
              type="button"
              onClick={() =>
                revealItemInDir(validation.database_path).catch(() => undefined)
              }
            >
              Reveal database
            </button>
            <button
              type="button"
              onClick={() =>
                revealItemInDir(`${validation.app_data_dir}/logs`).catch(
                  () => undefined,
                )
              }
            >
              Reveal logs
            </button>
          </div>
          <p className="storage-note">
            Data directory <code>{validation.app_data_dir}</code>
          </p>
        </div>
      ) : null}

      <p className="about-note">
        Symphony{appVersion ? ` v${appVersion}` : ""} ·{" "}
        <ExternalLink href={GITHUB_URL}>GitHub</ExternalLink> ·{" "}
        <ExternalLink href={`${GITHUB_URL}/issues`}>Report an issue</ExternalLink>
      </p>
    </form>
  );
}

// List fields keep a local text draft: round-tripping every keystroke through
// join(parse(...)) would eat separators as the user types them.
function ListInput({
  value,
  onChange,
  disabled,
  separator,
  placeholder,
  rows,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
  separator: "comma" | "newline";
  placeholder?: string;
  rows?: number;
}) {
  const join = (items: string[]) =>
    separator === "comma" ? items.join(", ") : items.join("\n");
  const parse = (text: string) =>
    text
      .split(separator === "comma" ? "," : "\n")
      .map((item) => item.trim())
      .filter(Boolean);
  const joined = join(value);
  const [draft, setDraft] = useState(joined);
  const lastEmitted = useRef(joined);
  useEffect(() => {
    // Re-seed only on external changes (settings load, reset to defaults).
    if (joined !== lastEmitted.current) {
      setDraft(joined);
      lastEmitted.current = joined;
    }
  }, [joined]);
  function handleChange(text: string) {
    setDraft(text);
    const next = parse(text);
    lastEmitted.current = join(next);
    onChange(next);
  }
  if (separator === "newline") {
    return (
      <textarea
        {...literalInputProps}
        className="mono-input"
        value={draft}
        disabled={disabled}
        rows={rows ?? 6}
        placeholder={placeholder}
        onChange={(e) => handleChange(e.currentTarget.value)}
      />
    );
  }
  return (
    <input
      {...literalInputProps}
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => handleChange(e.currentTarget.value)}
    />
  );
}

function EnvInput({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled: boolean;
}) {
  const joined = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, envValue]) => `${key}=${envValue}`)
    .join("\n");
  const [draft, setDraft] = useState(joined);
  const lastEmitted = useRef(joined);

  useEffect(() => {
    if (joined !== lastEmitted.current) {
      setDraft(joined);
      lastEmitted.current = joined;
    }
  }, [joined]);

  function parse(text: string): Record<string, string> {
    const next: Record<string, string> = {};
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const separator = line.indexOf("=");
      const key = (separator === -1 ? line : line.slice(0, separator)).trim();
      if (key === "") continue;
      next[key] = separator === -1 ? "" : line.slice(separator + 1);
    }
    return next;
  }

  function handleChange(text: string) {
    setDraft(text);
    const next = parse(text);
    lastEmitted.current = Object.entries(next)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, envValue]) => `${key}=${envValue}`)
      .join("\n");
    onChange(next);
  }

  return (
    <textarea
      {...literalInputProps}
      className="mono-input"
      value={draft}
      disabled={disabled}
      rows={4}
      placeholder={"OPENAI_API_KEY=...\nFEATURE_FLAG=1"}
      onChange={(e) => handleChange(e.currentTarget.value)}
    />
  );
}

const BACKEND_OPTIONS: Array<{ value: AppSettings["agent_backend"]; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude Code" },
  { value: "cursor", label: "Cursor" },
  { value: "opencode", label: "opencode" },
];

function BackendIcon({ backend }: { backend: AppSettings["agent_backend"] }) {
  if (backend === "claude") {
    return (
      <svg className="backend-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="#D97757"
          d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.583.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.473.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
        />
      </svg>
    );
  }
  if (backend === "cursor") {
    return (
      <svg className="backend-icon" viewBox="600 300 400 400" aria-hidden="true">
        <path
          fill="#F7F7F4"
          d="M999.994 554.294C999.994 559.859 999.994 565.419 999.962 570.984C999.935 575.67 999.882 580.357 999.753 585.038C999.475 595.247 998.875 605.542 997.059 615.639C995.217 625.88 992.212 635.409 987.477 644.718C982.822 653.861 976.738 662.233 969.485 669.491C962.227 676.748 953.861 682.828 944.712 687.482C935.409 692.217 925.875 695.222 915.633 697.065C905.537 698.88 895.242 699.48 885.033 699.759C880.346 699.887 875.665 699.941 870.978 699.968C865.413 700.005 859.853 700 854.288 700H745.695C740.13 700 734.571 700 729.005 699.968C724.319 699.941 719.632 699.887 714.951 699.759C704.742 699.48 694.447 698.88 684.35 697.065C674.109 695.222 664.58 692.217 655.271 687.482C646.128 682.828 637.756 676.743 630.499 669.491C623.241 662.233 617.161 653.866 612.507 644.718C607.772 635.414 604.767 625.88 602.925 615.639C601.109 605.542 600.509 595.247 600.23 585.038C600.102 580.352 600.048 575.67 600.021 570.984C600 565.419 600 559.859 600 554.294V445.701C600 440.136 600 434.576 600.032 429.011C600.059 424.324 600.112 419.637 600.241 414.956C600.52 404.747 601.119 394.452 602.935 384.356C604.778 374.115 607.783 364.586 612.518 355.277C617.172 346.133 623.257 337.762 630.509 330.504C637.767 323.246 646.133 317.167 655.282 312.512C664.586 307.777 674.12 304.772 684.361 302.93C694.458 301.114 704.752 300.514 714.961 300.236C719.648 300.107 724.329 300.054 729.016 300.027C734.576 300 740.136 300 745.701 300H854.294C859.859 300 865.419 300 870.984 300.032C875.67 300.059 880.357 300.112 885.038 300.241C895.247 300.52 905.542 301.119 915.639 302.935C925.88 304.778 935.409 307.783 944.718 312.518C953.861 317.172 962.233 323.257 969.491 330.509C976.748 337.767 982.828 346.133 987.482 355.282C992.217 364.586 995.222 374.12 997.065 384.361C998.88 394.458 999.48 404.752 999.759 414.961C999.887 419.648 999.941 424.329 999.968 429.016C1000.01 434.581 1000 440.141 1000 445.706V554.299L999.994 554.294Z"
        />
        <path
          fill="#72716D"
          d="M800.001 500L928.151 573.986C927.364 575.352 926.223 576.515 924.809 577.329L805.025 646.484C801.913 648.279 798.078 648.279 794.966 646.484L675.182 577.329C673.768 576.515 672.627 575.347 671.84 573.986L799.99 500H800.001Z"
        />
        <path
          fill="#55544F"
          d="M800 352.165V500L671.85 573.987C671.062 572.621 670.623 571.046 670.623 569.418V430.582C670.623 427.314 672.364 424.304 675.192 422.67L794.97 353.515C796.529 352.615 798.264 352.165 800 352.165Z"
        />
        <path
          fill="#43413C"
          d="M928.15 426.013C927.363 424.647 926.222 423.485 924.808 422.67L805.024 353.515C803.471 352.615 801.735 352.165 800 352.165V500L928.15 573.987C928.938 572.621 929.377 571.046 929.377 569.418V430.582C929.377 428.948 928.943 427.384 928.15 426.013Z"
        />
        <path
          fill="#D6D5D2"
          d="M919.184 431.192C919.913 432.446 920.009 434.053 919.184 435.483L802.856 636.961C802.074 638.327 799.995 637.765 799.995 636.195V503.428C799.995 502.367 799.711 501.35 799.197 500.455L919.179 431.182H919.184V431.192Z"
        />
        <path
          fill="white"
          d="M919.184 431.192L799.202 500.466C798.694 499.577 797.949 498.827 797.028 498.291L682.054 431.91C680.688 431.128 681.251 429.05 682.82 429.05H915.467C917.117 429.05 918.461 429.944 919.179 431.198H919.184V431.192Z"
        />
      </svg>
    );
  }
  if (backend === "opencode") {
    // Official OpenCode logomark (opencode.ai/brand). Two-tone square glyph:
    // the inner fill uses currentColor so it adapts to light/dark like the
    // other backend icons, with the frame in a muted currentColor. The brand
    // paths span x:0-24, y:6-36; the viewBox crops that 24x30 content and
    // centers it in a square so the mark sits centered in the 16x16 icon box.
    return (
      <svg className="backend-icon" viewBox="-3 6 30 30" aria-hidden="true">
        <path fill="currentColor" fillOpacity="0.55" d="M18 30H6V18H18V30Z" />
        <path fill="currentColor" d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" />
      </svg>
    );
  }
  return (
    <svg className="backend-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.073zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"
      />
    </svg>
  );
}

// Native <option> elements can't render icons, so the backend picker is a
// custom trigger + listbox driven with the aria-activedescendant pattern.
function BackendSelect({
  value,
  disabled,
  onChange,
}: {
  value: AppSettings["agent_backend"];
  disabled: boolean;
  onChange: (next: AppSettings["agent_backend"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const selected = BACKEND_OPTIONS.find((option) => option.value === value) ?? BACKEND_OPTIONS[0];

  function openList() {
    setActiveIndex(Math.max(0, BACKEND_OPTIONS.findIndex((option) => option.value === value)));
    setOpen(true);
  }

  function commit(index: number) {
    onChange(BACKEND_OPTIONS[index].value);
    setOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        openList();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(BACKEND_OPTIONS.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(activeIndex);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div className="icon-select" ref={rootRef}>
      <button
        type="button"
        className="icon-select-trigger"
        disabled={disabled}
        role="combobox"
        aria-label="Backend"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? "backend-listbox" : undefined}
        aria-activedescendant={open ? `backend-option-${BACKEND_OPTIONS[activeIndex].value}` : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={handleKeyDown}
      >
        <BackendIcon backend={selected.value} />
        {selected.label}
        <svg className="chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <ul className="icon-select-list" id="backend-listbox" role="listbox">
          {BACKEND_OPTIONS.map((option, index) => (
            <li
              key={option.value}
              id={`backend-option-${option.value}`}
              role="option"
              aria-selected={option.value === value}
              className={index === activeIndex ? "icon-select-option active" : "icon-select-option"}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => commit(index)}
            >
              <span className="icon-select-check" aria-hidden="true">
                {option.value === value ? (
                  <svg viewBox="0 0 16 16" width="12" height="12">
                    <path
                      d="M3 8.5l3.5 3.5L13 4.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </span>
              <BackendIcon backend={option.value} />
              {option.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PromptEditor({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function insertVariable(name: string) {
    const token = `{{${name}}}`;
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div className="prompt-editor">
      <textarea
        ref={ref}
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      <aside className="var-reference">
        <h4>Variables</h4>
        <p className="hint">
          Filled in from the Linear issue when a run starts. Click to insert at the cursor.
        </p>
        <ul className="var-list">
          {PROMPT_VARIABLES.map((variable) => (
            <li key={variable.name}>
              <button
                type="button"
                className="var-button"
                disabled={disabled}
                onClick={() => insertVariable(variable.name)}
              >
                <code>{`{{${variable.name}}}`}</code>
                <small className="hint">
                  {variable.description}
                  {variable.example ? (
                    <>
                      {" — e.g. "}
                      <code>{variable.example}</code>
                    </>
                  ) : null}
                </small>
              </button>
            </li>
          ))}
        </ul>
        <p className="hint">
          On retries, Symphony appends a <code>## Retry context</code> section with the prior
          run's error automatically.
        </p>
      </aside>
    </div>
  );
}

function SkillsBlock({
  status,
  checking,
  manuallyInstalled,
  install,
  installRunning,
  busy,
  runtimeAvailable,
  repoConfigured,
  onRefresh,
  onInstall,
  onMarkInstalled,
  onUseAutomaticCheck,
}: {
  /// Status and install are this card's repo only; installRunning is true
  /// while ANY repo's install session runs (the installer is one-at-a-time).
  status: SkillsStatus | null;
  checking: boolean;
  manuallyInstalled: boolean;
  install: SkillsInstallStatus | null;
  installRunning: boolean;
  busy: boolean;
  runtimeAvailable: boolean;
  repoConfigured: boolean;
  onRefresh: () => void;
  onInstall: () => void;
  onMarkInstalled: () => void;
  onUseAutomaticCheck: () => void;
}) {
  const installing = install?.state === "running";
  const otherInstallRunning = installRunning && !installing;
  const actionsDisabled = busy || installRunning || !runtimeAvailable || !repoConfigured;
  const manualActionsDisabled = busy || !runtimeAvailable || !repoConfigured;
  // A just-finished install knows the PR URL before the next status check does.
  const prUrl =
    (install?.state === "completed" ? install.pr_url : null) ??
    status?.pr_url ??
    null;

  let tone: "neutral" | "info" | "success" | "warning" | "error" = "neutral";
  let headline = "Check this repo for Symphony skills.";
  let detail: React.ReactNode =
    "Symphony can detect whether this repo already ships the bundled agent skills; missing skills are injected locally for issue runs.";
  let meta: React.ReactNode = null;
  let actions: React.ReactNode = null;

  const checkButton = (
    <button type="button" disabled={actionsDisabled} onClick={onRefresh}>
      Check status
    </button>
  );
  const checkAgainButton = (
    <button type="button" disabled={actionsDisabled} onClick={onRefresh}>
      Check again
    </button>
  );
  const markInstalledButton = (
    <button type="button" disabled={manualActionsDisabled} onClick={onMarkInstalled}>
      Mark installed
    </button>
  );

  if (manuallyInstalled) {
    tone = "success";
    headline = "Agent skills are marked installed.";
    detail =
      "Symphony will stop warning when this repo does not match the exact bundled skill set.";
    meta = "Use automatic check to compare the default branch against the bundled manifests again.";
    actions = (
      <button
        type="button"
        disabled={manualActionsDisabled}
        onClick={onUseAutomaticCheck}
      >
        Use automatic check
      </button>
    );
  } else if (installing) {
    tone = "info";
    headline = "Creating an install PR.";
    detail =
      "Symphony is working in a temporary checkout, writing the bundled skills, adapting validation commands, and opening a PR.";
    meta = install?.message ?? "Preparing install session...";
    actions = (
      <button type="button" disabled>
        Creating PR...
      </button>
    );
  } else if (install?.state === "failed") {
    tone = "error";
    headline = "Install PR was not created.";
    detail =
      "Fix the reported GitHub or agent access problem, then retry the install session.";
    meta = install.error ?? "Install failed.";
    actions = (
      <button
        type="button"
        className="primary"
        disabled={actionsDisabled}
        onClick={onInstall}
      >
        Retry install PR
      </button>
    );
  } else if (checking) {
    tone = "info";
    headline = "Checking the default branch.";
    detail = "Symphony is using GitHub to verify the bundled skill manifests.";
  } else if (status?.state === "installed") {
    tone = "success";
    headline = "Agent skills are installed.";
    detail = `All ${BUNDLED_SKILL_COUNT} Symphony skills are present on this repo's default branch.`;
    actions = checkAgainButton;
  } else if (prUrl) {
    tone = "warning";
    headline = "An install PR is waiting for review.";
    detail =
      "Symphony will inject local fallback skills until the PR lands on the default branch.";
    actions = (
      <>
        <button
          type="button"
          onClick={() => openUrl(prUrl).catch(() => undefined)}
        >
          View PR
        </button>
        {markInstalledButton}
        {checkAgainButton}
      </>
    );
  } else if (status?.state === "missing") {
    tone = "warning";
    headline = "Repository does not ship all agent skills.";
    detail = `Issue runs will get local fallback copies. Create an install PR for ${BUNDLED_SKILL_EXAMPLES}, and the rest of the bundled workflow skills, if this repo should check them in.`;
    meta = `${status.missing.length} of ${BUNDLED_SKILL_COUNT} bundled skills are missing.`;
    actions = (
      <>
        <button
          type="button"
          className="primary"
          disabled={actionsDisabled}
          onClick={onInstall}
        >
          Create install PR
        </button>
        {markInstalledButton}
        {checkAgainButton}
      </>
    );
  } else if (status?.state === "unavailable") {
    tone = "error";
    headline = "Symphony could not check this repo.";
    detail = status.detail ?? "Check the repository URL, GitHub CLI, and authentication.";
    actions = (
      <>
        {checkButton}
        {markInstalledButton}
      </>
    );
  } else if (!repoConfigured) {
    headline = "Add a repository URL first.";
    detail = "Skill detection and install PR creation run against the repo URL above.";
  } else {
    actions = (
      <>
        {checkButton}
        {markInstalledButton}
      </>
    );
  }

  if (otherInstallRunning) {
    meta = (
      <>
        {meta ? <span>{meta}</span> : null}
        <span>Another repository is already creating an install PR.</span>
      </>
    );
  }

  return (
    <div className="field-group skills-field">
      <div className="field-label-row">
        <span>Agent skills</span>
      </div>
      <div className={`skills-install ${tone}`} aria-live="polite">
        <div className="skills-install-copy">
          <strong>{headline}</strong>
          <small>{detail}</small>
          {meta ? (
            <small
              className={
                tone === "error"
                  ? "skills-install-detail error"
                  : "skills-install-detail"
              }
            >
              {meta}
            </small>
          ) : null}
        </div>
        {actions ? <div className="skills-install-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="inline-link"
      onClick={() => openUrl(href).catch(() => undefined)}
    >
      {children}
    </button>
  );
}

function scrollToMatch(container: HTMLElement | null, index: number) {
  const mark = container?.querySelector(`mark[data-match-index="${index}"]`);
  if (!(mark instanceof HTMLElement)) return;
  // A match inside a collapsed payload is invisible until its details opens.
  const details = mark.closest("details");
  if (details && !details.open) details.open = true;
  mark.scrollIntoView({ block: "center", inline: "nearest" });
}

function EventStream({
  events,
  live,
}: {
  events: AgentEventRow[];
  live: boolean;
}) {
  // The worker writes a "humanized" twin alongside every raw event that has
  // a summary; the summaries below cover the raw events, so skip the twins.
  const visible = useMemo(
    () => events.filter((event) => event.kind !== "humanized"),
    [events],
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastScrolledMatch = useRef("");
  const [follow, setFollow] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);

  const described = useMemo(
    () =>
      visible.map((event) => ({
        ...describeEvent(event.kind, event.payload),
        pretty: prettyPayload(event.payload),
      })),
    [visible],
  );

  const needle = searchOpen ? query.toLowerCase() : "";

  // Number every match across events so Enter/Shift+Enter can walk them in
  // document order; each event records where its label/summary/payload start.
  const { matchStarts, totalMatches } = useMemo(() => {
    const matchStarts: { label: number; summary: number; payload: number }[] = [];
    let totalMatches = 0;
    for (const item of described) {
      const label = totalMatches;
      totalMatches += countMatches(item.label, needle);
      const summary = totalMatches;
      totalMatches += countMarkdownMatches(item.summary, needle);
      const payload = totalMatches;
      totalMatches += countMatches(item.pretty, needle);
      matchStarts.push({ label, summary, payload });
    }
    return { matchStarts, totalMatches };
  }, [described, needle]);

  useEffect(() => {
    setCurrent(0);
  }, [needle]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [searchOpen]);

  useEffect(() => {
    if (current !== 0 && current >= totalMatches) setCurrent(0);
  }, [current, totalMatches]);

  useEffect(() => {
    if (!follow) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, follow]);

  // Keep the active match in view. Runs after every render but only acts when
  // the (query, index) pair changed, so live events streaming in while the
  // user reads a match don't re-yank the scroll position.
  useEffect(() => {
    if (!needle || totalMatches === 0) {
      lastScrolledMatch.current = "";
      return;
    }
    const key = `${needle}\u0000${current}`;
    if (lastScrolledMatch.current === key) return;
    lastScrolledMatch.current = key;
    scrollToMatch(containerRef.current, current);
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const findShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f";
      if (findShortcut && visible.length > 0) {
        event.preventDefault();
        if (searchOpen) {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        } else {
          setSearchOpen(true);
        }
      } else if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen, visible.length]);

  const step = (dir: 1 | -1) => {
    if (totalMatches === 0) return;
    if (totalMatches === 1) {
      // The index can't change, so re-center the only match directly.
      scrollToMatch(containerRef.current, 0);
      return;
    }
    setCurrent((prev) => (prev + dir + totalMatches) % totalMatches);
  };

  if (visible.length === 0) {
    return (
      <Empty title="No events recorded" text="This run has no agent events yet." />
    );
  }

  return (
    <div className="events-wrap">
      {searchOpen ? (
        <div className="event-search">
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            placeholder="Search events…"
            aria-label="Search run log"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              }
            }}
          />
          {needle ? (
            <span className="event-search-count tnum">
              {totalMatches === 0
                ? "0/0"
                : `${Math.min(current + 1, totalMatches)}/${totalMatches}`}
            </span>
          ) : null}
          <button
            type="button"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
            disabled={totalMatches === 0}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => step(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            title="Next match (Enter)"
            aria-label="Next match"
            disabled={totalMatches === 0}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => step(1)}
          >
            ↓
          </button>
          <button
            type="button"
            title="Close (Esc)"
            aria-label="Close search"
            onClick={() => setSearchOpen(false)}
          >
            ✕
          </button>
        </div>
      ) : null}
      <div
        className="events"
        ref={containerRef}
        onScroll={() => {
          const el = containerRef.current;
          if (!el) return;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
      >
        {visible.map((event, index) => {
          const { label, summary, tone, pretty } = described[index];
          const starts = matchStarts[index];
          return (
            <article key={event.id} className={tone === "error" ? "event-error" : undefined}>
              <div className="event-line">
                <span className="event-kind">
                  {highlightMatches(label, needle, starts.label, current)}
                </span>
                <div
                  className={
                    event.kind === "tool_call" ? "event-summary mono" : "event-summary"
                  }
                >
                  {summary ? (
                    <MarkdownText
                      text={summary}
                      needle={needle}
                      firstIndex={starts.summary}
                      currentIndex={current}
                    />
                  ) : (
                    <em>no details</em>
                  )}
                </div>
                <time title={shortTime(event.created_at)}>
                  {timeOnly(event.created_at)}
                </time>
              </div>
              <details>
                <summary>payload</summary>
                <pre>{highlightMatches(pretty, needle, starts.payload, current)}</pre>
              </details>
            </article>
          );
        })}
        {!follow && live ? (
          <button
            type="button"
            className="jump-latest"
            onClick={() => {
              const el = containerRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              setFollow(true);
            }}
          >
            Jump to latest ↓
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RunTable({
  runs,
  onOpenRun,
  emptyTitle,
  emptyText,
  actionLabel,
  actionDisabled,
  onAction,
  activeRunIds,
  selectedRunId,
  lastActivity,
  showRepo,
}: {
  runs: RunWithIssueRow[];
  onOpenRun: (id: string) => void;
  emptyTitle?: string;
  emptyText?: string;
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
  activeRunIds?: Set<string>;
  selectedRunId?: string;
  lastActivity?: Map<string, string>;
  showRepo?: boolean;
}) {
  if (runs.length === 0) {
    return (
      <Empty
        title={emptyTitle ?? "No runs"}
        text={emptyText}
        actionLabel={actionLabel}
        actionDisabled={actionDisabled}
        onAction={onAction}
      />
    );
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Issue</th>
          <th>Run</th>
          <th>Status</th>
          <th>Created</th>
          {lastActivity ? <th>Last activity</th> : null}
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr
            key={run.id}
            className={
              run.id === selectedRunId ? "clickable-row selected" : "clickable-row"
            }
            tabIndex={0}
            role="button"
            aria-label={`Open run ${run.issue_identifier} number ${run.run_number}`}
            aria-current={run.id === selectedRunId ? "true" : undefined}
            onClick={() => onOpenRun(run.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpenRun(run.id);
              }
            }}
          >
            <td>
              <strong>
                {run.issue_identifier}
                {showRepo && run.repo_name ? (
                  <span className="repo-badge">{run.repo_name}</span>
                ) : null}
                {activeRunIds?.has(run.id) ? <span className="pulse" /> : null}
              </strong>
              <small>{run.issue_title}</small>
              {run.error_message ? (
                <small className="row-error" title={run.error_message}>
                  {run.error_class ? `${run.error_class}: ` : ""}
                  {run.error_message}
                </small>
              ) : null}
            </td>
            <td>#{run.run_number}</td>
            <td><Badge status={run.status} /></td>
            <td className="tnum" title={shortTime(run.created_at)}>
              {relativeTime(run.created_at)}
            </td>
            {lastActivity ? (
              <td
                className="tnum"
                title={
                  lastActivity.has(run.id)
                    ? shortTime(lastActivity.get(run.id)!)
                    : undefined
                }
              >
                {lastActivity.has(run.id)
                  ? relativeTime(lastActivity.get(run.id)!)
                  : "—"}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="kpi">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function RuntimeBanner({ title, message }: { title: string; message: string }) {
  return (
    <div className="runtime-banner" role="status">
      <div>
        <strong>{title}</strong>
        <span>{message}</span>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Empty({
  title,
  text,
  actionLabel,
  actionDisabled,
  onAction,
}: {
  title: string;
  text?: string;
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {text ? <span>{text}</span> : null}
      {actionLabel ? (
        <button disabled={actionDisabled} onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function Badge({ status }: { status: string }) {
  return <span className={`badge ${statusSlug(status)}`}>{status}</span>;
}

function WaveMark() {
  return (
    <svg
      className="brand-icon"
      viewBox="0 0 100 100"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="4" y="36" width="8" height="28" rx="4" />
      <rect x="18" y="25" width="8" height="50" rx="4" />
      <rect x="32" y="12" width="8" height="76" rx="4" />
      <rect x="46" y="28" width="8" height="44" rx="4" />
      <rect x="60" y="4" width="8" height="92" rx="4" />
      <rect x="74" y="20" width="8" height="60" rx="4" />
      <rect x="88" y="34" width="8" height="32" rx="4" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function label(view: View) {
  return view[0].toUpperCase() + view.slice(1);
}

function friendlyError(message: string) {
  if (
    message.includes("Linear auth failed") ||
    message.includes("Linear HTTP error 401")
  ) {
    return "Linear rejected the request. Add a valid API key under Settings → Linear, then start the worker again.";
  }
  if (
    message.includes("front matter") ||
    message.includes("tracker configuration")
  ) {
    return `The workflow needs attention: ${message}. Edit it under Settings → Workflow.`;
  }
  return message;
}

function formatError(err: unknown) {
  const message = String(err);
  if (message.includes("invoke") || message.includes("transformCallback")) {
    return "Unable to reach the Symphony desktop runtime. Open the Tauri app to use live worker actions.";
  }
  return friendlyError(message);
}

export default App;
