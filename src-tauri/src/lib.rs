use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};
pub use symphony_contracts::AppSettings;
use symphony_contracts::{
    DashboardOverview, IssueSummary, LinearViewerProfile, RetroChangeBatch, RetroSuggestionReview,
    RetroSummary, RunDetail, RunSummary, SaveSettingsRequest, SettingsSaveResult,
    TrackerTestResult, ValidationResult, WorkflowStateRow,
};
use symphony_storage::{
    now_iso, open_sqlite, EventBus, Repository, RetroBatchReservation, RetroBatchRow,
    RetroSuggestionRow, StorageEvent,
};
use symphony_tracker::{LinearTracker, TrackerClient};
use symphony_worker::{
    check_repo_workflow, check_skills, resolve_repo_workflow_at_ref, resolve_workspace_root_dir,
    sanitize_key, RepoWorkflowSource, RepoWorkflowStatus, SkillFile, SkillsInstallConfig,
    SkillsInstallStatus, SkillsInstaller, SkillsStatus, WorkerManager, WorkerStartConfig,
    WorkerStatus, WorkflowTransferConfig, WorkflowTransferManager, WorkflowTransferStatus,
};
use tauri::{Emitter, Listener, Manager, State};

#[cfg(desktop)]
mod application_instance;
mod path_env;
mod projections;
mod retro;
mod settings;
#[cfg(test)]
mod settings_effects_tests;
mod settings_store;
mod settings_transaction;
mod storage_events;

use retro::{
    clone_repo_snapshot, hash_body, integrate_retro_guidance, parse_report, run_repo_pr_batch,
    uses_legacy_retro_section, RetroDetail, RetroManager, RetroProposalConfig, RetroStatus,
    INTERRUPTED_RETRO_MESSAGE,
};
use settings::{default_prompt_template, workflow_from_settings};
use uuid::Uuid;

const KEYRING_SERVICE: &str = "symphony";
const KEYRING_LINEAR_USER: &str = "linear_api_key";
const RETRO_REVIEW_INCOMPLETE_MESSAGE: &str =
    "Review every available suggestion before creating a change batch.";
const RETRO_ACCEPTED_SET_CHANGED_MESSAGE: &str =
    "Accepted suggestions changed while the batch was starting. Review the latest decisions and retry.";
const INTERRUPTED_RETRO_BATCH_MESSAGE: &str =
    "Symphony restarted before this change batch completed. Retry the batch.";
#[cfg(desktop)]
const CHECK_FOR_UPDATES_MENU_ID: &str = "check-for-updates";

#[derive(Default)]
struct UpdateCheckBridge {
    inner: Mutex<UpdateCheckBridgeState>,
}

#[derive(Default)]
struct UpdateCheckBridgeState {
    listener_ready: bool,
    pending_requests: u64,
    delivery_in_flight: bool,
}

impl UpdateCheckBridgeState {
    fn next_delivery(&mut self) -> bool {
        if !self.listener_ready || self.pending_requests == 0 || self.delivery_in_flight {
            return false;
        }
        self.delivery_in_flight = true;
        true
    }

    fn queue_request(&mut self) -> bool {
        self.pending_requests = self.pending_requests.saturating_add(1);
        self.next_delivery()
    }

    fn register_listener(&mut self) -> bool {
        self.listener_ready = true;
        // A previous delivery may have been lost while the webview listener was
        // being rebuilt. The pending request is redelivered to the new listener.
        self.delivery_in_flight = false;
        self.next_delivery()
    }

    fn acknowledge(&mut self) -> bool {
        if !self.delivery_in_flight {
            return false;
        }
        self.pending_requests = self.pending_requests.saturating_sub(1);
        self.delivery_in_flight = false;
        self.next_delivery()
    }

    fn delivery_failed(&mut self) {
        self.delivery_in_flight = false;
    }
}

impl UpdateCheckBridge {
    fn with_state<T>(
        &self,
        action: impl FnOnce(&mut UpdateCheckBridgeState) -> T,
    ) -> Result<T, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Update check request state is unavailable.".to_string())?;
        Ok(action(&mut state))
    }

    fn queue_request(&self) -> Result<bool, String> {
        self.with_state(UpdateCheckBridgeState::queue_request)
    }

    fn register_listener(&self) -> Result<bool, String> {
        self.with_state(UpdateCheckBridgeState::register_listener)
    }

    fn acknowledge(&self) -> Result<bool, String> {
        self.with_state(UpdateCheckBridgeState::acknowledge)
    }

    fn delivery_failed(&self) {
        let _ = self.with_state(UpdateCheckBridgeState::delivery_failed);
    }
}

#[derive(Clone)]
struct AppState {
    repo: Repository,
    worker: WorkerManager,
    skills_installer: SkillsInstaller,
    workflow_transfer: WorkflowTransferManager,
    retro: RetroManager,
    app_data_dir: PathBuf,
    settings_store: settings_store::SettingsStore,
    database_path: PathBuf,
}

const SYMPHONY_SKILL_PREFIX: &str = "symphony-";

/// The agent skills shipped with the app, copied into issue workspaces when
/// missing and used by the optional install-PR flow under
/// `.agents/skills/symphony-<name>/SKILL.md`. The bundled assets are the
/// portable owners; repository copies may contain only declared adaptations.
fn bundled_skills() -> Vec<SkillFile> {
    macro_rules! skill {
        ($name:literal) => {
            SkillFile {
                name: format!("{}{}", SYMPHONY_SKILL_PREFIX, $name),
                content: include_str!(concat!("../assets/skills/", $name, "/SKILL.md")).to_string(),
            }
        };
    }
    vec![
        skill!("commit"),
        skill!("land"),
        skill!("pr-feedback"),
        skill!("pull"),
        skill!("push"),
        skill!("screenshot"),
        skill!("workpad"),
    ]
}

#[tauri::command]
async fn load_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    load_settings_from_disk(&state).await
}

#[tauri::command]
async fn save_settings(
    state: State<'_, AppState>,
    request: SaveSettingsRequest,
) -> Result<SettingsSaveResult, String> {
    save_settings_owned(state.inner().clone(), request).await
}

async fn save_settings_owned(
    state: AppState,
    request: SaveSettingsRequest,
) -> Result<SettingsSaveResult, String> {
    settings_store::finish_operation(async move {
        let _effects = state.settings_store.commit_effects().await;
        let result = state
            .settings_store
            .save(request.settings, request.linear_api_key)
            .await;
        finish_settings_recovery(&state).await;
        Ok(finish_settings_save_after_commit(&state, result?).await)
    })
    .await
}

/// Caller owns the effects gate and an operation that outlives its IPC caller.
/// Once committed, a runtime error must not turn the save receipt into failure.
async fn finish_settings_save_after_commit(
    state: &AppState,
    mut settings: AppSettings,
) -> SettingsSaveResult {
    let runtime_update_error = match apply_settings_to_worker(state, &settings).await {
        Ok(admitted) => {
            // Keep the committed fields and revision; only overlay availability
            // that was actually observed by this runtime continuation.
            settings.linear_api_key_set = admitted.linear_api_key_set;
            settings.linear_api_key_error = admitted.linear_api_key_error;
            None
        }
        Err(_) => {
            // Do not expose backend diagnostics that could contain credentials
            // or environment values. Recovery details remain on settings load.
            let error = "Settings saved, but the worker could not refresh its configuration. Resolve the settings or credential recovery error, then save again or restart the worker.";
            state.worker.report_configuration_error(error).await;
            Some(error.to_string())
        }
    };
    SettingsSaveResult {
        settings,
        runtime_update_error,
    }
}

#[tauri::command]
async fn validate_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<ValidationResult, String> {
    let issues = workflow_validation_issues(&settings);
    let workflow_error = primary_validation_issue(&issues).map(|issue| issue.message.clone());
    let workflow_blocking = issues.iter().any(|issue| issue.blocking);
    let codex_command = effective_command(settings.codex_command.as_deref(), "codex");
    let claude_command = effective_command(settings.claude_command.as_deref(), "claude");
    let cursor_command = settings::effective_cursor_command(&settings.cursor_command);
    let opencode_command = effective_command(settings.opencode_command.as_deref(), "opencode");
    Ok(ValidationResult {
        workflow_ok: workflow_error.is_none(),
        workflow_blocking,
        workflow_error,
        issues,
        codex_found: command_found(&codex_command),
        claude_found: command_found(&claude_command),
        cursor_found: command_found(&cursor_command),
        opencode_found: command_found(&opencode_command),
        codex_command,
        claude_command,
        cursor_command,
        opencode_command,
        app_data_dir: state.app_data_dir.display().to_string(),
        database_path: state.database_path.display().to_string(),
    })
}

fn workflow_validation_issues(settings: &AppSettings) -> Vec<symphony_core::ValidationIssue> {
    symphony_core::validate_runtime_config(
        &workflow_from_settings(settings, None),
        &settings.repos,
        &settings.session_env,
    )
}

fn validate_workflow_settings(settings: &AppSettings) -> Option<String> {
    primary_validation_issue(&workflow_validation_issues(settings))
        .map(|issue| issue.message.clone())
}

fn primary_validation_issue(
    issues: &[symphony_core::ValidationIssue],
) -> Option<&symphony_core::ValidationIssue> {
    issues
        .iter()
        .find(|issue| issue.blocking)
        .or(issues.first())
}

async fn apply_settings_to_worker(
    state: &AppState,
    settings: &AppSettings,
) -> Result<AppSettings, String> {
    // A committed revision must fence older work even if its fresh runtime
    // snapshot cannot be read or validated.
    state
        .worker
        .observe_settings_revision(settings.settings_revision)
        .await;
    let snapshot = worker_settings_with_effects(state).await?;
    if snapshot.settings.linear_api_key_error.is_some() {
        state
            .worker
            .report_configuration_error(
                "Settings saved, but credential access prevented worker update. Restart worker after unlocking credential store.",
            )
            .await;
    } else if live_reconfigure_allowed(&snapshot.settings) {
        if let Some(api_key) = snapshot.credential.as_deref() {
            state
                .worker
                .reconfigure(worker_start_config(state, &snapshot.settings, api_key)?)
                .await;
        }
    } else {
        state
            .worker
            .report_configuration_error(
                "Settings saved, but incomplete configuration prevented worker update. Finish setup and save again to apply the saved settings.",
            )
            .await;
    }
    Ok(snapshot.settings)
}

#[cfg(test)]
fn workflow_setup_incomplete(settings: &AppSettings) -> bool {
    workflow_validation_issues(settings)
        .iter()
        .any(|issue| issue.code == symphony_core::ValidationCode::MissingRepository)
}

fn live_reconfigure_allowed(settings: &AppSettings) -> bool {
    settings.linear_api_key_error.is_none() && workflow_validation_issues(settings).is_empty()
}

fn validate_session_env(env: &BTreeMap<String, String>) -> Option<String> {
    symphony_core::validate_session_environment(env)
        .first()
        .map(|issue| issue.message.clone())
}

#[cfg(test)]
fn validate_repos(repos: &[symphony_core::RepoConfig]) -> Option<String> {
    symphony_core::validate_repositories(repos)
        .first()
        .map(|issue| issue.message.clone())
}

fn effective_command(override_cmd: Option<&str>, default: &str) -> String {
    match override_cmd.map(str::trim).filter(|cmd| !cmd.is_empty()) {
        Some(cmd) => cmd.to_string(),
        None => default.to_string(),
    }
}

// Launch commands may be wrappers with arguments (`mycode --agent codex`);
// only the first token names the executable to look up.
fn command_found(command: &str) -> bool {
    command
        .split_whitespace()
        .next()
        .is_some_and(|bin| which::which(bin).is_ok())
}

#[tauri::command]
async fn test_tracker_connection(
    state: State<'_, AppState>,
    request: SaveSettingsRequest,
) -> Result<TrackerTestResult, String> {
    // Prefer the unsaved form value so users can test a just-typed key.
    let api_key = request_linear_api_key(&state, request.linear_api_key).await?;
    let Some(api_key) = api_key else {
        return Ok(TrackerTestResult {
            ok: false,
            message: "No Linear API key configured. Add one above, then test again.".to_string(),
            active_issue_count: None,
        });
    };

    let workflow = workflow_from_settings(&request.settings, Some(&api_key));
    let tracker = LinearTracker::new(workflow.front_matter.tracker.clone());
    if let Err(err) = tracker.preflight().await {
        return Ok(TrackerTestResult {
            ok: false,
            message: err.to_string(),
            active_issue_count: None,
        });
    }
    match tracker.fetch_active().await {
        Ok(issues) => Ok(TrackerTestResult {
            ok: true,
            message: match issues.len() {
                0 => "Connected. No issues currently match your filters.".to_string(),
                1 => "Connected. 1 issue matches your filters.".to_string(),
                n => format!("Connected. {n} issues match your filters."),
            },
            active_issue_count: Some(issues.len() as u32),
        }),
        Err(err) => Ok(TrackerTestResult {
            ok: false,
            message: err.to_string(),
            active_issue_count: None,
        }),
    }
}

#[tauri::command]
async fn get_linear_viewer(
    state: State<'_, AppState>,
    request: SaveSettingsRequest,
) -> Result<LinearViewerProfile, String> {
    // Prefer the unsaved form value so checking the box can resolve the user
    // before the API key has been saved.
    let api_key = request_linear_api_key(&state, request.linear_api_key).await?;
    let Some(api_key) = api_key else {
        return Err(
            "No Linear API key configured. Add one above to show the assigned user.".to_string(),
        );
    };

    let workflow = workflow_from_settings(&request.settings, Some(&api_key));
    let tracker = LinearTracker::new(workflow.front_matter.tracker.clone());
    let viewer = tracker.viewer().await.map_err(|err| err.to_string())?;
    let username = viewer
        .name
        .as_deref()
        .or(viewer.display_name.as_deref())
        .or(viewer.email.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&viewer.id)
        .to_string();
    Ok(LinearViewerProfile {
        id: viewer.id,
        username,
        display_name: viewer.display_name,
        email: viewer.email,
    })
}

#[tauri::command]
async fn list_workflow_states(state: State<'_, AppState>) -> Result<Vec<WorkflowStateRow>, String> {
    let snapshot = load_runtime_settings(&state).await?;
    let Some(api_key) = snapshot.credential else {
        return Err(
            "No Linear API key configured. Add one under Settings → Linear to load the board columns."
                .to_string(),
        );
    };
    let settings = snapshot.settings;
    let workflow = workflow_from_settings(&settings, Some(&api_key));
    let tracker = LinearTracker::new(workflow.front_matter.tracker.clone());
    let states = tracker
        .list_workflow_states()
        .await
        .map_err(|err| err.to_string())?;
    Ok(states
        .into_iter()
        .map(|ws| WorkflowStateRow {
            id: ws.id,
            name: ws.name,
            state_type: ws.state_type,
            position: ws.position,
        })
        .collect())
}

#[tauri::command]
async fn set_issue_state(
    state: State<'_, AppState>,
    issue_id: String,
    state_id: String,
) -> Result<(), String> {
    // Authoritatively block a move while an agent run is active. The frontend guard
    // uses a (possibly stale) overview snapshot; enforce it here at the mutation
    // boundary against the local run table to close the TOCTOU race.
    if state
        .repo
        .has_active_run(&issue_id)
        .await
        .map_err(|err| err.to_string())?
    {
        return Err(
            "Can't move this issue while an agent run is active — stop the run first.".to_string(),
        );
    }
    // Trust boundary: the mutation runs against Linear with the user's own key.
    let snapshot = load_runtime_settings(&state).await?;
    let Some(api_key) = snapshot.credential else {
        return Err(
            "No Linear API key configured. Add one under Settings → Linear to move issues."
                .to_string(),
        );
    };
    let settings = snapshot.settings;
    let workflow = workflow_from_settings(&settings, Some(&api_key));
    let tracker = LinearTracker::new(workflow.front_matter.tracker.clone());
    tracker
        .set_issue_state(&issue_id, &state_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn list_board_issues(state: State<'_, AppState>) -> Result<Vec<IssueSummary>, String> {
    let snapshot = load_runtime_settings(&state).await?;
    let Some(api_key) = snapshot.credential else {
        return Err(
            "No Linear API key configured. Add one under Settings → Linear to load the board."
                .to_string(),
        );
    };
    let settings = snapshot.settings;
    let workflow = workflow_from_settings(&settings, Some(&api_key));
    let tracker = LinearTracker::new(workflow.front_matter.tracker.clone());
    let issues = tracker
        .fetch_board_issues()
        .await
        .map_err(|err| err.to_string())?;
    let seen_at = now_iso();
    Ok(issues
        .into_iter()
        .map(|issue| IssueSummary {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description,
            priority: i64::from(issue.priority),
            state: issue.state,
            branch: issue.branch,
            labels: issue.labels,
            blockers: issue.blockers,
            last_seen_at: seen_at.clone(),
        })
        .collect())
}

#[tauri::command]
async fn remove_linear_api_key(state: State<'_, AppState>) -> Result<AppSettings, String> {
    remove_linear_api_key_owned(state.inner().clone()).await
}

async fn remove_linear_api_key_owned(state: AppState) -> Result<AppSettings, String> {
    settings_store::finish_operation(async move {
        let _effects = state.settings_store.commit_effects().await;
        let result = state.settings_store.remove_key().await;
        finish_settings_recovery(&state).await;
        let settings = result?;
        state
            .worker
            .stop_for_settings_revision(settings.settings_revision)
            .await;
        Ok(settings)
    })
    .await
}

#[tauri::command]
fn get_default_prompt() -> String {
    default_prompt_template()
}

#[tauri::command]
fn get_default_skills() -> Vec<SkillFile> {
    bundled_skills()
}

#[tauri::command]
async fn get_overview(state: State<'_, AppState>) -> Result<DashboardOverview, String> {
    state
        .repo
        .overview()
        .await
        .map(projections::dashboard_overview)
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn list_runs(state: State<'_, AppState>) -> Result<Vec<RunSummary>, String> {
    state
        .repo
        .list_runs(200)
        .await
        .map(|rows| rows.into_iter().map(projections::run_summary).collect())
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn get_run_detail(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<RunDetail>, String> {
    state
        .repo
        .get_run_detail(&id)
        .await
        .map(|detail| {
            detail.map(|(run, events)| RunDetail {
                run: projections::run_summary(run),
                events: events.into_iter().map(projections::agent_event).collect(),
            })
        })
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn stop_run(state: State<'_, AppState>, id: String) -> Result<Option<RunDetail>, String> {
    state
        .worker
        .stop_run(&id)
        .await
        .map_err(|err| err.to_string())?;
    state
        .repo
        .get_run_detail(&id)
        .await
        .map(|detail| {
            detail.map(|(run, events)| RunDetail {
                run: projections::run_summary(run),
                events: events.into_iter().map(projections::agent_event).collect(),
            })
        })
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn list_issues(state: State<'_, AppState>) -> Result<Vec<IssueSummary>, String> {
    state
        .repo
        .list_issues(200)
        .await
        .map(|rows| rows.into_iter().map(projections::issue_summary).collect())
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn get_worker_status(state: State<'_, AppState>) -> Result<WorkerStatus, String> {
    Ok(state.worker.status().await)
}

#[tauri::command]
async fn start_worker(state: State<'_, AppState>) -> Result<WorkerStatus, String> {
    start_worker_owned(state.inner().clone()).await
}

async fn start_worker_owned(state: AppState) -> Result<WorkerStatus, String> {
    settings_store::finish_operation(async move {
        let _effects = state.settings_store.commit_effects().await;
        let snapshot = worker_settings_with_effects(&state).await?;
        if let Some(error) = snapshot.settings.linear_api_key_error.as_ref() {
            return Err(error.clone());
        }
        let Some(api_key) = snapshot.credential.as_deref() else {
            return Err(
                "No Linear API key configured. Add one under Settings → Linear, then start the worker."
                    .to_string(),
            );
        };
        // A worker started from invalid settings (e.g. no active states) would
        // poll forever without dispatching anything — fail up front instead.
        if let Some(error) = validate_workflow_settings(&snapshot.settings) {
            return Err(error);
        }
        state
            .worker
            .start(worker_start_config(&state, &snapshot.settings, api_key)?)
            .await
            .map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn stop_worker(state: State<'_, AppState>) -> Result<WorkerStatus, String> {
    Ok(state.worker.stop().await)
}

fn worker_start_config(
    state: &AppState,
    settings: &AppSettings,
    api_key: &str,
) -> Result<WorkerStartConfig, String> {
    Ok(WorkerStartConfig {
        runtime: symphony_core::RunnableConfig::new(
            settings.settings_revision,
            workflow_from_settings(settings, Some(api_key)),
            settings.repos.clone(),
            settings.session_env.clone(),
        )
        .map_err(|error| error.to_string())?,
        skills: bundled_skills(),
        env: build_env(api_key),
        app_data_dir: state.app_data_dir.clone(),
    })
}

#[tauri::command]
async fn trigger_retry_now(state: State<'_, AppState>, issue_id: String) -> Result<bool, String> {
    state
        .worker
        .trigger_retry_now(&issue_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn start_retro(state: State<'_, AppState>) -> Result<RetroStatus, String> {
    let snapshot = load_runtime_settings(&state).await?;
    let Some(api_key) = snapshot.credential else {
        return Err(
            "No Linear API key configured. Add one under Settings → Linear, then run a retro."
                .to_string(),
        );
    };
    let settings = snapshot.settings;
    let workflow = workflow_from_settings(&settings, Some(&api_key));
    let tracker = LinearTracker::new(workflow.front_matter.tracker.clone());
    let workspace_root =
        resolve_workspace_root_dir(&workflow.front_matter.workspace.root, &state.app_data_dir);
    let proposal_config = RetroProposalConfig {
        prompt_template: settings.prompt_template.clone(),
        workflow_hash: workflow.source_hash.clone(),
        repos: settings
            .repos
            .iter()
            .map(|repo| (repo.name.clone(), repo.url.clone()))
            .collect(),
        workspace_root,
        session_env: settings.session_env.clone(),
        skills: bundled_skills()
            .into_iter()
            .map(|skill| (skill.name, skill.content))
            .collect(),
    };
    state
        .retro
        .start(state.repo.clone(), tracker, proposal_config)
        .await
}

#[tauri::command]
async fn get_retro_status(state: State<'_, AppState>) -> Result<RetroStatus, String> {
    Ok(state.retro.status().await)
}

#[tauri::command]
async fn list_retros(state: State<'_, AppState>) -> Result<Vec<RetroSummary>, String> {
    state
        .repo
        .list_retros(50)
        .await
        .map(|rows| rows.into_iter().map(projections::retro_summary).collect())
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn get_retro_detail(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<RetroDetail>, String> {
    let Some(row) = state
        .repo
        .get_retro(&id)
        .await
        .map_err(|err| err.to_string())?
    else {
        return Ok(None);
    };
    let suggestions = state
        .repo
        .list_retro_suggestions(&id)
        .await
        .map_err(|err| err.to_string())?;
    let batches = state
        .repo
        .list_retro_batches(&id)
        .await
        .map_err(|err| err.to_string())?;
    Ok(Some(RetroDetail {
        report: parse_report(&row)?,
        row: projections::retro_summary(row),
        suggestions: suggestions
            .into_iter()
            .map(projections::retro_suggestion_review)
            .collect(),
        batches: batches
            .into_iter()
            .map(projections::retro_change_batch)
            .collect(),
    }))
}

#[tauri::command]
async fn has_in_progress_retro_batches(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .repo
        .has_in_progress_retro_batches()
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn delete_retro(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let deleted = state
        .repo
        .delete_retro(&id)
        .await
        .map_err(|err| err.to_string())?;
    if !deleted {
        return Err(
            "This retro was not found, is not the latest completed retro, or still has generation or batch work in progress."
                .to_string(),
        );
    }
    state.retro.forget(&id).await;
    Ok(())
}

#[tauri::command]
async fn set_retro_suggestion_decision(
    state: State<'_, AppState>,
    id: String,
    decision: symphony_core::SuggestionDecision,
) -> Result<RetroSuggestionReview, String> {
    state
        .repo
        .set_retro_suggestion_decision(&id, decision)
        .await
        .map_err(|err| err.to_string())?
        .map(projections::retro_suggestion_review)
        .ok_or_else(|| "Suggestion was not found.".to_string())
}

fn ensure_retro_review_complete(suggestions: &[RetroSuggestionRow]) -> Result<(), String> {
    if suggestions.iter().any(|suggestion| {
        suggestion.proposal_status == symphony_core::ProposalState::Ready
            && suggestion.decision == symphony_core::SuggestionDecision::Pending
    }) {
        Err(RETRO_REVIEW_INCOMPLETE_MESSAGE.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
async fn apply_retro_workflow(
    state: State<'_, AppState>,
    retro_id: String,
) -> Result<RetroChangeBatch, String> {
    let state = state.inner().clone();
    settings_store::finish_operation(apply_retro_workflow_inner(state, retro_id))
        .await
        .map(projections::retro_change_batch)
}

async fn apply_retro_workflow_inner(
    state: AppState,
    retro_id: String,
) -> Result<RetroBatchRow, String> {
    let all_suggestions = state
        .repo
        .list_retro_suggestions(&retro_id)
        .await
        .map_err(|err| err.to_string())?;
    ensure_retro_review_complete(&all_suggestions)?;
    let suggestions = all_suggestions
        .into_iter()
        .filter(|suggestion| {
            suggestion.target_type == symphony_core::SuggestionTarget::Prompt
                && suggestion.decision == symphony_core::SuggestionDecision::Accepted
                && suggestion.proposal_status == symphony_core::ProposalState::Ready
        })
        .collect::<Vec<_>>();
    if suggestions.is_empty() {
        return Err("Accept at least one workflow suggestion first.".to_string());
    }
    let settings = load_settings_from_disk(&state).await?;
    let expected_ref = suggestions
        .first()
        .and_then(|suggestion| suggestion.base_ref.clone())
        .ok_or_else(|| "Workflow proposal has no base revision.".to_string())?;
    let expected_prompt_hashes = suggestions
        .iter()
        .filter_map(|suggestion| suggestion.base_hash.clone())
        .collect::<BTreeSet<_>>();
    if expected_prompt_hashes.len() != 1 {
        return Err("Workflow proposals do not share one prompt revision.".to_string());
    }
    let expected_prompt_hash = expected_prompt_hashes
        .into_iter()
        .next()
        .expect("one prompt hash was checked above");
    let batch = RetroBatchRow {
        id: Uuid::new_v4().to_string(),
        retro_id: retro_id.clone(),
        kind: symphony_core::BatchKind::WorkflowUpdate,
        repo_name: None,
        repo_url: None,
        base_ref: Some(expected_ref.clone()),
        state: symphony_core::BatchState::Running,
        progress: Some("Checking workflow freshness…".to_string()),
        error: None,
        pr_url: None,
        created_at: now_iso(),
        completed_at: None,
    };
    let suggestion_ids = suggestions
        .iter()
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();
    state
        .repo
        .reserve_retro_batch(&batch, &suggestion_ids)
        .await
        .map_err(|err| err.to_string())
        .and_then(|reservation| match reservation {
            RetroBatchReservation::Created => Ok(()),
            RetroBatchReservation::ReviewIncomplete => {
                Err(RETRO_REVIEW_INCOMPLETE_MESSAGE.to_string())
            }
            RetroBatchReservation::AcceptedSetChanged => {
                Err(RETRO_ACCEPTED_SET_CHANGED_MESSAGE.to_string())
            }
            RetroBatchReservation::AlreadyReserved => {
                Err("A workflow change batch already exists for this retro.".to_string())
            }
        })?;
    if suggestions.iter().any(uses_legacy_retro_section) {
        state
            .repo
            .update_retro_batch(
                &batch.id,
                symphony_core::BatchState::Stale,
                Some("The proposal format changed."),
                Some("Generate a new retro and review the updated in-place diff."),
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        return state
            .repo
            .list_retro_batches(&retro_id)
            .await
            .map_err(|err| err.to_string())?
            .into_iter()
            .find(|item| item.id == batch.id)
            .ok_or_else(|| "Workflow batch was not found.".to_string());
    }
    if prompt_revision(&settings) != expected_prompt_hash {
        state
            .repo
            .update_retro_batch(
                &batch.id,
                symphony_core::BatchState::Stale,
                Some("Prompt changed since this diff was prepared."),
                Some("Generate a new retro and review the updated diff."),
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        return state
            .repo
            .list_retro_batches(&retro_id)
            .await
            .map_err(|err| err.to_string())?
            .into_iter()
            .find(|item| item.id == batch.id)
            .ok_or_else(|| "Workflow batch was not found.".to_string());
    }

    // A prompt proposal targets the saved default only while every repository
    // represented by the batch still falls back to that default. If a repo
    // added a valid checked-in workflow after review, applying the old batch
    // would update the wrong source of truth.
    let source_check_root = resolve_workspace_root_dir(
        &workflow_from_settings(&settings, None)
            .front_matter
            .workspace
            .root,
        &state.app_data_dir,
    )
    .join("_retro-source-check")
    .join(&retro_id);
    let mut checked_repos = BTreeSet::new();
    let mut source_changed = None;
    for suggestion in &suggestions {
        if !checked_repos.insert(suggestion.repo_name.clone()) {
            continue;
        }
        let repo_url = current_retro_repo_url(
            &settings,
            &suggestion.repo_name,
            suggestion.repo_url.as_deref(),
        );
        let Some(repo_url) = repo_url else {
            source_changed = Some(format!(
                "Repository `{}` was removed or reconfigured.",
                suggestion.repo_name
            ));
            break;
        };
        let workspace = source_check_root.join(sanitize_key(&suggestion.repo_name));
        match clone_repo_snapshot(&repo_url, &workspace, &settings.session_env).await {
            Ok(snapshot) => {
                let resolved = resolve_repo_workflow_at_ref(
                    &snapshot.root,
                    &snapshot.head,
                    &settings.prompt_template,
                )
                .await;
                tokio::fs::remove_dir_all(&snapshot.root).await.ok();
                if resolved.source != RepoWorkflowSource::Default {
                    source_changed = Some(format!(
                        "Repository `{}` now uses a checked-in workflow.",
                        suggestion.repo_name
                    ));
                    break;
                }
            }
            Err(error) => {
                source_changed = Some(format!(
                    "Could not confirm the workflow source for `{}`: {error}",
                    suggestion.repo_name
                ));
                break;
            }
        }
    }
    tokio::fs::remove_dir_all(&source_check_root).await.ok();
    if let Some(error) = source_changed {
        state
            .repo
            .update_retro_batch(
                &batch.id,
                symphony_core::BatchState::Stale,
                Some("A repository workflow source changed."),
                Some(&format!(
                    "{error} Generate a new retro and review the updated diff."
                )),
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        return state
            .repo
            .list_retro_batches(&retro_id)
            .await
            .map_err(|err| err.to_string())?
            .into_iter()
            .find(|item| item.id == batch.id)
            .ok_or_else(|| "Workflow batch was not found.".to_string());
    }

    let guidance = suggestions
        .iter()
        .map(|suggestion| suggestion.guidance.clone())
        .collect::<Vec<_>>();
    let mut updated = settings;
    updated.prompt_template = integrate_retro_guidance(&updated.prompt_template, &guidance);
    if let Some(error) = validate_workflow_settings(&updated) {
        state
            .repo
            .update_retro_batch(
                &batch.id,
                symphony_core::BatchState::Failed,
                None,
                Some(&error),
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        return Err(error);
    }
    // Source validation above may be slow. Serialize only the CAS commit and
    // its complete worker/batch continuation; intervening saves fail CAS.
    let _effects = state.settings_store.commit_effects().await;
    let result = state
        .settings_store
        .apply_prompt(
            updated.settings_revision,
            expected_prompt_hash,
            updated.prompt_template.clone(),
        )
        .await;
    finish_settings_recovery(&state).await;
    let committed = match result {
        Ok(settings) => settings,
        Err(error) => {
            state
                .repo
                .update_retro_batch(
                    &batch.id,
                    symphony_core::BatchState::Failed,
                    None,
                    Some(&error),
                    None,
                )
                .await
                .map_err(|update_err| update_err.to_string())?;
            return Err(error);
        }
    };
    finish_retro_workflow_after_prompt_save(&state, &batch, &committed).await
}

/// The prompt has committed. The owned caller keeps the settings effects gate
/// until runtime refresh and the batch's terminal outcome are both recorded.
async fn finish_retro_workflow_after_prompt_save(
    state: &AppState,
    batch: &RetroBatchRow,
    committed: &AppSettings,
) -> Result<RetroBatchRow, String> {
    if let Err(error) = apply_settings_to_worker(state, committed).await {
        let progress = "Workflow prompt saved; runtime refresh failed.";
        state
            .repo
            .update_retro_batch(
                &batch.id,
                symphony_core::BatchState::Failed,
                Some(progress),
                Some(&error),
                None,
            )
            .await
            .map_err(|update_error| {
                format!("{progress} {error} Could not record the batch outcome: {update_error}")
            })?;
        return Err(format!("{progress} {error}"));
    }
    state
        .repo
        .update_retro_batch(
            &batch.id,
            symphony_core::BatchState::Completed,
            Some("Workflow prompt updated."),
            None,
            None,
        )
        .await
        .map_err(|err| err.to_string())?;
    state
        .repo
        .list_retro_batches(&batch.retro_id)
        .await
        .map_err(|err| err.to_string())?
        .into_iter()
        .find(|item| item.id == batch.id)
        .ok_or_else(|| "Workflow batch was not found.".to_string())
}

fn current_retro_repo_url(
    settings: &AppSettings,
    repo_name: &str,
    stored_url: Option<&str>,
) -> Option<String> {
    let stored_url = stored_url?.trim();
    let configured_url = settings
        .repos
        .iter()
        .find(|repo| repo.name == repo_name)?
        .url
        .trim();
    (!stored_url.is_empty() && stored_url == configured_url).then(|| configured_url.to_string())
}

fn prompt_revision(settings: &AppSettings) -> String {
    hash_body(&settings.prompt_template)
}

#[tauri::command]
async fn start_retro_prs(
    state: State<'_, AppState>,
    retro_id: String,
) -> Result<Vec<RetroChangeBatch>, String> {
    start_retro_prs_inner(state, retro_id).await.map(|rows| {
        rows.into_iter()
            .map(projections::retro_change_batch)
            .collect()
    })
}

async fn start_retro_prs_inner(
    state: State<'_, AppState>,
    retro_id: String,
) -> Result<Vec<RetroBatchRow>, String> {
    let settings = load_settings_from_disk(&state).await?;
    let all_suggestions = state
        .repo
        .list_retro_suggestions(&retro_id)
        .await
        .map_err(|err| err.to_string())?;
    ensure_retro_review_complete(&all_suggestions)?;
    let suggestions = all_suggestions
        .into_iter()
        .filter(|suggestion| {
            matches!(suggestion.target_type.as_str(), "skill" | "repo_workflow")
                && suggestion.decision == symphony_core::SuggestionDecision::Accepted
                && suggestion.proposal_status == symphony_core::ProposalState::Ready
        })
        .collect::<Vec<_>>();
    if suggestions.is_empty() {
        return Err("Accept at least one repository suggestion first.".to_string());
    }
    let mut by_repo = BTreeMap::<String, Vec<RetroSuggestionRow>>::new();
    for suggestion in suggestions {
        by_repo
            .entry(suggestion.repo_name.clone())
            .or_default()
            .push(suggestion);
    }
    let blocked_repos = state
        .repo
        .list_retro_batches(&retro_id)
        .await
        .map_err(|err| err.to_string())?
        .into_iter()
        .filter(|batch| {
            batch.kind == symphony_core::BatchKind::RepoPr
                && matches!(
                    batch.state.as_str(),
                    "queued" | "running" | "completed" | "stale"
                )
        })
        .filter_map(|batch| batch.repo_name)
        .collect::<BTreeSet<_>>();
    let workspace_root = resolve_workspace_root_dir(
        &workflow_from_settings(&settings, None)
            .front_matter
            .workspace
            .root,
        &state.app_data_dir,
    );
    for (repo_name, suggestions) in by_repo {
        if blocked_repos.contains(&repo_name) {
            continue;
        }
        let stored_url = suggestions
            .first()
            .and_then(|suggestion| suggestion.repo_url.as_deref());
        let repo_url = current_retro_repo_url(&settings, &repo_name, stored_url);
        let legacy_proposal = suggestions.iter().any(uses_legacy_retro_section);
        let stale_error = if legacy_proposal {
            Some(
                "The proposal format changed. Generate a new retro and review the updated in-place diff."
                    .to_string(),
            )
        } else {
            repo_url.is_none().then(|| {
                format!(
                    "Repository `{repo_name}` was removed or its URL changed after this retro was generated. Generate a new retro before opening a PR."
                )
            })
        };
        let batch = RetroBatchRow {
            id: Uuid::new_v4().to_string(),
            retro_id: retro_id.clone(),
            kind: symphony_core::BatchKind::RepoPr,
            repo_name: Some(repo_name.clone()),
            repo_url,
            base_ref: suggestions.first().and_then(|item| item.base_ref.clone()),
            state: if stale_error.is_some() {
                symphony_core::BatchState::Stale
            } else {
                symphony_core::BatchState::Queued
            },
            progress: stale_error
                .as_ref()
                .map(|_| {
                    if legacy_proposal {
                        "Proposal format changed.".to_string()
                    } else {
                        "Repository configuration changed.".to_string()
                    }
                })
                .or_else(|| Some("Queued for PR creation…".to_string())),
            error: stale_error.clone(),
            pr_url: None,
            created_at: now_iso(),
            completed_at: stale_error.as_ref().map(|_| now_iso()),
        };
        let ids = suggestions
            .iter()
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        let reservation = state
            .repo
            .reserve_retro_batch(&batch, &ids)
            .await
            .map_err(|err| err.to_string())?;
        match reservation {
            RetroBatchReservation::Created => {}
            RetroBatchReservation::ReviewIncomplete => {
                return Err(RETRO_REVIEW_INCOMPLETE_MESSAGE.to_string());
            }
            RetroBatchReservation::AcceptedSetChanged => {
                return Err(RETRO_ACCEPTED_SET_CHANGED_MESSAGE.to_string());
            }
            RetroBatchReservation::AlreadyReserved => continue,
        }
        if stale_error.is_some() {
            continue;
        }
        let repository = state.repo.clone();
        let session_env = settings.session_env.clone();
        let workspace = workspace_root
            .join("_retro-actions")
            .join(&retro_id)
            .join(sanitize_key(&repo_name));
        tauri::async_runtime::spawn(async move {
            run_repo_pr_batch(repository, batch, suggestions, workspace, session_env).await;
        });
    }
    state
        .repo
        .list_retro_batches(&retro_id)
        .await
        .map_err(|err| err.to_string())
}

// Both skills commands take the repo URL straight from the caller's form
// (and the session environment/settings the caller is editing, like
// validate_settings) rather than reloading from disk, so unsaved edits -- a
// just-typed repo URL or token in Session environment -- are what gets checked
// and installed against. Each configured repo is checked and installed
// individually; the UI shows one status per repo card.
#[tauri::command]
async fn get_skills_status(
    repo_url: String,
    session_env: BTreeMap<String, String>,
) -> Result<SkillsStatus, String> {
    if let Some(error) = validate_session_env(&session_env) {
        return Err(error);
    }
    let names: Vec<String> = bundled_skills()
        .into_iter()
        .map(|skill| skill.name)
        .collect();
    Ok(check_skills(&repo_url, &names, &session_env).await)
}

#[tauri::command]
async fn get_skills_install_status(
    state: State<'_, AppState>,
) -> Result<SkillsInstallStatus, String> {
    Ok(state.skills_installer.status().await)
}

#[tauri::command]
async fn install_skills(
    state: State<'_, AppState>,
    settings: AppSettings,
    repo_url: String,
) -> Result<SkillsInstallStatus, String> {
    let repo_url = repo_url.trim().to_string();
    if repo_url.is_empty() {
        return Err("Add a repository URL under Settings → Repositories first.".to_string());
    }
    let workflow = workflow_from_settings(&settings, None);
    let workspace_root =
        resolve_workspace_root_dir(&workflow.front_matter.workspace.root, &state.app_data_dir);
    state
        .skills_installer
        .start(SkillsInstallConfig {
            repo_url,
            workspace_root,
            workflow,
            skills: bundled_skills(),
            env: build_install_env(),
            session_env: settings.session_env.clone(),
        })
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn get_repo_workflow_status(
    repo_url: String,
    session_env: BTreeMap<String, String>,
) -> Result<RepoWorkflowStatus, String> {
    if let Some(error) = validate_session_env(&session_env) {
        return Err(error);
    }
    Ok(check_repo_workflow(&repo_url, &session_env).await)
}

#[tauri::command]
async fn get_workflow_transfer_status(
    state: State<'_, AppState>,
) -> Result<WorkflowTransferStatus, String> {
    Ok(state.workflow_transfer.status().await)
}

#[tauri::command]
async fn transfer_workflow_to_repo(
    state: State<'_, AppState>,
    repo_url: String,
) -> Result<WorkflowTransferStatus, String> {
    let repo_url = repo_url.trim().to_string();
    if repo_url.is_empty() {
        return Err("Add a repository URL under Settings → Repositories first.".to_string());
    }
    let settings = load_settings_from_disk(&state).await?;
    if let Some(error) = validate_workflow_settings(&settings) {
        return Err(error);
    }
    let workflow = workflow_from_settings(&settings, None);
    let workspace_root =
        resolve_workspace_root_dir(&workflow.front_matter.workspace.root, &state.app_data_dir);
    state
        .workflow_transfer
        .start(WorkflowTransferConfig {
            repo_url,
            prompt_template: settings.prompt_template,
            workspace_root,
            env: build_install_env(),
            session_env: settings.session_env,
        })
        .await
}

fn emit_update_check_request(
    app: &tauri::AppHandle,
    bridge: &UpdateCheckBridge,
) -> Result<(), String> {
    if let Err(error) = app.emit("check-for-updates-requested", ()) {
        bridge.delivery_failed();
        return Err(format!("Could not deliver update check request: {error}"));
    }
    Ok(())
}

fn deliver_update_check_request(
    app: &tauri::AppHandle,
    bridge: &UpdateCheckBridge,
    delivery: Result<bool, String>,
) {
    match delivery {
        Ok(true) => {
            if let Err(error) = emit_update_check_request(app, bridge) {
                tracing::warn!(target: "symphony", %error);
            }
        }
        Ok(false) => {}
        Err(error) => tracing::warn!(target: "symphony", %error),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // GUI launches inherit launchd's minimal PATH, which breaks hooks and
    // agent processes that need user-installed tools. Overlay the login-shell
    // PATH before Tauri spawns threads that read the environment.
    let path_fix = path_env::fix();
    let builder = tauri::Builder::default();
    // Register first where plugin IPC is available. Linux relies on the file
    // lease below: this plugin version panics without a working session D-Bus.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        application_instance::activate_main_window(app);
    }));
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(UpdateCheckBridge::default());
    #[cfg(desktop)]
    let builder = builder.menu(build_app_menu).on_menu_event(|app, event| {
        if event.id() == CHECK_FOR_UPDATES_MENU_ID {
            application_instance::activate_main_window(app);
            let bridge = app.state::<UpdateCheckBridge>();
            let delivery = bridge.queue_request();
            deliver_update_check_request(app, &bridge, delivery);
        }
    });
    builder
        .setup(move |app| {
            let app_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_dir)?;
            // Plugin IPC can fail open. The stable app-data lease is the final
            // admission gate, held in app state until this process terminates.
            #[cfg(desktop)]
            match application_instance::InstanceLease::acquire(&app_dir)? {
                Some(lease) => {
                    app.manage(lease);
                }
                None => std::process::exit(0),
            }
            let handle = app.handle().clone();
            let ready_handle = handle.clone();
            app.listen("up:r", move |_| {
                let bridge = ready_handle.state::<UpdateCheckBridge>();
                let delivery = bridge.register_listener();
                deliver_update_check_request(&ready_handle, &bridge, delivery);
            });
            let acknowledged_handle = handle.clone();
            app.listen("up:a", move |_| {
                let bridge = acknowledged_handle.state::<UpdateCheckBridge>();
                let delivery = bridge.acknowledge();
                deliver_update_check_request(&acknowledged_handle, &bridge, delivery);
            });
            let _ = keyring::use_native_store(false);
            init_tracing(&app_dir);
            match &path_fix {
                Ok(path) => tracing::info!(target: "symphony", %path, "login-shell PATH overlaid"),
                Err(error) => tracing::warn!(
                    target: "symphony",
                    %error,
                    "login-shell PATH resolution failed; keeping inherited PATH"
                ),
            }
            let db_path = app_dir.join("symphony.sqlite");
            let (repo, bus) = tauri::async_runtime::block_on(async {
                let bus = EventBus::default();
                let pool = open_sqlite(&db_path).await?;
                let repo = Repository::new(pool, bus.clone());
                repo.fail_running_retros(INTERRUPTED_RETRO_MESSAGE).await?;
                repo.fail_in_progress_retro_batches(INTERRUPTED_RETRO_BATCH_MESSAGE)
                    .await?;
                Ok::<_, symphony_storage::StorageError>((repo, bus))
            })?;
            let worker = WorkerManager::new(repo.clone());
            // Tauri's setup callback runs on the synchronous event-loop
            // thread. Enter its Tokio runtime before WorkspaceCleanupManager
            // calls tokio::spawn, otherwise desktop launch panics with no
            // reactor running.
            let cleanup_worker = worker.clone();
            tauri::async_runtime::spawn(async move {
                cleanup_worker.start_workspace_cleanup();
            });
            let state = AppState {
                repo,
                worker,
                skills_installer: SkillsInstaller::new(),
                workflow_transfer: WorkflowTransferManager::new(),
                retro: RetroManager::new(),
                app_data_dir: app_dir.clone(),
                settings_store: settings_store::SettingsStore::new(
                    app_dir.join("settings.json"),
                    Arc::new(settings_store::KeyringCredentials),
                ),
                database_path: db_path,
            };
            forward_events(handle, bus);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            validate_settings,
            test_tracker_connection,
            get_linear_viewer,
            remove_linear_api_key,
            get_default_prompt,
            get_default_skills,
            get_overview,
            list_runs,
            get_run_detail,
            stop_run,
            list_issues,
            list_workflow_states,
            set_issue_state,
            list_board_issues,
            get_worker_status,
            start_worker,
            stop_worker,
            trigger_retry_now,
            start_retro,
            get_retro_status,
            list_retros,
            get_retro_detail,
            has_in_progress_retro_batches,
            delete_retro,
            set_retro_suggestion_decision,
            apply_retro_workflow,
            start_retro_prs,
            get_skills_status,
            get_skills_install_status,
            install_skills,
            get_repo_workflow_status,
            get_workflow_transfer_status,
            transfer_workflow_to_repo
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(desktop)]
fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem};

    let menu = Menu::default(app)?;
    if cfg!(dev) {
        // The frontend intentionally does not load the updater in `tauri dev`.
        return Ok(menu);
    }
    let check_for_updates = MenuItem::with_id(
        app,
        CHECK_FOR_UPDATES_MENU_ID,
        "Check for Updates…",
        true,
        None::<&str>,
    )?;

    #[cfg(target_os = "macos")]
    if let Some(app_menu) = menu
        .items()?
        .into_iter()
        .next()
        .and_then(|item| item.as_submenu().cloned())
    {
        // Keep the conventional macOS order: About, Check for Updates, separator.
        app_menu.insert(&check_for_updates, 1)?;
    }

    #[cfg(not(target_os = "macos"))]
    if let Some(help_menu) = menu
        .get(tauri::menu::HELP_SUBMENU_ID)
        .and_then(|item| item.as_submenu().cloned())
    {
        help_menu.append(&check_for_updates)?;
    }

    Ok(menu)
}

fn forward_events(handle: tauri::AppHandle, bus: EventBus) {
    tauri::async_runtime::spawn(async move {
        let mut rx = bus.subscribe();
        while let Some(event) = storage_events::next_event(&mut rx).await {
            match &event {
                StorageEvent::DbChanged { .. } => {
                    let _ = handle.emit(
                        "db_changed",
                        projections::storage_notification(event.clone()),
                    );
                }
                StorageEvent::AgentEvent { .. } => {
                    let _ = handle.emit(
                        "agent_event",
                        projections::storage_notification(event.clone()),
                    );
                }
                StorageEvent::RateLimitChanged { .. } => {
                    let _ = handle.emit(
                        "rate_limit_changed",
                        projections::storage_notification(event.clone()),
                    );
                }
                StorageEvent::WorkflowReady => {
                    let _ = handle.emit(
                        "workflow_ready",
                        projections::storage_notification(event.clone()),
                    );
                }
            }
        }
    });
}

async fn load_settings_from_disk(state: &AppState) -> Result<AppSettings, String> {
    let state = state.clone();
    settings_store::finish_operation(async move {
        let _effects = state.settings_store.commit_effects().await;
        load_settings_with_effects(&state).await
    })
    .await
}

/// Caller owns the settings effects gate for this complete continuation.
async fn load_settings_with_effects(state: &AppState) -> Result<AppSettings, String> {
    let result = state.settings_store.load().await;
    finish_settings_recovery(state).await;
    if let Ok(settings) = &result {
        state
            .worker
            .observe_settings_revision(settings.settings_revision)
            .await;
        if settings.linear_api_key_error.is_none() && !settings.linear_api_key_set {
            state
                .worker
                .stop_for_settings_revision(settings.settings_revision)
                .await;
        }
    }
    result
}

/// Caller owns the settings effects gate and an operation that outlives IPC.
async fn worker_settings_with_effects(
    state: &AppState,
) -> Result<settings_store::SettingsSnapshot, String> {
    let result = state.settings_store.runtime_snapshot().await;
    finish_settings_recovery(state).await;
    if let Ok(snapshot) = &result {
        state
            .worker
            .observe_settings_revision(snapshot.settings.settings_revision)
            .await;
        if snapshot.settings.linear_api_key_error.is_none() && snapshot.credential.is_none() {
            state
                .worker
                .stop_for_settings_revision(snapshot.settings.settings_revision)
                .await;
        }
    }
    result
}

/// Read one recoverable settings/credential pair before operational use.
async fn load_runtime_settings(
    state: &AppState,
) -> Result<settings_store::SettingsSnapshot, String> {
    let state = state.clone();
    settings_store::finish_operation(async move {
        let _effects = state.settings_store.commit_effects().await;
        let snapshot = worker_settings_with_effects(&state).await?;
        if let Some(error) = snapshot.settings.linear_api_key_error.as_ref() {
            return Err(error.clone());
        }
        Ok(snapshot)
    })
    .await
}

async fn request_linear_api_key(
    state: &AppState,
    typed_key: Option<String>,
) -> Result<Option<String>, String> {
    if let Some(key) = typed_key.filter(|key| !key.trim().is_empty()) {
        return Ok(Some(key));
    }
    Ok(load_runtime_settings(state).await?.credential)
}

async fn finish_settings_recovery(state: &AppState) {
    if state.settings_store.take_recovery_stop() {
        // Recovery may finish a previous removal or replacement after its IPC
        // failed. Stop any runtime holding the old credential before proceeding.
        state.worker.stop().await;
    }
}

/// Environment for hooks and agents (the structured settings feed the
/// workflow config directly; this only carries what shell scripts and agent
/// processes need at execution time). Repo-specific variables — REPO_URL,
/// REPO_NAME, SYMPHONY_INSTALL_CMD — are overlaid per run by the worker once
/// the issue is routed.
fn build_env(api_key: &str) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    env.insert("LINEAR_API_KEY".to_string(), api_key.to_string());
    env
}

/// Install bootstrap agents only need the app's repaired PATH from the base
/// environment. Do not forward keychain-derived secrets such as LINEAR_API_KEY
/// into target-repo package scripts or validation commands.
fn build_install_env() -> BTreeMap<String, String> {
    build_install_env_from(std::env::vars())
}

fn build_install_env_from(
    vars: impl IntoIterator<Item = (String, String)>,
) -> BTreeMap<String, String> {
    vars.into_iter()
        .filter(|(key, value)| key == "PATH" && !value.trim().is_empty())
        .collect()
}

fn keyring_entry() -> keyring_core::Result<keyring_core::Entry> {
    keyring_core::Entry::new(KEYRING_SERVICE, KEYRING_LINEAR_USER)
}

fn init_tracing(app_dir: &std::path::Path) {
    let log_dir = app_dir.join("logs");
    let file_appender = tracing_appender::rolling::daily(log_dir, "symphony.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let _guard = Box::leak(Box::new(guard));
    let subscriber = tracing_subscriber::fmt()
        .with_writer(non_blocking)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "symphony=info,symphony_worker=info".into()),
        )
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);
}

#[cfg(test)]
mod tests {
    use super::*;
    use symphony_core::RepoConfig;

    #[test]
    fn update_check_bridge_queues_until_a_listener_is_ready() {
        let mut bridge = UpdateCheckBridgeState::default();

        assert!(!bridge.queue_request());
        assert!(bridge.register_listener());
        assert_eq!(bridge.pending_requests, 1);
        assert!(!bridge.acknowledge());
        assert_eq!(bridge.pending_requests, 0);
    }

    #[test]
    fn update_check_bridge_redelivers_pending_work_to_a_rebuilt_listener() {
        let mut bridge = UpdateCheckBridgeState::default();

        bridge.register_listener();
        assert!(bridge.queue_request());
        assert!(bridge.register_listener());
        assert_eq!(bridge.pending_requests, 1);
        assert!(!bridge.acknowledge());
        assert_eq!(bridge.pending_requests, 0);
    }

    fn repo(name: &str) -> RepoConfig {
        RepoConfig {
            name: name.to_string(),
            url: format!("git@github.com:acme/{name}.git"),
            ..RepoConfig::default()
        }
    }

    /// Default settings plus the one thing defaults cannot ship: a repo.
    fn configured_settings() -> AppSettings {
        AppSettings {
            repos: vec![RepoConfig {
                is_default: true,
                ..repo("widgets")
            }],
            ..AppSettings::default()
        }
    }

    #[test]
    fn retro_prs_require_the_saved_repo_name_and_url_to_match() {
        let mut settings = configured_settings();
        let stored = "git@github.com:acme/widgets.git";
        assert_eq!(
            current_retro_repo_url(&settings, "widgets", Some(stored)).as_deref(),
            Some(stored)
        );

        settings.repos[0].url = "git@github.com:acme/replacement.git".to_string();
        assert!(current_retro_repo_url(&settings, "widgets", Some(stored)).is_none());
        assert!(current_retro_repo_url(&settings, "removed", Some(stored)).is_none());
    }

    #[test]
    fn prompt_revision_ignores_unrelated_workflow_settings() {
        let settings = configured_settings();
        let revision = prompt_revision(&settings);
        let original_workflow = workflow_from_settings(&settings, Some("lin_api_test"));
        let mut changed = settings;
        changed.active_states.push("Needs review".to_string());
        let changed_workflow = workflow_from_settings(&changed, Some("lin_api_test"));

        assert_ne!(original_workflow.source_hash, changed_workflow.source_hash);
        assert_eq!(prompt_revision(&changed), revision);
    }

    #[test]
    fn default_settings_build_a_usable_workflow() {
        let settings = configured_settings();
        let workflow = workflow_from_settings(&settings, Some("lin_api_test"));
        assert_eq!(workflow.front_matter.tracker.api_key, "lin_api_test");
        assert!(workflow.front_matter.tracker.team_keys.is_empty());
        assert!(workflow.front_matter.tracker.project_ids.is_empty());
        assert!(workflow.front_matter.tracker.assigned_to_me);
        assert_eq!(
            workflow.front_matter.agent.backend,
            symphony_core::AgentBackend::Codex
        );
        assert!(workflow.front_matter.codex.network_access);
        assert!(!workflow.front_matter.claude.allowed_tools.is_empty());
        // Launch commands fall back to the bare CLI names when Settings
        // leaves them blank.
        assert_eq!(workflow.front_matter.codex.command, "codex");
        assert_eq!(workflow.front_matter.claude.command, "claude");
        // Hooks keep shell-style defaults for bash to expand at run time.
        let after_create = workflow.front_matter.hooks.after_create.expect("hook");
        assert!(after_create.contains("${ISSUE_BRANCH:-symphony/${ISSUE_IDENTIFIER}}"));
        assert!(after_create.contains("${SYMPHONY_INSTALL_CMD:-npm ci}"));
        assert!(validate_workflow_settings(&settings).is_none());
    }

    #[test]
    fn install_env_only_forwards_repaired_path() {
        let env = build_install_env_from([
            ("PATH".to_string(), "/opt/homebrew/bin:/usr/bin".to_string()),
            ("LINEAR_API_KEY".to_string(), "lin_secret".to_string()),
            ("GH_TOKEN".to_string(), "gh_secret".to_string()),
        ]);

        assert_eq!(env.len(), 1);
        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert!(!env.contains_key("LINEAR_API_KEY"));
        assert!(!env.contains_key("GH_TOKEN"));
    }

    #[test]
    fn assigned_to_me_setting_flows_to_tracker_config() {
        let settings = AppSettings {
            tracker_assigned_to_me: true,
            ..configured_settings()
        };
        let workflow = workflow_from_settings(&settings, Some("lin_api_test"));
        assert!(workflow.front_matter.tracker.assigned_to_me);
    }

    #[test]
    fn validation_flags_empty_states_and_unknown_placeholders() {
        let no_states = AppSettings {
            active_states: Vec::new(),
            ..configured_settings()
        };
        assert!(validate_workflow_settings(&no_states)
            .expect("empty active states must fail validation")
            .contains("Active states"));

        let bad_prompt = AppSettings {
            prompt_template: "Fix {{issue.foo}} and {{issue.title}}".to_string(),
            ..configured_settings()
        };
        let error = validate_workflow_settings(&bad_prompt).expect("unknown placeholder");
        assert!(error.contains("issue.foo"), "unexpected error: {error}");
        // Known placeholders are not flagged.
        assert_eq!(
            symphony_core::unknown_prompt_placeholders(&bad_prompt.prompt_template),
            vec!["issue.foo"]
        );

        let invalid_env = AppSettings {
            session_env: BTreeMap::from([
                ("GOOD_VAR".to_string(), "ok".to_string()),
                ("1_BAD".to_string(), "no".to_string()),
            ]),
            ..configured_settings()
        };
        assert!(validate_workflow_settings(&invalid_env)
            .expect("invalid session env name")
            .contains("1_BAD"));

        let invalid_value = AppSettings {
            session_env: BTreeMap::from([("GOOD_VAR".to_string(), "bad\0value".to_string())]),
            ..configured_settings()
        };
        assert!(validate_workflow_settings(&invalid_value)
            .expect("invalid session env value")
            .contains("NUL"));
    }

    #[test]
    fn validation_requires_a_routable_repos_list() {
        // No repos at all: the worker could never dispatch anything.
        assert!(validate_workflow_settings(&AppSettings::default())
            .expect("empty repos must fail validation")
            .contains("No repository configured"));

        let unnamed = vec![RepoConfig {
            name: "  ".to_string(),
            ..repo("widgets")
        }];
        assert!(validate_repos(&unnamed)
            .expect("unnamed repo")
            .contains("name"));

        let no_url = vec![RepoConfig {
            url: String::new(),
            ..repo("widgets")
        }];
        assert!(validate_repos(&no_url)
            .expect("missing url")
            .contains("\"widgets\" has no Git URL"));

        let duplicate_names = vec![repo("widgets"), repo("Widgets")];
        assert!(validate_repos(&duplicate_names)
            .expect("duplicate names")
            .contains("share the name"));

        // Distinct names that sanitize to the same workspace folder.
        let colliding_names = vec![repo("api.v2"), repo("api_v2")];
        assert!(validate_repos(&colliding_names)
            .expect("colliding workspace keys")
            .contains("same workspace folder"));

        let two_defaults = vec![
            RepoConfig {
                is_default: true,
                ..repo("a")
            },
            RepoConfig {
                is_default: true,
                ..repo("b")
            },
        ];
        assert!(validate_repos(&two_defaults)
            .expect("two defaults")
            .contains("default"));

        // A clean multi-repo config passes.
        let web = repo("web");
        let backend = RepoConfig {
            is_default: true,
            ..repo("backend")
        };
        assert!(validate_repos(&[web, backend]).is_none());
    }

    #[test]
    fn missing_repo_is_an_incomplete_setup_not_a_blocking_error() {
        // No repo yet (e.g. a first-time user who has only entered a Linear
        // key): the workflow is not runnable, but this is unfinished setup, so
        // the save must not be blocked.
        let fresh = AppSettings::default();
        assert!(validate_workflow_settings(&fresh).is_some());
        assert!(workflow_setup_incomplete(&fresh));

        // Once a repo exists, a real mistake (here, empty active states) is a
        // blocking error rather than incomplete setup.
        let broken = AppSettings {
            active_states: Vec::new(),
            ..configured_settings()
        };
        assert!(validate_workflow_settings(&broken).is_some());
        assert!(!workflow_setup_incomplete(&broken));
    }

    #[test]
    fn blocking_validation_message_matches_the_field_that_needs_attention() {
        let mut draft = AppSettings::default();
        draft
            .session_env
            .insert("INVALID-NAME".into(), "value".into());
        let issues = workflow_validation_issues(&draft);
        assert!(!issues.first().unwrap().blocking);
        let primary = primary_validation_issue(&issues).unwrap();
        assert!(primary.blocking);
        assert_eq!(
            validate_workflow_settings(&draft).as_deref(),
            Some(primary.message.as_str())
        );
        assert_eq!(primary.field, symphony_core::ValidationField::SessionEnv);
    }

    #[test]
    fn only_runnable_settings_reconfigure_a_live_worker() {
        assert!(!live_reconfigure_allowed(&AppSettings::default()));
        assert!(live_reconfigure_allowed(&configured_settings()));

        let broken = AppSettings {
            active_states: Vec::new(),
            ..configured_settings()
        };
        assert!(!live_reconfigure_allowed(&broken));
        let unavailable_keyring = AppSettings {
            linear_api_key_error: Some("Credential store unavailable".into()),
            ..configured_settings()
        };
        assert!(!live_reconfigure_allowed(&unavailable_keyring));
    }

    #[test]
    fn placeholder_scan_ignores_non_variable_braces() {
        assert!(symphony_core::unknown_prompt_placeholders(
            "code sample: {{\"key\": 1}} and {{ issue.title }}"
        )
        .is_empty());
        assert_eq!(
            symphony_core::unknown_prompt_placeholders("{{issue.nope}}"),
            vec!["issue.nope"]
        );
    }

    #[test]
    fn bundled_skills_match_their_frontmatter_names() {
        let skills = bundled_skills();
        assert_eq!(skills.len(), 7);
        for skill in skills {
            let name_line = format!("name: {}", skill.name);
            assert!(
                skill
                    .content
                    .lines()
                    .take(5)
                    .any(|line| line.trim() == name_line),
                "skill {} frontmatter does not declare its installed name",
                skill.name
            );
            assert!(skill.content.starts_with("---\n"));
        }
    }

    #[test]
    fn bundled_skills_are_symphony_prefixed() {
        for skill in bundled_skills() {
            assert!(
                skill.name.starts_with(SYMPHONY_SKILL_PREFIX),
                "bundled skill {} is not Symphony-prefixed",
                skill.name
            );
        }
    }

    #[test]
    fn default_prompt_references_every_bundled_skill() {
        let prompt = default_prompt_template();
        for skill in bundled_skills() {
            assert!(
                prompt.contains(&format!("`{}`", skill.name)),
                "default prompt never mentions the bundled skill {}",
                skill.name
            );
        }
    }

    #[test]
    fn command_found_checks_first_token_only() {
        assert!(command_found("sh -lc"));
        assert!(!command_found("symphony-test-missing-binary --agent codex"));
        assert!(!command_found(""));
    }

    #[test]
    fn effective_command_falls_back_on_blank_overrides() {
        assert_eq!(effective_command(None, "codex"), "codex");
        assert_eq!(effective_command(Some("  "), "codex"), "codex");
        assert_eq!(
            effective_command(Some("mycode --agent codex"), "codex"),
            "mycode --agent codex"
        );
    }

    #[test]
    fn default_prompt_uses_supported_placeholders() {
        let prompt = default_prompt_template();
        assert!(
            symphony_core::unknown_prompt_placeholders(&prompt).is_empty(),
            "default prompt contains unsupported placeholders: {:?}",
            symphony_core::unknown_prompt_placeholders(&prompt)
        );
        for token in [
            "{{issue.identifier}}",
            "{{issue.title}}",
            "{{issue.state}}",
            "{{issue.labels}}",
            "{{issue.description}}",
        ] {
            assert!(
                prompt.contains(token),
                "prompt template is missing placeholder: {token}"
            );
        }
    }
}
