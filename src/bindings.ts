// Initial bindings. In dev builds, src-tauri rewrites this file from Rust Specta types.

export type AgentBackend = "codex" | "claude";

export type AppSettings = {
  workflow_source: string;
  repo_url: string;
  tracker_workspace: string | null;
  tracker_prefix: string | null;
  tracker_project_id: string | null;
  workspace_root: string | null;
  install_cmd: string | null;
  agent_backend: AgentBackend;
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

export type ValidationResult = {
  workflow_ok: boolean;
  workflow_error: string | null;
  codex_found: boolean;
  claude_found: boolean;
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

export type Overview = {
  active_runs: RunWithIssueRow[];
  retry_queue: RetryWithIssueRow[];
  recent_failures: RunWithIssueRow[];
  live_sessions: LiveSessionRow[];
  worker_heartbeat: WorkerHeartbeatRow | null;
  rate_limits: RateLimitStateRow[];
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
