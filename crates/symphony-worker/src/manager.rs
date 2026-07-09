use crate::{
    backoff_ms, run_hook, sanitize_key,
    skills::{
        ensure_workspace_skills, github_token_env_has_token_for_repo_url,
        github_token_env_vars_for_repo_url,
    },
    HookInvocation, SkillFile, WorkspaceManager,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
};
use symphony_agents::{
    AgentDriver, AgentRunRequest, ClaudeRunOptions, CursorRunOptions, NativeAgentDriver,
    OpencodeRunOptions,
};
use symphony_core::{
    append_retry_context, render_prompt, route_issue, AgentBackend, AgentOutcome, HookName, Issue,
    MappedAgentEvent, ParsedWorkflow, RepoConfig, RetryContext, RunStatus, TokenCountPayload,
};
use symphony_storage::{now_iso, Repository, RunRow, StorageError};
use symphony_tracker::{LinearTracker, TrackerClient, TrackerError};
use thiserror::Error;
use tokio::{
    sync::{mpsc, Mutex, Notify, RwLock},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use tracing::{error, warn};
use uuid::Uuid;

const USER_CANCELLED_SUPPRESSION: &str = "user_cancelled";

#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("worker is already running")]
    AlreadyRunning,
    #[error("run {0} was not found")]
    RunNotFound(String),
    #[error("run {0} is not active")]
    RunNotActive(String),
    #[error("run {0} is not managed by this worker")]
    RunNotManaged(String),
    #[error("tracker error: {0}")]
    Tracker(#[from] TrackerError),
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkerStartConfig {
    pub workflow: ParsedWorkflow,
    /// Configured repositories; each issue is routed to one of them.
    pub repos: Vec<RepoConfig>,
    /// Bundled Symphony skills copied into issue workspaces when missing.
    pub skills: Vec<SkillFile>,
    pub env: BTreeMap<String, String>,
    /// User-configured variables explicitly injected into each agent session.
    pub session_env: BTreeMap<String, String>,
    pub app_data_dir: PathBuf,
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
    status: WorkerStatus,
    stop: Option<CancellationToken>,
    handle: Option<JoinHandle<()>>,
    runtime_config: Option<SharedRuntimeConfig>,
    reconfigure_generation: u64,
}

type SharedRuntimeConfig = Arc<RwLock<RuntimeConfig>>;

#[derive(Debug, Clone, Default)]
struct RunCancellationRegistry {
    tokens: Arc<Mutex<BTreeMap<String, CancellationToken>>>,
    user_requested: Arc<Mutex<BTreeSet<String>>>,
}

impl RunCancellationRegistry {
    async fn register(&self, run_id: &str, token: CancellationToken) {
        self.tokens.lock().await.insert(run_id.to_string(), token);
        self.user_requested.lock().await.remove(run_id);
    }

    async fn cancel(&self, run_id: &str) -> bool {
        let token = self.tokens.lock().await.get(run_id).cloned();
        if let Some(token) = token {
            self.user_requested.lock().await.insert(run_id.to_string());
            token.cancel();
            true
        } else {
            false
        }
    }

    async fn was_user_requested(&self, run_id: &str) -> bool {
        self.user_requested.lock().await.contains(run_id)
    }

    async fn unregister(&self, run_id: &str) {
        self.tokens.lock().await.remove(run_id);
        self.user_requested.lock().await.remove(run_id);
    }
}

#[derive(Debug, Clone)]
pub struct WorkerManager {
    repo: Repository,
    inner: Arc<Mutex<InnerState>>,
    run_cancellations: RunCancellationRegistry,
    wake: Arc<Notify>,
}

impl WorkerManager {
    pub fn new(repo: Repository) -> Self {
        Self {
            repo,
            inner: Arc::new(Mutex::new(InnerState {
                status: WorkerStatus {
                    state: WorkerState::Stopped,
                    started_at: None,
                    last_error: None,
                },
                stop: None,
                handle: None,
                runtime_config: None,
                reconfigure_generation: 0,
            })),
            run_cancellations: RunCancellationRegistry::default(),
            wake: Arc::new(Notify::new()),
        }
    }

    pub async fn status(&self) -> WorkerStatus {
        self.inner.lock().await.status.clone()
    }

    pub async fn start(&self, config: WorkerStartConfig) -> Result<WorkerStatus, WorkerError> {
        {
            let mut inner = self.inner.lock().await;
            if inner.status.state == WorkerState::Running {
                return Err(WorkerError::AlreadyRunning);
            }
            let stop = CancellationToken::new();
            let repo = self.repo.clone();
            let manager = self.clone();
            let runtime = runtime_config_from_start(
                config,
                self.run_cancellations.clone(),
                self.wake.clone(),
            );
            let runtime_config = Arc::new(RwLock::new(runtime));
            let stop_for_task = stop.clone();
            inner.status = WorkerStatus {
                state: WorkerState::Running,
                started_at: Some(now_iso()),
                last_error: None,
            };
            inner.reconfigure_generation = inner.reconfigure_generation.wrapping_add(1);
            inner.stop = Some(stop);
            inner.runtime_config = Some(runtime_config.clone());
            inner.handle = Some(tokio::spawn(async move {
                let result = run_worker(repo, runtime_config, stop_for_task).await;
                let mut inner = manager.inner.lock().await;
                inner.status.state = WorkerState::Stopped;
                inner.status.started_at = None;
                inner.status.last_error = result.err().map(|err| err.to_string());
                inner.stop = None;
                inner.handle = None;
                inner.runtime_config = None;
                inner.reconfigure_generation = inner.reconfigure_generation.wrapping_add(1);
            }));
        }
        Ok(self.status().await)
    }

    /// Refresh the settings snapshot used by future worker ticks. Runs that
    /// have already been dispatched keep the config they started with.
    pub async fn reconfigure(&self, config: WorkerStartConfig) -> WorkerStatus {
        self.reconfigure_with_tracker_preflight(config, preflight_tracker_config)
            .await
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
        let runtime =
            runtime_config_from_start(config, self.run_cancellations.clone(), self.wake.clone());
        let (runtime_config, generation) = {
            let mut inner = self.inner.lock().await;
            if inner.status.state != WorkerState::Running {
                return inner.status.clone();
            }
            inner.reconfigure_generation = inner.reconfigure_generation.wrapping_add(1);
            (inner.runtime_config.clone(), inner.reconfigure_generation)
        };
        if let Some(runtime_config) = runtime_config {
            let current = runtime_config.read().await.clone();
            if current.workflow.front_matter.tracker != runtime.workflow.front_matter.tracker {
                if let Err(err) =
                    preflight_tracker(runtime.workflow.front_matter.tracker.clone()).await
                {
                    let mut inner = self.inner.lock().await;
                    if inner.status.state == WorkerState::Running
                        && inner.reconfigure_generation == generation
                    {
                        inner.status.last_error = Some(err.to_string());
                    }
                    return inner.status.clone();
                }
            }
            {
                let mut inner = self.inner.lock().await;
                if inner.status.state != WorkerState::Running {
                    return inner.status.clone();
                }
                if inner.reconfigure_generation != generation {
                    return inner.status.clone();
                }
                *runtime_config.write().await = runtime;
                inner.status.last_error = None;
            }
            self.wake.notify_one();
        }
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
        if self.run_cancellations.cancel(run_id).await {
            self.repo
                .append_event(
                    run_id,
                    symphony_core::AgentEventKind::Status,
                    &serde_json::json!({ "message": "Run cancellation requested" }),
                )
                .await
                .ok();
            return Ok(());
        }

        let Some(run) = self.repo.get_run(run_id).await? else {
            return Err(WorkerError::RunNotFound(run_id.to_string()));
        };
        if matches!(run.status.as_str(), "pending" | "running") {
            return Err(WorkerError::RunNotManaged(run_id.to_string()));
        }
        Err(WorkerError::RunNotActive(run_id.to_string()))
    }

    pub async fn stop(&self) -> WorkerStatus {
        let mut inner = self.inner.lock().await;
        if inner.stop.is_none() && inner.handle.is_none() {
            inner.status.state = WorkerState::Stopped;
            inner.status.started_at = None;
            inner.runtime_config = None;
            inner.reconfigure_generation = inner.reconfigure_generation.wrapping_add(1);
            return inner.status.clone();
        }
        inner.status.state = WorkerState::Stopping;
        inner.reconfigure_generation = inner.reconfigure_generation.wrapping_add(1);
        if let Some(stop) = &inner.stop {
            stop.cancel();
        }
        inner.status.clone()
    }
}

#[derive(Debug, Clone)]
struct RuntimeConfig {
    workflow: ParsedWorkflow,
    repos: Vec<RepoConfig>,
    skills: Vec<SkillFile>,
    env: BTreeMap<String, String>,
    session_env: BTreeMap<String, String>,
    app_data_dir: PathBuf,
    run_cancellations: RunCancellationRegistry,
    wake: Arc<Notify>,
}

fn runtime_config_from_start(
    config: WorkerStartConfig,
    run_cancellations: RunCancellationRegistry,
    wake: Arc<Notify>,
) -> RuntimeConfig {
    RuntimeConfig {
        workflow: config.workflow,
        repos: config.repos,
        skills: config.skills,
        env: config.env,
        session_env: config.session_env,
        app_data_dir: config.app_data_dir,
        run_cancellations,
        wake,
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
    repo.upsert_workflow(&initial_config.workflow).await?;
    let tracker_config = initial_config.workflow.front_matter.tracker.clone();
    let tracker = LinearTracker::new(tracker_config.clone());
    tracker.preflight().await?;
    recover(&repo, &tracker, &initial_config).await?;
    let started_at = now_iso();
    repo.upsert_worker_heartbeat(&started_at, std::process::id() as i64)
        .await?;

    let heartbeat_repo = repo.clone();
    let heartbeat_stop = stop.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = heartbeat_stop.cancelled() => break,
                _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {
                    if heartbeat_stop.is_cancelled() {
                        break;
                    }
                    let _ = heartbeat_repo.beat_worker_heartbeat().await;
                }
            }
        }
    });

    run_loop(&repo, &config, &stop, tracker, tracker_config, |cfg| {
        LinearTracker::new(cfg.clone())
    })
    .await;
    Ok(())
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
            error!(error = %err, "worker tick failed");
        }
        let interval_ms = current_config.workflow.front_matter.polling.interval_ms;
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = current_config.wake.notified() => {}
            _ = tokio::time::sleep(std::time::Duration::from_millis(interval_ms)) => {}
        }
    }
}

async fn recover<T: TrackerClient>(
    repo: &Repository,
    tracker: &T,
    config: &RuntimeConfig,
) -> Result<(), WorkerError> {
    for run in repo.list_running().await? {
        warn!(run_id = %run.id, issue_id = %run.issue_id, "orphan run marked crashed");
        repo.delete_live_session(&run.id).await.ok();
        repo.finish_run(
            &run.id,
            RunStatus::Failure,
            Some("process_crashed"),
            Some("worker restarted while run was in-flight"),
        )
        .await?;
        let due = due_after(backoff_ms(
            run.run_number,
            config.workflow.front_matter.agent.max_retry_backoff_ms,
        ));
        repo.schedule_retry(
            &run.issue_id,
            run.run_number + 1,
            &due,
            Some("process_crashed"),
            Some("worker restart"),
        )
        .await?;
    }
    for run in repo.list_pending().await? {
        repo.finish_run(
            &run.id,
            RunStatus::Failure,
            Some("process_crashed"),
            Some("worker restarted before run was claimed"),
        )
        .await?;
        let due = due_after(backoff_ms(
            run.run_number,
            config.workflow.front_matter.agent.max_retry_backoff_ms,
        ));
        repo.schedule_retry(
            &run.issue_id,
            run.run_number + 1,
            &due,
            Some("process_crashed"),
            Some("worker restart"),
        )
        .await?;
    }
    repo.delete_orphaned_pending_sessions().await.ok();
    if let Ok(terminal) = tracker.fetch_terminal().await {
        for issue in terminal {
            if !repo.has_active_run(&issue.id).await.unwrap_or(true) {
                if let Some(repo_config) = route_issue(&config.repos, &issue) {
                    let _ = workspace_manager(config, repo_config).remove(&issue).await;
                }
            }
        }
    }
    Ok(())
}

/// Await `fut`, but bail the moment `stop` is cancelled, returning `None`.
///
/// The tracker's Linear calls take no cancellation token and can block for
/// ~15s per attempt (~47s across retries), so a stop issued mid-tick would
/// otherwise have to wait them out. Wrapping each tracker call lets `tick`
/// abandon the network wait and unwind through its normal early returns instead
/// of being force-dropped at an arbitrary await — which would not be
/// cancellation-safe across [`reserve_and_dispatch`]'s reserve → spawn handoff.
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
            Ok(Some(issue)) => repo.upsert_issues(&[issue]).await?,
            Ok(None) => warn!(
                issue_id = %issue_id,
                "issue left the active set and is gone from the tracker; keeping last known state"
            ),
            Err(err) => warn!(
                issue_id = %issue_id,
                error = %err,
                "failed to refresh issue that left the active set"
            ),
        }
    }

    if !repo.active_rate_limits(&now_iso()).await?.is_empty() {
        return Ok(());
    }

    let retry_ids = repo.pending_retry_issue_ids().await?;
    for issue in active {
        if stop.is_cancelled() {
            return Ok(());
        }
        if !issue.blockers.is_empty() || retry_ids.contains(&issue.id) {
            continue;
        }
        if let Some(fingerprint) = repo
            .issue_dispatch_suppression(&issue.id, USER_CANCELLED_SUPPRESSION)
            .await?
        {
            if fingerprint == issue_fingerprint(&issue) {
                continue;
            }
            repo.clear_issue_dispatch_suppression(&issue.id, USER_CANCELLED_SUPPRESSION)
                .await?;
        }
        if repo.has_active_run(&issue.id).await? {
            continue;
        }
        let Some(dispatch_config) =
            latest_runtime_config_if_tracker_matches(config, latest_config).await
        else {
            return Ok(());
        };
        let Some(repo_config) = route_issue(&dispatch_config.repos, &issue) else {
            warn!(
                issue = %issue.identifier,
                "no repository matches this issue; skipping (add a repo:<name> or matching bare label, add a matching repo rule, or mark a default)"
            );
            continue;
        };
        if repo.count_active().await?
            >= dispatch_config
                .workflow
                .front_matter
                .agent
                .max_concurrent_agents as i64
        {
            break;
        }
        reserve_and_dispatch(
            repo.clone(),
            dispatch_config.clone(),
            issue,
            repo_config.clone(),
            None,
            stop.clone(),
        )
        .await?;
    }

    let due = repo.due_retries(&now_iso()).await?;
    for retry in due {
        if stop.is_cancelled() {
            return Ok(());
        }
        let Some(dispatch_config) =
            latest_runtime_config_if_tracker_matches(config, latest_config).await
        else {
            return Ok(());
        };
        if repo.count_active().await?
            >= dispatch_config
                .workflow
                .front_matter
                .agent
                .max_concurrent_agents as i64
        {
            break;
        }
        let fetched =
            match cancellable(stop, tracker.fetch_by_id_for_dispatch(&retry.issue_id)).await {
                Some(result) => result?,
                None => return Ok(()),
            };
        if let Some(issue) = fetched {
            // The issue may have left the active set since the failed run
            // (e.g. moved to Done); drop the retry rather than keep it queued
            // or dispatch a run nobody asked for.
            let is_active = dispatch_config
                .workflow
                .front_matter
                .tracker
                .active_states
                .iter()
                .any(|state| state.eq_ignore_ascii_case(&issue.state));
            if !is_active {
                repo.clear_retry(&retry.issue_id).await?;
                continue;
            }
            // The issue may have become blocked since the failed run; keep the
            // retry queued so it dispatches once the blocker clears.
            if !issue.blockers.is_empty() {
                continue;
            }
            // If the issue is still active but no longer routes anywhere
            // (e.g. the default repo was cleared), drop the retry. Otherwise
            // retry_ids suppresses the normal active-dispatch path forever.
            let Some(repo_config) = route_issue(&dispatch_config.repos, &issue) else {
                warn!(
                    issue = %issue.identifier,
                    "no repository matches this retry; clearing it"
                );
                repo.clear_retry(&retry.issue_id).await?;
                continue;
            };
            reserve_and_dispatch(
                repo.clone(),
                dispatch_config.clone(),
                issue,
                repo_config.clone(),
                Some(retry.run_number),
                stop.clone(),
            )
            .await?;
        } else {
            repo.clear_retry(&retry.issue_id).await?;
        }
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
    let workspaces = workspace_manager(&config, &repo_config);
    let workspace_path = workspaces
        .path_for(&issue.identifier)
        .map_err(|err| StorageError::Sqlx(sqlx::Error::Protocol(err.to_string())))?;
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
    let run_stop = stop.child_token();
    config
        .run_cancellations
        .register(&run.id, run_stop.clone())
        .await;
    let run_cancellations = config.run_cancellations.clone();
    tokio::spawn(async move {
        let result = tokio::spawn(dispatch_run(
            repo,
            config,
            issue,
            repo_config,
            run,
            run_stop,
        ))
        .await;
        handle_dispatch_result(
            result,
            &recovery_repo,
            &recovery_issue_id,
            &recovery_run,
            retry_backoff_cap,
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
) {
    match result {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            let message = err.to_string();
            error!(error = %err, "dispatch failed");
            recover_stranded_run(
                repo,
                issue_id,
                run,
                retry_backoff_cap,
                "dispatch_error",
                &message,
            )
            .await;
        }
        Err(err) => {
            let class = if err.is_panic() {
                "dispatch_panic"
            } else {
                "dispatch_cancelled"
            };
            let message = format!("dispatch task ended without cleanup: {err}");
            error!(error = %err, "dispatch task ended without cleanup");
            recover_stranded_run(repo, issue_id, run, retry_backoff_cap, class, &message).await;
        }
    }
}

/// Mark a run that fell out of `dispatch_run` via an unhandled error as failed
/// and queue a retry — the safety net for the reserve → running → finish path.
///
/// `dispatch_run` may have already reached a terminal state before the error
/// escaped (e.g. `fail()` finished the run but its retry insert then errored),
/// so only rescue rows still stuck `pending`/`running`. That keeps this
/// idempotent: we never re-stamp `ended_at` or double-queue a retry for a run
/// that already finished. Every step is best-effort — we are already on the
/// error path and cannot propagate — and anything we cannot fix here is still
/// caught by the worker-restart `recover()` sweep.
async fn recover_stranded_run(
    repo: &Repository,
    issue_id: &str,
    run: &RunRow,
    retry_backoff_cap: u64,
    class: &str,
    message: &str,
) {
    // dispatch_run's normal end-of-run delete_live_session is skipped when it
    // returns early via `?`, so clean it up here regardless of the run's
    // status: overview() surfaces every live_sessions row and the restart
    // cleanup only prunes `pending-*` ones, so a leftover would keep a failed
    // run showing as live indefinitely.
    repo.delete_live_session(&run.id).await.ok();

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
    if let Err(finish_err) = repo
        .finish_run(&run.id, RunStatus::Failure, Some(class), Some(message))
        .await
    {
        error!(
            error = %finish_err,
            run_id = %run.id,
            "could not finish stranded run; leaving it for worker-restart recovery"
        );
        return;
    }
    let due = due_after(backoff_ms(run.run_number, retry_backoff_cap));
    if let Err(retry_err) = repo
        .schedule_retry(
            issue_id,
            run.run_number + 1,
            &due,
            Some(class),
            Some(message),
        )
        .await
    {
        error!(
            error = %retry_err,
            run_id = %run.id,
            "finished stranded run but could not schedule its retry"
        );
    }
}

async fn dispatch_run(
    repo: Repository,
    config: RuntimeConfig,
    issue: Issue,
    repo_config: RepoConfig,
    run: RunRow,
    stop: CancellationToken,
) -> Result<(), WorkerError> {
    dispatch_run_with_driver(
        repo,
        config,
        issue,
        repo_config,
        run,
        stop,
        NativeAgentDriver,
    )
    .await
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
    let workspaces = workspace_manager(&config, &repo_config);
    if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
        return Ok(());
    }
    adopt_legacy_workspace(&repo, &config, &issue, &run, &workspaces).await;
    let workspace = workspaces
        .create_or_reuse(&issue)
        .await
        .map_err(|err| StorageError::Sqlx(sqlx::Error::Protocol(err.to_string())))?;
    let env = run_env(&config.env, &repo_config);

    if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
        return Ok(());
    }
    if workspace.needs_init {
        if let Some(script) = &config.workflow.front_matter.hooks.after_create {
            let result = run_hook(HookInvocation {
                hook: HookName::AfterCreate,
                script,
                issue: &issue,
                workspace_path: &workspace.path,
                run_number: run.run_number,
                timeout_ms: config.workflow.front_matter.hooks.timeout_ms,
                env: &env,
                cancel: &stop,
            })
            .await;
            repo.record_hook(
                &run.id,
                HookName::AfterCreate,
                i64::from(result.exit_code),
                result.duration_ms,
                result.stderr_tail.as_deref(),
            )
            .await?;
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
        .map_err(|err| StorageError::Sqlx(sqlx::Error::Protocol(err.to_string())))?;
    if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
        return Ok(());
    }

    if workspace.needs_init {
        workspaces
            .mark_ready(&issue)
            .await
            .map_err(|err| StorageError::Sqlx(sqlx::Error::Protocol(err.to_string())))?;
    }

    match repo.mark_running(&run.id).await {
        Ok(()) => {}
        Err(StorageError::AlreadyRunning(_)) => {
            repo.finish_run(
                &run.id,
                RunStatus::Cancelled,
                Some("reconciled"),
                Some("lost race to a concurrent run for the same issue"),
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
        let result = run_hook(HookInvocation {
            hook: HookName::BeforeRun,
            script,
            issue: &issue,
            workspace_path: &workspace.path,
            run_number: run.run_number,
            timeout_ms: config.workflow.front_matter.hooks.timeout_ms,
            env: &env,
            cancel: &stop,
        })
        .await;
        repo.record_hook(
            &run.id,
            HookName::BeforeRun,
            i64::from(result.exit_code),
            result.duration_ms,
            result.stderr_tail.as_deref(),
        )
        .await?;
    }

    if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
        return Ok(());
    }
    ensure_workspace_skills(&workspace.path, &config.skills)
        .await
        .map_err(|err| StorageError::Sqlx(sqlx::Error::Protocol(err.to_string())))?;
    if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
        return Ok(());
    }

    let mut prompt = render_prompt(&config.workflow.prompt_template, &issue, Some(&repo_config));
    if let Some(prior) = repo.prior_run(&issue.id, &run.id).await? {
        let recent_events = repo
            .recent_events_for_issue(&issue.id, 10)
            .await?
            .into_iter()
            .map(|event| format!("{}: {}", event.kind, event.payload))
            .collect();
        prompt = append_retry_context(
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
            &format!("{session}-{session}"),
            session,
            session,
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
                    persist_run_event(&repo, &run.id, provider, &event).await?;
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
        persist_run_event(&repo, &run.id, provider, &event).await?;
    }

    match result {
        Ok(result) => {
            repo.upsert_live_session(
                &run.id,
                &format!("{}-{}", result.thread_id, result.turn_id),
                &result.thread_id,
                &result.turn_id,
                &TokenCountPayload {
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0,
                },
            )
            .await?;
            if let Some(script) = &config.workflow.front_matter.hooks.after_run {
                let hook = run_hook(HookInvocation {
                    hook: HookName::AfterRun,
                    script,
                    issue: &issue,
                    workspace_path: &workspace.path,
                    run_number: run.run_number,
                    timeout_ms: config.workflow.front_matter.hooks.timeout_ms,
                    env: &env,
                    cancel: &stop,
                })
                .await;
                repo.record_hook(
                    &run.id,
                    HookName::AfterRun,
                    i64::from(hook.exit_code),
                    hook.duration_ms,
                    hook.stderr_tail.as_deref(),
                )
                .await?;
            }
            if finish_if_cancelled_for_run(&repo, &config, &run, &issue, &stop).await? {
                return Ok(());
            }
            match result.outcome {
                AgentOutcome::Success => {
                    repo.finish_run(&run.id, RunStatus::Success, None, None)
                        .await?;
                    repo.clear_retry(&issue.id).await?;
                }
                AgentOutcome::Cancelled => {
                    repo.finish_run(
                        &run.id,
                        RunStatus::Cancelled,
                        result.error_class.as_deref(),
                        result.error_message.as_deref(),
                    )
                    .await?;
                    repo.clear_retry(&issue.id).await?;
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
    repo.delete_live_session(&run.id).await.ok();
    Ok(())
}

async fn finish_if_cancelled_for_run(
    repo: &Repository,
    config: &RuntimeConfig,
    run: &RunRow,
    issue: &Issue,
    stop: &CancellationToken,
) -> Result<bool, WorkerError> {
    let suppress_dispatch = config.run_cancellations.was_user_requested(&run.id).await;
    finish_if_cancelled(repo, run, issue, stop, suppress_dispatch).await
}

async fn finish_if_cancelled(
    repo: &Repository,
    run: &RunRow,
    issue: &Issue,
    stop: &CancellationToken,
    suppress_dispatch: bool,
) -> Result<bool, WorkerError> {
    if !stop.is_cancelled() {
        return Ok(false);
    }
    repo.finish_run(
        &run.id,
        RunStatus::Cancelled,
        Some("cancelled"),
        Some("run cancelled"),
    )
    .await?;
    if suppress_dispatch {
        repo.suppress_issue_dispatch(
            &issue.id,
            USER_CANCELLED_SUPPRESSION,
            &issue_fingerprint(issue),
        )
        .await?;
    }
    repo.clear_retry(&issue.id).await?;
    repo.delete_live_session(&run.id).await.ok();
    Ok(true)
}

fn issue_fingerprint(issue: &Issue) -> String {
    serde_json::to_string(issue).expect("issue serialization should not fail")
}

async fn persist_run_event(
    repo: &Repository,
    run_id: &str,
    provider: &str,
    event: &MappedAgentEvent,
) -> Result<(), WorkerError> {
    // A null payload marks a metadata-only event (e.g. a thinking-token
    // update): persist the side channels but keep it out of the visible
    // event log.
    if !event.payload.is_null() {
        repo.append_event(run_id, event.kind.clone(), &event.payload)
            .await?;
    }
    if let Some(info) = &event.session_info {
        repo.set_run_session_info(run_id, info).await?;
    }
    if let Some(tokens) = &event.tokens {
        repo.upsert_live_session(run_id, &format!("pending-{run_id}"), "", "", tokens)
            .await?;
        repo.update_tokens(run_id, tokens).await?;
        repo.record_token_usage(provider, tokens).await?;
    }
    if let Some(rate_limit) = &event.rate_limit {
        repo.upsert_rate_limit(rate_limit).await?;
    }
    if let Some(summary) = &event.humanized {
        repo.append_event(
            run_id,
            symphony_core::AgentEventKind::Humanized,
            &serde_json::json!({ "summary": summary }),
        )
        .await?;
    }
    Ok(())
}

async fn fail(
    repo: &Repository,
    config: &RuntimeConfig,
    run: &RunRow,
    issue: &Issue,
    class: &str,
    message: &str,
) -> Result<(), WorkerError> {
    repo.finish_run(&run.id, RunStatus::Failure, Some(class), Some(message))
        .await?;
    let due = due_after(backoff_ms(
        run.run_number,
        config.workflow.front_matter.agent.max_retry_backoff_ms,
    ));
    repo.schedule_retry(
        &issue.id,
        run.run_number + 1,
        &due,
        Some(class),
        Some(message),
    )
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
    WorkspaceManager::new(root.join(sanitize_key(repo.name.trim())))
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
    use symphony_tracker::StaticTracker;

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
        }
    }

    fn start_config(config: RuntimeConfig) -> WorkerStartConfig {
        WorkerStartConfig {
            workflow: config.workflow,
            repos: config.repos,
            skills: config.skills,
            env: config.env,
            session_env: config.session_env,
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
            pr_urls: vec![],
            project_id: None,
            project_slug_id: None,
        }
    }

    struct DispatchFilteringTracker {
        by_id: Option<Issue>,
        by_id_for_dispatch: Option<Issue>,
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
            "sess-sess",
            "sess",
            "sess",
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
        )
        .await;

        // The row is now terminal and a retry is queued, freeing its slot.
        assert_eq!(
            repo.get_run(&run.id).await.unwrap().unwrap().status,
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
            "sess-sess",
            "sess",
            "sess",
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
        handle_dispatch_result(result, &repo, "lin-1", &run, 60_000).await;

        let row = repo.get_run(&run.id).await.unwrap().unwrap();
        assert_eq!(row.status, "failure");
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
        )
        .await;

        // The success stands: no spurious failure overwrite, no retry queued.
        assert_eq!(
            repo.get_run(&run.id).await.unwrap().unwrap().status,
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
        // No default and no matching team/project rule: a retry created before
        // this route change should not suppress active dispatch forever.
        config.repos = vec![RepoConfig {
            name: "web".to_string(),
            team_prefixes: vec!["WEB".to_string()],
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
        // Two repos, neither default, no rule matching SYM-1: unroutable.
        config.repos = vec![
            RepoConfig {
                name: "web".to_string(),
                team_prefixes: vec!["WEB".to_string()],
                ..RepoConfig::default()
            },
            RepoConfig {
                name: "backend".to_string(),
                team_prefixes: vec!["ENG".to_string()],
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
            repo.get_run(&run.id).await.unwrap().unwrap().status,
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
            repo.get_run(&run.id).await.unwrap().unwrap().status,
            "success"
        );
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
            inner.status = WorkerStatus {
                state: WorkerState::Running,
                started_at: Some(now_iso()),
                last_error: None,
            };
            inner.stop = Some(stop.clone());
            inner.runtime_config = Some(shared.clone());
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
            inner.status = WorkerStatus {
                state: WorkerState::Running,
                started_at: Some(now_iso()),
                last_error: None,
            };
            inner.runtime_config = Some(shared.clone());
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
    async fn stop_run_cancels_only_the_requested_run() {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let manager = WorkerManager::new(repo);
        let first = CancellationToken::new();
        let second = CancellationToken::new();

        manager
            .run_cancellations
            .register("run-1", first.clone())
            .await;
        manager
            .run_cancellations
            .register("run-2", second.clone())
            .await;

        manager.stop_run("run-1").await.unwrap();

        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
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
            inner.status = WorkerStatus {
                state: WorkerState::Running,
                started_at: Some(now_iso()),
                last_error: None,
            };
            inner.runtime_config = Some(shared.clone());
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
            repo.get_run(&run.id).await.unwrap().unwrap().status,
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

    #[tokio::test]
    async fn user_cancelled_active_issue_is_not_immediately_redispatched() {
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
        assert!(repo
            .issue_dispatch_suppression("lin-1", USER_CANCELLED_SUPPRESSION)
            .await
            .unwrap()
            .is_some());
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
        assert_eq!(row.status, "cancelled");
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
        assert_eq!(row.status, "cancelled");
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

        {
            let mut inner = manager.inner.lock().await;
            inner.status = WorkerStatus {
                state: WorkerState::Running,
                started_at: Some(now_iso()),
                last_error: None,
            };
        }

        let status = manager.stop().await;

        assert_eq!(status.state, WorkerState::Stopped);
        assert_eq!(status.started_at, None);
    }
}
