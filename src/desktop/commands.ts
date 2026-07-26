import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  IssueRow,
  LinearViewerProfile,
  Overview,
  RepoWorkflowStatus,
  RetroBatchRow,
  RetroDetail,
  RetroRow,
  RetroStatus,
  RetroSuggestionRow,
  RunDetail,
  RunWithIssueRow,
  SaveSettingsRequest,
  SkillsInstallStatus,
  SkillsStatus,
  TrackerTestResult,
  ValidationResult,
  WorkflowTransferStatus,
  WorkerStatus,
} from "../bindings";

function invokeCommand<Result>(
  command: string,
  args?: Record<string, unknown>,
): Promise<Result> {
  return args === undefined
    ? invoke<Result>(command)
    : invoke<Result>(command, args);
}

export const desktopCommands = {
  getOverview: () => invokeCommand<Overview>("get_overview"),
  listRuns: () => invokeCommand<RunWithIssueRow[]>("list_runs"),
  listIssues: () => invokeCommand<IssueRow[]>("list_issues"),
  getWorkerStatus: () => invokeCommand<WorkerStatus>("get_worker_status"),
  getRunDetail: (id: string) =>
    invokeCommand<RunDetail | null>("get_run_detail", { id }),
  getRetroStatus: () => invokeCommand<RetroStatus>("get_retro_status"),
  listRetros: () => invokeCommand<RetroRow[]>("list_retros"),
  getRetroDetail: (id: string) =>
    invokeCommand<RetroDetail | null>("get_retro_detail", { id }),
  hasInProgressRetroBatches: () =>
    invokeCommand<boolean>("has_in_progress_retro_batches"),
  loadSettings: () => invokeCommand<AppSettings>("load_settings"),
  saveSettings: (request: SaveSettingsRequest) =>
    invokeCommand<AppSettings>("save_settings", { request }),
  validateSettings: (settings: AppSettings) =>
    invokeCommand<ValidationResult>("validate_settings", { settings }),
  getLinearViewer: (request: SaveSettingsRequest) =>
    invokeCommand<LinearViewerProfile>("get_linear_viewer", { request }),
  testTrackerConnection: (request: SaveSettingsRequest) =>
    invokeCommand<TrackerTestResult>("test_tracker_connection", { request }),
  removeLinearApiKey: () =>
    invokeCommand<AppSettings>("remove_linear_api_key"),
  getDefaultPrompt: () => invokeCommand<string>("get_default_prompt"),
  startWorker: () => invokeCommand<WorkerStatus>("start_worker"),
  stopWorker: () => invokeCommand<WorkerStatus>("stop_worker"),
  stopRun: (id: string) =>
    invokeCommand<RunDetail | null>("stop_run", { id }),
  triggerRetryNow: (issueId: string) =>
    invokeCommand<boolean>("trigger_retry_now", { issueId }),
  getSkillsStatus: (
    repoUrl: string,
    sessionEnv: AppSettings["session_env"],
  ) =>
    invokeCommand<SkillsStatus>("get_skills_status", { repoUrl, sessionEnv }),
  installSkills: (settings: AppSettings, repoUrl: string) =>
    invokeCommand<SkillsInstallStatus>("install_skills", { settings, repoUrl }),
  getSkillsInstallStatus: () =>
    invokeCommand<SkillsInstallStatus>("get_skills_install_status"),
  getRepoWorkflowStatus: (
    repoUrl: string,
    sessionEnv: AppSettings["session_env"],
  ) =>
    invokeCommand<RepoWorkflowStatus>("get_repo_workflow_status", {
      repoUrl,
      sessionEnv,
    }),
  transferWorkflowToRepo: (repoUrl: string) =>
    invokeCommand<WorkflowTransferStatus>("transfer_workflow_to_repo", {
      repoUrl,
    }),
  getWorkflowTransferStatus: () =>
    invokeCommand<WorkflowTransferStatus>("get_workflow_transfer_status"),
  startRetro: () => invokeCommand<RetroStatus>("start_retro"),
  deleteRetro: (id: string) => invokeCommand<void>("delete_retro", { id }),
  setRetroSuggestionDecision: (id: string, decision: string) =>
    invokeCommand<RetroSuggestionRow>("set_retro_suggestion_decision", {
      id,
      decision,
    }),
  applyRetroWorkflow: (retroId: string) =>
    invokeCommand<RetroBatchRow>("apply_retro_workflow", { retroId }),
  startRetroPrs: (retroId: string) =>
    invokeCommand<RetroBatchRow[]>("start_retro_prs", { retroId }),
};
