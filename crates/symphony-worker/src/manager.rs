use crate::{
    backoff_ms,
    dispatch_policy::{self, Admission, DispatchMode, EligibilityDecision, EligibilityFacts},
    hooks::run_hook_with_sanitizer,
    output::OutputSanitizer,
    resolve_repo_workflow,
    run_output::RunOutput,
    sanitize_key,
    skills::{
        ensure_workspace_skills, github_token_env_has_token_for_repo_url,
        github_token_env_vars_for_repo_url,
    },
    workspace::WorkspaceClaims,
    HookInvocation, SkillFile, WorkspaceCleanupManager, WorkspaceManager,
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use symphony_agents::{
    AgentDriver, AgentRunRequest, ClaudeRunOptions, CursorRunOptions, NativeAgentDriver,
    OpencodeRunOptions,
};
#[cfg(test)]
use symphony_core::RunStatus;
use symphony_core::{
    render_prompt, route_issue, AgentBackend, AgentOutcome, HookName, Issue, ParsedWorkflow,
    RepoConfig, RetryContext, TokenCountPayload,
};
use symphony_storage::{
    now_iso, Repository, RunCompletion, RunRow, StorageError, USER_REQUESTED_RETRY_CLASS,
};
use symphony_tracker::{LinearTracker, TrackerClient, TrackerError};
use thiserror::Error;
use tokio::{
    sync::{mpsc, Mutex, Notify, RwLock},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;
use tracing::{error, warn};
use uuid::Uuid;

const STOPPED_ISSUE_STATE: &str = "In Review";
const USER_CANCELLED_SUPPRESSION: &str = "user_cancelled";
const TERMINAL_WORKSPACE_CLEANUP_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(60 * 60);
const TERMINAL_WORKSPACE_GRACE_PERIOD: ChronoDuration = ChronoDuration::hours(1);

#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("worker is already running")]
    AlreadyRunning,
    #[error(
        "settings revision {revision} is stale; the worker has accepted revision {latest_revision}"
    )]
    StaleSettings { revision: u64, latest_revision: u64 },
    #[error("run {0} was not found")]
    RunNotFound(String),
    #[error("run {0} is not active")]
    RunNotActive(String),
    #[error("run {0} is not managed by this worker")]
    RunNotManaged(String),
    #[error("tracker error: {0}")]
    Tracker(#[from] TrackerError),
    #[error("workspace error: {0}")]
    Workspace(#[from] crate::workspace::WorkspaceError),
    #[error("workspace skill injection failed: {0}")]
    WorkspaceSkills(#[source] std::io::Error),
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
}

#[derive(Clone)]
pub struct WorkerStartConfig {
    pub runtime: symphony_core::RunnableConfig,
    /// Bundled Symphony skills copied into issue workspaces when missing.
    pub skills: Vec<SkillFile>,
    pub env: BTreeMap<String, String>,
    pub app_data_dir: PathBuf,
}

impl std::fmt::Debug for WorkerStartConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkerStartConfig")
            .field("runtime", &self.runtime)
            .field("skill_count", &self.skills.len())
            .field("environment_entry_count", &self.env.len())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkerState {
    Stopped,
    Running,
    Stopping,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkerStatus {
    pub state: WorkerState,
    pub started_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug)]
struct InnerState {
    lifecycle: WorkerLifecycle,
    last_error: Option<String>,
    generation: u64,
    reconfigure_generation: u64,
    latest_settings_revision: u64,
}

#[derive(Debug)]
enum WorkerLifecycle {
    Stopped,
    Running(OwnedWorker),
    Stopping(OwnedWorker),
}

#[derive(Debug)]
struct OwnedWorker {
    generation: u64,
    started_at: String,
    stop: CancellationToken,
    runtime_config: SharedRuntimeConfig,
    output_credentials: Arc<std::sync::Mutex<OutputSanitizer>>,
    // The supervisor owns polling and all run tasks until they have exited.
    _supervisor: JoinHandle<()>,
}

impl InnerState {
    fn status(&self) -> WorkerStatus {
        let (state, started_at) = match &self.lifecycle {
            WorkerLifecycle::Stopped => (WorkerState::Stopped, None),
            WorkerLifecycle::Running(worker) => {
                (WorkerState::Running, Some(worker.started_at.clone()))
            }
            WorkerLifecycle::Stopping(worker) => {
                (WorkerState::Stopping, Some(worker.started_at.clone()))
            }
        };
        WorkerStatus {
            state,
            started_at,
            last_error: self.last_error.clone(),
        }
    }

    fn request_stop(&mut self) -> WorkerStatus {
        self.reconfigure_generation = self.reconfigure_generation.wrapping_add(1);
        let lifecycle = std::mem::replace(&mut self.lifecycle, WorkerLifecycle::Stopped);
        self.lifecycle = match lifecycle {
            WorkerLifecycle::Running(worker) | WorkerLifecycle::Stopping(worker) => {
                worker.stop.cancel();
                WorkerLifecycle::Stopping(worker)
            }
            WorkerLifecycle::Stopped => WorkerLifecycle::Stopped,
        };
        self.status()
    }

    fn owns_generation(&self, generation: u64) -> bool {
        match &self.lifecycle {
            WorkerLifecycle::Running(worker) | WorkerLifecycle::Stopping(worker) => {
                worker.generation == generation
            }
            WorkerLifecycle::Stopped => false,
        }
    }
}

type SharedRuntimeConfig = Arc<RwLock<RuntimeConfig>>;
type RunTasks = Arc<Mutex<JoinSet<()>>>;

#[derive(Debug, Clone, Default)]
struct RunCancellationRegistry {
    runs: Arc<Mutex<BTreeMap<String, ManagedRun>>>,
}

#[derive(Clone)]
struct ManagedRun {
    token: CancellationToken,
    tracker_config: symphony_core::TrackerConfig,
    issue: Issue,
    lifecycle: Arc<Mutex<()>>,
    stop_intent: Arc<Mutex<StopIntent>>,
}

#[derive(Debug, Default)]
struct StopIntent {
    suppression_fingerprint: Option<String>,
    stopped_state_observed: bool,
}

impl RunCancellationRegistry {
    async fn register(
        &self,
        run_id: &str,
        token: CancellationToken,
        tracker_config: symphony_core::TrackerConfig,
        issue: Issue,
    ) {
        self.runs.lock().await.insert(
            run_id.to_string(),
            ManagedRun {
                token,
                tracker_config,
                issue,
                lifecycle: Arc::new(Mutex::new(())),
                stop_intent: Arc::new(Mutex::new(StopIntent::default())),
            },
        );
    }

    async fn get(&self, run_id: &str) -> Option<ManagedRun> {
        self.runs.lock().await.get(run_id).cloned()
    }

    async fn unregister(&self, run_id: &str) {
        self.runs.lock().await.remove(run_id);
    }

    async fn for_issue(&self, issue_id: &str) -> Vec<ManagedRun> {
        self.runs
            .lock()
            .await
            .values()
            .filter(|managed| managed.issue.id == issue_id)
            .cloned()
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct WorkerManager {
    repo: Repository,
    inner: Arc<Mutex<InnerState>>,
    run_cancellations: RunCancellationRegistry,
    wake: Arc<Notify>,
    workspace_cleanup: WorkspaceCleanupManager,
    workspace_claims: WorkspaceClaims,
}

impl WorkerManager {
    pub fn new(repo: Repository) -> Self {
        let workspace_cleanup = WorkspaceCleanupManager::new(repo.clone());
        Self {
            repo,
            inner: Arc::new(Mutex::new(InnerState {
                lifecycle: WorkerLifecycle::Stopped,
                last_error: None,
                generation: 0,
                reconfigure_generation: 0,
                latest_settings_revision: 0,
            })),
            run_cancellations: RunCancellationRegistry::default(),
            wake: Arc::new(Notify::new()),
            workspace_cleanup,
            workspace_claims: WorkspaceClaims::default(),
        }
    }

    pub fn start_workspace_cleanup(&self) {
        self.workspace_cleanup.start();
    }

    pub async fn status(&self) -> WorkerStatus {
        self.inner.lock().await.status()
    }

    pub async fn start(&self, config: WorkerStartConfig) -> Result<WorkerStatus, WorkerError> {
        self.start_with_runner(config, run_worker).await
    }

    async fn start_with_runner<F, Fut>(
        &self,
        config: WorkerStartConfig,
        runner: F,
    ) -> Result<WorkerStatus, WorkerError>
    where
        F: FnOnce(Repository, SharedRuntimeConfig, CancellationToken) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<(), WorkerError>> + Send + 'static,
    {
        self.start_workspace_cleanup();
        let mut inner = self.inner.lock().await;
        if !matches!(inner.lifecycle, WorkerLifecycle::Stopped) {
            return Err(WorkerError::AlreadyRunning);
        }
        let revision = config.runtime.settings_revision();
        if revision < inner.latest_settings_revision {
            return Err(WorkerError::StaleSettings {
                revision,
                latest_revision: inner.latest_settings_revision,
            });
        }
        let stop = CancellationToken::new();
        let run_tasks = RunTasks::default();
        let runtime = runtime_config_from_start(
            config,
            self.run_cancellations.clone(),
            self.wake.clone(),
            Some(self.workspace_cleanup.clone()),
            self.workspace_claims.clone(),
            run_tasks.clone(),
        );
        inner.latest_settings_revision = runtime.settings_revision;
        let output_credentials = Arc::new(std::sync::Mutex::new(runtime.output_sanitizer()));
        let supervisor_credentials = output_credentials.clone();
        let runtime_config = Arc::new(RwLock::new(runtime));
        inner.generation = inner.generation.wrapping_add(1);
        let generation = inner.generation;
        inner.reconfigure_generation = inner.reconfigure_generation.wrapping_add(1);
        inner.last_error = None;
        let manager = self.clone();
        let repo = self.repo.clone();
        let task_config = runtime_config.clone();
        let task_stop = stop.clone();
        let supervisor = tokio::spawn(async move {
            // Observe a poll-task panic just like a returned startup error, then
            // cancel and join children before releasing this generation.
            let result = tokio::spawn(runner(repo, task_config, task_stop.clone())).await;
            task_stop.cancel();
            {
                let mut inner = manager.inner.lock().await;
                if inner.owns_generation(generation) {
                    let lifecycle =
                        std::mem::replace(&mut inner.lifecycle, WorkerLifecycle::Stopped);
                    inner.lifecycle = match lifecycle {
                        WorkerLifecycle::Running(worker) | WorkerLifecycle::Stopping(worker) => {
                            WorkerLifecycle::Stopping(worker)
                        }
                        WorkerLifecycle::Stopped => WorkerLifecycle::Stopped,
                    };
                }
            }
            let mut tasks = run_tasks.lock().await;
            while let Some(result) = tasks.join_next().await {
                if let Err(error) = result {
                    error!(error = %supervisor_credentials.lock().unwrap().error(&error.to_string()), "run supervisor failed while stopping");
                }
            }
            drop(tasks);
            let output_sanitizer = supervisor_credentials.lock().unwrap().clone();
            let mut inner = manager.inner.lock().await;
            if inner.owns_generation(generation) {
                inner.lifecycle = WorkerLifecycle::Stopped;
                inner.last_error = match result {
                    Ok(result) => result
                        .err()
                        .map(|error| output_sanitizer.error(&error.to_string())),
                    Err(error) => {
                        Some(output_sanitizer.error(&format!("worker task failed: {error}")))
                    }
                };
                inner.reconfigure_generation = inner.reconfigure_generation.wrapping_add(1);
            }
        });
        inner.lifecycle = WorkerLifecycle::Running(OwnedWorker {
            generation,
            started_at: now_iso(),
            stop,
            runtime_config,
            output_credentials,
            _supervisor: supervisor,
        });
        Ok(inner.status())
    }

    /// Refresh the settings snapshot used by future worker ticks. Runs that
    /// have already been dispatched keep the config they started with.
    pub async fn reconfigure(&self, config: WorkerStartConfig) -> WorkerStatus {
        self.reconfigure_with_tracker_preflight(config, preflight_tracker_config)
            .await
    }

    /// Fence a committed draft even when it cannot become a runtime config.
    pub async fn observe_settings_revision(&self, revision: u64) {
        let mut inner = self.inner.lock().await;
        if revision > inner.latest_settings_revision {
            inner.latest_settings_revision = revision;
            inner.reconfigure_generation = inner.reconfigure_generation.wrapping_add(1);
        }
    }

    async fn reconfigure_with_tracker_preflight<F, Fut>(
        &self,
        config: WorkerStartConfig,
        preflight_tracker: F,
    ) -> WorkerStatus
    where
        F: FnOnce(symphony_core::TrackerConfig) -> Fut,
        Fut: std::future::Future<Output = Result<(), WorkerError>>,
    {
        let (runtime_config, generation) = {
            let mut inner = self.inner.lock().await;
            if config.runtime.settings_revision() < inner.latest_settings_revision {
                return inner.status();
            }
            // Fence committed settings order in every lifecycle state. A stopped
            // save must invalidate a delayed start as well as an older reconfigure.
            inner.latest_settings_revision = config.runtime.settings_revision();
            // Absence is a removal intent, not a failed tracker replacement.
            // Never retain an old in-memory credential after accepting it.
            if config
                .runtime
                .workflow()
                .front_matter
                .tracker
                .api_key
                .trim()
                .is_empty()
            {
                return inner.request_stop();
            }
            let WorkerLifecycle::Running(worker) = &inner.lifecycle else {
                return inner.status();
            };
            let runtime_config = worker.runtime_config.clone();
            inner.reconfigure_generation = inner.reconfigure_generation.wrapping_add(1);
            (runtime_config, inner.reconfigure_generation)
        };
        let current = runtime_config.read().await.clone();
        let runtime = runtime_config_from_start(
            config,
            self.run_cancellations.clone(),
            self.wake.clone(),
            Some(self.workspace_cleanup.clone()),
            self.workspace_claims.clone(),
            current.run_tasks.clone(),
        );
        if current.workflow.front_matter.tracker != runtime.workflow.front_matter.tracker {
            if let Err(err) = preflight_tracker(runtime.workflow.front_matter.tracker.clone()).await
            {
                let mut inner = self.inner.lock().await;
                if matches!(inner.lifecycle, WorkerLifecycle::Running(_))
                    && inner.reconfigure_generation == generation
                {
                    inner.last_error = Some(runtime.output_sanitizer().error(&err.to_string()));
                }
                return inner.status();
            }
        }
        {
            let mut inner = self.inner.lock().await;
            if !matches!(inner.lifecycle, WorkerLifecycle::Running(_))
                || inner.reconfigure_generation != generation
            {
                return inner.status();
            }
            if let WorkerLifecycle::Running(worker) = &inner.lifecycle {
                worker
                    .output_credentials
                    .lock()
                    .unwrap()
                    .include(&runtime.output_sanitizer());
            }
            *runtime_config.write().await = runtime;
            inner.last_error = None;
        }
        self.wake.notify_one();
        self.status().await
    }

    pub async fn trigger_retry_now(&self, issue_id: &str) -> Result<bool, WorkerError> {
        let updated = self.repo.trigger_retry_now(issue_id).await?;
        if updated {
            self.wake.notify_one();
        }
        Ok(updated)
    }

    pub async fn stop_run(&self, run_id: &str) -> Result<(), WorkerError> {
        if let Some(managed) = self.run_cancellations.get(run_id).await {
            let tracker = LinearTracker::new(managed.tracker_config.clone());
            return self.stop_managed_run(run_id, managed, &tracker).await;
        }

        let Some(run) = self.repo.get_run(run_id).await? else {
            return Err(WorkerError::RunNotFound(run_id.to_string()));
        };
        if matches!(run.status.as_str(), "pending" | "running") {
            return Err(WorkerError::RunNotManaged(run_id.to_string()));
        }
        Err(WorkerError::RunNotActive(run_id.to_string()))
    }

    async fn stop_managed_run<T: TrackerClient>(
        &self,
        run_id: &str,
        managed: ManagedRun,
        tracker: &T,
    ) -> Result<(), WorkerError> {
        // Stop the agent promptly, then move the issue out of the configured
        // active states. Until Linear confirms the move, the cancellation
        // checkpoint installs the local suppression as a fallback.
        let fallback_fingerprint = issue_fingerprint(&managed.issue);
        let lifecycle = managed.lifecycle.lock().await;
        let mut stop_intent = managed.stop_intent.lock().await;
        if !stop_intent.stopped_state_observed {
            stop_intent.suppression_fingerprint = Some(fallback_fingerprint.clone());
        }
        managed.token.cancel();

        // Final cancellation also takes this lock, so a run that completed
        // before the stop request is visible here as terminal, while a run
        // that was active when cancellation won cannot complete underneath
        // this revalidation.
        let Some(run) = self.repo.get_run(run_id).await? else {
            stop_intent.suppression_fingerprint = None;
            stop_intent.stopped_state_observed = true;
            return Err(WorkerError::RunNotFound(run_id.to_string()));
        };
        if !matches!(run.status.as_str(), "pending" | "running") {
            stop_intent.suppression_fingerprint = None;
            stop_intent.stopped_state_observed = true;
            self.repo
                .clear_issue_dispatch_suppression(&managed.issue.id, USER_CANCELLED_SUPPRESSION)
                .await?;
            return Err(WorkerError::RunNotActive(run_id.to_string()));
        }
        drop(stop_intent);
        drop(lifecycle);
        self.repo
            .append_event(
                run_id,
                symphony_core::AgentEventKind::Status,
                &serde_json::json!({ "message": "Run cancellation requested" }),
            )
            .await
            .ok();
        let transition = tracker
            .set_issue_state_by_name(&managed.issue.id, STOPPED_ISSUE_STATE)
            .await;
        // Serialize this with cancellation finalization so either it observes
        // the reconciled fingerprint or this reconciliation runs after it.
        let mut stop_intent = managed.stop_intent.lock().await;
        match transition {
            Ok(()) => {
                let destination_is_active = managed
                    .tracker_config
                    .active_states
                    .iter()
                    .any(|state| state.eq_ignore_ascii_case(STOPPED_ISSUE_STATE));
                if destination_is_active {
                    let stopped_issue = Issue {
                        state: STOPPED_ISSUE_STATE.to_ascii_lowercase(),
                        ..managed.issue.clone()
                    };
                    let fingerprint = issue_fingerprint(&stopped_issue);
                    stop_intent.suppression_fingerprint = Some(fingerprint.clone());
                    self.repo
                        .suppress_issue_dispatch(
                            &managed.issue.id,
                            USER_CANCELLED_SUPPRESSION,
                            &fingerprint,
                        )
                        .await?;
                } else if !stop_intent.stopped_state_observed {
                    // Keep the old active-state fingerprint until polling
                    // observes In Review. This fences a fetch_active request
                    // that began before Linear acknowledged the transition.
                    stop_intent.suppression_fingerprint = Some(fallback_fingerprint.clone());
                    self.repo
                        .suppress_issue_dispatch(
                            &managed.issue.id,
                            USER_CANCELLED_SUPPRESSION,
                            &fallback_fingerprint,
                        )
                        .await?;
                }
            }
            Err(err) => {
                // Another concurrent stop may already have reconciled the
                // issue transition. In that case the observation flag makes
                // this failure a no-op instead of reviving fallback state.
                if !stop_intent.stopped_state_observed {
                    stop_intent.suppression_fingerprint = Some(fallback_fingerprint.clone());
                    self.repo
                        .suppress_issue_dispatch(
                            &managed.issue.id,
                            USER_CANCELLED_SUPPRESSION,
                            &fallback_fingerprint,
                        )
                        .await?;
                }
                return Err(err.into());
            }
        }
        drop(stop_intent);
        self.repo
            .append_event(
                run_id,
                symphony_core::AgentEventKind::Status,
                &serde_json::json!({ "message": format!("Issue moved to {STOPPED_ISSUE_STATE}") }),
            )
            .await
            .ok();
        Ok(())
    }

    /// Stop requested by the user, independent of settings commit order.
    pub async fn stop(&self) -> WorkerStatus {
        self.inner.lock().await.request_stop()
    }

    /// Only an adopted newer runtime can supersede credential-removal intent.
    /// The same lock fences delayed starts/reconfiguration and owns cancellation.
    pub async fn stop_for_settings_revision(&self, revision: u64) -> WorkerStatus {
        let mut inner = self.inner.lock().await;
        let active_revision = match &inner.lifecycle {
            WorkerLifecycle::Running(worker) | WorkerLifecycle::Stopping(worker) => {
                worker.runtime_config.read().await.settings_revision
            }
            WorkerLifecycle::Stopped => 0,
        };
        if revision < active_revision {
            return inner.status();
        }
        inner.latest_settings_revision = inner.latest_settings_revision.max(revision);
        inner.request_stop()
    }
}

#[derive(Clone)]
struct RuntimeConfig {
    settings_revision: u64,
    workflow: ParsedWorkflow,
    repos: Vec<RepoConfig>,
    skills: Vec<SkillFile>,
    env: BTreeMap<String, String>,
    session_env: BTreeMap<String, String>,
    app_data_dir: PathBuf,
    run_cancellations: RunCancellationRegistry,
    wake: Arc<Notify>,
    workspace_cleanup: Option<WorkspaceCleanupManager>,
    workspace_claims: WorkspaceClaims,
    run_tasks: RunTasks,
}

impl std::fmt::Debug for RuntimeConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeConfig")
            .field("backend", &self.workflow.front_matter.agent.backend)
            .field("repo_count", &self.repos.len())
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for ManagedRun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ManagedRun")
            .field("cancelled", &self.token.is_cancelled())
            .finish_non_exhaustive()
    }
}

impl RuntimeConfig {
    fn output_sanitizer(&self) -> OutputSanitizer {
        OutputSanitizer::new(
            &self.workflow.front_matter.tracker.api_key,
            &self.env,
            &self.session_env,
        )
    }
}

fn runtime_config_from_start(
    config: WorkerStartConfig,
    run_cancellations: RunCancellationRegistry,
    wake: Arc<Notify>,
    workspace_cleanup: Option<WorkspaceCleanupManager>,
    workspace_claims: WorkspaceClaims,
    run_tasks: RunTasks,
) -> RuntimeConfig {
    let settings_revision = config.runtime.settings_revision();
    let (workflow, repos, session_env) = config.runtime.into_parts();
    RuntimeConfig {
        settings_revision,
        workflow,
        repos,
        skills: config.skills,
        env: config.env,
        session_env,
        app_data_dir: config.app_data_dir,
        run_cancellations,
        wake,
        workspace_cleanup,
        workspace_claims,
        run_tasks,
    }
}

async fn preflight_tracker_config(
    tracker_config: symphony_core::TrackerConfig,
) -> Result<(), WorkerError> {
    let tracker = LinearTracker::new(tracker_config);
    tracker.preflight().await?;
    Ok(())
}

async fn run_worker(
    repo: Repository,
    config: SharedRuntimeConfig,
    stop: CancellationToken,
) -> Result<(), WorkerError> {
    let initial_config = config.read().await.clone();
    repo.notify_workflow_ready();
    let tracker_config = initial_config.workflow.front_matter.tracker.clone();
    let tracker = LinearTracker::new(tracker_config.clone());
    if !prepare_worker(&repo, &tracker, &initial_config, &stop).await? {
        return Ok(());
    }
    // Terminal workspaces are quarantined after startup recovery. The
    // rename is fast; recursive deletion belongs to the app-owned collector
    // and never gates the first active-issue poll.
    if !recover_terminal_workspaces_at_startup(&repo, &tracker, &initial_config, &stop).await {
        return Ok(());
    }

    let cleanup_tracker = LinearTracker::new(tracker_config.clone());
    tokio::join!(
        run_loop(
            &repo,
            &config,
            &stop,
            tracker,
            tracker_config.clone(),
            |cfg| { LinearTracker::new(cfg.clone()) }
        ),
        run_terminal_workspace_cleanup_loop(
            &repo,
            &config,
            &stop,
            cleanup_tracker,
            tracker_config,
            |cfg| LinearTracker::new(cfg.clone()),
        ),
    );
    Ok(())
}

/// Complete tracker preflight and repair persisted run ownership before the
/// worker recovers terminal workspaces.
async fn prepare_worker<T: TrackerClient>(
    repo: &Repository,
    tracker: &T,
    config: &RuntimeConfig,
    stop: &CancellationToken,
) -> Result<bool, WorkerError> {
    let Some(preflight) = cancellable(stop, tracker.preflight()).await else {
        return Ok(false);
    };
    preflight?;
    recover_stranded_runs(repo, config).await?;
    Ok(!stop.is_cancelled())
}

/// The worker's poll loop: tick, then wait for the next wake/interval/stop,
/// rebuilding the tracker whenever live reconfiguration changes its settings.
///
/// A stop must take effect promptly rather than waiting out an in-flight Linear
/// request — each GraphQL call can block for ~15s per attempt (~47s across
/// retries) and takes no cancellation token. We get that responsiveness from
/// `tick` itself, which bails at its tracker calls when `stop` fires (see
/// [`cancellable`]) and already checks `stop.is_cancelled()` between dispatches.
/// We deliberately do *not* race the whole tick future against cancellation:
/// dropping it at an arbitrary await is not cancellation-safe, because
/// `reserve_and_dispatch` commits a `pending` run before spawning the task that
/// owns its lifecycle, so a drop in that window would strand the run until the
/// next restart sweep. Letting `tick` unwind through its own early returns keeps
/// that reserve → spawn handoff atomic.
///
/// `make_tracker` builds a tracker from a tracker config; in production it
/// constructs a [`LinearTracker`], while tests inject a stub.
async fn run_loop<T, F>(
    repo: &Repository,
    config: &SharedRuntimeConfig,
    stop: &CancellationToken,
    mut tracker: T,
    mut tracker_config: symphony_core::TrackerConfig,
    mut make_tracker: F,
) where
    T: TrackerClient,
    F: FnMut(&symphony_core::TrackerConfig) -> T,
{
    while !stop.is_cancelled() {
        let current_config = config.read().await.clone();
        let current_tracker_config = current_config.workflow.front_matter.tracker.clone();
        if current_tracker_config != tracker_config {
            tracker_config = current_tracker_config;
            tracker = make_tracker(&tracker_config);
        }
        if let Err(err) = tick(repo, &tracker, &current_config, Some(config), stop).await {
            error!(error = %current_config.output_sanitizer().error(&err.to_string()), "worker tick failed");
        }
        let interval_ms = current_config.workflow.front_matter.polling.interval_ms;
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = current_config.wake.notified() => {}
            _ = tokio::time::sleep(std::time::Duration::from_millis(interval_ms)) => {}
        }
    }
}

async fn run_terminal_workspace_cleanup_loop<T, F>(
    repo: &Repository,
    config: &SharedRuntimeConfig,
    stop: &CancellationToken,
    mut tracker: T,
    mut tracker_config: symphony_core::TrackerConfig,
    mut make_tracker: F,
) where
    T: TrackerClient,
    F: FnMut(&symphony_core::TrackerConfig) -> T,
{
    let mut next_cleanup = tokio::time::Instant::now() + TERMINAL_WORKSPACE_CLEANUP_INTERVAL;
    while !stop.is_cancelled() {
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = tokio::time::sleep_until(next_cleanup) => {}
        }
        let current_config = config.read().await.clone();
        let current_tracker_config = current_config.workflow.front_matter.tracker.clone();
        if current_tracker_config != tracker_config {
            tracker_config = current_tracker_config;
            tracker = make_tracker(&tracker_config);
        }
        if let Err(err) =
            recover_terminal_workspaces(repo, &tracker, &current_config, Some(config), stop).await
        {
            error!(error = %current_config.output_sanitizer().error(&err.to_string()), "hourly terminal workspace cleanup failed");
        }
        next_cleanup = tokio::time::Instant::now() + TERMINAL_WORKSPACE_CLEANUP_INTERVAL;
    }
}

async fn recover_stranded_runs(
    repo: &Repository,
    config: &RuntimeConfig,
) -> Result<(), WorkerError> {
    let mut stranded = repo.list_running().await?;
    stranded.extend(repo.list_pending().await?);
    for run in stranded {
        warn!(run_id = %run.id, issue_id = %run.issue_id, "orphan run marked crashed");
        let due = due_after(backoff_ms(
            run.run_number,
            config.workflow.front_matter.agent.max_retry_backoff_ms,
        ));
        repo.complete_run(
            &run.id,
            RunCompletion::Failure {
                error_class: "process_crashed",
                error_message: "worker restarted before run completed",
                retry_due_at: &due,
            },
        )
        .await?;
    }
    repo.delete_orphaned_pending_sessions().await.ok();
    Ok(())
}

async fn recover_terminal_workspaces<T: TrackerClient>(
    repo: &Repository,
    tracker: &T,
    config: &RuntimeConfig,
    latest_config: Option<&SharedRuntimeConfig>,
    stop: &CancellationToken,
) -> Result<bool, WorkerError> {
    let Some(terminal) = cancellable(stop, tracker.fetch_terminal()).await else {
        return Ok(false);
    };
    let terminal = terminal?;
    let Some(config) = latest_runtime_config_if_tracker_matches(config, latest_config).await else {
        return Ok(!stop.is_cancelled());
    };
    for candidate in terminal {
        if stop.is_cancelled() {
            return Ok(false);
        }
        let Some(candidate_repo) = route_issue(&config.repos, &candidate) else {
            continue;
        };
        let candidate_workspace = workspace_manager(&config, candidate_repo);
        let candidate_path = candidate_workspace.path_for(&candidate.identifier)?;
        let Some(_workspace_claim) = config.workspace_claims.try_claim(&candidate_path)? else {
            continue;
        };
        match tokio::fs::symlink_metadata(&candidate_path).await {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(crate::workspace::WorkspaceError::Io(error).into()),
        }
        if repo.has_active_run(&candidate.id).await? {
            continue;
        }
        let Some(current_issue) = cancellable(stop, tracker.fetch_by_id(&candidate.id)).await
        else {
            return Ok(false);
        };
        let Some(current_issue) = current_issue? else {
            warn!(
                issue = %candidate.identifier,
                "terminal cleanup candidate disappeared from the tracker; preserving workspace"
            );
            continue;
        };
        let Some(config) = latest_runtime_config_if_tracker_matches(&config, latest_config).await
        else {
            return Ok(!stop.is_cancelled());
        };
        let is_terminal = config
            .workflow
            .front_matter
            .tracker
            .terminal_states
            .iter()
            .any(|state| state.eq_ignore_ascii_case(&current_issue.state));
        if !is_terminal || !terminal_workspace_grace_period_elapsed(&current_issue, Utc::now()) {
            continue;
        }
        if let Some(repo_config) = route_issue(&config.repos, &current_issue) {
            let workspaces = workspace_manager(&config, repo_config);
            if workspaces.path_for(&current_issue.identifier)? != candidate_path {
                continue;
            }
            if let Err(error) = workspaces.remove(&current_issue).await {
                warn!(
                    issue = %current_issue.identifier,
                    repo = %repo_config.name,
                    %error,
                    "could not quarantine terminal issue workspace"
                );
            }
        }
    }
    Ok(!stop.is_cancelled())
}

async fn recover_terminal_workspaces_at_startup<T: TrackerClient>(
    repo: &Repository,
    tracker: &T,
    config: &RuntimeConfig,
    stop: &CancellationToken,
) -> bool {
    match recover_terminal_workspaces(repo, tracker, config, None, stop).await {
        Ok(should_continue) => should_continue,
        Err(error) => {
            warn!(error = %config.output_sanitizer().error(&error.to_string()), "startup terminal workspace cleanup failed; continuing worker startup");
            !stop.is_cancelled()
        }
    }
}

fn terminal_workspace_grace_period_elapsed(issue: &Issue, now: DateTime<Utc>) -> bool {
    let terminal_timestamps = [issue.completed_at.as_deref(), issue.canceled_at.as_deref()];
    if terminal_timestamps.iter().all(Option::is_none) {
        warn!(
            issue = %issue.identifier,
            "terminal issue has no completion or cancellation timestamp; preserving workspace"
        );
        return false;
    }
    let mut parsed_timestamps = Vec::new();
    for timestamp in terminal_timestamps.into_iter().flatten() {
        match DateTime::parse_from_rfc3339(timestamp) {
            Ok(timestamp) => parsed_timestamps.push(timestamp.with_timezone(&Utc)),
            Err(_) => {
                warn!(
                    issue = %issue.identifier,
                    terminal_at = timestamp,
                    "terminal issue has an invalid completion or cancellation timestamp; preserving workspace"
                );
                return false;
            }
        }
    }
    let Some(terminal_at) = parsed_timestamps.into_iter().max() else {
        return false;
    };
    terminal_at <= now - TERMINAL_WORKSPACE_GRACE_PERIOD
}

/// Await `fut`, but bail the moment `stop` is cancelled, returning `None`.
///
/// The tracker's Linear calls take no cancellation token and can block for
/// ~15s per attempt (~47s across retries), so a stop issued during startup or a
/// tick would otherwise have to wait them out. Wrapping each tracker call lets
/// the owning operation abandon the network wait and unwind through its normal
/// early returns instead of force-dropping broader work at an arbitrary await.
async fn cancellable<F>(stop: &CancellationToken, fut: F) -> Option<F::Output>
where
    F: std::future::Future,
{
    tokio::select! {
        _ = stop.cancelled() => None,
        output = fut => Some(output),
    }
}

async fn tick<T: TrackerClient>(
    repo: &Repository,
    tracker: &T,
    config: &RuntimeConfig,
    latest_config: Option<&SharedRuntimeConfig>,
    stop: &CancellationToken,
) -> Result<(), WorkerError> {
    let active = match cancellable(stop, tracker.fetch_active()).await {
        Some(result) => result?,
        None => return Ok(()),
    };
    if latest_runtime_config_if_tracker_matches(config, latest_config)
        .await
        .is_none()
    {
        return Ok(());
    }
    repo.upsert_issues(&active).await?;

    let active_ids = active
        .iter()
        .map(|issue| issue.id.clone())
        .collect::<std::collections::HashSet<_>>();
    for retry_id in repo.all_retry_issue_ids().await? {
        if active_ids.contains(&retry_id) {
            continue;
        }
        let Some(fetched) = cancellable(stop, tracker.fetch_by_id(&retry_id)).await else {
            return Ok(());
        };
        if matches!(fetched, Ok(None)) {
            repo.clear_retry(&retry_id).await?;
        }
    }

    // An issue that leaves the active set (e.g. moved to Done in Linear) stops
    // appearing in fetch_active, so its local row would otherwise stay frozen
    // at the last active state. Refetch it by id and store whatever state it
    // has now. Issues can pass through intermediate states on the way out
    // (Linear's GitHub integration moves them to In Review before Done), so
    // keep refreshing every tick until the row reaches a terminal state.
    for issue_id in repo
        .issue_ids_not_in_states(&config.workflow.front_matter.tracker.terminal_states)
        .await?
    {
        if active_ids.contains(&issue_id) {
            continue;
        }
        let Some(fetched) = cancellable(stop, tracker.fetch_by_id(&issue_id)).await else {
            return Ok(());
        };
        match fetched {
            Ok(Some(issue)) => {
                repo.upsert_issues(std::slice::from_ref(&issue)).await?;
                acknowledge_stopped_state(repo, config, &issue).await?;
            }
            Ok(None) => warn!(
                issue_id = %issue_id,
                "issue left the active set and is gone from the tracker; keeping last known state"
            ),
            Err(err) => warn!(
                issue_id = %issue_id,
                error = %config.output_sanitizer().error(&err.to_string()),
                "failed to refresh issue that left the active set"
            ),
        }
    }

    let retry_ids = repo.pending_retry_issue_ids().await?;
    for issue in active {
        if stop.is_cancelled() {
            return Ok(());
        }
        let suppression = repo
            .issue_dispatch_suppression(&issue.id, USER_CANCELLED_SUPPRESSION)
            .await?;
        let suppression_matches = suppression
            .as_ref()
            .is_some_and(|fingerprint| *fingerprint == issue_fingerprint(&issue));
        if suppression.is_some() && !suppression_matches {
            repo.clear_issue_dispatch_suppression(&issue.id, USER_CANCELLED_SUPPRESSION)
                .await?;
        }
        let Some(dispatch_config) =
            latest_runtime_config_if_tracker_matches(config, latest_config).await
        else {
            return Ok(());
        };
        let decision = dispatch_policy::decide(EligibilityFacts {
            issue: Some(&issue),
            repos: &dispatch_config.repos,
            active_states: &dispatch_config.workflow.front_matter.tracker.active_states,
            mode: DispatchMode::Active,
            has_active_run: repo.has_active_run(&issue.id).await?,
            retry_queued: retry_ids.contains(&issue.id),
            suppression_matches,
            admission: dispatch_admission(repo, &dispatch_config).await?,
        });
        match decision {
            EligibilityDecision::Skip(reason) if reason.pauses_dispatch() => return Ok(()),
            EligibilityDecision::Skip(_) => continue,
            EligibilityDecision::Dispatch(plan) => {
                reserve_and_dispatch(
                    repo.clone(),
                    dispatch_config.clone(),
                    plan.issue.clone(),
                    plan.repository.clone(),
                    plan.run_number,
                    stop.clone(),
                )
                .await?;
            }
        }
    }

    for retry in repo.due_retries(&now_iso()).await? {
        if stop.is_cancelled() {
            return Ok(());
        }
        let Some(dispatch_config) =
            latest_runtime_config_if_tracker_matches(config, latest_config).await
        else {
            return Ok(());
        };
        // Avoid fetching/moving tracker state while admission is paused.
        if dispatch_admission(repo, &dispatch_config)
            .await?
            .skip()
            .is_some()
        {
            return Ok(());
        }
        let mut fetched =
            match cancellable(stop, tracker.fetch_by_id_for_dispatch(&retry.issue_id)).await {
                Some(result) => result?,
                None => return Ok(()),
            };
        // Tracker I/O may overlap a settings edit; evaluate with the newest
        // matching configuration instead of the pre-fetch provider/route.
        let Some(dispatch_config) =
            latest_runtime_config_if_tracker_matches(config, latest_config).await
        else {
            return Ok(());
        };
        if let Some(issue) = &mut fetched {
            match dispatch_policy::retry_resume_state(
                issue,
                retry.error_class.as_deref() == Some(USER_REQUESTED_RETRY_CLASS),
                STOPPED_ISSUE_STATE,
                &dispatch_config.workflow.front_matter.tracker.active_states,
            ) {
                Ok(Some(resume_state)) => {
                    match cancellable(
                        stop,
                        tracker.set_issue_state_by_name(&issue.id, resume_state),
                    )
                    .await
                    {
                        Some(result) => result?,
                        None => return Ok(()),
                    }
                    issue.state = resume_state.to_lowercase();
                    repo.upsert_issues(std::slice::from_ref(issue)).await?;
                }
                Ok(None) => {}
                Err(reason) => {
                    if reason.clears_retry() {
                        repo.clear_retry(&retry.issue_id).await?;
                    }
                    continue;
                }
            }
        }
        let Some(dispatch_config) =
            latest_runtime_config_if_tracker_matches(config, latest_config).await
        else {
            return Ok(());
        };
        let decision = dispatch_policy::decide(EligibilityFacts {
            issue: fetched.as_ref(),
            repos: &dispatch_config.repos,
            active_states: &dispatch_config.workflow.front_matter.tracker.active_states,
            mode: DispatchMode::Retry {
                run_number: retry.run_number,
            },
            has_active_run: repo.has_active_run(&retry.issue_id).await?,
            retry_queued: true,
            suppression_matches: false,
            admission: dispatch_admission(repo, &dispatch_config).await?,
        });
        match decision {
            EligibilityDecision::Skip(reason) => {
                if reason.clears_retry() {
                    repo.clear_retry(&retry.issue_id).await?;
                }
                if reason.pauses_dispatch() {
                    return Ok(());
                }
            }
            EligibilityDecision::Dispatch(plan) => {
                reserve_and_dispatch(
                    repo.clone(),
                    dispatch_config.clone(),
                    plan.issue.clone(),
                    plan.repository.clone(),
                    plan.run_number,
                    stop.clone(),
                )
                .await?;
            }
        }
    }
    Ok(())
}

async fn dispatch_admission(
    repo: &Repository,
    config: &RuntimeConfig,
) -> Result<Admission, WorkerError> {
    Ok(Admission {
        active_runs: repo.count_active().await?,
        max_concurrent: config.workflow.front_matter.agent.max_concurrent_agents,
        rate_limited: provider_rate_limited(repo, config).await?,
    })
}

async fn provider_rate_limited(
    repo: &Repository,
    config: &RuntimeConfig,
) -> Result<bool, WorkerError> {
    provider_rate_limited_at(repo, config, &now_iso()).await
}

async fn provider_rate_limited_at(
    repo: &Repository,
    config: &RuntimeConfig,
    now: &str,
) -> Result<bool, WorkerError> {
    let provider = config.workflow.front_matter.agent.backend.as_source_str();
    Ok(repo.active_rate_limits(now).await?.iter().any(|limit| {
        limit.source == provider
            || limit
                .source
                .strip_prefix(provider)
                .is_some_and(|suffix| suffix.starts_with('_'))
    }))
}

async fn acknowledge_stopped_state(
    repo: &Repository,
    config: &RuntimeConfig,
    issue: &Issue,
) -> Result<(), WorkerError> {
    if !issue.state.eq_ignore_ascii_case(STOPPED_ISSUE_STATE)
        || config
            .workflow
            .front_matter
            .tracker
            .active_states
            .iter()
            .any(|state| state.eq_ignore_ascii_case(STOPPED_ISSUE_STATE))
    {
        return Ok(());
    }

    let managed_runs = config.run_cancellations.for_issue(&issue.id).await;
    if managed_runs.is_empty() {
        repo.clear_issue_dispatch_suppression(&issue.id, USER_CANCELLED_SUPPRESSION)
            .await?;
        return Ok(());
    }

    for managed in managed_runs {
        let mut stop_intent = managed.stop_intent.lock().await;
        stop_intent.stopped_state_observed = true;
        stop_intent.suppression_fingerprint = None;
        // Keep the intent lock through the delete so cancellation finalization
        // cannot reinsert the old fingerprint after this observation.
        repo.clear_issue_dispatch_suppression(&issue.id, USER_CANCELLED_SUPPRESSION)
            .await?;
    }
    Ok(())
}

async fn latest_runtime_config(
    fallback: &RuntimeConfig,
    latest_config: Option<&SharedRuntimeConfig>,
) -> RuntimeConfig {
    match latest_config {
        Some(config) => config.read().await.clone(),
        None => fallback.clone(),
    }
}

async fn latest_runtime_config_if_tracker_matches(
    fallback: &RuntimeConfig,
    latest_config: Option<&SharedRuntimeConfig>,
) -> Option<RuntimeConfig> {
    let latest = latest_runtime_config(fallback, latest_config).await;
    if latest.workflow.front_matter.tracker == fallback.workflow.front_matter.tracker {
        Some(latest)
    } else {
        None
    }
}

async fn reserve_and_dispatch(
    repo: Repository,
    config: RuntimeConfig,
    issue: Issue,
    repo_config: RepoConfig,
    run_number: Option<i64>,
    stop: CancellationToken,
) -> Result<(), WorkerError> {
    reserve_and_dispatch_with_driver(
        repo,
        config,
        DispatchTarget {
            issue,
            repo_config,
            run_number,
        },
        stop,
        NativeAgentDriver,
    )
    .await
}

struct DispatchTarget {
    issue: Issue,
    repo_config: RepoConfig,
    run_number: Option<i64>,
}

async fn reserve_and_dispatch_with_driver<D: AgentDriver + 'static>(
    repo: Repository,
    config: RuntimeConfig,
    target: DispatchTarget,
    stop: CancellationToken,
    driver: D,
) -> Result<(), WorkerError> {
    let DispatchTarget {
        issue,
        repo_config,
        run_number,
    } = target;
    let workspaces = workspace_manager(&config, &repo_config);
    let workspace_path = workspaces.path_for(&issue.identifier)?;
    let Some(workspace_claim) = config.workspace_claims.try_claim(&workspace_path)? else {
        return Ok(());
    };
    let number = match run_number {
        Some(number) => number,
        None => repo.last_run_number(&issue.id).await? + 1,
    };
    let Some(run) = repo
        .try_reserve_run(
            &issue.id,
            number,
            &workspace_path.display().to_string(),
            Some(&repo_config.name),
        )
        .await?
    else {
        return Ok(());
    };
    // Capture what we need to rescue the run if dispatch_run returns early via
    // `?`. Without this, any error after the run is reserved (e.g. a transient
    // event-persist failure mid-stream) abandons the row in a non-terminal
    // state forever: nothing finishes it, no retry is scheduled, and it keeps
    // occupying a max_concurrent_agents slot until the worker restarts.
    let recovery_repo = repo.clone();
    let recovery_run = run.clone();
    let recovery_issue_id = issue.id.clone();
    let retry_backoff_cap = config.workflow.front_matter.agent.max_retry_backoff_ms;
    let recovery_sanitizer = config.output_sanitizer();
    let run_stop = stop.child_token();
    config
        .run_cancellations
        .register(
            &run.id,
            run_stop.clone(),
            config.workflow.front_matter.tracker.clone(),
            issue.clone(),
        )
        .await;
    let run_cancellations = config.run_cancellations.clone();
    let tasks = config.run_tasks.clone();
    let mut run_tasks = tasks.lock().await;
    while let Some(result) = run_tasks.try_join_next() {
        if let Err(error) = result {
            error!(error = %recovery_sanitizer.error(&error.to_string()), "run supervisor failed");
        }
    }
    run_tasks.spawn(async move {
        let _workspace_claim = workspace_claim;
        let result = tokio::spawn(dispatch_run_with_driver(
            repo,
            config,
            issue,
            repo_config,
            run,
            run_stop,
            driver,
        ))
        .await;
        handle_dispatch_result(
            result,
            &recovery_repo,
            &recovery_issue_id,
            &recovery_run,
            retry_backoff_cap,
            &recovery_sanitizer,
        )
        .await;
        run_cancellations.unregister(&recovery_run.id).await;
    });
    Ok(())
}

async fn handle_dispatch_result(
    result: Result<Result<(), WorkerError>, tokio::task::JoinError>,
    repo: &Repository,
    issue_id: &str,
    run: &RunRow,
    retry_backoff_cap: u64,
    sanitizer: &OutputSanitizer,
) {
    match result {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            let message = sanitizer.error(&err.to_string());
            error!(error = %message, "dispatch failed");
            recover_stranded_run(
                repo,
                issue_id,
                run,
                retry_backoff_cap,
                "dispatch_error",
                &message,
                sanitizer,
            )
            .await;
        }
        Err(err) => {
            let class = if err.is_panic() {
                "dispatch_panic"
            } else {
                "dispatch_cancelled"
            };
            let message = sanitizer.error(&format!("dispatch task ended without cleanup: {err}"));
            error!(error = %message, "dispatch task ended without cleanup");
            recover_stranded_run(
                repo,
                issue_id,
                run,
                retry_backoff_cap,
                class,
                &message,
                sanitizer,
            )
            .await;
        }
    }
}

/// Mark a run that fell out of `dispatch_run` via an unhandled error as failed
/// and queue a retry — the safety net for the reserve → running → finish path.
///
/// `dispatch_run` may have already reached a terminal state before the error
/// escaped. Its outcome, retry, and live-session cleanup commit together,
/// so only rescue rows still stuck `pending`/`running`. That keeps this
/// idempotent: we never re-stamp `ended_at` or double-queue a retry for a run
/// that already finished. Every step is best-effort — we are already on the
/// error path and cannot propagate — and anything we cannot fix here is still
/// caught by the worker-restart `recover()` sweep.
async fn recover_stranded_run(
    repo: &Repository,
    _issue_id: &str,
    run: &RunRow,
    retry_backoff_cap: u64,
    class: &str,
    message: &str,
    sanitizer: &OutputSanitizer,
) {
    match repo.get_run(&run.id).await {
        Ok(Some(current)) if matches!(current.status.as_str(), "pending" | "running") => {}
        Ok(_) => return,
        Err(read_err) => {
            error!(
                error = %read_err,
                run_id = %run.id,
                "could not read stranded run status; leaving it for worker-restart recovery"
            );
            return;
        }
    }
    let due = due_after(backoff_ms(run.run_number, retry_backoff_cap));
    if let Err(err) = RunOutput::new(repo, sanitizer)
        .failure(&run.id, &due, class, message)
        .await
    {
        error!(error = %sanitizer.error(&err.to_string()), run_id = %run.id,
            "could not persist stranded run recovery");
    }
}

async fn dispatch_run_with_driver<D>(
    repo: Repository,
    config: RuntimeConfig,
    issue: Issue,
    repo_config: RepoConfig,
    run: RunRow,
    stop: CancellationToken,
    driver: D,
) -> Result<(), WorkerError>
where
    D: AgentDriver + 'static,
{
    let sanitizer = config.output_sanitizer();
    let output = RunOutput::new(&repo, &sanitizer);
    let workspaces = workspace_manager(&config, &repo_config);
    if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
        return Ok(());
    }
    adopt_legacy_workspace(&repo, &config, &issue, &run, &workspaces).await;
    let workspace = workspaces.create_or_reuse(&issue).await?;
    let env = run_env(&config.env, &repo_config);

    if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
        return Ok(());
    }
    if workspace.needs_init {
        if let Some(script) = &config.workflow.front_matter.hooks.after_create {
            let result = run_hook_with_sanitizer(
                HookInvocation {
                    hook: HookName::AfterCreate,
                    script,
                    issue: &issue,
                    workspace_path: &workspace.path,
                    run_number: run.run_number,
                    timeout_ms: config.workflow.front_matter.hooks.timeout_ms,
                    env: &env,
                    cancel: &stop,
                },
                sanitizer.clone(),
            )
            .await;
            if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
                return Ok(());
            }
            if result.exit_code != 0 {
                fail(
                    &repo,
                    &config,
                    &run,
                    &issue,
                    "after_create_failed",
                    result
                        .stderr_tail
                        .as_deref()
                        .unwrap_or("after_create non-zero"),
                )
                .await?;
                return Ok(());
            }
        }
        if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
            return Ok(());
        }
    }

    ensure_workspace_skills(&workspace.path, &config.skills)
        .await
        .map_err(WorkerError::WorkspaceSkills)?;
    if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
        return Ok(());
    }

    if workspace.needs_init {
        workspaces.mark_ready(&issue).await?;
    }

    match repo.mark_running(&run.id).await {
        Ok(()) => {}
        Err(StorageError::AlreadyRunning(_)) => {
            repo.complete_run(
                &run.id,
                RunCompletion::Cancelled {
                    error_class: Some("reconciled"),
                    error_message: Some("lost race to a concurrent run for the same issue"),
                    suppression: None,
                },
            )
            .await?;
            return Ok(());
        }
        Err(err) => return Err(err.into()),
    }

    if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
        return Ok(());
    }
    if let Some(script) = &config.workflow.front_matter.hooks.before_run {
        let _ = run_hook_with_sanitizer(
            HookInvocation {
                hook: HookName::BeforeRun,
                script,
                issue: &issue,
                workspace_path: &workspace.path,
                run_number: run.run_number,
                timeout_ms: config.workflow.front_matter.hooks.timeout_ms,
                env: &env,
                cancel: &stop,
            },
            sanitizer.clone(),
        )
        .await;
    }

    if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
        return Ok(());
    }
    ensure_workspace_skills(&workspace.path, &config.skills)
        .await
        .map_err(WorkerError::WorkspaceSkills)?;
    if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
        return Ok(());
    }

    let resolved_workflow = resolve_repo_workflow(
        &workspace.path,
        &repo_config.url,
        &config.workflow.prompt_template,
        &config.session_env,
        &stop,
    )
    .await;
    let workflow_message = match resolved_workflow.source {
        crate::RepoWorkflowSource::Repository => format!(
            "Using {}{}",
            resolved_workflow
                .filename
                .as_deref()
                .unwrap_or(crate::WORKFLOW_FILE),
            resolved_workflow
                .revision
                .as_deref()
                .and_then(|revision| revision.get(..8))
                .map(|revision| format!(" from the repository default branch at {revision}"))
                .unwrap_or_default()
        ),
        _ => resolved_workflow
            .detail
            .clone()
            .unwrap_or_else(|| "Using the default workflow.".to_string()),
    };
    output.status(&run.id, &workflow_message).await?;
    let mut prompt = render_prompt(
        &resolved_workflow.prompt_template,
        &issue,
        Some(&repo_config),
    );
    if let Some(prior) = repo.prior_run(&issue.id, &run.id).await? {
        let recent_events = repo
            .recent_events_for_issue(&issue.id, 10)
            .await?
            .into_iter()
            .map(|event| sanitizer.historical_event(&event.kind, &event.payload))
            .collect();
        prompt = sanitizer.retry_prompt(
            &prompt,
            &RetryContext {
                run_number: prior.run_number,
                error_class: prior.error_class,
                error_message: prior.error_message,
                recent_events,
            },
        );
    }

    let backend = config.workflow.front_matter.agent.backend.clone();
    let pre_session = matches!(backend, AgentBackend::Claude).then(|| Uuid::new_v4().to_string());
    if let Some(session) = &pre_session {
        repo.upsert_live_session(
            &run.id,
            &symphony_core::AgentSessionId::new(format!("{session}-{session}")),
            &symphony_core::AgentThreadId::new(session),
            &symphony_core::AgentTurnId::new(session),
            &TokenCountPayload {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
            },
        )
        .await?;
    }

    let (tx, mut rx) = mpsc::channel(256);
    let request = AgentRunRequest {
        backend: backend.clone(),
        command: match backend {
            AgentBackend::Codex => config.workflow.front_matter.codex.command.clone(),
            AgentBackend::Claude => config.workflow.front_matter.claude.command.clone(),
            AgentBackend::Cursor => config.workflow.front_matter.cursor.command.clone(),
            AgentBackend::Opencode => config.workflow.front_matter.opencode.command.clone(),
        },
        cwd: workspace.path.clone(),
        prompt,
        codex_permission_mode: config.workflow.front_matter.codex.permission_mode.clone(),
        thread_sandbox: config.workflow.front_matter.codex.thread_sandbox.clone(),
        turn_sandbox_policy: config
            .workflow
            .front_matter
            .codex
            .turn_sandbox_policy
            .clone(),
        network_access: config.workflow.front_matter.codex.network_access,
        turn_timeout_ms: match backend {
            AgentBackend::Codex => config.workflow.front_matter.codex.turn_timeout_ms,
            AgentBackend::Claude => config.workflow.front_matter.claude.turn_timeout_ms,
            AgentBackend::Cursor => config.workflow.front_matter.cursor.turn_timeout_ms,
            AgentBackend::Opencode => config.workflow.front_matter.opencode.turn_timeout_ms,
        },
        claude: ClaudeRunOptions {
            permission_mode: config.workflow.front_matter.claude.permission_mode.clone(),
            allowed_tools: config.workflow.front_matter.claude.allowed_tools.clone(),
            disallowed_tools: config.workflow.front_matter.claude.disallowed_tools.clone(),
            add_dirs: config.workflow.front_matter.claude.add_dirs.clone(),
            session_id: pre_session,
        },
        cursor: CursorRunOptions {
            mode: config.workflow.front_matter.cursor.mode.clone(),
            force: config.workflow.front_matter.cursor.force,
            trust: config.workflow.front_matter.cursor.trust,
            approve_mcps: config.workflow.front_matter.cursor.approve_mcps,
            sandbox: config.workflow.front_matter.cursor.sandbox.clone(),
            model: config.workflow.front_matter.cursor.model.clone(),
        },
        opencode: OpencodeRunOptions {
            model: config.workflow.front_matter.opencode.model.clone(),
            agent: config.workflow.front_matter.opencode.agent.clone(),
            skip_permissions: config.workflow.front_matter.opencode.skip_permissions,
        },
        env: agent_env(&env, &config.session_env),
    };
    let driver_stop = stop.clone();
    let mut run_fut = Box::pin(driver.run(request, tx, driver_stop));
    let provider = backend.as_source_str();
    let result = loop {
        tokio::select! {
            maybe_event = rx.recv() => {
                if let Some(event) = maybe_event {
                    output.event(&run.id, provider, &event).await?;
                }
            }
            result = &mut run_fut => break result,
        }
    };
    // The select breaks the moment the driver completes, but events it sent
    // just before returning (the final rate-limit signal, the closing token
    // count) may still sit in the channel. The completed driver dropped its
    // sender, so this drain terminates once the queue is empty.
    while let Some(event) = rx.recv().await {
        output.event(&run.id, provider, &event).await?;
    }

    match result {
        Ok(result) => {
            output
                .identity(&run.id, &result.thread_id, &result.turn_id)
                .await?;
            if let Some(script) = &config.workflow.front_matter.hooks.after_run {
                let _ = run_hook_with_sanitizer(
                    HookInvocation {
                        hook: HookName::AfterRun,
                        script,
                        issue: &issue,
                        workspace_path: &workspace.path,
                        run_number: run.run_number,
                        timeout_ms: config.workflow.front_matter.hooks.timeout_ms,
                        env: &env,
                        cancel: &stop,
                    },
                    sanitizer.clone(),
                )
                .await;
            }
            let managed = config.run_cancellations.get(&run.id).await;
            let _lifecycle = match managed.as_ref() {
                Some(managed) => Some(managed.lifecycle.lock().await),
                None => None,
            };
            if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
                return Ok(());
            }
            match result.outcome {
                AgentOutcome::Success => {
                    repo.complete_run(&run.id, RunCompletion::Success).await?;
                }
                AgentOutcome::Cancelled => {
                    output
                        .cancelled(
                            &run.id,
                            result.error_class.as_deref(),
                            result.error_message.as_deref(),
                        )
                        .await?;
                }
                AgentOutcome::Failure => {
                    fail(
                        &repo,
                        &config,
                        &run,
                        &issue,
                        result.error_class.as_deref().unwrap_or("agent_failure"),
                        result
                            .error_message
                            .as_deref()
                            .unwrap_or("agent reported failure"),
                    )
                    .await?;
                }
            }
        }
        Err(err) => {
            let managed = config.run_cancellations.get(&run.id).await;
            let _lifecycle = match managed.as_ref() {
                Some(managed) => Some(managed.lifecycle.lock().await),
                None => None,
            };
            if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
                return Ok(());
            }
            fail(
                &repo,
                &config,
                &run,
                &issue,
                "dispatch_error",
                &err.to_string(),
            )
            .await?;
        }
    }
    Ok(())
}

async fn finish_if_cancelled_for_run(
    repo: &Repository,
    config: &RuntimeConfig,
    run: &RunRow,
    issue: &Issue,
    stop: &CancellationToken,
) -> Result<bool, WorkerError> {
    let cancelled = match config.run_cancellations.get(&run.id).await {
        Some(managed) => {
            let stop_intent = managed.stop_intent.lock().await;
            // Keep the per-run lock through finalization so tracker-result
            // reconciliation cannot race this suppression write.
            finish_if_cancelled_with_suppression(
                repo,
                run,
                issue,
                stop,
                stop_intent.suppression_fingerprint.as_deref(),
            )
            .await
        }
        None => finish_if_cancelled(repo, run, issue, stop, false).await,
    }?;
    Ok(cancelled)
}

async fn finish_if_cancelled(
    repo: &Repository,
    run: &RunRow,
    issue: &Issue,
    stop: &CancellationToken,
    suppress_dispatch: bool,
) -> Result<bool, WorkerError> {
    let fingerprint = suppress_dispatch.then(|| issue_fingerprint(issue));
    finish_if_cancelled_with_suppression(repo, run, issue, stop, fingerprint.as_deref()).await
}

async fn finish_if_cancelled_with_suppression(
    repo: &Repository,
    run: &RunRow,
    _issue: &Issue,
    stop: &CancellationToken,
    suppression_fingerprint: Option<&str>,
) -> Result<bool, WorkerError> {
    if !stop.is_cancelled() {
        return Ok(false);
    }
    repo.complete_run(
        &run.id,
        RunCompletion::Cancelled {
            error_class: Some("cancelled"),
            error_message: Some("run cancelled"),
            suppression: suppression_fingerprint
                .map(|fingerprint| (USER_CANCELLED_SUPPRESSION, fingerprint)),
        },
    )
    .await?;
    Ok(true)
}

fn issue_fingerprint(issue: &Issue) -> String {
    #[derive(Serialize)]
    struct DispatchFingerprint<'a> {
        id: &'a str,
        identifier: &'a str,
        title: &'a str,
        description: &'a Option<String>,
        priority: i16,
        state: &'a str,
        branch: &'a Option<String>,
        labels: &'a [String],
        blockers: &'a [String],
        project_id: &'a Option<String>,
        project_slug_id: &'a Option<String>,
    }

    serde_json::to_string(&DispatchFingerprint {
        id: &issue.id,
        identifier: &issue.identifier,
        title: &issue.title,
        description: &issue.description,
        priority: issue.priority,
        state: &issue.state,
        branch: &issue.branch,
        labels: &issue.labels,
        blockers: &issue.blockers,
        project_id: &issue.project_id,
        project_slug_id: &issue.project_slug_id,
    })
    .expect("issue fingerprint serialization should not fail")
}

async fn fail(
    repo: &Repository,
    config: &RuntimeConfig,
    run: &RunRow,
    _issue: &Issue,
    class: &str,
    message: &str,
) -> Result<(), WorkerError> {
    let due = due_after(backoff_ms(
        run.run_number,
        config.workflow.front_matter.agent.max_retry_backoff_ms,
    ));
    RunOutput::new(repo, &config.output_sanitizer())
        .failure(&run.id, &due, class, message)
        .await?;
    Ok(())
}

/// Workspaces created before multi-repo support lived at `<root>/<issue>`,
/// without the repo segment. A retry queued across that upgrade expects the
/// prior attempt's checkout (branch state, workpad, uncommitted work), so
/// when the namespaced directory does not exist yet and the previous run was
/// pre-multi-repo (no repo recorded) and left a ready workspace directly
/// under the root, move it into the new namespace instead of letting
/// `create_or_reuse` initialize a fresh clone. Strictly an upgrade path:
/// directories under another repo's namespace are never adopted, since they
/// hold a clone of a different repository. Best effort — on any mismatch or
/// rename failure the run falls back to a fresh workspace.
async fn adopt_legacy_workspace(
    repo: &Repository,
    config: &RuntimeConfig,
    issue: &Issue,
    run: &RunRow,
    workspaces: &WorkspaceManager,
) {
    let Ok(new_path) = workspaces.path_for(&issue.identifier) else {
        return;
    };
    if tokio::fs::metadata(&new_path).await.is_ok() {
        return;
    }
    let Ok(Some(prior)) = repo.prior_run(&issue.id, &run.id).await else {
        return;
    };
    if prior.repo_name.is_some() {
        return;
    }
    let old_path = PathBuf::from(&prior.workspace_path);
    if old_path.parent() != Some(workspace_root(config).as_path()) {
        return;
    }
    if tokio::fs::metadata(old_path.join(crate::WORKSPACE_READY_SENTINEL))
        .await
        .is_err()
    {
        return;
    }
    if let Some(parent) = new_path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    match tokio::fs::rename(&old_path, &new_path).await {
        Ok(()) => tracing::info!(
            issue = %issue.identifier,
            from = %old_path.display(),
            to = %new_path.display(),
            "adopted pre-multi-repo workspace"
        ),
        Err(err) => warn!(
            issue = %issue.identifier,
            error = %err,
            "could not adopt pre-multi-repo workspace; initializing a fresh one"
        ),
    }
}

/// Per-issue workspaces are namespaced by repo (`<root>/<repo>/<issue>`), so
/// a routing change can never point an issue's retries at a directory holding
/// a clone of a different repository.
fn workspace_manager(config: &RuntimeConfig, repo: &RepoConfig) -> WorkspaceManager {
    let root = workspace_root(config);
    let repo_name = repo.name.trim();
    let root = root.join(sanitize_key(repo_name));
    match &config.workspace_cleanup {
        Some(cleanup) => WorkspaceManager::with_cleanup(root, repo_name, cleanup.clone()),
        None => WorkspaceManager::new(root),
    }
}

fn workspace_root(config: &RuntimeConfig) -> PathBuf {
    crate::resolve_workspace_root_dir(
        &config.workflow.front_matter.workspace.root,
        &config.app_data_dir,
    )
}

/// The hook environment for one run: the shared env plus the routed repo's
/// coordinates. The default after_create hook consumes REPO_URL and
/// SYMPHONY_INSTALL_CMD; REPO_NAME lets custom hooks branch per repo.
fn run_env(base: &BTreeMap<String, String>, repo: &RepoConfig) -> BTreeMap<String, String> {
    let mut env = base.clone();
    env.insert("REPO_URL".to_string(), repo.url.clone());
    env.insert("REPO_NAME".to_string(), repo.name.clone());
    if let Some(cmd) = repo
        .install_cmd
        .as_deref()
        .map(str::trim)
        .filter(|cmd| !cmd.is_empty())
    {
        env.insert("SYMPHONY_INSTALL_CMD".to_string(), cmd.to_string());
    }
    env
}

fn due_after(ms: u64) -> String {
    (chrono::Utc::now() + chrono::Duration::milliseconds(ms as i64))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Environment injected into agent processes. Agents inherit the app's env;
/// this adds what lives outside it: the Linear key (from the OS keychain),
/// the routed repo's coordinates, and custom session env from settings.
/// Takes the per-run env (`run_env`), which carries the runtime values.
fn agent_env(
    env: &BTreeMap<String, String>,
    session_env: &BTreeMap<String, String>,
) -> Vec<(String, String)> {
    let mut injected = [
        "LINEAR_API_KEY",
        "REPO_URL",
        "REPO_NAME",
        "SYMPHONY_INSTALL_CMD",
    ]
    .iter()
    .filter_map(|key| {
        env.get(*key)
            .filter(|value| !value.trim().is_empty())
            .map(|value| (key.to_string(), value.clone()))
    })
    .collect::<BTreeMap<_, _>>();
    if let Some(repo_url) = env.get("REPO_URL").map(String::as_str) {
        if !github_token_env_has_token_for_repo_url(repo_url, session_env) {
            for key in github_token_env_vars_for_repo_url(repo_url) {
                if let Some(value) = env.get(*key).filter(|value| !value.trim().is_empty()) {
                    injected.insert((*key).to_string(), value.clone());
                }
            }
        }
    }
    injected.extend(
        session_env
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    injected.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use symphony_core::MappedAgentEvent;
    use symphony_tracker::StaticTracker;

    fn test_running_worker(
        runtime_config: SharedRuntimeConfig,
        stop: CancellationToken,
    ) -> WorkerLifecycle {
        WorkerLifecycle::Running(OwnedWorker {
            generation: 0,
            started_at: now_iso(),
            stop,
            runtime_config,
            output_credentials: Arc::new(std::sync::Mutex::new(OutputSanitizer::default())),
            _supervisor: tokio::spawn(async {}),
        })
    }

    fn runtime_config(root: &std::path::Path) -> RuntimeConfig {
        let front_matter = symphony_core::WorkflowFrontMatter {
            tracker: symphony_core::TrackerConfig {
                api_key: "test-key".to_string(),
                active_states: vec!["Todo".to_string(), "In Progress".to_string()],
                terminal_states: vec!["Done".to_string()],
                ..Default::default()
            },
            workspace: symphony_core::WorkspaceConfig {
                root: root.display().to_string(),
            },
            ..Default::default()
        };
        RuntimeConfig {
            settings_revision: 0,
            workflow: symphony_core::build_parsed_workflow(
                front_matter,
                "Prompt {{issue.identifier}}".to_string(),
            ),
            repos: vec![RepoConfig {
                name: "widgets".to_string(),
                url: "git@github.com:acme/widgets.git".to_string(),
                is_default: true,
                ..RepoConfig::default()
            }],
            skills: Vec::new(),
            env: BTreeMap::new(),
            session_env: BTreeMap::new(),
            app_data_dir: root.to_path_buf(),
            run_cancellations: RunCancellationRegistry::default(),
            wake: Arc::new(Notify::new()),
            workspace_cleanup: None,
            workspace_claims: WorkspaceClaims::default(),
            run_tasks: RunTasks::default(),
        }
    }

    fn start_config(config: RuntimeConfig) -> WorkerStartConfig {
        WorkerStartConfig {
            runtime: symphony_core::RunnableConfig::new(
                config.settings_revision,
                config.workflow,
                config.repos,
                config.session_env,
            )
            .unwrap(),
            skills: config.skills,
            env: config.env,
            app_data_dir: config.app_data_dir,
        }
    }

    fn issue(state: &str, blockers: Vec<String>) -> Issue {
        Issue {
            id: "lin-1".to_string(),
            identifier: "SYM-1".to_string(),
            title: "Test".to_string(),
            description: None,
            priority: 1,
            state: state.to_string(),
            branch: None,
            labels: vec![],
            blockers,
            completed_at: None,
            canceled_at: None,
            project_id: None,
            project_slug_id: None,
        }
    }

    struct StateMovingTracker {
        moved: Arc<Mutex<Vec<(String, String)>>>,
        fail: bool,
        expected_cancelled: CancellationToken,
    }

    struct RetryReactivatingTracker {
        current: Arc<Mutex<Issue>>,
        moved: Arc<Mutex<Vec<(String, String)>>>,
    }

    #[async_trait::async_trait]
    impl TrackerClient for RetryReactivatingTracker {
        async fn preflight(&self) -> Result<(), TrackerError> {
            Ok(())
        }

        async fn fetch_active(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
        }

        async fn fetch_terminal(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
        }

        async fn fetch_by_id(&self, id: &str) -> Result<Option<Issue>, TrackerError> {
            let current = self.current.lock().await;
            Ok((current.id == id).then(|| current.clone()))
        }

        async fn fetch_by_id_for_dispatch(&self, id: &str) -> Result<Option<Issue>, TrackerError> {
            let current = self.current.lock().await;
            Ok((current.id == id).then(|| current.clone()))
        }

        async fn fetch_workpads(
            &self,
            _issue_ids: &[String],
        ) -> Result<Vec<symphony_tracker::WorkpadComment>, TrackerError> {
            Ok(Vec::new())
        }

        async fn set_issue_state_by_name(
            &self,
            issue_id: &str,
            state_name: &str,
        ) -> Result<(), TrackerError> {
            self.moved
                .lock()
                .await
                .push((issue_id.to_string(), state_name.to_string()));
            self.current.lock().await.state = state_name.to_lowercase();
            Ok(())
        }
    }

    #[async_trait::async_trait]
    impl TrackerClient for StateMovingTracker {
        async fn preflight(&self) -> Result<(), TrackerError> {
            Ok(())
        }

        async fn fetch_active(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
        }

        async fn fetch_terminal(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
        }

        async fn fetch_by_id(&self, _id: &str) -> Result<Option<Issue>, TrackerError> {
            Ok(None)
        }

        async fn fetch_workpads(
            &self,
            _issue_ids: &[String],
        ) -> Result<Vec<symphony_tracker::WorkpadComment>, TrackerError> {
            Ok(Vec::new())
        }

        async fn set_issue_state_by_name(
            &self,
            issue_id: &str,
            state_name: &str,
        ) -> Result<(), TrackerError> {
            assert!(self.expected_cancelled.is_cancelled());
            if self.fail {
                return Err(TrackerError::Invalid("state move failed".to_string()));
            }
            self.moved
                .lock()
                .await
                .push((issue_id.to_string(), state_name.to_string()));
            Ok(())
        }
    }

    struct DispatchFilteringTracker {
        by_id: Option<Issue>,
        by_id_for_dispatch: Option<Issue>,
    }

    #[derive(Clone)]
    struct CountingTerminalTracker {
        terminal: Vec<Issue>,
        terminal_fetches: Arc<AtomicUsize>,
        by_id_fetches: Arc<AtomicUsize>,
    }

    struct FailingTerminalTracker;

    struct BlockingTerminalTracker {
        terminal: Vec<Issue>,
        entered: Arc<Notify>,
        release: Arc<Notify>,
    }

    #[async_trait::async_trait]
    impl TrackerClient for CountingTerminalTracker {
        async fn preflight(&self) -> Result<(), TrackerError> {
            Ok(())
        }

        async fn fetch_active(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
        }

        async fn fetch_terminal(&self) -> Result<Vec<Issue>, TrackerError> {
            self.terminal_fetches.fetch_add(1, Ordering::SeqCst);
            Ok(self.terminal.clone())
        }

        async fn fetch_by_id(&self, _id: &str) -> Result<Option<Issue>, TrackerError> {
            self.by_id_fetches.fetch_add(1, Ordering::SeqCst);
            Ok(self.terminal.first().cloned())
        }

        async fn fetch_workpads(
            &self,
            _issue_ids: &[String],
        ) -> Result<Vec<symphony_tracker::WorkpadComment>, TrackerError> {
            Ok(Vec::new())
        }
    }

    #[async_trait::async_trait]
    impl TrackerClient for FailingTerminalTracker {
        async fn preflight(&self) -> Result<(), TrackerError> {
            Ok(())
        }

        async fn fetch_active(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
        }

        async fn fetch_terminal(&self) -> Result<Vec<Issue>, TrackerError> {
            Err(TrackerError::Invalid("terminal fetch failed".to_string()))
        }

        async fn fetch_by_id(&self, _id: &str) -> Result<Option<Issue>, TrackerError> {
            Ok(None)
        }

        async fn fetch_workpads(
            &self,
            _issue_ids: &[String],
        ) -> Result<Vec<symphony_tracker::WorkpadComment>, TrackerError> {
            Ok(Vec::new())
        }
    }

    #[async_trait::async_trait]
    impl TrackerClient for BlockingTerminalTracker {
        async fn preflight(&self) -> Result<(), TrackerError> {
            Ok(())
        }

        async fn fetch_active(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
        }

        async fn fetch_terminal(&self) -> Result<Vec<Issue>, TrackerError> {
            self.entered.notify_one();
            self.release.notified().await;
            Ok(self.terminal.clone())
        }

        async fn fetch_by_id(&self, _id: &str) -> Result<Option<Issue>, TrackerError> {
            Ok(None)
        }

        async fn fetch_workpads(
            &self,
            _issue_ids: &[String],
        ) -> Result<Vec<symphony_tracker::WorkpadComment>, TrackerError> {
            Ok(Vec::new())
        }
    }

    #[async_trait::async_trait]
    impl TrackerClient for DispatchFilteringTracker {
        async fn preflight(&self) -> Result<(), TrackerError> {
            Ok(())
        }

        async fn fetch_active(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
        }

        async fn fetch_terminal(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
        }

        async fn fetch_by_id(&self, id: &str) -> Result<Option<Issue>, TrackerError> {
            Ok(self.by_id.as_ref().filter(|issue| issue.id == id).cloned())
        }

        async fn fetch_by_id_for_dispatch(&self, id: &str) -> Result<Option<Issue>, TrackerError> {
            Ok(self
                .by_id_for_dispatch
                .as_ref()
                .filter(|issue| issue.id == id)
                .cloned())
        }

        async fn fetch_workpads(
            &self,
            _issue_ids: &[String],
        ) -> Result<Vec<symphony_tracker::WorkpadComment>, TrackerError> {
            Ok(Vec::new())
        }
    }

    fn mock_driver(outcome: AgentOutcome) -> symphony_agents::MockAgentDriver {
        let failed = outcome == AgentOutcome::Failure;
        symphony_agents::MockAgentDriver {
            result: symphony_agents::AgentRunResult {
                thread_id: "thread-test".to_string(),
                turn_id: "turn-test".to_string(),
                outcome,
                error_class: failed.then(|| "agent_failure".to_string()),
                error_message: failed.then(|| "agent reported failure".to_string()),
            },
            events: vec![],
        }
    }

    #[tokio::test]
    async fn persists_token_event_once_and_keeps_counts_after_final_identity_update() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        repo.upsert_issues(&[issue("todo", vec![])]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        repo.mark_running(&run.id).await.unwrap();
        let mut storage_events = repo.events().subscribe();

        RunOutput::new(&repo, &OutputSanitizer::default())
            .event(
                &run.id,
                "codex",
                &MappedAgentEvent::Visible {
                    kind: symphony_core::AgentEventKind::TokenCount,
                    payload: serde_json::json!({
                        "input_tokens": 120,
                        "output_tokens": 34,
                        "total_tokens": 154,
                    }),
                    humanized: None,
                    metadata: symphony_core::AgentEventMetadata {
                        tokens: Some(TokenCountPayload {
                            input_tokens: 120,
                            output_tokens: 34,
                            total_tokens: 154,
                        }),
                        rate_limit: None,
                        session_info: None,
                    },
                },
            )
            .await
            .unwrap();

        let mut live_session_upserts = 0;
        let mut token_usage_upserts = 0;
        while let Ok(event) = storage_events.try_recv() {
            if let symphony_storage::StorageEvent::DbChanged { table, op } = event {
                if table == "live_sessions" && op == "upsert" {
                    live_session_upserts += 1;
                }
                if table == "token_usage" && op == "upsert" {
                    token_usage_upserts += 1;
                }
            }
        }
        assert_eq!(live_session_upserts, 1);
        assert_eq!(token_usage_upserts, 1);

        let session = repo
            .overview()
            .await
            .unwrap()
            .live_sessions
            .into_iter()
            .find(|session| session.run_id == run.id)
            .unwrap();
        assert_eq!(session.input_tokens, 120);
        assert_eq!(session.output_tokens, 34);
        assert_eq!(session.total_tokens, 154);
        assert!(!session.last_event_at.is_empty());

        repo.upsert_live_session(
            &run.id,
            &symphony_core::AgentSessionId::new("final-session"),
            &symphony_core::AgentThreadId::new("thread-1"),
            &symphony_core::AgentTurnId::new("turn-1"),
            &TokenCountPayload {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
            },
        )
        .await
        .unwrap();
        let session = repo
            .overview()
            .await
            .unwrap()
            .live_sessions
            .into_iter()
            .find(|session| session.run_id == run.id)
            .unwrap();
        assert_eq!(session.session_id, "final-session");
        assert_eq!(session.thread_id, "thread-1");
        assert_eq!(session.turn_id, "turn-1");
        assert_eq!(session.input_tokens, 120);
        assert_eq!(session.output_tokens, 34);
        assert_eq!(session.total_tokens, 154);

        let usage = repo.overview().await.unwrap().token_usage;
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].source, "codex");
        assert_eq!(usage[0].input_tokens, 120);
        assert_eq!(usage[0].output_tokens, 34);
        assert_eq!(usage[0].total_tokens, 154);
        assert_eq!(usage[0].run_count, 1);
    }

    const TRACKER_CANARY: &str = "synthetic-tracker-canary";
    const ENV_CANARY: &str = "synthetic-inherited-canary";
    const SESSION_CANARY: &str = "synthetic-session-\"\n界-canary";

    fn canary_config(root: &std::path::Path) -> RuntimeConfig {
        let mut config = runtime_config(root);
        config.workflow.front_matter.tracker.api_key = TRACKER_CANARY.into();
        config.env.insert("GH_TOKEN".into(), ENV_CANARY.into());
        config
            .session_env
            .insert("CUSTOM_VALUE".into(), SESSION_CANARY.into());
        config.repos[0].url = root.join("missing-local-repository").display().to_string();
        config
    }

    fn assert_no_canaries(value: &str) {
        for secret in [TRACKER_CANARY, ENV_CANARY, SESSION_CANARY] {
            assert!(!value.contains(secret), "raw canary leaked");
            let escaped = serde_json::to_string(secret).unwrap();
            assert!(
                !value.contains(&escaped[1..escaped.len() - 1]),
                "JSON-escaped canary leaked"
            );
        }
    }

    #[tokio::test]
    async fn output_boundary_redacts_durable_events_metadata_errors_and_ui_reads() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = canary_config(temp.path());
        let sanitizer = config.output_sanitizer();
        let output = RunOutput::new(&repo, &sanitizer);
        assert_no_canaries(&format!("{:?} {:?}", config, start_config(config.clone())));
        assert_no_canaries(&format!(
            "{:?}",
            crate::SkillsInstallConfig {
                repo_url: TRACKER_CANARY.into(),
                workspace_root: temp.path().into(),
                workflow: config.workflow.clone(),
                skills: vec![],
                env: config.env.clone(),
                session_env: config.session_env.clone(),
            }
        ));
        assert_no_canaries(&format!(
            "{:?}",
            crate::WorkflowTransferConfig {
                repo_url: TRACKER_CANARY.into(),
                prompt_template: SESSION_CANARY.into(),
                workspace_root: temp.path().into(),
                env: config.env.clone(),
                session_env: config.session_env.clone(),
            }
        ));
        repo.upsert_issues(&[issue("todo", vec![])]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        let mut updates = repo.events().subscribe();
        let combined = format!("{TRACKER_CANARY} {ENV_CANARY} {SESSION_CANARY}");
        output.event(&run.id, "codex", &MappedAgentEvent::Visible {
            kind: symphony_core::AgentEventKind::ToolCall,
            payload: serde_json::json!({"args": {"output": combined, "authorization": "unknown-canary"}, "input_tokens": 12}),
            humanized: Some(combined.clone()),
            metadata: symphony_core::AgentEventMetadata { tokens: Some(TokenCountPayload { input_tokens: 12, output_tokens: 3, total_tokens: 15 }),
            rate_limit: Some(symphony_core::RateLimitPayload { source: ENV_CANARY.into(), remaining: Some(0), reset_at: Some(SESSION_CANARY.into()) }),
            session_info: Some(symphony_core::SessionInfoPayload { model: Some(TRACKER_CANARY.into()), agent_version: Some(SESSION_CANARY.into()), ..Default::default() }),
        }, }).await.unwrap();
        output
            .identity(&run.id, TRACKER_CANARY, SESSION_CANARY)
            .await
            .unwrap();
        output.status(&run.id, &combined).await.unwrap();
        // Identity must already be safe while the run is live, before atomic
        // completion removes it from overview.
        assert_no_canaries(&serde_json::to_string(&repo.overview().await.unwrap()).unwrap());
        output
            .failure(
                &run.id,
                "2099-01-01T00:00:00Z",
                SESSION_CANARY,
                &format!("{combined}{}", "界".repeat(10_000)),
            )
            .await
            .unwrap();
        let ui = serde_json::to_string(&repo.get_run_detail(&run.id).await.unwrap()).unwrap();
        assert_no_canaries(&ui);
        assert!(!ui.contains("unknown-canary"));
        assert!(ui.contains("[REDACTED]"));
        assert_no_canaries(&serde_json::to_string(&repo.overview().await.unwrap()).unwrap());
        assert_no_canaries(
            &serde_json::to_string(&repo.due_retries("9999-01-01T00:00:00Z").await.unwrap())
                .unwrap(),
        );
        let row = repo.get_run(&run.id).await.unwrap().unwrap();
        assert!(row.error_message.unwrap().len() <= crate::output::ERROR_LIMIT);
        while let Ok(event) = updates.try_recv() {
            assert_no_canaries(&serde_json::to_string(&event).unwrap());
        }
    }

    #[tokio::test]
    async fn metadata_only_output_is_sanitized_without_visible_timeline_rows() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::new(
            symphony_storage::open_sqlite(temp.path().join("metadata.sqlite"))
                .await
                .unwrap(),
            symphony_storage::EventBus::default(),
        );
        repo.upsert_issues(&[issue("todo", vec![])]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        let sanitizer = OutputSanitizer::new("metadata-secret", &BTreeMap::new(), &BTreeMap::new());
        RunOutput::new(&repo, &sanitizer)
            .event(
                &run.id,
                "codex",
                &MappedAgentEvent::Metadata {
                    metadata: symphony_core::AgentEventMetadata {
                        tokens: Some(TokenCountPayload {
                            input_tokens: 1,
                            output_tokens: 2,
                            total_tokens: 3,
                        }),
                        session_info: Some(symphony_core::SessionInfoPayload {
                            model: Some("metadata-secret".into()),
                            ..Default::default()
                        }),
                        rate_limit: Some(symphony_core::RateLimitPayload {
                            source: "codex_primary".into(),
                            remaining: Some(0),
                            reset_at: Some("2099-01-01T01:00:00+01:00".into()),
                        }),
                    },
                },
            )
            .await
            .unwrap();
        let (row, events) = repo.get_run_detail(&run.id).await.unwrap().unwrap();
        assert!(events.is_empty());
        assert_eq!(
            row.session_info.unwrap().model.as_deref(),
            Some("[REDACTED]")
        );
        let overview = repo.overview().await.unwrap();
        assert_eq!(overview.live_sessions[0].total_tokens, 3);
        assert_eq!(overview.rate_limits[0].source, "codex_primary");
        assert_eq!(
            overview.rate_limits[0].reset_at.as_deref(),
            Some("2099-01-01T00:00:00.000Z")
        );
    }

    fn rate_limit_event(source: &str, reset_at: &str) -> MappedAgentEvent {
        let limit = symphony_core::RateLimitPayload {
            source: source.into(),
            remaining: Some(0),
            reset_at: Some(reset_at.into()),
        };
        MappedAgentEvent::Visible {
            kind: symphony_core::AgentEventKind::RateLimit,
            payload: serde_json::to_value(&limit).unwrap(),
            humanized: Some(format!("{source} resets at {reset_at}")),
            metadata: symphony_core::AgentEventMetadata {
                tokens: None,
                rate_limit: Some(limit),
                session_info: None,
            },
        }
    }

    #[tokio::test]
    async fn output_preserves_quota_identity_and_expiry_despite_session_value_overlap() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::new(
            symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
                .await
                .unwrap(),
            symphony_storage::EventBus::default(),
        );
        let mut config = runtime_config(temp.path());
        config.session_env = BTreeMap::from([
            ("AGENT".into(), "codex".into()),
            ("YEAR".into(), "2026".into()),
            ("BUCKET".into(), "primary".into()),
        ]);
        let sanitizer = config.output_sanitizer();
        let output = RunOutput::new(&repo, &sanitizer);
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let run = repo
            .try_reserve_run(&ready.id, 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        for source in ["codex", "codex_primary", "codex_secondary"] {
            output
                .event(
                    &run.id,
                    "codex",
                    &rate_limit_event(source, "2026-12-01T00:00:00.000Z"),
                )
                .await
                .unwrap();
        }
        let overview = repo.overview().await.unwrap();
        assert_eq!(overview.rate_limits.len(), 3);
        for (row, expected_source) in
            overview
                .rate_limits
                .iter()
                .zip(["codex", "codex_primary", "codex_secondary"])
        {
            assert_eq!(row.source, expected_source);
            assert_eq!(row.reset_at.as_deref(), Some("2026-12-01T00:00:00.000Z"));
        }
        let detail = repo.get_run_detail(&run.id).await.unwrap().unwrap();
        for event in detail.1 {
            assert!(!event.payload.to_string().contains("codex"));
            assert!(!event.payload.to_string().contains("2026"));
            assert!(event.payload.to_string().contains("[REDACTED]"));
        }
        // Both polling paths consume this provider predicate through Admission.
        // Drive the clock explicitly so expiry is tested without wall-clock sleeps.
        for (at, paused) in [
            ("2026-11-30T23:59:59.999Z", true),
            ("2026-12-01T00:00:00.000Z", false),
            ("2026-12-01T00:00:00.001Z", false),
        ] {
            let rate_limited = provider_rate_limited_at(&repo, &config, at).await.unwrap();
            assert_eq!(rate_limited, paused);
            for mode in [DispatchMode::Active, DispatchMode::Retry { run_number: 2 }] {
                let decision = dispatch_policy::decide(EligibilityFacts {
                    issue: Some(&ready),
                    repos: &config.repos,
                    active_states: &config.workflow.front_matter.tracker.active_states,
                    mode,
                    has_active_run: false,
                    retry_queued: false,
                    suppression_matches: false,
                    admission: Admission {
                        active_runs: 0,
                        max_concurrent: 1,
                        rate_limited,
                    },
                });
                if paused {
                    assert!(matches!(
                        decision,
                        EligibilityDecision::Skip(dispatch_policy::SkipReason::RateLimited)
                    ));
                } else {
                    assert!(matches!(decision, EligibilityDecision::Dispatch(_)));
                }
            }
        }
    }

    #[tokio::test]
    async fn output_canonicalizes_untrusted_quota_buckets_and_timestamps_without_leaking() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::new(
            symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
                .await
                .unwrap(),
            symphony_storage::EventBus::default(),
        );
        let config = canary_config(temp.path());
        let sanitizer = config.output_sanitizer();
        let output = RunOutput::new(&repo, &sanitizer);
        repo.upsert_issues(&[issue("todo", vec![])]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        let mut updates = repo.events().subscribe();
        let unknown = format!("codex_{SESSION_CANARY}");
        for source in [&unknown, &unknown, &format!("codex_{ENV_CANARY}")] {
            output
                .event(
                    &run.id,
                    "codex",
                    &rate_limit_event(source, "2026-12-01T04:00:00+04:00"),
                )
                .await
                .unwrap();
        }
        let overview = repo.overview().await.unwrap();
        // Repeated unknown bucket updates the same row; distinct buckets cannot
        // clear one another's quota and still belong to the emitting provider.
        assert_eq!(overview.rate_limits.len(), 2);
        for row in &overview.rate_limits {
            assert!(row.source.starts_with("codex_bucket_"));
            assert_eq!(row.source.len(), "codex_bucket_".len() + 64);
            assert_eq!(row.reset_at.as_deref(), Some("2026-12-01T00:00:00.000Z"));
        }
        assert!(
            provider_rate_limited_at(&repo, &config, "2026-11-30T23:59:59.999Z")
                .await
                .unwrap()
        );
        assert!(
            !provider_rate_limited_at(&repo, &config, "2026-12-01T00:00:00.000Z")
                .await
                .unwrap()
        );
        output
            .event(
                &run.id,
                "codex",
                &rate_limit_event("codex_primary", SESSION_CANARY),
            )
            .await
            .unwrap();
        // A foreign source cannot create quota metadata for another provider.
        output
            .event(
                &run.id,
                "codex",
                &rate_limit_event("claude", "2026-12-01T00:00:00.000Z"),
            )
            .await
            .unwrap();
        let overview = repo.overview().await.unwrap();
        assert_eq!(overview.rate_limits.len(), 3);
        assert!(overview
            .rate_limits
            .iter()
            .find(|row| row.source == "codex_primary")
            .unwrap()
            .reset_at
            .is_none());
        assert_no_canaries(&serde_json::to_string(&overview).unwrap());
        assert_no_canaries(
            &serde_json::to_string(&repo.get_run_detail(&run.id).await.unwrap()).unwrap(),
        );
        while let Ok(event) = updates.try_recv() {
            assert_no_canaries(&serde_json::to_string(&event).unwrap());
        }
    }

    struct PromptCaptureDriver {
        captured: Arc<Mutex<Option<String>>>,
    }

    #[async_trait::async_trait]
    impl AgentDriver for PromptCaptureDriver {
        async fn run(
            &self,
            request: AgentRunRequest,
            _events: symphony_agents::AgentEventSender,
            _cancel: CancellationToken,
        ) -> Result<symphony_agents::AgentRunResult, symphony_agents::AgentError> {
            *self.captured.lock().await = Some(request.prompt);
            Ok(symphony_agents::AgentRunResult {
                thread_id: TRACKER_CANARY.into(),
                turn_id: SESSION_CANARY.into(),
                outcome: AgentOutcome::Failure,
                error_class: Some(ENV_CANARY.into()),
                error_message: Some(SESSION_CANARY.into()),
            })
        }
    }

    #[tokio::test]
    async fn dispatch_redacts_legacy_retry_context_and_provider_terminal_output() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = canary_config(temp.path());
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let prior = repo
            .try_reserve_run(&ready.id, 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        // A historical row written before this boundary existed. This test
        // deliberately does not claim migration of the historical database.
        repo.finish_run(
            &prior.id,
            RunStatus::Failure,
            Some(TRACKER_CANARY),
            Some(SESSION_CANARY),
        )
        .await
        .unwrap();
        repo.append_event(
            &prior.id,
            symphony_core::AgentEventKind::Status,
            &serde_json::json!({"output": SESSION_CANARY, "message": ENV_CANARY}),
        )
        .await
        .unwrap();
        let run = repo
            .try_reserve_run(&ready.id, 2, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        let captured = Arc::new(Mutex::new(None));
        dispatch_run_with_driver(
            repo.clone(),
            config.clone(),
            ready,
            config.repos[0].clone(),
            run.clone(),
            CancellationToken::new(),
            PromptCaptureDriver {
                captured: captured.clone(),
            },
        )
        .await
        .unwrap();
        let prompt = captured.lock().await.clone().unwrap();
        assert_no_canaries(&prompt);
        assert!(prompt.contains("[REDACTED]"));
        assert_no_canaries(
            &serde_json::to_string(&repo.get_run_detail(&run.id).await.unwrap()).unwrap(),
        );
        assert_no_canaries(
            &serde_json::to_string(&repo.due_retries("9999-01-01T00:00:00Z").await.unwrap())
                .unwrap(),
        );
    }

    #[tokio::test]
    async fn hook_failures_and_stranded_run_recovery_share_output_redaction() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let mut config = canary_config(temp.path());
        config.workflow.front_matter.hooks.after_create =
            Some("printf '%s' \"$GH_TOKEN\" >&2; exit 1".into());
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let run = repo
            .try_reserve_run(&ready.id, 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        dispatch_run_with_driver(
            repo.clone(),
            config.clone(),
            ready.clone(),
            config.repos[0].clone(),
            run.clone(),
            CancellationToken::new(),
            mock_driver(AgentOutcome::Success),
        )
        .await
        .unwrap();
        let row = repo.get_run(&run.id).await.unwrap().unwrap();
        assert_eq!(row.error_class.as_deref(), Some("after_create_failed"));
        assert_eq!(row.error_message.as_deref(), Some("[REDACTED]"));
        let stranded = repo
            .try_reserve_run(&ready.id, 2, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        handle_dispatch_result(
            Ok(Err(WorkerError::WorkspaceSkills(std::io::Error::other(
                SESSION_CANARY,
            )))),
            &repo,
            &ready.id,
            &stranded,
            60_000,
            &config.output_sanitizer(),
        )
        .await;
        assert_no_canaries(
            &serde_json::to_string(&repo.get_run_detail(&stranded.id).await.unwrap()).unwrap(),
        );
        assert_no_canaries(
            &serde_json::to_string(&repo.due_retries("9999-01-01T00:00:00Z").await.unwrap())
                .unwrap(),
        );
        let cancelled = repo
            .try_reserve_run(&ready.id, 3, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        RunOutput::new(&repo, &config.output_sanitizer())
            .cancelled(&cancelled.id, Some(TRACKER_CANARY), Some(ENV_CANARY))
            .await
            .unwrap();
        assert_no_canaries(
            &serde_json::to_string(&repo.get_run_detail(&cancelled.id).await.unwrap()).unwrap(),
        );
    }

    #[tokio::test]
    async fn hook_redacts_session_credential_before_the_stderr_tail_cutoff() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let mut config = canary_config(temp.path());
        let secret = format!("synthetic-session-{}", "秘密".repeat(1000));
        config
            .session_env
            .insert("CUSTOM_VALUE".into(), secret.clone());
        // The hook need not receive a variable to echo it: output can come
        // from files/tool results. Its capture still uses the run's full set.
        config.workflow.front_matter.hooks.after_create =
            Some(format!("printf '%s' '{secret}' >&2; exit 1"));
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let run = repo
            .try_reserve_run(&ready.id, 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        dispatch_run_with_driver(
            repo.clone(),
            config.clone(),
            ready,
            config.repos[0].clone(),
            run.clone(),
            CancellationToken::new(),
            mock_driver(AgentOutcome::Success),
        )
        .await
        .unwrap();
        let row = repo.get_run(&run.id).await.unwrap().unwrap();
        assert_eq!(row.error_message.as_deref(), Some("[REDACTED]"));
        assert!(
            !serde_json::to_string(&repo.get_run_detail(&run.id).await.unwrap())
                .unwrap()
                .contains("秘密")
        );
    }

    #[tokio::test]
    async fn supervisor_redacts_credentials_from_intermediate_reconfigurations() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let manager = WorkerManager::new(repo);
        let config = canary_config(temp.path());
        let release = Arc::new(Notify::new());
        let worker_release = release.clone();
        manager
            .start_with_runner(start_config(config.clone()), move |_, _, _| async move {
                worker_release.notified().await;
                Err(WorkerError::WorkspaceSkills(std::io::Error::other(
                    "synthetic-intermediate-key",
                )))
            })
            .await
            .unwrap();
        let mut changed = config.clone();
        changed
            .session_env
            .insert("ROTATED_KEY".into(), "synthetic-intermediate-key".into());
        manager
            .reconfigure_with_tracker_preflight(start_config(changed), |_| async { Ok(()) })
            .await;
        manager
            .reconfigure_with_tracker_preflight(start_config(config), |_| async { Ok(()) })
            .await;
        release.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let status = manager.status().await;
                if status.state == WorkerState::Stopped {
                    assert!(!status
                        .last_error
                        .as_deref()
                        .unwrap()
                        .contains("synthetic-intermediate-key"));
                    assert!(status.last_error.unwrap().contains("[REDACTED]"));
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    async fn wait_for_path(path: &std::path::Path) {
        for _ in 0..500 {
            if tokio::fs::metadata(path).await.is_ok() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {}", path.display());
    }

    #[tokio::test]
    async fn rescues_a_run_stranded_by_a_dispatch_error() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());

        // A run reserved and marked running, then abandoned mid-flight: exactly
        // the state a dispatch_run early-return via `?` leaves behind.
        repo.upsert_issues(&[issue("todo", vec![])]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        repo.mark_running(&run.id).await.unwrap();
        // A live session like the Claude pre-session dispatch_run creates; its
        // normal cleanup is skipped on the error path.
        repo.upsert_live_session(
            &run.id,
            &symphony_core::AgentSessionId::new("sess-sess"),
            &symphony_core::AgentThreadId::new("sess"),
            &symphony_core::AgentTurnId::new("sess"),
            &symphony_core::TokenCountPayload {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
            },
        )
        .await
        .unwrap();

        recover_stranded_run(
            &repo,
            "lin-1",
            &run,
            60_000,
            "dispatch_error",
            &WorkerError::AlreadyRunning.to_string(),
            &OutputSanitizer::default(),
        )
        .await;

        // The row is now terminal and a retry is queued, freeing its slot.
        assert_eq!(
            repo.get_run(&run.id)
                .await
                .unwrap()
                .unwrap()
                .status
                .as_str(),
            "failure"
        );
        assert_eq!(
            repo.get_run(&run.id)
                .await
                .unwrap()
                .unwrap()
                .error_class
                .as_deref(),
            Some("dispatch_error")
        );
        assert!(repo
            .all_retry_issue_ids()
            .await
            .unwrap()
            .contains(&"lin-1".to_string()));
        // The live session is cleaned up so the failed run stops showing as live.
        assert!(repo.overview().await.unwrap().live_sessions.is_empty());
    }

    #[tokio::test]
    async fn runtime_boundary_contracts_rescue_workspace_and_skill_failures() {
        let failures = [
            WorkerError::from(crate::workspace::WorkspaceError::EscapedRoot(
                "fixture-workspace".to_string(),
            )),
            WorkerError::WorkspaceSkills(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "fixture skill write denied",
            )),
        ];

        for failure in failures {
            let expected_message = failure.to_string();
            assert!(!expected_message.contains("storage error"));
            assert!(!expected_message.contains("database error"));

            let temp = tempfile::tempdir().unwrap();
            let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
                .await
                .unwrap();
            let repo = Repository::new(pool, symphony_storage::EventBus::default());
            repo.upsert_issues(&[issue("todo", vec![])]).await.unwrap();
            let run = repo
                .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
                .await
                .unwrap()
                .unwrap();

            handle_dispatch_result(
                Ok(Err(failure)),
                &repo,
                "lin-1",
                &run,
                60_000,
                &OutputSanitizer::default(),
            )
            .await;

            let row = repo.get_run(&run.id).await.unwrap().unwrap();
            assert_eq!(row.status.as_str(), "failure");
            assert_eq!(row.error_class.as_deref(), Some("dispatch_error"));
            assert_eq!(
                row.error_message.as_deref(),
                Some(expected_message.as_str())
            );
            assert_eq!(repo.all_retry_issue_ids().await.unwrap(), vec!["lin-1"]);
        }
    }

    #[tokio::test]
    async fn rescues_a_run_stranded_by_a_dispatch_panic() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());

        repo.upsert_issues(&[issue("todo", vec![])]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        repo.mark_running(&run.id).await.unwrap();
        repo.upsert_live_session(
            &run.id,
            &symphony_core::AgentSessionId::new("sess-sess"),
            &symphony_core::AgentThreadId::new("sess"),
            &symphony_core::AgentTurnId::new("sess"),
            &symphony_core::TokenCountPayload {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
            },
        )
        .await
        .unwrap();

        let result = tokio::spawn(async {
            panic!("event mapper panic");
            #[allow(unreachable_code)]
            Ok::<(), WorkerError>(())
        })
        .await;
        handle_dispatch_result(
            result,
            &repo,
            "lin-1",
            &run,
            60_000,
            &OutputSanitizer::default(),
        )
        .await;

        let row = repo.get_run(&run.id).await.unwrap().unwrap();
        assert_eq!(row.status.as_str(), "failure");
        assert_eq!(row.error_class.as_deref(), Some("dispatch_panic"));
        assert!(row
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("event mapper panic")));
        assert!(repo
            .all_retry_issue_ids()
            .await
            .unwrap()
            .contains(&"lin-1".to_string()));
        assert!(repo.overview().await.unwrap().live_sessions.is_empty());
    }

    #[tokio::test]
    async fn leaves_an_already_finished_run_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());

        repo.upsert_issues(&[issue("todo", vec![])]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        repo.mark_running(&run.id).await.unwrap();
        // dispatch_run finished the run cleanly, then errored on a later step.
        repo.finish_run(&run.id, RunStatus::Success, None, None)
            .await
            .unwrap();

        recover_stranded_run(
            &repo,
            "lin-1",
            &run,
            60_000,
            "dispatch_error",
            &WorkerError::AlreadyRunning.to_string(),
            &OutputSanitizer::default(),
        )
        .await;

        // The success stands: no spurious failure overwrite, no retry queued.
        assert_eq!(
            repo.get_run(&run.id)
                .await
                .unwrap()
                .unwrap()
                .status
                .as_str(),
            "success"
        );
        assert!(repo.all_retry_issue_ids().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn refreshes_issue_that_reaches_done_via_an_intermediate_state() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());
        let stop = CancellationToken::new();

        // Blocked so the tick records the issue without dispatching a run.
        let todo = issue("todo", vec!["SYM-0".to_string()]);
        let tracker = StaticTracker {
            active: vec![todo.clone()],
            terminal: vec![],
        };
        tick(&repo, &tracker, &config, None, &stop).await.unwrap();
        assert_eq!(
            repo.get_issue("lin-1").await.unwrap().unwrap().state,
            "todo"
        );

        // Hop 1: issue moves to a state that is neither active nor terminal
        // (e.g. Linear's GitHub integration moves it to In Review on PR open).
        let in_review = Issue {
            state: "in review".to_string(),
            blockers: vec![],
            ..todo
        };
        let tracker = StaticTracker {
            active: vec![],
            terminal: vec![in_review.clone()],
        };
        tick(&repo, &tracker, &config, None, &stop).await.unwrap();
        assert_eq!(
            repo.get_issue("lin-1").await.unwrap().unwrap().state,
            "in review"
        );

        // Hop 2: issue reaches Done. The local row must follow.
        let done = Issue {
            state: "done".to_string(),
            ..in_review
        };
        let tracker = StaticTracker {
            active: vec![],
            terminal: vec![done],
        };
        tick(&repo, &tracker, &config, None, &stop).await.unwrap();
        assert_eq!(
            repo.get_issue("lin-1").await.unwrap().unwrap().state,
            "done"
        );
    }

    #[tokio::test]
    async fn refreshes_issue_that_left_the_active_set() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());
        let stop = CancellationToken::new();

        // Blocked so the tick records the issue without dispatching a run.
        let todo = issue("todo", vec!["SYM-0".to_string()]);
        let tracker = StaticTracker {
            active: vec![todo.clone()],
            terminal: vec![],
        };
        tick(&repo, &tracker, &config, None, &stop).await.unwrap();
        let row = repo.get_issue("lin-1").await.unwrap().unwrap();
        assert_eq!(row.state, "todo");

        let done = Issue {
            state: "done".to_string(),
            blockers: vec![],
            ..todo
        };
        let tracker = StaticTracker {
            active: vec![],
            terminal: vec![done],
        };
        tick(&repo, &tracker, &config, None, &stop).await.unwrap();
        let row = repo.get_issue("lin-1").await.unwrap().unwrap();
        assert_eq!(row.state, "done");
    }

    #[tokio::test]
    async fn refreshes_departed_issue_even_when_dispatch_lookup_hides_it() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());
        let stop = CancellationToken::new();

        let todo = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&todo))
            .await
            .unwrap();
        repo.schedule_retry("lin-1", 1, "2000-01-01T00:00:00Z", None, None)
            .await
            .unwrap();
        let done = Issue {
            state: "done".to_string(),
            ..todo
        };
        let tracker = DispatchFilteringTracker {
            by_id: Some(done),
            by_id_for_dispatch: None,
        };

        tick(&repo, &tracker, &config, None, &stop).await.unwrap();

        let row = repo.get_issue("lin-1").await.unwrap().unwrap();
        assert_eq!(row.state, "done");
        assert_eq!(repo.last_run_number("lin-1").await.unwrap(), 0);
        assert!(repo.pending_retry_issue_ids().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn keeps_last_known_state_when_departed_issue_is_gone_from_tracker() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());
        let stop = CancellationToken::new();

        let todo = issue("todo", vec!["SYM-0".to_string()]);
        let tracker = StaticTracker {
            active: vec![todo],
            terminal: vec![],
        };
        tick(&repo, &tracker, &config, None, &stop).await.unwrap();

        let tracker = StaticTracker {
            active: vec![],
            terminal: vec![],
        };
        tick(&repo, &tracker, &config, None, &stop).await.unwrap();
        let row = repo.get_issue("lin-1").await.unwrap().unwrap();
        assert_eq!(row.state, "todo");
    }

    #[tokio::test]
    async fn keeps_due_retry_queued_while_issue_is_blocked() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());
        let stop = CancellationToken::new();

        let blocked = issue("todo", vec!["SYM-0".to_string()]);
        let tracker = StaticTracker {
            active: vec![blocked.clone()],
            terminal: vec![],
        };
        repo.upsert_issues(&[blocked]).await.unwrap();
        repo.schedule_retry("lin-1", 1, "2000-01-01T00:00:00Z", None, None)
            .await
            .unwrap();

        tick(&repo, &tracker, &config, None, &stop).await.unwrap();

        assert_eq!(repo.last_run_number("lin-1").await.unwrap(), 0);
        assert_eq!(
            repo.pending_retry_issue_ids().await.unwrap(),
            vec!["lin-1".to_string()]
        );
    }

    #[tokio::test]
    async fn clears_due_retry_when_issue_left_the_active_states() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());
        let stop = CancellationToken::new();

        // Done but still blocked: the blocker check alone would keep the
        // retry queued forever and dispatch once the blocker clears.
        let done = issue("done", vec!["SYM-0".to_string()]);
        let tracker = StaticTracker {
            active: vec![],
            terminal: vec![done.clone()],
        };
        repo.upsert_issues(&[done]).await.unwrap();
        repo.schedule_retry("lin-1", 1, "2000-01-01T00:00:00Z", None, None)
            .await
            .unwrap();

        tick(&repo, &tracker, &config, None, &stop).await.unwrap();

        assert_eq!(repo.last_run_number("lin-1").await.unwrap(), 0);
        assert!(repo.pending_retry_issue_ids().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn clears_due_retry_when_issue_loses_its_route() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let mut config = runtime_config(temp.path());
        // No default or repository label: a retry created before this route
        // change should not suppress active dispatch forever.
        config.repos = vec![RepoConfig {
            name: "web".to_string(),
            ..RepoConfig::default()
        }];
        let stop = CancellationToken::new();

        let ready = issue("todo", vec![]);
        let tracker = StaticTracker {
            active: vec![ready.clone()],
            terminal: vec![],
        };
        repo.upsert_issues(&[ready]).await.unwrap();
        repo.schedule_retry("lin-1", 1, "2000-01-01T00:00:00Z", None, None)
            .await
            .unwrap();

        tick(&repo, &tracker, &config, None, &stop).await.unwrap();

        assert_eq!(repo.last_run_number("lin-1").await.unwrap(), 0);
        assert!(repo.pending_retry_issue_ids().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn skips_unroutable_issue_without_creating_a_run() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let mut config = runtime_config(temp.path());
        // Two repos, neither default, and no repository label: unroutable.
        config.repos = vec![
            RepoConfig {
                name: "web".to_string(),
                ..RepoConfig::default()
            },
            RepoConfig {
                name: "backend".to_string(),
                ..RepoConfig::default()
            },
        ];
        let stop = CancellationToken::new();

        let ready = issue("todo", vec![]);
        let tracker = StaticTracker {
            active: vec![ready],
            terminal: vec![],
        };
        tick(&repo, &tracker, &config, None, &stop).await.unwrap();

        assert_eq!(repo.last_run_number("lin-1").await.unwrap(), 0);
        assert!(repo.pending_retry_issue_ids().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn adopts_pre_multi_repo_workspace_for_queued_retries() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());
        repo.upsert_issues(&[issue("todo", vec![])]).await.unwrap();

        // The pre-upgrade attempt: a ready workspace at <root>/<issue> and a
        // failed run recorded without a repo.
        let old_path = temp.path().join("SYM-1");
        tokio::fs::create_dir_all(&old_path).await.unwrap();
        tokio::fs::write(old_path.join(crate::WORKSPACE_READY_SENTINEL), "")
            .await
            .unwrap();
        tokio::fs::write(old_path.join("marker.txt"), "prior attempt")
            .await
            .unwrap();
        let prior = repo
            .try_reserve_run("lin-1", 1, &old_path.display().to_string(), None)
            .await
            .unwrap()
            .unwrap();
        repo.finish_run(&prior.id, RunStatus::Failure, Some("agent_failure"), None)
            .await
            .unwrap();

        let repo_config = config.repos[0].clone();
        let workspaces = workspace_manager(&config, &repo_config);
        let new_path = workspaces.path_for("SYM-1").unwrap();
        let retry = repo
            .try_reserve_run(
                "lin-1",
                2,
                &new_path.display().to_string(),
                Some(&repo_config.name),
            )
            .await
            .unwrap()
            .unwrap();

        adopt_legacy_workspace(&repo, &config, &issue("todo", vec![]), &retry, &workspaces).await;

        assert!(tokio::fs::metadata(&old_path).await.is_err());
        assert_eq!(
            tokio::fs::read_to_string(new_path.join("marker.txt"))
                .await
                .unwrap(),
            "prior attempt"
        );
        // The adopted workspace is ready, so dispatch would reuse it as-is.
        assert!(
            tokio::fs::metadata(new_path.join(crate::WORKSPACE_READY_SENTINEL))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn never_adopts_a_workspace_from_another_repos_namespace() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());
        repo.upsert_issues(&[issue("todo", vec![])]).await.unwrap();

        // The prior run already belongs to a different repo's namespace —
        // its directory holds a clone of that repo and must stay put.
        let other_path = temp.path().join("other").join("SYM-1");
        tokio::fs::create_dir_all(&other_path).await.unwrap();
        tokio::fs::write(other_path.join(crate::WORKSPACE_READY_SENTINEL), "")
            .await
            .unwrap();
        let prior = repo
            .try_reserve_run("lin-1", 1, &other_path.display().to_string(), Some("other"))
            .await
            .unwrap()
            .unwrap();
        repo.finish_run(&prior.id, RunStatus::Failure, Some("agent_failure"), None)
            .await
            .unwrap();

        let repo_config = config.repos[0].clone();
        let workspaces = workspace_manager(&config, &repo_config);
        let new_path = workspaces.path_for("SYM-1").unwrap();
        let retry = repo
            .try_reserve_run(
                "lin-1",
                2,
                &new_path.display().to_string(),
                Some(&repo_config.name),
            )
            .await
            .unwrap()
            .unwrap();

        adopt_legacy_workspace(&repo, &config, &issue("todo", vec![]), &retry, &workspaces).await;

        assert!(tokio::fs::metadata(&other_path).await.is_ok());
        assert!(tokio::fs::metadata(&new_path).await.is_err());
    }

    #[tokio::test]
    async fn injects_missing_skills_before_marking_fresh_workspace_ready() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let workspace_root = temp.path().canonicalize().unwrap().join("workspaces");
        let mut config = runtime_config(&workspace_root);
        config.workflow.front_matter.hooks.after_create = Some(
            r#"git init
printf cloned > hook-ran
"#
            .to_string(),
        );
        config.skills = vec![SkillFile {
            name: "symphony-workpad".to_string(),
            content: "workpad skill".to_string(),
        }];
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let repo_config = config.repos[0].clone();
        let workspace_path = workspace_manager(&config, &repo_config)
            .path_for(&ready.identifier)
            .unwrap();
        let run = repo
            .try_reserve_run(
                &ready.id,
                1,
                &workspace_path.display().to_string(),
                Some(&repo_config.name),
            )
            .await
            .unwrap()
            .unwrap();

        dispatch_run_with_driver(
            repo.clone(),
            config,
            ready,
            repo_config,
            run.clone(),
            CancellationToken::new(),
            mock_driver(AgentOutcome::Success),
        )
        .await
        .unwrap();

        assert_eq!(
            tokio::fs::read_to_string(
                workspace_path.join(".agents/skills/symphony-workpad/SKILL.md")
            )
            .await
            .unwrap(),
            "workpad skill"
        );
        assert!(
            tokio::fs::metadata(workspace_path.join(crate::WORKSPACE_READY_SENTINEL))
                .await
                .is_ok()
        );
        let exclude = tokio::fs::read_to_string(workspace_path.join(".git/info/exclude"))
            .await
            .unwrap();
        assert!(exclude.contains("/.agents/skills/symphony-workpad/SKILL.md"));
        assert_eq!(
            repo.get_run(&run.id)
                .await
                .unwrap()
                .unwrap()
                .status
                .as_str(),
            "success"
        );
    }

    #[tokio::test]
    async fn injects_missing_skills_into_ready_reused_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let workspace_root = temp.path().canonicalize().unwrap().join("workspaces");
        let mut config = runtime_config(&workspace_root);
        config.workflow.front_matter.hooks.after_create =
            Some("echo should not run >&2\nexit 99\n".to_string());
        config.workflow.front_matter.hooks.before_run =
            Some("rm -rf .agents .claude\nrm -f .git/info/exclude\n".to_string());
        config.skills = vec![SkillFile {
            name: "symphony-workpad".to_string(),
            content: "workpad skill".to_string(),
        }];
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let repo_config = config.repos[0].clone();
        let workspace_path = workspace_manager(&config, &repo_config)
            .path_for(&ready.identifier)
            .unwrap();
        tokio::fs::create_dir_all(&workspace_path).await.unwrap();
        let output = tokio::process::Command::new("git")
            .arg("-C")
            .arg(&workspace_path)
            .arg("init")
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "git init failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        tokio::fs::write(workspace_path.join(crate::WORKSPACE_READY_SENTINEL), "")
            .await
            .unwrap();
        let run = repo
            .try_reserve_run(
                &ready.id,
                1,
                &workspace_path.display().to_string(),
                Some(&repo_config.name),
            )
            .await
            .unwrap()
            .unwrap();

        dispatch_run_with_driver(
            repo.clone(),
            config,
            ready,
            repo_config,
            run.clone(),
            CancellationToken::new(),
            mock_driver(AgentOutcome::Success),
        )
        .await
        .unwrap();

        assert_eq!(
            tokio::fs::read_to_string(
                workspace_path.join(".agents/skills/symphony-workpad/SKILL.md")
            )
            .await
            .unwrap(),
            "workpad skill"
        );
        let exclude = tokio::fs::read_to_string(workspace_path.join(".git/info/exclude"))
            .await
            .unwrap();
        assert!(exclude.contains("/.agents/skills/symphony-workpad/SKILL.md"));
        assert_eq!(
            repo.get_run(&run.id)
                .await
                .unwrap()
                .unwrap()
                .status
                .as_str(),
            "success"
        );
    }

    async fn hook_runs_count(db_path: &std::path::Path) -> i64 {
        let output = tokio::process::Command::new("sqlite3")
            .arg(db_path)
            .arg("select count(*) from hook_runs;")
            .output()
            .await
            .expect("sqlite3 must be available for hook_runs count assertions");
        assert!(
            output.status.success(),
            "sqlite3 failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .expect("hook_runs count should be an integer")
    }

    fn drain_hook_runs_db_changes(
        events: &mut tokio::sync::broadcast::Receiver<symphony_storage::StorageEvent>,
    ) -> usize {
        let mut count = 0;
        while let Ok(event) = events.try_recv() {
            if let symphony_storage::StorageEvent::DbChanged { table, .. } = event {
                if table == "hook_runs" {
                    count += 1;
                }
            }
        }
        count
    }

    #[tokio::test]
    async fn after_create_failure_fails_run_without_persisting_hook_runs() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("test.sqlite");
        let pool = symphony_storage::open_sqlite(&db_path).await.unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let workspace_root = temp.path().canonicalize().unwrap().join("workspaces");
        let mut config = runtime_config(&workspace_root);
        config.workflow.front_matter.hooks.after_create = Some(
            r#"printf once > "$WORKSPACE_PATH/after-create-ran"
echo after_create failed >&2
exit 7
"#
            .to_string(),
        );
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let repo_config = config.repos[0].clone();
        let workspace_path = workspace_manager(&config, &repo_config)
            .path_for(&ready.identifier)
            .unwrap();
        let run = repo
            .try_reserve_run(
                &ready.id,
                1,
                &workspace_path.display().to_string(),
                Some(&repo_config.name),
            )
            .await
            .unwrap()
            .unwrap();
        let mut storage_events = repo.events().subscribe();

        dispatch_run_with_driver(
            repo.clone(),
            config,
            ready,
            repo_config,
            run.clone(),
            CancellationToken::new(),
            mock_driver(AgentOutcome::Success),
        )
        .await
        .unwrap();

        let finished = repo.get_run(&run.id).await.unwrap().unwrap();
        assert_eq!(finished.status.as_str(), "failure");
        assert_eq!(finished.error_class.as_deref(), Some("after_create_failed"));
        assert_eq!(
            tokio::fs::read_to_string(workspace_path.join("after-create-ran"))
                .await
                .unwrap(),
            "once"
        );
        assert!(
            tokio::fs::metadata(workspace_path.join(crate::WORKSPACE_READY_SENTINEL))
                .await
                .is_err(),
            "failed after_create must not mark the workspace ready"
        );
        assert_eq!(hook_runs_count(&db_path).await, 0);
        assert_eq!(drain_hook_runs_db_changes(&mut storage_events), 0);
    }

    #[tokio::test]
    async fn before_run_and_after_run_execute_once_without_persisting_or_changing_outcome() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("test.sqlite");
        let pool = symphony_storage::open_sqlite(&db_path).await.unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let workspace_root = temp.path().canonicalize().unwrap().join("workspaces");
        let mut config = runtime_config(&workspace_root);
        // Fresh workspace: after_create succeeds once, then before_run/after_run
        // exit nonzero — outcome must still follow the agent result.
        config.workflow.front_matter.hooks.after_create = Some(
            r#"git init
printf once > "$WORKSPACE_PATH/after-create-ran"
"#
            .to_string(),
        );
        config.workflow.front_matter.hooks.before_run = Some(
            r#"printf once > "$WORKSPACE_PATH/before-run-ran"
echo before_run failed >&2
exit 11
"#
            .to_string(),
        );
        config.workflow.front_matter.hooks.after_run = Some(
            r#"printf once > "$WORKSPACE_PATH/after-run-ran"
echo after_run failed >&2
exit 13
"#
            .to_string(),
        );
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let repo_config = config.repos[0].clone();
        let workspace_path = workspace_manager(&config, &repo_config)
            .path_for(&ready.identifier)
            .unwrap();
        let run = repo
            .try_reserve_run(
                &ready.id,
                1,
                &workspace_path.display().to_string(),
                Some(&repo_config.name),
            )
            .await
            .unwrap()
            .unwrap();
        let mut storage_events = repo.events().subscribe();

        dispatch_run_with_driver(
            repo.clone(),
            config,
            ready,
            repo_config,
            run.clone(),
            CancellationToken::new(),
            mock_driver(AgentOutcome::Success),
        )
        .await
        .unwrap();

        assert_eq!(
            repo.get_run(&run.id)
                .await
                .unwrap()
                .unwrap()
                .status
                .as_str(),
            "success"
        );
        assert_eq!(
            tokio::fs::read_to_string(workspace_path.join("after-create-ran"))
                .await
                .unwrap(),
            "once"
        );
        assert_eq!(
            tokio::fs::read_to_string(workspace_path.join("before-run-ran"))
                .await
                .unwrap(),
            "once"
        );
        assert_eq!(
            tokio::fs::read_to_string(workspace_path.join("after-run-ran"))
                .await
                .unwrap(),
            "once"
        );
        assert_eq!(hook_runs_count(&db_path).await, 0);
        assert_eq!(drain_hook_runs_db_changes(&mut storage_events), 0);
    }

    #[test]
    fn run_env_overlays_the_routed_repo() {
        let mut base = BTreeMap::new();
        base.insert("PATH".to_string(), "/usr/bin".to_string());
        let repo = RepoConfig {
            name: "widgets".to_string(),
            url: "git@github.com:acme/widgets.git".to_string(),
            install_cmd: Some("pnpm install".to_string()),
            ..RepoConfig::default()
        };

        let env = run_env(&base, &repo);

        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(
            env.get("REPO_URL").map(String::as_str),
            Some("git@github.com:acme/widgets.git")
        );
        assert_eq!(env.get("REPO_NAME").map(String::as_str), Some("widgets"));
        assert_eq!(
            env.get("SYMPHONY_INSTALL_CMD").map(String::as_str),
            Some("pnpm install")
        );

        let no_install = RepoConfig {
            install_cmd: Some("  ".to_string()),
            ..repo
        };
        assert!(!run_env(&base, &no_install).contains_key("SYMPHONY_INSTALL_CMD"));
    }

    #[test]
    fn agent_env_injects_runtime_and_custom_session_vars() {
        let run = BTreeMap::from([
            ("LINEAR_API_KEY".to_string(), "lin_key".to_string()),
            (
                "REPO_URL".to_string(),
                "git@github.com:acme/widgets.git".to_string(),
            ),
            ("GH_TOKEN".to_string(), "gh-token".to_string()),
            (
                "GH_ENTERPRISE_TOKEN".to_string(),
                "enterprise-token".to_string(),
            ),
            ("PATH".to_string(), "/usr/bin".to_string()),
        ]);
        let custom = BTreeMap::from([
            ("OPENAI_API_KEY".to_string(), "sk-test".to_string()),
            ("REPO_URL".to_string(), "override".to_string()),
            ("EMPTY_ALLOWED".to_string(), "".to_string()),
        ]);

        let env = agent_env(&run, &custom)
            .into_iter()
            .collect::<BTreeMap<_, _>>();

        assert_eq!(
            env.get("LINEAR_API_KEY").map(String::as_str),
            Some("lin_key")
        );
        assert_eq!(
            env.get("OPENAI_API_KEY").map(String::as_str),
            Some("sk-test")
        );
        assert_eq!(env.get("GH_TOKEN").map(String::as_str), Some("gh-token"));
        assert!(!env.contains_key("GH_ENTERPRISE_TOKEN"));
        assert_eq!(env.get("EMPTY_ALLOWED").map(String::as_str), Some(""));
        assert_eq!(env.get("REPO_URL").map(String::as_str), Some("override"));
        assert!(!env.contains_key("PATH"));
    }

    #[test]
    fn agent_env_does_not_forward_github_tokens_for_unsupported_repo() {
        let run = BTreeMap::from([
            (
                "REPO_URL".to_string(),
                "git@gitlab.com:acme/widgets.git".to_string(),
            ),
            ("GH_TOKEN".to_string(), "dotcom-token".to_string()),
            (
                "GH_ENTERPRISE_TOKEN".to_string(),
                "enterprise-token".to_string(),
            ),
        ]);
        let env = agent_env(&run, &BTreeMap::new())
            .into_iter()
            .collect::<BTreeMap<_, _>>();

        assert!(!env.contains_key("GH_TOKEN"));
        assert!(!env.contains_key("GH_ENTERPRISE_TOKEN"));
    }

    #[test]
    fn agent_env_session_token_suppresses_runtime_precedence_tokens() {
        let run = BTreeMap::from([
            (
                "REPO_URL".to_string(),
                "git@github.com:acme/widgets.git".to_string(),
            ),
            ("GH_TOKEN".to_string(), "stale-process".to_string()),
        ]);
        let session = BTreeMap::from([(
            "GITHUB_TOKEN".to_string(),
            "repo-scoped-session".to_string(),
        )]);
        let env = agent_env(&run, &session)
            .into_iter()
            .collect::<BTreeMap<_, _>>();

        assert!(!env.contains_key("GH_TOKEN"));
        assert_eq!(
            env.get("GITHUB_TOKEN").map(String::as_str),
            Some("repo-scoped-session")
        );
    }

    #[test]
    fn tracker_auth_errors_are_not_reported_as_storage_errors() {
        let err = WorkerError::from(TrackerError::Auth("401 Unauthorized".to_string()));

        assert_eq!(
            err.to_string(),
            "tracker error: Linear auth failed: 401 Unauthorized"
        );
        assert!(!err.to_string().contains("storage error"));
        assert!(!err.to_string().contains("database error"));
    }

    #[test]
    fn runtime_boundary_contracts_classify_non_storage_worker_errors() {
        let workspace = WorkerError::from(crate::workspace::WorkspaceError::EscapedRoot(
            "fixture".to_string(),
        ));
        assert_eq!(
            workspace.to_string(),
            "workspace error: workspace path escaped root: fixture"
        );

        let skills = WorkerError::WorkspaceSkills(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "fixture denied",
        ));
        assert_eq!(
            skills.to_string(),
            "workspace skill injection failed: fixture denied"
        );

        for error in [workspace, skills] {
            assert!(!error.to_string().contains("storage error"));
            assert!(!error.to_string().contains("database error"));
        }
    }

    #[tokio::test]
    async fn failed_reconfigure_preflight_keeps_live_config_and_worker_token() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let manager =
            WorkerManager::new(Repository::new(pool, symphony_storage::EventBus::default()));
        let mut initial = runtime_config(temp.path());
        initial.repos[0].install_cmd = Some("make get".to_string());
        let shared = std::sync::Arc::new(tokio::sync::RwLock::new(initial));
        let stop = CancellationToken::new();
        {
            let mut inner = manager.inner.lock().await;
            inner.lifecycle = test_running_worker(shared.clone(), stop.clone());
        }
        let mut updated = runtime_config(temp.path());
        updated.workflow.front_matter.tracker.api_key = "bad-key".to_string();
        updated.repos[0].install_cmd = Some("make gen".to_string());

        let status = manager
            .reconfigure_with_tracker_preflight(start_config(updated), |_| async {
                Err(WorkerError::from(TrackerError::Auth("bad key".to_string())))
            })
            .await;

        assert_eq!(status.state, WorkerState::Running);
        assert_eq!(
            status.last_error.as_deref(),
            Some("tracker error: Linear auth failed: bad key")
        );
        assert!(!stop.is_cancelled());
        let live = shared.read().await;
        assert_eq!(live.workflow.front_matter.tracker.api_key, "test-key");
        assert_eq!(live.repos[0].install_cmd.as_deref(), Some("make get"));
    }

    #[tokio::test]
    async fn older_credential_removal_cannot_stop_a_newer_worker() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("revision.sqlite"))
            .await
            .unwrap();
        let manager =
            WorkerManager::new(Repository::new(pool, symphony_storage::EventBus::default()));
        let mut current = runtime_config(temp.path());
        current.settings_revision = 2;
        manager
            .start_with_runner(start_config(current), |_, _, stop| async move {
                stop.cancelled().await;
                Ok(())
            })
            .await
            .unwrap();
        let (stop, generation) = {
            let inner = manager.inner.lock().await;
            let WorkerLifecycle::Running(worker) = &inner.lifecycle else {
                panic!("worker must be running");
            };
            (worker.stop.clone(), inner.reconfigure_generation)
        };
        let status = manager.stop_for_settings_revision(1).await;
        assert_eq!(status.state, WorkerState::Running);
        assert!(!stop.is_cancelled());
        assert_eq!(
            manager.inner.lock().await.reconfigure_generation,
            generation
        );
        assert_eq!(manager.inner.lock().await.latest_settings_revision, 2);

        // Explicit Stop still cancels the current worker regardless of revisions.
        assert_eq!(manager.stop().await.state, WorkerState::Stopping);
        assert!(stop.is_cancelled());
        wait_until_stopped(&manager).await;
    }

    #[tokio::test]
    async fn credential_removal_fences_a_delayed_older_start() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("revision.sqlite"))
            .await
            .unwrap();
        let manager =
            WorkerManager::new(Repository::new(pool, symphony_storage::EventBus::default()));
        assert_eq!(
            manager.stop_for_settings_revision(2).await.state,
            WorkerState::Stopped
        );
        let mut old = runtime_config(temp.path());
        old.settings_revision = 1;
        let result = manager
            .start_with_runner(start_config(old), |_, _, _| async {
                panic!("configuration from before credential removal must not run")
            })
            .await;
        assert!(matches!(
            result,
            Err(WorkerError::StaleSettings {
                revision: 1,
                latest_revision: 2
            })
        ));
        assert_eq!(manager.status().await.state, WorkerState::Stopped);
        assert_eq!(manager.inner.lock().await.latest_settings_revision, 2);
    }

    #[tokio::test]
    async fn committed_incomplete_draft_fences_an_older_start_and_reconfiguration() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("revision.sqlite"))
            .await
            .unwrap();
        let manager =
            WorkerManager::new(Repository::new(pool, symphony_storage::EventBus::default()));
        // A saveable draft has no RunnableConfig; its revision still commits.
        manager.observe_settings_revision(2).await;
        let mut old = runtime_config(temp.path());
        old.settings_revision = 1;
        let result = manager
            .start_with_runner(start_config(old.clone()), |_, _, _| async {
                panic!("superseded draft must not start")
            })
            .await;
        assert!(matches!(
            result,
            Err(WorkerError::StaleSettings {
                revision: 1,
                latest_revision: 2
            })
        ));
        manager
            .reconfigure_with_tracker_preflight(start_config(old), |_| async {
                panic!("superseded reconfiguration must not reach preflight")
            })
            .await;
        assert_eq!(manager.status().await.state, WorkerState::Stopped);
        assert_eq!(manager.inner.lock().await.latest_settings_revision, 2);
    }

    #[tokio::test]
    async fn credential_less_reconfiguration_stops_the_old_runtime_without_preflight() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("revision.sqlite"))
            .await
            .unwrap();
        let manager =
            WorkerManager::new(Repository::new(pool, symphony_storage::EventBus::default()));
        let mut initial = runtime_config(temp.path());
        initial.settings_revision = 1;
        manager
            .start_with_runner(start_config(initial), |_, _, stop| async move {
                stop.cancelled().await;
                Ok(())
            })
            .await
            .unwrap();
        let stop = {
            let inner = manager.inner.lock().await;
            let WorkerLifecycle::Running(worker) = &inner.lifecycle else {
                panic!("running worker")
            };
            worker.stop.clone()
        };
        let mut no_key = runtime_config(temp.path());
        no_key.settings_revision = 3;
        no_key.workflow.front_matter.tracker.api_key.clear();
        let status = manager.reconfigure_with_tracker_preflight(start_config(no_key), |_| async {
            panic!("credential absence must stop rather than retain an old key after preflight failure")
        }).await;
        assert_eq!(status.state, WorkerState::Stopping);
        assert!(stop.is_cancelled());
        manager.stop_for_settings_revision(2).await;
        assert_eq!(manager.inner.lock().await.latest_settings_revision, 3);
        wait_until_stopped(&manager).await;
    }

    #[tokio::test]
    async fn an_unapplied_newer_draft_does_not_supersede_credential_removal() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("revision.sqlite"))
            .await
            .unwrap();
        let manager =
            WorkerManager::new(Repository::new(pool, symphony_storage::EventBus::default()));
        let mut initial = runtime_config(temp.path());
        initial.settings_revision = 1;
        manager
            .start_with_runner(start_config(initial), |_, _, stop| async move {
                stop.cancelled().await;
                Ok(())
            })
            .await
            .unwrap();
        manager.observe_settings_revision(3).await;
        assert_eq!(
            manager.stop_for_settings_revision(2).await.state,
            WorkerState::Stopping
        );
        assert_eq!(manager.inner.lock().await.latest_settings_revision, 3);
        wait_until_stopped(&manager).await;
    }

    #[tokio::test]
    async fn an_incomplete_commit_invalidates_preflight_already_in_flight() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("revision.sqlite"))
            .await
            .unwrap();
        let manager =
            WorkerManager::new(Repository::new(pool, symphony_storage::EventBus::default()));
        manager
            .start_with_runner(
                start_config(runtime_config(temp.path())),
                |_, _, stop| async move {
                    stop.cancelled().await;
                    Ok(())
                },
            )
            .await
            .unwrap();
        let shared = {
            let inner = manager.inner.lock().await;
            let WorkerLifecycle::Running(worker) = &inner.lifecycle else {
                panic!("running worker")
            };
            worker.runtime_config.clone()
        };
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let mut old = runtime_config(temp.path());
        old.settings_revision = 1;
        old.workflow.front_matter.tracker.api_key = "older-replacement".into();
        let pending_manager = manager.clone();
        let pending = tokio::spawn(async move {
            pending_manager
                .reconfigure_with_tracker_preflight(start_config(old), |_| async move {
                    entered_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    Ok(())
                })
                .await
        });
        entered_rx.await.unwrap();
        manager.observe_settings_revision(2).await;
        release_tx.send(()).unwrap();
        pending.await.unwrap();
        assert_eq!(shared.read().await.settings_revision, 0);
        assert_eq!(
            shared.read().await.workflow.front_matter.tracker.api_key,
            "test-key"
        );
        manager.stop().await;
        wait_until_stopped(&manager).await;
    }

    #[tokio::test]
    async fn failed_newer_tracker_replacement_does_not_supersede_credential_removal() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("revision.sqlite"))
            .await
            .unwrap();
        let manager =
            WorkerManager::new(Repository::new(pool, symphony_storage::EventBus::default()));
        let mut initial = runtime_config(temp.path());
        initial.settings_revision = 1;
        manager
            .start_with_runner(start_config(initial), |_, _, stop| async move {
                stop.cancelled().await;
                Ok(())
            })
            .await
            .unwrap();
        let mut rejected = runtime_config(temp.path());
        rejected.settings_revision = 3;
        rejected.workflow.front_matter.tracker.api_key = "rejected-key".into();
        manager
            .reconfigure_with_tracker_preflight(start_config(rejected), |_| async {
                Err(TrackerError::Auth("invalid replacement".into()).into())
            })
            .await;
        assert_eq!(manager.status().await.state, WorkerState::Running);
        assert_eq!(
            manager.stop_for_settings_revision(2).await.state,
            WorkerState::Stopping
        );
        assert_eq!(manager.inner.lock().await.latest_settings_revision, 3);
        wait_until_stopped(&manager).await;
    }

    #[tokio::test]
    async fn stopped_save_fences_a_delayed_start_without_starting_the_worker() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("revision.sqlite"))
            .await
            .unwrap();
        let manager =
            WorkerManager::new(Repository::new(pool, symphony_storage::EventBus::default()));
        let mut newer = runtime_config(temp.path());
        newer.settings_revision = 2;
        let status = manager
            .reconfigure_with_tracker_preflight(start_config(newer), |_| async {
                panic!("stopped reconfiguration must not run preflight")
            })
            .await;
        assert_eq!(status.state, WorkerState::Stopped);
        let mut older = runtime_config(temp.path());
        older.settings_revision = 1;
        let result = manager
            .start_with_runner(start_config(older), |_, _, _| async {
                panic!("stale start must not run the worker")
            })
            .await;
        assert!(matches!(
            result,
            Err(WorkerError::StaleSettings {
                revision: 1,
                latest_revision: 2
            })
        ));
        assert_eq!(manager.status().await.state, WorkerState::Stopped);
        assert_eq!(manager.inner.lock().await.latest_settings_revision, 2);
    }

    #[tokio::test]
    async fn delayed_lower_revision_never_replaces_a_newer_settings_request() {
        for fail_newer_preflight in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let pool = symphony_storage::open_sqlite(temp.path().join("revision.sqlite"))
                .await
                .unwrap();
            let manager =
                WorkerManager::new(Repository::new(pool, symphony_storage::EventBus::default()));
            let initial = runtime_config(temp.path());
            let shared = Arc::new(RwLock::new(initial));
            {
                let mut inner = manager.inner.lock().await;
                inner.lifecycle = test_running_worker(shared.clone(), CancellationToken::new());
            }
            let mut newer = runtime_config(temp.path());
            newer.settings_revision = 2;
            newer.workflow.front_matter.tracker.api_key = "newer-key".into();
            manager
                .reconfigure_with_tracker_preflight(start_config(newer), |_| async {
                    if fail_newer_preflight {
                        Err(TrackerError::Auth("bad key".into()).into())
                    } else {
                        Ok(())
                    }
                })
                .await;
            let generation = manager.inner.lock().await.reconfigure_generation;
            let calls = Arc::new(AtomicUsize::new(0));
            let seen = calls.clone();
            let mut older = runtime_config(temp.path());
            older.settings_revision = 1;
            older.workflow.front_matter.tracker.api_key = "older-key".into();
            manager
                .reconfigure_with_tracker_preflight(start_config(older), move |_| async move {
                    seen.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await;
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert_eq!(
                manager.inner.lock().await.reconfigure_generation,
                generation
            );
            let expected = if fail_newer_preflight {
                "test-key"
            } else {
                "newer-key"
            };
            assert_eq!(
                shared.read().await.workflow.front_matter.tracker.api_key,
                expected
            );
        }
    }

    #[tokio::test]
    async fn older_reconfigure_cannot_overwrite_newer_save_after_preflight() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let manager =
            WorkerManager::new(Repository::new(pool, symphony_storage::EventBus::default()));
        let mut initial = runtime_config(temp.path());
        initial.repos[0].install_cmd = Some("make initial".to_string());
        let shared = std::sync::Arc::new(tokio::sync::RwLock::new(initial));
        {
            let mut inner = manager.inner.lock().await;
            inner.lifecycle = test_running_worker(shared.clone(), CancellationToken::new());
        }
        let mut older = runtime_config(temp.path());
        older.workflow.front_matter.tracker.api_key = "older-key".to_string();
        older.repos[0].install_cmd = Some("make older".to_string());
        let mut newer = runtime_config(temp.path());
        newer.workflow.front_matter.tracker.api_key = "newer-key".to_string();
        newer.repos[0].install_cmd = Some("make newer".to_string());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let first_manager = manager.clone();
        let first = tokio::spawn(async move {
            first_manager
                .reconfigure_with_tracker_preflight(start_config(older), move |_| async move {
                    started_tx.send(()).ok();
                    release_rx.await.unwrap();
                    Ok(())
                })
                .await
        });
        started_rx.await.unwrap();

        manager
            .reconfigure_with_tracker_preflight(start_config(newer), |_| async { Ok(()) })
            .await;
        release_tx.send(()).unwrap();
        first.await.unwrap();

        let live = shared.read().await;
        assert_eq!(live.workflow.front_matter.tracker.api_key, "newer-key");
        assert_eq!(live.repos[0].install_cmd.as_deref(), Some("make newer"));
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum BlockingStartupPhase {
        Preflight,
        Recovery,
    }

    struct BlockingStartupTracker {
        phase: BlockingStartupPhase,
        entered: Arc<Notify>,
    }

    #[async_trait::async_trait]
    impl TrackerClient for BlockingStartupTracker {
        async fn preflight(&self) -> Result<(), TrackerError> {
            if self.phase == BlockingStartupPhase::Preflight {
                self.entered.notify_one();
                return std::future::pending().await;
            }
            Ok(())
        }

        async fn fetch_active(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
        }

        async fn fetch_terminal(&self) -> Result<Vec<Issue>, TrackerError> {
            if self.phase == BlockingStartupPhase::Recovery {
                self.entered.notify_one();
                return std::future::pending().await;
            }
            Ok(Vec::new())
        }

        async fn fetch_by_id(&self, _id: &str) -> Result<Option<Issue>, TrackerError> {
            Ok(None)
        }

        async fn fetch_workpads(
            &self,
            _issue_ids: &[String],
        ) -> Result<Vec<symphony_tracker::WorkpadComment>, TrackerError> {
            Ok(Vec::new())
        }
    }

    async fn assert_worker_startup_cancels(phase: BlockingStartupPhase) {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());
        let stop = CancellationToken::new();
        let entered = Arc::new(Notify::new());
        let tracker = BlockingStartupTracker {
            phase,
            entered: entered.clone(),
        };

        let startup_repo = repo.clone();
        let startup_stop = stop.clone();
        let startup_phase = phase;
        let handle = tokio::spawn(async move {
            match startup_phase {
                BlockingStartupPhase::Preflight => {
                    prepare_worker(&startup_repo, &tracker, &config, &startup_stop).await
                }
                BlockingStartupPhase::Recovery => {
                    recover_terminal_workspaces(
                        &startup_repo,
                        &tracker,
                        &config,
                        None,
                        &startup_stop,
                    )
                    .await
                }
            }
        });

        tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
            .await
            .expect("worker startup did not reach the blocking tracker request");
        stop.cancel();

        let should_start = tokio::time::timeout(std::time::Duration::from_secs(5), handle)
            .await
            .expect("worker startup did not return promptly after stop")
            .expect("worker startup task panicked")
            .expect("worker startup returned an error");
        assert!(!should_start);
    }

    #[tokio::test]
    async fn worker_startup_stops_promptly_while_preflight_is_blocked() {
        assert_worker_startup_cancels(BlockingStartupPhase::Preflight).await;
    }

    #[tokio::test]
    async fn worker_startup_stops_promptly_while_recovery_fetch_is_blocked() {
        assert_worker_startup_cancels(BlockingStartupPhase::Recovery).await;
    }

    #[tokio::test]
    async fn terminal_recovery_quarantines_without_waiting_for_recursive_deletion() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let mut config = runtime_config(temp.path());
        config.workspace_cleanup = Some(WorkspaceCleanupManager::new(repo.clone()));
        let workspace = temp.path().join("widgets/SYM-1");
        tokio::fs::create_dir_all(workspace.join("large/tree"))
            .await
            .unwrap();
        tokio::fs::write(workspace.join("large/tree/marker"), "old")
            .await
            .unwrap();
        let mut terminal_issue = issue("done", vec![]);
        terminal_issue.completed_at = Some((Utc::now() - ChronoDuration::minutes(61)).to_rfc3339());
        let tracker = StaticTracker {
            active: vec![],
            terminal: vec![terminal_issue],
        };

        assert!(recover_terminal_workspaces(
            &repo,
            &tracker,
            &config,
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap());

        assert!(tokio::fs::metadata(&workspace).await.is_err());
        assert_eq!(repo.overview().await.unwrap().workspace_cleanup_count, 1);
        let queued = repo
            .due_workspace_cleanup("2099-01-01T00:00:00.000Z")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            tokio::fs::read_to_string(
                PathBuf::from(queued.quarantine_path).join("large/tree/marker")
            )
            .await
            .unwrap(),
            "old"
        );
    }

    #[tokio::test]
    async fn terminal_recovery_preserves_recently_completed_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let mut config = runtime_config(temp.path());
        config.workspace_cleanup = Some(WorkspaceCleanupManager::new(repo.clone()));
        let workspace = temp.path().join("widgets/SYM-1");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let mut terminal_issue = issue("done", vec![]);
        terminal_issue.completed_at = Some((Utc::now() - ChronoDuration::minutes(59)).to_rfc3339());
        let tracker = StaticTracker {
            active: vec![],
            terminal: vec![terminal_issue],
        };

        assert!(recover_terminal_workspaces(
            &repo,
            &tracker,
            &config,
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap());

        assert!(tokio::fs::metadata(&workspace).await.is_ok());
        assert_eq!(repo.overview().await.unwrap().workspace_cleanup_count, 0);
    }

    #[tokio::test]
    async fn terminal_recovery_quarantines_canceled_issue_after_grace_period() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let mut config = runtime_config(temp.path());
        config.workspace_cleanup = Some(WorkspaceCleanupManager::new(repo.clone()));
        config
            .workflow
            .front_matter
            .tracker
            .terminal_states
            .push("Canceled".to_string());
        let workspace = temp.path().join("widgets/SYM-1");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let mut terminal_issue = issue("canceled", vec![]);
        terminal_issue.canceled_at = Some((Utc::now() - ChronoDuration::minutes(61)).to_rfc3339());
        let tracker = StaticTracker {
            active: vec![],
            terminal: vec![terminal_issue],
        };

        assert!(recover_terminal_workspaces(
            &repo,
            &tracker,
            &config,
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap());

        assert!(tokio::fs::metadata(&workspace).await.is_err());
        assert_eq!(repo.overview().await.unwrap().workspace_cleanup_count, 1);
    }

    #[tokio::test]
    async fn terminal_recovery_propagates_tracker_failure() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());

        let error = recover_terminal_workspaces(
            &repo,
            &FailingTerminalTracker,
            &config,
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            WorkerError::Tracker(TrackerError::Invalid(_))
        ));
    }

    #[tokio::test]
    async fn startup_continues_when_terminal_recovery_fetch_fails() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());

        assert!(
            recover_terminal_workspaces_at_startup(
                &repo,
                &FailingTerminalTracker,
                &config,
                &CancellationToken::new(),
            )
            .await
        );
    }

    #[tokio::test]
    async fn terminal_recovery_preserves_workspace_when_issue_reopens() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let mut config = runtime_config(temp.path());
        config.workspace_cleanup = Some(WorkspaceCleanupManager::new(repo.clone()));
        let workspace = temp.path().join("widgets/SYM-1");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let reopened = issue("todo", vec![]);
        let mut stale_terminal = issue("done", vec![]);
        stale_terminal.completed_at = Some((Utc::now() - ChronoDuration::minutes(61)).to_rfc3339());
        let tracker = StaticTracker {
            active: vec![reopened],
            terminal: vec![stale_terminal],
        };

        assert!(recover_terminal_workspaces(
            &repo,
            &tracker,
            &config,
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap());

        assert!(tokio::fs::metadata(&workspace).await.is_ok());
        assert_eq!(repo.overview().await.unwrap().workspace_cleanup_count, 0);
    }

    #[tokio::test]
    async fn terminal_recovery_skips_remote_revalidation_for_missing_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());
        let mut terminal_issue = issue("done", vec![]);
        terminal_issue.completed_at = Some((Utc::now() - ChronoDuration::minutes(61)).to_rfc3339());
        let by_id_fetches = Arc::new(AtomicUsize::new(0));
        let tracker = CountingTerminalTracker {
            terminal: vec![terminal_issue],
            terminal_fetches: Arc::new(AtomicUsize::new(0)),
            by_id_fetches: by_id_fetches.clone(),
        };

        assert!(recover_terminal_workspaces(
            &repo,
            &tracker,
            &config,
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap());

        assert_eq!(by_id_fetches.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn terminal_recovery_revalidates_tracker_config_after_fetch() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let mut initial_config = runtime_config(temp.path());
        initial_config.workspace_cleanup = Some(WorkspaceCleanupManager::new(repo.clone()));
        let shared_config = Arc::new(RwLock::new(initial_config.clone()));
        let workspace = temp.path().join("widgets/SYM-1");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let mut terminal_issue = issue("done", vec![]);
        terminal_issue.completed_at = Some((Utc::now() - ChronoDuration::minutes(61)).to_rfc3339());
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let tracker = BlockingTerminalTracker {
            terminal: vec![terminal_issue],
            entered: entered.clone(),
            release: release.clone(),
        };
        let task_repo = repo.clone();
        let task_config = initial_config.clone();
        let task_shared = shared_config.clone();
        let handle = tokio::spawn(async move {
            recover_terminal_workspaces(
                &task_repo,
                &tracker,
                &task_config,
                Some(&task_shared),
                &CancellationToken::new(),
            )
            .await
        });

        tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
            .await
            .expect("terminal recovery did not start fetching");
        shared_config
            .write()
            .await
            .workflow
            .front_matter
            .tracker
            .api_key = "reconfigured-key".to_string();
        release.notify_one();

        assert!(handle.await.unwrap().unwrap());
        assert!(tokio::fs::metadata(&workspace).await.is_ok());
        assert_eq!(repo.overview().await.unwrap().workspace_cleanup_count, 0);
    }

    #[tokio::test]
    async fn terminal_cleanup_loop_fetches_terminal_issues_hourly() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        tokio::time::pause();
        let mut config = runtime_config(temp.path());
        config.workflow.front_matter.polling.interval_ms = 10 * 60 * 60 * 1_000;
        let config = Arc::new(RwLock::new(config));
        let stop = CancellationToken::new();
        let terminal_fetches = Arc::new(AtomicUsize::new(0));
        let tracker = CountingTerminalTracker {
            terminal: Vec::new(),
            terminal_fetches: terminal_fetches.clone(),
            by_id_fetches: Arc::new(AtomicUsize::new(0)),
        };
        let tracker_config = config.read().await.workflow.front_matter.tracker.clone();
        let task_repo = repo.clone();
        let task_config = config.clone();
        let task_stop = stop.clone();
        let replacement = tracker.clone();
        let handle = tokio::spawn(async move {
            run_terminal_workspace_cleanup_loop(
                &task_repo,
                &task_config,
                &task_stop,
                tracker,
                tracker_config,
                |_| replacement.clone(),
            )
            .await;
        });

        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        assert_eq!(terminal_fetches.load(Ordering::SeqCst), 0);
        tokio::time::advance(
            TERMINAL_WORKSPACE_CLEANUP_INTERVAL - std::time::Duration::from_secs(1),
        )
        .await;
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        assert_eq!(terminal_fetches.load(Ordering::SeqCst), 0);

        tokio::time::advance(std::time::Duration::from_secs(1)).await;
        tokio::time::resume();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while terminal_fetches.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("hourly terminal cleanup did not run");
        assert_eq!(terminal_fetches.load(Ordering::SeqCst), 1);

        stop.cancel();
        handle.await.unwrap();
    }

    /// A tracker whose `fetch_active` never resolves, standing in for a Linear
    /// request hung past its timeout.
    struct BlockingTracker;

    #[async_trait::async_trait]
    impl TrackerClient for BlockingTracker {
        async fn preflight(&self) -> Result<(), TrackerError> {
            Ok(())
        }

        async fn fetch_active(&self) -> Result<Vec<Issue>, TrackerError> {
            std::future::pending().await
        }

        async fn fetch_terminal(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
        }

        async fn fetch_by_id(&self, _id: &str) -> Result<Option<Issue>, TrackerError> {
            Ok(None)
        }

        async fn fetch_workpads(
            &self,
            _issue_ids: &[String],
        ) -> Result<Vec<symphony_tracker::WorkpadComment>, TrackerError> {
            Ok(Vec::new())
        }
    }

    #[tokio::test]
    async fn run_loop_stops_promptly_while_a_tick_is_blocked_on_the_tracker() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());
        let tracker_config = config.workflow.front_matter.tracker.clone();
        let shared: SharedRuntimeConfig = Arc::new(RwLock::new(config));
        let stop = CancellationToken::new();

        let loop_repo = repo.clone();
        let loop_config = shared.clone();
        let loop_stop = stop.clone();
        let handle = tokio::spawn(async move {
            run_loop(
                &loop_repo,
                &loop_config,
                &loop_stop,
                BlockingTracker,
                tracker_config,
                |_| BlockingTracker,
            )
            .await;
        });

        // Let the loop enter the tick and park on fetch_active.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        stop.cancel();

        // The tick abandons the never-resolving fetch_active when stop fires
        // (via `cancellable`) and unwinds, so run_loop returns promptly. Without
        // that, it would stay parked on fetch_active and this would time out.
        tokio::time::timeout(std::time::Duration::from_secs(5), handle)
            .await
            .expect("run_loop did not return promptly after stop")
            .expect("run_loop task panicked");
    }

    #[tokio::test]
    async fn cancellable_resolves_until_stop_then_yields_none() {
        let stop = CancellationToken::new();
        // Before cancellation it forwards the future's output.
        assert_eq!(cancellable(&stop, async { 7 }).await, Some(7));
        stop.cancel();
        // After cancellation it abandons even a future that never resolves.
        assert_eq!(
            cancellable(&stop, std::future::pending::<i32>()).await,
            None
        );
    }

    #[tokio::test]
    async fn stop_run_moves_issue_to_in_review_after_cancelling_only_requested_run() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let first_issue = issue("todo", vec![]);
        let second_issue = Issue {
            id: "lin-2".to_string(),
            identifier: "SYM-2".to_string(),
            ..first_issue.clone()
        };
        repo.upsert_issues(&[first_issue.clone(), second_issue.clone()])
            .await
            .unwrap();
        let first_run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws-1", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        let second_run = repo
            .try_reserve_run("lin-2", 1, "/tmp/ws-2", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        let manager = WorkerManager::new(repo);
        let first = CancellationToken::new();
        let second = CancellationToken::new();
        let tracker_config = runtime_config(temp.path()).workflow.front_matter.tracker;

        manager
            .run_cancellations
            .register(
                &first_run.id,
                first.clone(),
                tracker_config.clone(),
                first_issue,
            )
            .await;
        manager
            .run_cancellations
            .register(&second_run.id, second.clone(), tracker_config, second_issue)
            .await;
        let moved = Arc::new(Mutex::new(Vec::new()));
        let tracker = StateMovingTracker {
            moved: moved.clone(),
            fail: false,
            expected_cancelled: first.clone(),
        };
        manager
            .repo
            .suppress_issue_dispatch(&first_run.issue_id, USER_CANCELLED_SUPPRESSION, "fallback")
            .await
            .unwrap();

        manager
            .stop_managed_run(
                &first_run.id,
                manager.run_cancellations.get(&first_run.id).await.unwrap(),
                &tracker,
            )
            .await
            .unwrap();

        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert_eq!(
            *moved.lock().await,
            vec![("lin-1".to_string(), "In Review".to_string())]
        );
        let stop_intent = manager
            .run_cancellations
            .get(&first_run.id)
            .await
            .unwrap()
            .stop_intent;
        assert!(stop_intent.lock().await.suppression_fingerprint.is_some());
        assert!(manager
            .repo
            .issue_dispatch_suppression(&first_run.issue_id, USER_CANCELLED_SUPPRESSION)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn active_in_review_keeps_post_transition_suppression() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        let manager = WorkerManager::new(repo);
        let token = CancellationToken::new();
        let moved = Arc::new(Mutex::new(Vec::new()));
        let tracker = StateMovingTracker {
            moved,
            fail: false,
            expected_cancelled: token.clone(),
        };
        let mut tracker_config = runtime_config(temp.path()).workflow.front_matter.tracker;
        tracker_config.active_states.push("In Review".to_string());
        let managed = ManagedRun {
            token: token.clone(),
            tracker_config,
            issue: ready.clone(),
            lifecycle: Arc::new(Mutex::new(())),
            stop_intent: Arc::new(Mutex::new(StopIntent::default())),
        };

        manager
            .stop_managed_run(&run.id, managed, &tracker)
            .await
            .unwrap();

        assert!(token.is_cancelled());
        let stopped_issue = Issue {
            state: "in review".to_string(),
            ..ready
        };
        assert_eq!(
            manager
                .repo
                .issue_dispatch_suppression("lin-1", USER_CANCELLED_SUPPRESSION)
                .await
                .unwrap()
                .as_deref(),
            Some(issue_fingerprint(&stopped_issue).as_str())
        );
    }

    #[tokio::test]
    async fn polling_in_review_clears_the_old_state_suppression() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        repo.suppress_issue_dispatch(
            &ready.id,
            USER_CANCELLED_SUPPRESSION,
            &issue_fingerprint(&ready),
        )
        .await
        .unwrap();
        let in_review = Issue {
            state: "in review".to_string(),
            ..ready
        };
        let tracker = StaticTracker {
            active: vec![],
            terminal: vec![in_review],
        };

        tick(
            &repo,
            &tracker,
            &runtime_config(temp.path()),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(
            repo.get_issue("lin-1").await.unwrap().unwrap().state,
            "in review"
        );
        assert!(repo
            .issue_dispatch_suppression("lin-1", USER_CANCELLED_SUPPRESSION)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn explicit_retry_moves_a_stopped_issue_back_to_an_active_state() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let in_review = issue("in review", vec!["SYM-0".to_string()]);
        repo.upsert_issues(std::slice::from_ref(&in_review))
            .await
            .unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        repo.finish_run(
            &run.id,
            RunStatus::Cancelled,
            Some("cancelled"),
            Some("run cancelled"),
        )
        .await
        .unwrap();
        repo.trigger_retry_now("lin-1").await.unwrap();
        let current = Arc::new(Mutex::new(in_review));
        let moved = Arc::new(Mutex::new(Vec::new()));
        let tracker = RetryReactivatingTracker {
            current,
            moved: moved.clone(),
        };

        tick(
            &repo,
            &tracker,
            &runtime_config(temp.path()),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(
            *moved.lock().await,
            vec![("lin-1".to_string(), "Todo".to_string())]
        );
        assert_eq!(
            repo.get_issue("lin-1").await.unwrap().unwrap().state,
            "todo"
        );
        assert_eq!(
            repo.pending_retry_issue_ids().await.unwrap(),
            vec!["lin-1".to_string()]
        );
    }

    #[tokio::test]
    async fn managed_stop_revalidates_before_mutating_a_finished_run() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        repo.finish_run(&run.id, RunStatus::Success, None, None)
            .await
            .unwrap();
        assert!(repo
            .issue_dispatch_suppression("lin-1", USER_CANCELLED_SUPPRESSION)
            .await
            .unwrap()
            .is_none());
        let manager = WorkerManager::new(repo);
        let token = CancellationToken::new();
        let tracker = StateMovingTracker {
            moved: Arc::new(Mutex::new(Vec::new())),
            fail: true,
            expected_cancelled: token.clone(),
        };
        let stop_intent = Arc::new(Mutex::new(StopIntent::default()));
        let managed = ManagedRun {
            token: token.clone(),
            tracker_config: runtime_config(temp.path()).workflow.front_matter.tracker,
            issue: ready,
            lifecycle: Arc::new(Mutex::new(())),
            stop_intent: stop_intent.clone(),
        };

        let err = manager
            .stop_managed_run(&run.id, managed, &tracker)
            .await
            .unwrap_err();

        assert_eq!(err.to_string(), format!("run {} is not active", run.id));
        assert!(token.is_cancelled());
        let stop_intent = stop_intent.lock().await;
        assert!(stop_intent.suppression_fingerprint.is_none());
        assert!(stop_intent.stopped_state_observed);
        drop(stop_intent);
        assert!(manager
            .repo
            .issue_dispatch_suppression("lin-1", USER_CANCELLED_SUPPRESSION)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn concurrent_stop_failure_after_observation_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        let manager = WorkerManager::new(repo);
        let token = CancellationToken::new();
        let stop_intent = Arc::new(Mutex::new(StopIntent {
            suppression_fingerprint: None,
            stopped_state_observed: true,
        }));
        let managed = ManagedRun {
            token: token.clone(),
            tracker_config: runtime_config(temp.path()).workflow.front_matter.tracker,
            issue: ready,
            lifecycle: Arc::new(Mutex::new(())),
            stop_intent,
        };
        let tracker = StateMovingTracker {
            moved: Arc::new(Mutex::new(Vec::new())),
            fail: true,
            expected_cancelled: token,
        };

        let err = manager
            .stop_managed_run(&run.id, managed, &tracker)
            .await
            .unwrap_err();

        assert_eq!(
            err.to_string(),
            "tracker error: invalid Linear response: state move failed"
        );
        assert!(manager
            .repo
            .issue_dispatch_suppression("lin-1", USER_CANCELLED_SUPPRESSION)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn reconfigure_refreshes_the_running_worker_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let manager =
            WorkerManager::new(Repository::new(pool, symphony_storage::EventBus::default()));
        let mut initial = runtime_config(temp.path());
        initial.repos[0].install_cmd = Some("make get".to_string());
        let shared = std::sync::Arc::new(tokio::sync::RwLock::new(initial));
        {
            let mut inner = manager.inner.lock().await;
            inner.lifecycle = test_running_worker(shared.clone(), CancellationToken::new());
        }
        let mut updated = runtime_config(temp.path());
        updated.repos[0].install_cmd = Some("make gen".to_string());

        let status = manager.reconfigure(start_config(updated)).await;

        assert_eq!(status.state, WorkerState::Running);
        assert_eq!(
            shared.read().await.repos[0].install_cmd.as_deref(),
            Some("make gen")
        );
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            manager.wake.notified(),
        )
        .await
        .expect("reconfigure should wake the worker loop");
    }

    #[tokio::test]
    async fn due_retry_uses_latest_runtime_config_before_dispatch() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());
        let mut latest = config.clone();
        latest.workflow.front_matter.agent.max_concurrent_agents = 0;
        let shared = std::sync::Arc::new(tokio::sync::RwLock::new(latest));
        let stop = CancellationToken::new();
        let ready = issue("todo", vec![]);
        let tracker = StaticTracker {
            active: vec![ready.clone()],
            terminal: vec![],
        };
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        repo.schedule_retry("lin-1", 1, "2000-01-01T00:00:00Z", None, None)
            .await
            .unwrap();

        tick(&repo, &tracker, &config, Some(&shared), &stop)
            .await
            .unwrap();

        assert_eq!(repo.last_run_number("lin-1").await.unwrap(), 0);
        assert_eq!(
            repo.pending_retry_issue_ids().await.unwrap(),
            vec!["lin-1".to_string()]
        );
    }

    #[tokio::test]
    async fn tracker_change_preserves_retry_during_cleanup() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let config = runtime_config(temp.path());
        let mut latest = config.clone();
        latest.workflow.front_matter.tracker.api_key = "new-key".to_string();
        let shared = std::sync::Arc::new(tokio::sync::RwLock::new(latest));
        let stop = CancellationToken::new();
        let ready = issue("todo", vec![]);
        let tracker = StaticTracker {
            active: vec![],
            terminal: vec![],
        };
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        repo.schedule_retry("lin-1", 1, "2000-01-01T00:00:00Z", None, None)
            .await
            .unwrap();

        tick(&repo, &tracker, &config, Some(&shared), &stop)
            .await
            .unwrap();

        assert_eq!(
            repo.pending_retry_issue_ids().await.unwrap(),
            vec!["lin-1".to_string()]
        );
        assert_eq!(repo.last_run_number("lin-1").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn stop_run_rejects_a_finished_run() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        repo.upsert_issues(&[issue("todo", vec![])]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        repo.finish_run(&run.id, RunStatus::Success, None, None)
            .await
            .unwrap();
        let manager = WorkerManager::new(repo);

        let err = manager.stop_run(&run.id).await.unwrap_err();

        assert_eq!(err.to_string(), format!("run {} is not active", run.id));
    }

    #[tokio::test]
    async fn cancellation_finishes_run_without_scheduling_a_retry() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        repo.upsert_issues(&[issue("todo", vec![])]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        repo.schedule_retry("lin-1", 2, "2000-01-01T00:00:00Z", None, None)
            .await
            .unwrap();
        let stop = CancellationToken::new();
        stop.cancel();

        let cancelled = finish_if_cancelled(&repo, &run, &issue("todo", vec![]), &stop, true)
            .await
            .unwrap();

        assert!(cancelled);
        assert_eq!(
            repo.get_run(&run.id)
                .await
                .unwrap()
                .unwrap()
                .status
                .as_str(),
            "cancelled"
        );
        assert!(repo
            .issue_dispatch_suppression("lin-1", USER_CANCELLED_SUPPRESSION)
            .await
            .unwrap()
            .is_some());
        assert!(repo.pending_retry_issue_ids().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn terminal_cancellation_rejects_late_failure_and_success() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("cancellation.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let current_issue = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&current_issue))
            .await
            .unwrap();
        let run = repo
            .try_reserve_run(&current_issue.id, 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        repo.mark_running(&run.id).await.unwrap();
        repo.schedule_retry(
            &current_issue.id,
            2,
            "2000-01-01T00:00:00Z",
            Some("stale"),
            None,
        )
        .await
        .unwrap();
        let stop = CancellationToken::new();
        stop.cancel();

        assert!(
            finish_if_cancelled(&repo, &run, &current_issue, &stop, true)
                .await
                .unwrap()
        );
        fail(
            &repo,
            &runtime_config(temp.path()),
            &run,
            &current_issue,
            "late_failure",
            "a late failure must not outrank cancellation",
        )
        .await
        .unwrap();
        assert!(!repo
            .finish_run(&run.id, RunStatus::Success, None, None)
            .await
            .unwrap());

        let terminal = repo.get_run(&run.id).await.unwrap().unwrap();
        assert_eq!(terminal.status.as_str(), "cancelled");
        assert_eq!(terminal.error_class.as_deref(), Some("cancelled"));
        assert!(repo.pending_retry_issue_ids().await.unwrap().is_empty());
        assert!(repo
            .issue_dispatch_suppression(&current_issue.id, USER_CANCELLED_SUPPRESSION)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn worker_stop_cancellation_does_not_suppress_issue_dispatch() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        repo.upsert_issues(&[issue("todo", vec![])]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        let stop = CancellationToken::new();
        stop.cancel();

        let cancelled = finish_if_cancelled(&repo, &run, &issue("todo", vec![]), &stop, false)
            .await
            .unwrap();

        assert!(cancelled);
        assert!(repo
            .issue_dispatch_suppression("lin-1", USER_CANCELLED_SUPPRESSION)
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn issue_fingerprint_stays_compatible_with_pre_cleanup_issue_shape() {
        let legacy_fingerprint = r#"{"id":"lin-1","identifier":"SYM-1","title":"Test","description":null,"priority":1,"state":"todo","branch":null,"labels":[],"blockers":[],"project_id":null,"project_slug_id":null}"#;
        let mut current_issue: Issue = serde_json::from_str(legacy_fingerprint).unwrap();
        current_issue.completed_at = Some("2026-08-13T10:00:00Z".to_string());
        current_issue.canceled_at = Some("2026-08-13T11:00:00Z".to_string());

        assert_eq!(issue_fingerprint(&current_issue), legacy_fingerprint);
    }

    #[test]
    fn terminal_grace_period_uses_the_latest_terminal_transition() {
        let now = Utc::now();
        let mut terminal_issue = issue("canceled", vec![]);
        terminal_issue.completed_at = Some((now - ChronoDuration::minutes(120)).to_rfc3339());
        terminal_issue.canceled_at = Some((now - ChronoDuration::minutes(30)).to_rfc3339());

        assert!(!terminal_workspace_grace_period_elapsed(
            &terminal_issue,
            now
        ));
    }

    #[test]
    fn terminal_grace_period_rejects_any_malformed_timestamp() {
        let now = Utc::now();
        let mut terminal_issue = issue("canceled", vec![]);
        terminal_issue.completed_at = Some((now - ChronoDuration::minutes(120)).to_rfc3339());
        terminal_issue.canceled_at = Some("not-a-timestamp".to_string());

        assert!(!terminal_workspace_grace_period_elapsed(
            &terminal_issue,
            now
        ));
    }

    #[tokio::test]
    async fn failed_review_move_suppresses_immediate_redispatch() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let mut config = runtime_config(temp.path());
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        let stop = CancellationToken::new();
        stop.cancel();
        finish_if_cancelled(&repo, &run, &ready, &stop, true)
            .await
            .unwrap();
        let tracker = StaticTracker {
            active: vec![ready.clone()],
            terminal: vec![],
        };
        let worker_stop = CancellationToken::new();

        tick(&repo, &tracker, &config, None, &worker_stop)
            .await
            .unwrap();

        assert_eq!(repo.last_run_number("lin-1").await.unwrap(), 1);
        assert!(repo.list_pending().await.unwrap().is_empty());
        assert!(repo.list_running().await.unwrap().is_empty());

        config.workflow.front_matter.agent.max_concurrent_agents = 0;
        let changed = Issue {
            title: "Updated after cancellation".to_string(),
            ..ready
        };
        let tracker = StaticTracker {
            active: vec![changed],
            terminal: vec![],
        };

        tick(&repo, &tracker, &config, None, &worker_stop)
            .await
            .unwrap();

        assert!(repo
            .issue_dispatch_suppression("lin-1", USER_CANCELLED_SUPPRESSION)
            .await
            .unwrap()
            .is_none());
        assert_eq!(repo.last_run_number("lin-1").await.unwrap(), 1);
    }

    #[tokio::test]
    async fn cancellation_during_after_create_wins_over_hook_failure() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let workspace_root = temp.path().canonicalize().unwrap().join("workspaces");
        let mut config = runtime_config(&workspace_root);
        config.workflow.front_matter.hooks.after_create = Some(
            r#"printf started > "$WORKSPACE_PATH/hook-started"
while [ ! -f "$WORKSPACE_PATH/release-hook" ]; do /bin/sleep 0.01; done
echo after_create failed >&2
exit 1
"#
            .to_string(),
        );
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let repo_config = config.repos[0].clone();
        let workspace_path = workspace_manager(&config, &repo_config)
            .path_for(&ready.identifier)
            .unwrap();
        let run = repo
            .try_reserve_run(
                &ready.id,
                1,
                &workspace_path.display().to_string(),
                Some(&repo_config.name),
            )
            .await
            .unwrap()
            .unwrap();
        let stop = CancellationToken::new();
        let mut handle = tokio::spawn(dispatch_run_with_driver(
            repo.clone(),
            config,
            ready,
            repo_config,
            run.clone(),
            stop.clone(),
            mock_driver(AgentOutcome::Success),
        ));

        let hook_started = workspace_path.join("hook-started");
        tokio::select! {
            _ = wait_for_path(&hook_started) => {}
            result = &mut handle => panic!("dispatch finished before after_create hook started: {result:?}"),
        }
        stop.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(2), handle)
            .await
            .expect("dispatch should finish promptly after hook cancellation")
            .unwrap()
            .unwrap();

        let row = repo.get_run(&run.id).await.unwrap().unwrap();
        assert_eq!(row.status.as_str(), "cancelled");
        assert_eq!(row.error_class.as_deref(), Some("cancelled"));
        assert!(repo.pending_retry_issue_ids().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancellation_during_after_run_wins_over_terminal_outcome() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let workspace_root = temp.path().canonicalize().unwrap().join("workspaces");
        let mut config = runtime_config(&workspace_root);
        config.workflow.front_matter.hooks.after_run = Some(
            r#"printf started > "$WORKSPACE_PATH/after-run-started"
while [ ! -f "$WORKSPACE_PATH/release-after-run" ]; do /bin/sleep 0.01; done
"#
            .to_string(),
        );
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let repo_config = config.repos[0].clone();
        let workspace_path = workspace_manager(&config, &repo_config)
            .path_for(&ready.identifier)
            .unwrap();
        let run = repo
            .try_reserve_run(
                &ready.id,
                1,
                &workspace_path.display().to_string(),
                Some(&repo_config.name),
            )
            .await
            .unwrap()
            .unwrap();
        let stop = CancellationToken::new();
        let mut handle = tokio::spawn(dispatch_run_with_driver(
            repo.clone(),
            config,
            ready,
            repo_config,
            run.clone(),
            stop.clone(),
            mock_driver(AgentOutcome::Failure),
        ));

        let hook_started = workspace_path.join("after-run-started");
        tokio::select! {
            _ = wait_for_path(&hook_started) => {}
            result = &mut handle => panic!("dispatch finished before after_run hook started: {result:?}"),
        }
        stop.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(2), handle)
            .await
            .expect("dispatch should finish promptly after hook cancellation")
            .unwrap()
            .unwrap();

        let row = repo.get_run(&run.id).await.unwrap().unwrap();
        assert_eq!(row.status.as_str(), "cancelled");
        assert_eq!(row.error_class.as_deref(), Some("cancelled"));
        assert!(repo.pending_retry_issue_ids().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn stop_without_active_worker_remains_stopped() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let manager =
            WorkerManager::new(Repository::new(pool, symphony_storage::EventBus::default()));

        let status = manager.stop().await;

        assert_eq!(status.state, WorkerState::Stopped);
        assert_eq!(status.started_at, None);
    }

    #[tokio::test]
    async fn workspace_cleanup_continues_after_worker_stop() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let manager = WorkerManager::new(repo.clone());
        manager.start_workspace_cleanup();
        assert_eq!(manager.stop().await.state, WorkerState::Stopped);

        let source = temp.path().join("widgets/SYM-1");
        tokio::fs::create_dir_all(&source).await.unwrap();
        tokio::fs::write(source.join("marker"), "old")
            .await
            .unwrap();
        manager
            .workspace_cleanup
            .quarantine("widgets", "SYM-1", &source)
            .await
            .unwrap();

        for _ in 0..500 {
            if repo.overview().await.unwrap().workspace_cleanup_count == 0 {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("cleanup paused after worker stop");
    }

    #[tokio::test]
    async fn worker_start_emits_workflow_ready_without_db_write() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let bus = symphony_storage::EventBus::default();
        let mut rx = bus.subscribe();
        let repo = Repository::new(pool, bus);
        let manager = WorkerManager::new(repo.clone());
        let config = start_config(runtime_config(temp.path()));
        let expected_hash = config.runtime.workflow().source_hash.clone();

        // Start worker – run_worker emits workflow_ready before any tracker I/O.
        let _status = manager.start(config).await.unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("workflow_ready should be emitted promptly")
            .unwrap();
        assert!(
            matches!(event, symphony_storage::StorageEvent::WorkflowReady),
            "expected WorkflowReady, got {event:?}"
        );
        // Persistence would emit DbChanged { table: "workflows", .. }. The
        // readiness signal must not — Settings refreshes without a DB write,
        // and Overview is not invalidated via the workflows table mapping.
        while let Ok(event) = rx.try_recv() {
            assert!(
                !matches!(
                    event,
                    symphony_storage::StorageEvent::DbChanged { ref table, .. }
                        if table == "workflows"
                ),
                "workflow readiness must not write the workflows table: {event:?}"
            );
        }
        // The in-memory workflow hash is still available for Retro consumers.
        assert!(!expected_hash.is_empty());
        manager.stop().await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    struct SlowCancellationDriver {
        entered: Arc<Notify>,
        cancelling: Arc<Notify>,
        release: Arc<Notify>,
    }

    #[async_trait::async_trait]
    impl AgentDriver for SlowCancellationDriver {
        async fn run(
            &self,
            _request: AgentRunRequest,
            _events: symphony_agents::AgentEventSender,
            cancel: CancellationToken,
        ) -> Result<symphony_agents::AgentRunResult, symphony_agents::AgentError> {
            self.entered.notify_one();
            cancel.cancelled().await;
            self.cancelling.notify_one();
            self.release.notified().await;
            Ok(mock_driver(AgentOutcome::Cancelled).result)
        }
    }

    async fn wait_until_stopped(manager: &WorkerManager) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while manager.status().await.state != WorkerState::Stopped {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("worker did not finish owned children");
    }

    async fn join_run_tasks(config: &RuntimeConfig) {
        let mut tasks = config.run_tasks.lock().await;
        while let Some(result) = tasks.join_next().await {
            result.expect("run supervisor panicked");
        }
    }

    #[tokio::test]
    async fn stop_waits_for_owned_run_and_workspace_before_allowing_restart() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::new(
            symphony_storage::open_sqlite(temp.path().join("worker.sqlite"))
                .await
                .unwrap(),
            symphony_storage::EventBus::default(),
        );
        let manager = WorkerManager::new(repo.clone());
        let mut config = runtime_config(temp.path());
        config.repos[0].url = temp.path().join("missing-local-repo").display().to_string();
        let start = start_config(config);
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let entered = Arc::new(Notify::new());
        let cancelling = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let driver = SlowCancellationDriver {
            entered: entered.clone(),
            cancelling: cancelling.clone(),
            release: release.clone(),
        };
        manager
            .start_with_runner(start.clone(), move |repo, config, stop| async move {
                let config = config.read().await.clone();
                let repo_config = config.repos[0].clone();
                reserve_and_dispatch_with_driver(
                    repo,
                    config,
                    DispatchTarget {
                        issue: ready,
                        repo_config,
                        run_number: None,
                    },
                    stop.clone(),
                    driver,
                )
                .await?;
                stop.cancelled().await;
                Ok(())
            })
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        let run = repo.list_running().await.unwrap().pop().unwrap();

        assert_eq!(manager.stop().await.state, WorkerState::Stopping);
        assert!(matches!(
            manager.start(start.clone()).await,
            Err(WorkerError::AlreadyRunning)
        ));
        tokio::time::timeout(std::time::Duration::from_secs(5), cancelling.notified())
            .await
            .unwrap();
        assert_eq!(manager.status().await.state, WorkerState::Stopping);
        assert_eq!(manager.stop().await.state, WorkerState::Stopping);
        assert_eq!(
            repo.get_run(&run.id).await.unwrap().unwrap().status,
            RunStatus::Running
        );
        assert!(manager
            .workspace_claims
            .try_claim(std::path::Path::new(&run.workspace_path))
            .unwrap()
            .is_none());

        release.notify_one();
        wait_until_stopped(&manager).await;
        assert_eq!(
            repo.get_run(&run.id).await.unwrap().unwrap().status,
            RunStatus::Cancelled
        );
        assert!(manager
            .workspace_claims
            .try_claim(std::path::Path::new(&run.workspace_path))
            .unwrap()
            .is_some());
        assert!(repo.pending_retry_issue_ids().await.unwrap().is_empty());
        manager
            .start_with_runner(start, |_, _, stop| async move {
                stop.cancelled().await;
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(manager.status().await.state, WorkerState::Running);
        manager.stop().await;
        wait_until_stopped(&manager).await;
    }

    #[tokio::test]
    async fn poll_panic_cancels_and_joins_owned_children() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::new(
            symphony_storage::open_sqlite(temp.path().join("worker.sqlite"))
                .await
                .unwrap(),
            symphony_storage::EventBus::default(),
        );
        let manager = WorkerManager::new(repo);
        let cancelled = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let child_cancelled = cancelled.clone();
        let child_release = release.clone();
        manager
            .start_with_runner(
                start_config(runtime_config(temp.path())),
                move |_, config, stop| async move {
                    config
                        .read()
                        .await
                        .run_tasks
                        .lock()
                        .await
                        .spawn(async move {
                            stop.cancelled().await;
                            child_cancelled.notify_one();
                            child_release.notified().await;
                        });
                    panic!("injected polling panic");
                },
            )
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), cancelled.notified())
            .await
            .unwrap();
        assert_eq!(manager.status().await.state, WorkerState::Stopping);
        release.notify_one();
        wait_until_stopped(&manager).await;
        assert!(manager
            .status()
            .await
            .last_error
            .unwrap()
            .contains("injected polling panic"));
    }

    struct ReopeningCleanupTracker {
        terminal: Issue,
        entered: Arc<Notify>,
        release: Arc<Notify>,
    }

    #[async_trait::async_trait]
    impl TrackerClient for ReopeningCleanupTracker {
        async fn preflight(&self) -> Result<(), TrackerError> {
            Ok(())
        }
        async fn fetch_active(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(Vec::new())
        }
        async fn fetch_terminal(&self) -> Result<Vec<Issue>, TrackerError> {
            Ok(vec![self.terminal.clone()])
        }
        async fn fetch_by_id(&self, _id: &str) -> Result<Option<Issue>, TrackerError> {
            let snapshot = self.terminal.clone();
            self.entered.notify_one();
            self.release.notified().await;
            Ok(Some(snapshot))
        }
        async fn fetch_workpads(
            &self,
            _: &[String],
        ) -> Result<Vec<symphony_tracker::WorkpadComment>, TrackerError> {
            Ok(Vec::new())
        }
    }

    #[tokio::test]
    async fn reopened_issue_cannot_reserve_until_terminal_quarantine_releases_claim() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::new(
            symphony_storage::open_sqlite(temp.path().join("worker.sqlite"))
                .await
                .unwrap(),
            symphony_storage::EventBus::default(),
        );
        let mut config = runtime_config(temp.path());
        config.repos[0].url = temp.path().join("missing-local-repo").display().to_string();
        config.workspace_cleanup = Some(WorkspaceCleanupManager::new(repo.clone()));
        let ready = issue("todo", vec![]);
        repo.upsert_issues(std::slice::from_ref(&ready))
            .await
            .unwrap();
        let workspace = workspace_manager(&config, &config.repos[0]);
        let original = workspace.create_or_reuse(&ready).await.unwrap();
        workspace.mark_ready(&ready).await.unwrap();
        tokio::fs::write(original.path.join("old-checkout"), "old")
            .await
            .unwrap();
        let mut terminal = ready.clone();
        terminal.state = "done".to_string();
        terminal.completed_at = Some((Utc::now() - ChronoDuration::hours(2)).to_rfc3339());
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let tracker = ReopeningCleanupTracker {
            terminal,
            entered: entered.clone(),
            release: release.clone(),
        };
        let cleanup_config = config.clone();
        let cleanup_repo = repo.clone();
        let cleanup = tokio::spawn(async move {
            recover_terminal_workspaces(
                &cleanup_repo,
                &tracker,
                &cleanup_config,
                None,
                &CancellationToken::new(),
            )
            .await
            .unwrap()
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
            .await
            .unwrap();

        // Linear has reopened the issue, but cleanup's terminal response is
        // already in flight. The reopened dispatch must not reserve or spawn.
        reserve_and_dispatch_with_driver(
            repo.clone(),
            config.clone(),
            DispatchTarget {
                issue: ready.clone(),
                repo_config: config.repos[0].clone(),
                run_number: None,
            },
            CancellationToken::new(),
            mock_driver(AgentOutcome::Success),
        )
        .await
        .unwrap();
        assert_eq!(repo.last_run_number(&ready.id).await.unwrap(), 0);
        assert!(original.path.join("old-checkout").exists());
        release.notify_one();
        assert!(cleanup.await.unwrap());
        assert!(!original.path.exists());
        assert_eq!(repo.overview().await.unwrap().workspace_cleanup_count, 1);

        // The next poll can now create a new checkout, with no live run ever
        // exposed to the old checkout's quarantine/deletion.
        reserve_and_dispatch_with_driver(
            repo.clone(),
            config.clone(),
            DispatchTarget {
                issue: ready.clone(),
                repo_config: config.repos[0].clone(),
                run_number: None,
            },
            CancellationToken::new(),
            mock_driver(AgentOutcome::Success),
        )
        .await
        .unwrap();
        join_run_tasks(&config).await;
        assert_eq!(repo.last_run_number(&ready.id).await.unwrap(), 1);
        assert!(original.path.join(crate::WORKSPACE_READY_SENTINEL).exists());
        assert!(!original.path.join("old-checkout").exists());
    }

    #[tokio::test]
    async fn provider_switch_ignores_other_provider_limits_for_normal_and_retry_dispatch() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::new(
            symphony_storage::open_sqlite(temp.path().join("worker.sqlite"))
                .await
                .unwrap(),
            symphony_storage::EventBus::default(),
        );
        let mut config = runtime_config(temp.path());
        config.workflow.front_matter.hooks.after_create = Some("exit 1".to_string());
        let ready = issue("todo", vec![]);
        let tracker = StaticTracker {
            active: vec![ready.clone()],
            terminal: Vec::new(),
        };
        repo.upsert_rate_limit(&symphony_core::RateLimitPayload {
            source: "codex_primary".to_string(),
            remaining: Some(0),
            reset_at: Some((Utc::now() + ChronoDuration::hours(1)).to_rfc3339()),
        })
        .await
        .unwrap();
        let stop = CancellationToken::new();
        tick(&repo, &tracker, &config, None, &stop).await.unwrap();
        assert_eq!(repo.last_run_number(&ready.id).await.unwrap(), 0);

        config.workflow.front_matter.agent.backend = AgentBackend::Claude;
        tick(&repo, &tracker, &config, None, &stop).await.unwrap();
        join_run_tasks(&config).await;
        assert_eq!(repo.last_run_number(&ready.id).await.unwrap(), 1);
        repo.schedule_retry(&ready.id, 2, &now_iso(), Some("test_failure"), None)
            .await
            .unwrap();
        config.workflow.front_matter.agent.backend = AgentBackend::Codex;
        tick(&repo, &tracker, &config, None, &stop).await.unwrap();
        assert_eq!(repo.last_run_number(&ready.id).await.unwrap(), 1);
        config.workflow.front_matter.agent.backend = AgentBackend::Claude;
        tick(&repo, &tracker, &config, None, &stop).await.unwrap();
        join_run_tasks(&config).await;
        assert_eq!(repo.last_run_number(&ready.id).await.unwrap(), 2);
    }
}
