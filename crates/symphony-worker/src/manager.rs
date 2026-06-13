use crate::{backoff_ms, run_hook, sanitize_key, WorkspaceManager};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use symphony_agents::{AgentDriver, AgentRunRequest, ClaudeRunOptions, NativeAgentDriver};
use symphony_core::{
    append_retry_context, render_prompt, route_issue, AgentBackend, AgentOutcome, HookName, Issue,
    MappedAgentEvent, ParsedWorkflow, RepoConfig, RetryContext, RunStatus, TokenCountPayload,
};
use symphony_storage::{now_iso, Repository, RunRow, StorageError};
use symphony_tracker::{LinearTracker, TrackerClient, TrackerError};
use thiserror::Error;
use tokio::{
    sync::{mpsc, Mutex},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use tracing::{error, warn};
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("worker is already running")]
    AlreadyRunning,
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
}

#[derive(Debug, Clone)]
pub struct WorkerManager {
    repo: Repository,
    inner: Arc<Mutex<InnerState>>,
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
            })),
        }
    }

    pub async fn status(&self) -> WorkerStatus {
        self.inner.lock().await.status.clone()
    }

    pub async fn start(&self, config: WorkerStartConfig) -> Result<WorkerStatus, WorkerError> {
        let workflow = config.workflow;
        {
            let mut inner = self.inner.lock().await;
            if inner.status.state == WorkerState::Running {
                return Err(WorkerError::AlreadyRunning);
            }
            let stop = CancellationToken::new();
            let repo = self.repo.clone();
            let manager = self.clone();
            let runtime = RuntimeConfig {
                workflow,
                repos: config.repos,
                env: config.env,
                session_env: config.session_env,
                app_data_dir: config.app_data_dir,
            };
            let stop_for_task = stop.clone();
            inner.status = WorkerStatus {
                state: WorkerState::Running,
                started_at: Some(now_iso()),
                last_error: None,
            };
            inner.stop = Some(stop);
            inner.handle = Some(tokio::spawn(async move {
                let result = run_worker(repo, runtime, stop_for_task).await;
                let mut inner = manager.inner.lock().await;
                inner.status.state = WorkerState::Stopped;
                inner.status.started_at = None;
                inner.status.last_error = result.err().map(|err| err.to_string());
                inner.stop = None;
                inner.handle = None;
            }));
        }
        Ok(self.status().await)
    }

    pub async fn stop(&self) -> WorkerStatus {
        let mut inner = self.inner.lock().await;
        if inner.stop.is_none() && inner.handle.is_none() {
            inner.status.state = WorkerState::Stopped;
            inner.status.started_at = None;
            return inner.status.clone();
        }
        inner.status.state = WorkerState::Stopping;
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
    env: BTreeMap<String, String>,
    session_env: BTreeMap<String, String>,
    app_data_dir: PathBuf,
}

async fn run_worker(
    repo: Repository,
    config: RuntimeConfig,
    stop: CancellationToken,
) -> Result<(), WorkerError> {
    repo.upsert_workflow(&config.workflow).await?;
    let tracker = LinearTracker::new(config.workflow.front_matter.tracker.clone());
    tracker.preflight().await?;
    recover(&repo, &tracker, &config).await?;
    let started_at = now_iso();
    repo.upsert_worker_heartbeat(&started_at, std::process::id() as i64)
        .await?;

    let heartbeat_repo = repo.clone();
    let heartbeat_stop = stop.clone();
    tokio::spawn(async move {
        while !heartbeat_stop.is_cancelled() {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let _ = heartbeat_repo.beat_worker_heartbeat().await;
        }
    });

    while !stop.is_cancelled() {
        if let Err(err) = tick(&repo, &tracker, &config, &stop).await {
            error!(error = %err, "worker tick failed");
        }
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = tokio::time::sleep(std::time::Duration::from_millis(config.workflow.front_matter.polling.interval_ms)) => {}
        }
    }
    Ok(())
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

async fn tick<T: TrackerClient>(
    repo: &Repository,
    tracker: &T,
    config: &RuntimeConfig,
    stop: &CancellationToken,
) -> Result<(), WorkerError> {
    let active = tracker.fetch_active().await?;
    repo.upsert_issues(&active).await?;

    let active_ids = active
        .iter()
        .map(|issue| issue.id.clone())
        .collect::<std::collections::HashSet<_>>();
    for retry_id in repo.all_retry_issue_ids().await? {
        if active_ids.contains(&retry_id) {
            continue;
        }
        if matches!(tracker.fetch_by_id(&retry_id).await, Ok(None)) {
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
        match tracker.fetch_by_id(&issue_id).await {
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
        if repo.has_active_run(&issue.id).await? {
            continue;
        }
        let Some(repo_config) = route_issue(&config.repos, &issue) else {
            warn!(
                issue = %issue.identifier,
                "no repository matches this issue; skipping (mark a repo as default or add a repo:<name> label)"
            );
            continue;
        };
        if repo.count_running().await?
            >= config.workflow.front_matter.agent.max_concurrent_agents as i64
        {
            break;
        }
        reserve_and_dispatch(
            repo.clone(),
            config.clone(),
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
        if repo.count_running().await?
            >= config.workflow.front_matter.agent.max_concurrent_agents as i64
        {
            break;
        }
        if let Some(issue) = tracker.fetch_by_id(&retry.issue_id).await? {
            // The issue may have left the active set since the failed run
            // (e.g. moved to Done); drop the retry rather than keep it queued
            // or dispatch a run nobody asked for.
            let is_active = config
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
            // Unroutable issues stay queued, like blocked ones: routing rules
            // only change with a worker restart, which re-enters this loop.
            let Some(repo_config) = route_issue(&config.repos, &issue) else {
                warn!(
                    issue = %issue.identifier,
                    "no repository matches this retry; keeping it queued"
                );
                continue;
            };
            reserve_and_dispatch(
                repo.clone(),
                config.clone(),
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
    tokio::spawn(async move {
        let result = tokio::spawn(dispatch_run(repo, config, issue, repo_config, run, stop)).await;
        handle_dispatch_result(
            result,
            &recovery_repo,
            &recovery_issue_id,
            &recovery_run,
            retry_backoff_cap,
        )
        .await;
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
    let workspaces = workspace_manager(&config, &repo_config);
    adopt_legacy_workspace(&repo, &config, &issue, &run, &workspaces).await;
    let workspace = workspaces
        .create_or_reuse(&issue)
        .await
        .map_err(|err| StorageError::Sqlx(sqlx::Error::Protocol(err.to_string())))?;
    let env = run_env(&config.env, &repo_config);

    if workspace.needs_init {
        if let Some(script) = &config.workflow.front_matter.hooks.after_create {
            let result = run_hook(
                HookName::AfterCreate,
                script,
                &issue,
                &workspace.path,
                run.run_number,
                config.workflow.front_matter.hooks.timeout_ms,
                &env,
            )
            .await;
            repo.record_hook(
                &run.id,
                HookName::AfterCreate,
                i64::from(result.exit_code),
                result.duration_ms,
                result.stderr_tail.as_deref(),
            )
            .await?;
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

    if let Some(script) = &config.workflow.front_matter.hooks.before_run {
        let result = run_hook(
            HookName::BeforeRun,
            script,
            &issue,
            &workspace.path,
            run.run_number,
            config.workflow.front_matter.hooks.timeout_ms,
            &env,
        )
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
    let driver = NativeAgentDriver;
    let request = AgentRunRequest {
        backend: backend.clone(),
        command: match backend {
            AgentBackend::Codex => config.workflow.front_matter.codex.command.clone(),
            AgentBackend::Claude => config.workflow.front_matter.claude.command.clone(),
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
        },
        claude: ClaudeRunOptions {
            permission_mode: config.workflow.front_matter.claude.permission_mode.clone(),
            allowed_tools: config.workflow.front_matter.claude.allowed_tools.clone(),
            disallowed_tools: config.workflow.front_matter.claude.disallowed_tools.clone(),
            add_dirs: config.workflow.front_matter.claude.add_dirs.clone(),
            session_id: pre_session,
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
                let hook = run_hook(
                    HookName::AfterRun,
                    script,
                    &issue,
                    &workspace.path,
                    run.run_number,
                    config.workflow.front_matter.hooks.timeout_ms,
                    &env,
                )
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
            env: BTreeMap::new(),
            session_env: BTreeMap::new(),
            app_data_dir: root.to_path_buf(),
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
        }
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
        tick(&repo, &tracker, &config, &stop).await.unwrap();
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
        tick(&repo, &tracker, &config, &stop).await.unwrap();
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
        tick(&repo, &tracker, &config, &stop).await.unwrap();
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
        tick(&repo, &tracker, &config, &stop).await.unwrap();
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
        tick(&repo, &tracker, &config, &stop).await.unwrap();
        let row = repo.get_issue("lin-1").await.unwrap().unwrap();
        assert_eq!(row.state, "done");
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
        tick(&repo, &tracker, &config, &stop).await.unwrap();

        let tracker = StaticTracker {
            active: vec![],
            terminal: vec![],
        };
        tick(&repo, &tracker, &config, &stop).await.unwrap();
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

        tick(&repo, &tracker, &config, &stop).await.unwrap();

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

        tick(&repo, &tracker, &config, &stop).await.unwrap();

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
        tick(&repo, &tracker, &config, &stop).await.unwrap();

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
        assert_eq!(env.get("EMPTY_ALLOWED").map(String::as_str), Some(""));
        assert_eq!(env.get("REPO_URL").map(String::as_str), Some("override"));
        assert!(!env.contains_key("PATH"));
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
