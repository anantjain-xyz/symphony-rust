/**
 * Frontend ownership for every Tauri command invoked from TypeScript.
 *
 * `preview` means `src/preview/runtime.ts` owns a representative read mock.
 * Mutations intentionally remain unavailable in browser preview.
 */
export const IPC_COMMANDS = {
  apply_retro_workflow: { preview: false },
  delete_retro: { preview: false },
  get_default_prompt: { preview: false },
  get_linear_viewer: { preview: false },
  get_overview: { preview: true },
  get_repo_workflow_status: { preview: true },
  get_retro_detail: { preview: true },
  get_retro_status: { preview: true },
  get_run_detail: { preview: true },
  get_skills_install_status: { preview: false },
  get_skills_status: { preview: true },
  get_worker_status: { preview: true },
  get_workflow_transfer_status: { preview: false },
  has_in_progress_retro_batches: { preview: true },
  install_skills: { preview: false },
  list_issues: { preview: true },
  list_retros: { preview: true },
  list_runs: { preview: true },
  load_settings: { preview: true },
  remove_linear_api_key: { preview: false },
  save_settings: { preview: false },
  set_retro_suggestion_decision: { preview: false },
  start_retro: { preview: false },
  start_retro_prs: { preview: false },
  start_worker: { preview: false },
  stop_run: { preview: false },
  stop_worker: { preview: false },
  test_tracker_connection: { preview: false },
  transfer_workflow_to_repo: { preview: false },
  trigger_retry_now: { preview: false },
  validate_settings: { preview: false },
} as const;

/** Registered for diagnostics or future callers but intentionally not invoked by the UI. */
export const BACKEND_ONLY_COMMANDS = ["get_issue_detail"] as const;

export type FrontendIpcCommand = keyof typeof IPC_COMMANDS;
