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
  SkillFile,
  SkillsInstallStatus,
  SkillsStatus,
  TrackerTestResult,
  ValidationResult,
  WorkerStatus,
  WorkflowStateRow,
  WorkflowTransferStatus,
} from "../bindings";

function invokeCommand<Result>(command: string, args?: Record<string, unknown>): Promise<Result> {
  return args === undefined ? invoke<Result>(command) : invoke<Result>(command, args);
}

export const getOverview = () => invokeCommand<Overview>("get_overview");
export const listRuns = () => invokeCommand<RunWithIssueRow[]>("list_runs");
export const listIssues = () => invokeCommand<IssueRow[]>("list_issues");
export const listBoardIssues = () => invokeCommand<IssueRow[]>("list_board_issues");
export const listWorkflowStates = () => invokeCommand<WorkflowStateRow[]>("list_workflow_states");
export const setIssueState = (issueId: string, stateId: string) =>
  invokeCommand<void>("set_issue_state", { issueId, stateId });
export const getWorkerStatus = () => invokeCommand<WorkerStatus>("get_worker_status");
export const getRunDetail = (id: string) =>
  invokeCommand<RunDetail | null>("get_run_detail", { id });
export const getRetroStatus = () => invokeCommand<RetroStatus>("get_retro_status");
export const listRetros = () => invokeCommand<RetroRow[]>("list_retros");
export const getRetroDetail = (id: string) =>
  invokeCommand<RetroDetail | null>("get_retro_detail", { id });
export const hasInProgressRetroBatches = () =>
  invokeCommand<boolean>("has_in_progress_retro_batches");
export const loadSettings = () => invokeCommand<AppSettings>("load_settings");
export const saveSettings = (request: SaveSettingsRequest) =>
  invokeCommand<AppSettings>("save_settings", { request });
export const validateSettings = (settings: AppSettings) =>
  invokeCommand<ValidationResult>("validate_settings", { settings });
export const getLinearViewer = (request: SaveSettingsRequest) =>
  invokeCommand<LinearViewerProfile>("get_linear_viewer", { request });
export const testTrackerConnection = (request: SaveSettingsRequest) =>
  invokeCommand<TrackerTestResult>("test_tracker_connection", { request });
export const removeLinearApiKey = () => invokeCommand<AppSettings>("remove_linear_api_key");
export const getDefaultPrompt = () => invokeCommand<string>("get_default_prompt");
export const getDefaultSkills = () => invokeCommand<SkillFile[]>("get_default_skills");
export const startWorker = () => invokeCommand<WorkerStatus>("start_worker");
export const stopWorker = () => invokeCommand<WorkerStatus>("stop_worker");
export const stopRun = (id: string) => invokeCommand<RunDetail | null>("stop_run", { id });
export const triggerRetryNow = (issueId: string) =>
  invokeCommand<boolean>("trigger_retry_now", { issueId });
export const getSkillsStatus = (repoUrl: string, sessionEnv: AppSettings["session_env"]) =>
  invokeCommand<SkillsStatus>("get_skills_status", { repoUrl, sessionEnv });
export const installSkills = (settings: AppSettings, repoUrl: string) =>
  invokeCommand<SkillsInstallStatus>("install_skills", { settings, repoUrl });
export const getSkillsInstallStatus = () =>
  invokeCommand<SkillsInstallStatus>("get_skills_install_status");
export const getRepoWorkflowStatus = (repoUrl: string, sessionEnv: AppSettings["session_env"]) =>
  invokeCommand<RepoWorkflowStatus>("get_repo_workflow_status", {
    repoUrl,
    sessionEnv,
  });
export const transferWorkflowToRepo = (repoUrl: string) =>
  invokeCommand<WorkflowTransferStatus>("transfer_workflow_to_repo", {
    repoUrl,
  });
export const getWorkflowTransferStatus = () =>
  invokeCommand<WorkflowTransferStatus>("get_workflow_transfer_status");
export const startRetro = () => invokeCommand<RetroStatus>("start_retro");
export const deleteRetro = (id: string) => invokeCommand<void>("delete_retro", { id });
export const setRetroSuggestionDecision = (id: string, decision: string) =>
  invokeCommand<RetroSuggestionRow>("set_retro_suggestion_decision", {
    id,
    decision,
  });
export const applyRetroWorkflow = (retroId: string) =>
  invokeCommand<RetroBatchRow>("apply_retro_workflow", { retroId });
export const startRetroPrs = (retroId: string) =>
  invokeCommand<RetroBatchRow[]>("start_retro_prs", { retroId });
export const registerUpdateCheckListener = (listenerId: string) =>
  invokeCommand<void>("register_update_check_listener", { listenerId });
export const acknowledgeUpdateCheckRequest = (listenerId: string) =>
  invokeCommand<void>("acknowledge_update_check_request", { listenerId });
