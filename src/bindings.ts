// Initial bindings. In dev builds, src-tauri rewrites this file from Rust Specta types.

export type AgentBackend = "codex" | "claude" | "cursor";

export type ApprovalPolicy = "never" | "on-request" | "on-failure" | "always";

export type ThreadSandbox = "none" | "workspace-write" | "read-only";

export type TurnSandboxPolicy =
  | "inherit"
  | "workspace-write"
  | "read-only"
  | "danger-full-access";

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "dontAsk"
  | "plan";

export type CursorAgentMode = "agent" | "plan" | "ask";

export type CursorSandboxMode = "enabled" | "disabled";

export type RepoConfig = {
  name: string;
  url: string;
  install_cmd: string | null;
  team_prefixes: string[];
  project_ids: string[];
  is_default: boolean;
};

export type AppSettings = {
  prompt_template: string;
  repos: RepoConfig[];
  workspace_root: string | null;
  tracker_workspace: string | null;
  tracker_prefix: string | null;
  tracker_project_id: string | null;
  tracker_assigned_to_me: boolean;
  active_states: string[];
  terminal_states: string[];
  polling_interval_ms: number;
  max_concurrent_agents: number;
  max_retry_backoff_ms: number;
  hook_after_create: string | null;
  hook_before_run: string | null;
  hook_after_run: string | null;
  hook_before_remove: string | null;
  hook_timeout_ms: number;
  agent_backend: AgentBackend;
  codex_command: string | null;
  claude_command: string | null;
  turn_timeout_ms: number;
  session_env: Record<string, string>;
  codex_approval_policy: ApprovalPolicy;
  codex_thread_sandbox: ThreadSandbox;
  codex_turn_sandbox_policy: TurnSandboxPolicy;
  codex_network_access: boolean;
  claude_permission_mode: ClaudePermissionMode;
  claude_allowed_tools: string[];
  claude_disallowed_tools: string[];
  claude_add_dirs: string[];
  cursor_command: string | null;
  cursor_mode: CursorAgentMode;
  cursor_force: boolean;
  cursor_trust: boolean;
  cursor_approve_mcps: boolean;
  cursor_sandbox: CursorSandboxMode;
  cursor_model: string | null;
  linear_api_key_set: boolean;
};

export type SaveSettingsRequest = {
  settings: AppSettings;
  linear_api_key: string | null;
};

export type TrackerTestResult = {
  ok: boolean;
  message: string;
  active_issue_count: number | null;
};

export type LinearViewerProfile = {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
};

export type ValidationResult = {
  workflow_ok: boolean;
  workflow_blocking: boolean;
  workflow_error: string | null;
  codex_found: boolean;
  claude_found: boolean;
  cursor_found: boolean;
  codex_command: string;
  claude_command: string;
  cursor_command: string;
  app_data_dir: string;
  database_path: string;
};

export type WorkerStatus = {
  state: "stopped" | "running" | "stopping";
  started_at: string | null;
  last_error: string | null;
};

export type RunWithIssueRow = {
  id: string;
  issue_id: string;
  run_number: number;
  workspace_path: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  error_class: string | null;
  error_message: string | null;
  worker_pid: number | null;
  session_info: string | null;
  repo_name: string | null;
  created_at: string;
  issue_identifier: string;
  issue_title: string;
  issue_state: string;
};

export type RetryWithIssueRow = {
  issue_id: string;
  run_number: number;
  due_at: string;
  error_class: string | null;
  error_message: string | null;
  created_at: string;
  issue_identifier: string;
  issue_title: string;
};

export type LiveSessionRow = {
  run_id: string;
  session_id: string;
  thread_id: string;
  turn_id: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  last_event_at: string;
  started_at: string;
};

export type RateLimitStateRow = {
  source: string;
  remaining: number | null;
  reset_at: string | null;
  updated_at: string;
};

export type WorkerHeartbeatRow = {
  id: string;
  started_at: string;
  last_beat_at: string;
  worker_pid: number | null;
};

export type TokenUsageRow = {
  source: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  run_count: number;
  updated_at: string;
};

export type Overview = {
  active_runs: RunWithIssueRow[];
  retry_queue: RetryWithIssueRow[];
  recent_failures: RunWithIssueRow[];
  live_sessions: LiveSessionRow[];
  worker_heartbeat: WorkerHeartbeatRow | null;
  rate_limits: RateLimitStateRow[];
  token_usage: TokenUsageRow[];
};

export type IssueRow = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  state: string;
  branch: string | null;
  labels: string;
  blockers: string;
  pr_urls: string;
  raw: string;
  last_seen_at: string;
};

export type AgentEventRow = {
  id: number;
  run_id: string;
  kind: string;
  payload: string;
  created_at: string;
};

export type SkillsStatus = {
  state: "installed" | "pr_open" | "missing" | "unavailable";
  missing: string[];
  pr_url: string | null;
  detail: string | null;
};

export type SkillsInstallStatus = {
  state: "idle" | "running" | "completed" | "failed";
  repo_url: string | null;
  message: string | null;
  pr_url: string | null;
  error: string | null;
};

export type RunDetail = {
  run: RunWithIssueRow;
  events: AgentEventRow[];
};

export type IssueDetail = {
  issue: IssueRow;
};
