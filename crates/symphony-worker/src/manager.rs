use crate::{backoff_ms, run_hook, WorkspaceManager};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use symphony_agents::{AgentDriver, AgentRunRequest, ClaudeRunOptions, NativeAgentDriver};
use symphony_core::{
    append_retry_context, parse_workflow_source, render_prompt, AgentBackend, AgentOutcome,
    HookName, Issue, MappedAgentEvent, ParsedWorkflow, RetryContext, RunStatus, TokenCountPayload,
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
    #[error("workflow error: {0}")]
    Workflow(#[from] symphony_core::WorkflowError),
    #[error("tracker error: {0}")]
    Tracker(#[from] TrackerError),
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkerStartConfig {
    pub workflow_source: String,
    pub env: BTreeMap<String, String>,
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
        let workflow = parse_workflow_source(&config.workflow_source, &config.env)?;
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
                env: config.env,
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
    env: BTreeMap<String, String>,
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
        let workspaces = workspace_manager(config);
        for issue in terminal {
            if !repo.has_active_run(&issue.id).await.unwrap_or(true) {
                let _ = workspaces.remove(&issue).await;
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
    // has now; once stored, it no longer matches active_states, so this costs
    // one extra request per departed issue, not per tick.
    for issue_id in repo
        .issue_ids_in_states(&config.workflow.front_matter.tracker.active_states)
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
        if repo.count_running().await?
            >= config.workflow.front_matter.agent.max_concurrent_agents as i64
        {
            break;
        }
        reserve_and_dispatch(repo.clone(), config.clone(), issue, None, stop.clone()).await?;
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
            reserve_and_dispatch(
                repo.clone(),
                config.clone(),
                issue,
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
    run_number: Option<i64>,
    stop: CancellationToken,
) -> Result<(), WorkerError> {
    let workspaces = workspace_manager(&config);
    let workspace_path = workspaces
        .path_for(&issue.identifier)
        .map_err(|err| StorageError::Sqlx(sqlx::Error::Protocol(err.to_string())))?;
    let number = match run_number {
        Some(number) => number,
        None => repo.last_run_number(&issue.id).await? + 1,
    };
    let Some(run) = repo
        .try_reserve_run(&issue.id, number, &workspace_path.display().to_string())
        .await?
    else {
        return Ok(());
    };
    tokio::spawn(async move {
        if let Err(err) = dispatch_run(repo, config, issue, run, stop).await {
            error!(error = %err, "dispatch failed");
        }
    });
    Ok(())
}

async fn dispatch_run(
    repo: Repository,
    config: RuntimeConfig,
    issue: Issue,
    run: RunRow,
    stop: CancellationToken,
) -> Result<(), WorkerError> {
    let workspaces = workspace_manager(&config);
    let workspace = workspaces
        .create_or_reuse(&issue)
        .await
        .map_err(|err| StorageError::Sqlx(sqlx::Error::Protocol(err.to_string())))?;

    if workspace.needs_init {
        if let Some(script) = &config.workflow.front_matter.hooks.after_create {
            let result = run_hook(
                HookName::AfterCreate,
                script,
                &issue,
                &workspace.path,
                run.run_number,
                config.workflow.front_matter.hooks.timeout_ms,
                &config.env,
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
            &config.env,
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

    let mut prompt = render_prompt(&config.workflow.prompt_template, &issue);
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
        env: agent_env(&config.env),
    };
    let driver_stop = stop.clone();
    let mut run_fut = Box::pin(driver.run(request, tx, driver_stop));
    let result = loop {
        tokio::select! {
            maybe_event = rx.recv() => {
                if let Some(event) = maybe_event {
                    persist_run_event(&repo, &run.id, &event).await?;
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
        persist_run_event(&repo, &run.id, &event).await?;
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
                    &config.env,
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

fn workspace_manager(config: &RuntimeConfig) -> WorkspaceManager {
    WorkspaceManager::new(crate::resolve_workspace_root_dir(
        &config.workflow.front_matter.workspace.root,
        &config.env,
        &config.app_data_dir,
    ))
}

fn due_after(ms: u64) -> String {
    (chrono::Utc::now() + chrono::Duration::milliseconds(ms as i64))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Environment injected into agent processes. Agents inherit the app's env;
/// this adds secrets that live outside it (the Linear key comes from the OS
/// keychain) so workflows can call the Linear API directly.
fn agent_env(env: &BTreeMap<String, String>) -> Vec<(String, String)> {
    env.get("LINEAR_API_KEY")
        .filter(|key| !key.trim().is_empty())
        .map(|key| vec![("LINEAR_API_KEY".to_string(), key.clone())])
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use symphony_tracker::StaticTracker;

    fn runtime_config(root: &std::path::Path) -> RuntimeConfig {
        let raw = format!(
            r#"---
tracker:
  kind: linear
  api_key: test-key
  active_states: [Todo, In Progress]
  terminal_states: [Done]
workspace:
  root: {root}
---
Prompt {{{{issue.identifier}}}}
"#,
            root = root.display()
        );
        RuntimeConfig {
            workflow: parse_workflow_source(&raw, &BTreeMap::new()).unwrap(),
            env: BTreeMap::new(),
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
        }
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
