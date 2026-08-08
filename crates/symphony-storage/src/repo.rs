use crate::{kind_from_str, now_iso, EventBus, StorageError, StorageEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use sqlx::{sqlite::SqliteQueryResult, FromRow, QueryBuilder, Sqlite, SqlitePool};
use std::collections::BTreeMap;
use symphony_core::{
    AgentEventKind, HookName, Issue, ParsedWorkflow, RateLimitPayload, RunStatus,
    SessionInfoPayload, TokenCountPayload,
};
use uuid::Uuid;

const SQLITE_BIND_CHUNK_SIZE: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct WorkflowRow {
    pub id: String,
    pub source_hash: String,
    pub parsed: String,
    pub prompt_template: String,
    pub loaded_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct IssueRow {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub priority: i64,
    pub state: String,
    pub branch: Option<String>,
    pub labels: String,
    pub blockers: String,
    pub pr_urls: String,
    pub raw: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct RunRow {
    pub id: String,
    pub issue_id: String,
    pub run_number: i64,
    pub workspace_path: String,
    pub status: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub error_class: Option<String>,
    pub error_message: Option<String>,
    pub worker_pid: Option<i64>,
    /// JSON-encoded `SessionInfoPayload` reported by the agent CLI at startup.
    pub session_info: Option<String>,
    /// Configured repo the run was routed to; null on pre-multi-repo rows.
    pub repo_name: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct RunWithIssueRow {
    pub id: String,
    pub issue_id: String,
    pub run_number: i64,
    pub workspace_path: String,
    pub status: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub error_class: Option<String>,
    pub error_message: Option<String>,
    pub worker_pid: Option<i64>,
    pub session_info: Option<String>,
    pub repo_name: Option<String>,
    pub created_at: String,
    pub issue_identifier: String,
    pub issue_title: String,
    pub issue_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct LiveSessionRow {
    pub run_id: String,
    pub session_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub last_event_at: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct AgentEventRow {
    pub id: i64,
    pub run_id: String,
    pub kind: String,
    pub payload: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct RetryQueueRow {
    pub issue_id: String,
    pub run_number: i64,
    pub due_at: String,
    pub error_class: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct RetryWithIssueRow {
    pub issue_id: String,
    pub run_number: i64,
    pub due_at: String,
    pub error_class: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub issue_identifier: String,
    pub issue_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct RetroRow {
    pub id: String,
    pub since_at: String,
    pub until_at: String,
    pub status: String,
    pub run_count: i64,
    pub issue_count: i64,
    pub report_json: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct RetroInputRow {
    pub retro_id: String,
    pub run_id: String,
    pub issue_id: String,
    pub repo_name: Option<String>,
    pub workpad_comment_id: Option<String>,
    pub workpad_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct RetroSuggestionRow {
    pub id: String,
    pub retro_id: String,
    pub repo_name: String,
    pub repo_url: Option<String>,
    pub finding_index: i64,
    pub target_type: String,
    pub target_id: String,
    pub target_path: String,
    pub title: String,
    pub body: String,
    pub rationale: String,
    pub confidence: String,
    pub guidance: String,
    pub before_content: Option<String>,
    pub after_content: Option<String>,
    pub unified_diff: Option<String>,
    pub base_ref: Option<String>,
    pub base_hash: Option<String>,
    pub proposal_status: String,
    pub proposal_error: Option<String>,
    pub decision: String,
    pub decided_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct RetroBatchRow {
    pub id: String,
    pub retro_id: String,
    pub kind: String,
    pub repo_name: Option<String>,
    pub repo_url: Option<String>,
    pub base_ref: Option<String>,
    pub state: String,
    pub progress: Option<String>,
    pub error: Option<String>,
    pub pr_url: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetroBatchReservation {
    Created,
    ReviewIncomplete,
    AcceptedSetChanged,
    AlreadyReserved,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct WorkpadSnapshotRow {
    pub issue_id: String,
    pub comment_id: String,
    pub body_hash: String,
    pub body: String,
    pub comment_created_at: Option<String>,
    pub comment_updated_at: Option<String>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct RateLimitStateRow {
    pub source: String,
    pub remaining: Option<i64>,
    pub reset_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct TokenUsageRow {
    pub source: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub run_count: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct WorkerHeartbeatRow {
    pub id: String,
    pub started_at: String,
    pub last_beat_at: String,
    pub worker_pid: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct WorkspaceCleanupRow {
    pub id: String,
    pub repo_name: String,
    pub issue_identifier: String,
    pub source_path: String,
    pub quarantine_path: String,
    pub status: String,
    pub attempts: i64,
    pub next_attempt_at: String,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Overview {
    pub active_runs: Vec<RunWithIssueRow>,
    pub retry_queue: Vec<RetryWithIssueRow>,
    pub retry_count: i64,
    pub recent_failures: Vec<RunWithIssueRow>,
    pub failure_count: i64,
    pub workspace_cleanup_count: i64,
    pub live_sessions: Vec<LiveSessionRow>,
    pub worker_heartbeat: Option<WorkerHeartbeatRow>,
    pub rate_limits: Vec<RateLimitStateRow>,
    pub token_usage: Vec<TokenUsageRow>,
}

#[derive(Debug, Clone)]
pub struct Repository {
    pool: SqlitePool,
    events: EventBus,
}

impl Repository {
    pub fn new(pool: SqlitePool, events: EventBus) -> Self {
        Self { pool, events }
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub fn events(&self) -> &EventBus {
        &self.events
    }

    pub async fn upsert_workflow(&self, workflow: &ParsedWorkflow) -> Result<(), StorageError> {
        let parsed = serde_json::to_string(&workflow.front_matter)?;
        sqlx::query(
            r#"
            insert into workflows (id, source_hash, parsed, prompt_template)
            values (?1, ?2, ?3, ?4)
            on conflict(source_hash) do nothing
            "#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&workflow.source_hash)
        .bind(parsed)
        .bind(&workflow.prompt_template)
        .execute(&self.pool)
        .await?;
        self.changed("workflows", "upsert");
        Ok(())
    }

    pub async fn latest_workflow(&self) -> Result<Option<WorkflowRow>, StorageError> {
        Ok(sqlx::query_as::<_, WorkflowRow>(
            "select * from workflows order by loaded_at desc limit 1",
        )
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn upsert_issues(&self, issues: &[Issue]) -> Result<(), StorageError> {
        let mut tx = self.pool.begin().await?;
        for issue in issues {
            let labels = serde_json::to_string(&issue.labels)?;
            let blockers = serde_json::to_string(&issue.blockers)?;
            let pr_urls = serde_json::to_string(&issue.pr_urls)?;
            let raw = serde_json::to_string(issue)?;
            sqlx::query(
                r#"
                insert into issues (
                  id, identifier, title, description, priority, state, branch,
                  labels, blockers, pr_urls, raw, last_seen_at
                )
                values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                on conflict(id) do update set
                  identifier = excluded.identifier,
                  title = excluded.title,
                  description = excluded.description,
                  priority = excluded.priority,
                  state = excluded.state,
                  branch = excluded.branch,
                  labels = excluded.labels,
                  blockers = excluded.blockers,
                  pr_urls = excluded.pr_urls,
                  raw = excluded.raw,
                  last_seen_at = excluded.last_seen_at
                "#,
            )
            .bind(&issue.id)
            .bind(&issue.identifier)
            .bind(&issue.title)
            .bind(&issue.description)
            .bind(i64::from(issue.priority))
            .bind(&issue.state)
            .bind(&issue.branch)
            .bind(labels)
            .bind(blockers)
            .bind(pr_urls)
            .bind(raw)
            .bind(now_iso())
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        if !issues.is_empty() {
            self.changed("issues", "upsert");
        }
        Ok(())
    }

    pub async fn try_reserve_run(
        &self,
        issue_id: &str,
        run_number: i64,
        workspace_path: &str,
        repo_name: Option<&str>,
    ) -> Result<Option<RunRow>, StorageError> {
        let id = Uuid::new_v4().to_string();
        let result = sqlx::query(
            r#"
            insert or ignore into runs (id, issue_id, run_number, workspace_path, status, repo_name)
            values (?1, ?2, ?3, ?4, 'pending', ?5)
            "#,
        )
        .bind(&id)
        .bind(issue_id)
        .bind(run_number)
        .bind(workspace_path)
        .bind(repo_name)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        self.changed("runs", "insert");
        self.get_run(&id).await
    }

    pub async fn get_run(&self, id: &str) -> Result<Option<RunRow>, StorageError> {
        Ok(
            sqlx::query_as::<_, RunRow>("select * from runs where id = ?1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    pub async fn mark_running(&self, run_id: &str) -> Result<(), StorageError> {
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "update runs set status = 'running', started_at = ?1 where id = ?2 and status = 'pending'",
        )
        .bind(now_iso())
        .bind(run_id)
        .execute(&mut *tx)
        .await;
        match result {
            Ok(result) => {
                let updated = result.rows_affected() > 0;
                let cleared_retry = if updated {
                    sqlx::query(
                        r#"
                        delete from retry_queue
                        where issue_id = (select issue_id from runs where id = ?1)
                        "#,
                    )
                    .bind(run_id)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected()
                } else {
                    0
                };
                tx.commit().await?;
                if updated {
                    self.changed("runs", "update");
                }
                if cleared_retry > 0 {
                    self.changed("retry_queue", "delete");
                }
                Ok(())
            }
            Err(sqlx::Error::Database(db_err))
                if db_err.message().contains("runs_one_running_per_issue")
                    || db_err
                        .message()
                        .contains("UNIQUE constraint failed: runs.issue_id") =>
            {
                Err(StorageError::AlreadyRunning(run_id.to_string()))
            }
            Err(err) => Err(err.into()),
        }
    }

    pub async fn finish_run(
        &self,
        run_id: &str,
        status: RunStatus,
        error_class: Option<&str>,
        error_message: Option<&str>,
    ) -> Result<bool, StorageError> {
        if !status.is_terminal() {
            return Err(StorageError::InvalidRunTransition {
                run_id: run_id.to_string(),
                status: status.as_db_str().to_string(),
            });
        }
        let result = sqlx::query(
            r#"
            update runs
            set status = ?1, ended_at = ?2, error_class = ?3, error_message = ?4
            where id = ?5 and status in ('pending', 'running')
            "#,
        )
        .bind(status.as_db_str())
        .bind(now_iso())
        .bind(error_class)
        .bind(error_message)
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        let transitioned = result.rows_affected() > 0;
        if transitioned {
            self.changed("runs", "update");
        }
        Ok(transitioned)
    }

    pub async fn list_running(&self) -> Result<Vec<RunRow>, StorageError> {
        Ok(
            sqlx::query_as::<_, RunRow>("select * from runs where status = 'running'")
                .fetch_all(&self.pool)
                .await?,
        )
    }

    pub async fn list_pending(&self) -> Result<Vec<RunRow>, StorageError> {
        Ok(
            sqlx::query_as::<_, RunRow>("select * from runs where status = 'pending'")
                .fetch_all(&self.pool)
                .await?,
        )
    }

    /// Count runs occupying a concurrency slot. This includes `pending` runs
    /// (reserved and doing setup, not yet executing) as well as `running` ones,
    /// so that the `max_concurrent_agents` gate counts work that is in-flight
    /// but has not yet flipped to `running`. Counting only `running` here let a
    /// single dispatch pass reserve many runs into `pending` at once, blowing
    /// past the configured limit until they later transitioned to `running`.
    pub async fn count_active(&self) -> Result<i64, StorageError> {
        let (count,): (i64,) =
            sqlx::query_as("select count(*) from runs where status in ('pending', 'running')")
                .fetch_one(&self.pool)
                .await?;
        Ok(count)
    }

    pub async fn last_run_number(&self, issue_id: &str) -> Result<i64, StorageError> {
        let row: Option<(i64,)> = sqlx::query_as(
            "select run_number from runs where issue_id = ?1 order by run_number desc limit 1",
        )
        .bind(issue_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.0).unwrap_or(0))
    }

    pub async fn suppress_issue_dispatch(
        &self,
        issue_id: &str,
        reason: &str,
        issue_fingerprint: &str,
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            insert into issue_dispatch_suppressions (issue_id, reason, issue_fingerprint)
            values (?1, ?2, ?3)
            on conflict(issue_id, reason) do update set
              issue_fingerprint = excluded.issue_fingerprint,
              created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            "#,
        )
        .bind(issue_id)
        .bind(reason)
        .bind(issue_fingerprint)
        .execute(&self.pool)
        .await?;
        self.changed("issue_dispatch_suppressions", "upsert");
        Ok(())
    }

    pub async fn issue_dispatch_suppression(
        &self,
        issue_id: &str,
        reason: &str,
    ) -> Result<Option<String>, StorageError> {
        let row: Option<(String,)> = sqlx::query_as(
            "select issue_fingerprint from issue_dispatch_suppressions where issue_id = ?1 and reason = ?2",
        )
        .bind(issue_id)
        .bind(reason)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| row.0))
    }

    pub async fn clear_issue_dispatch_suppression(
        &self,
        issue_id: &str,
        reason: &str,
    ) -> Result<(), StorageError> {
        sqlx::query("delete from issue_dispatch_suppressions where issue_id = ?1 and reason = ?2")
            .bind(issue_id)
            .bind(reason)
            .execute(&self.pool)
            .await?;
        self.changed("issue_dispatch_suppressions", "delete");
        Ok(())
    }

    pub async fn has_active_run(&self, issue_id: &str) -> Result<bool, StorageError> {
        let (count,): (i64,) = sqlx::query_as(
            "select count(*) from runs where issue_id = ?1 and status in ('pending', 'running')",
        )
        .bind(issue_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(count > 0)
    }

    pub async fn set_worker_pid(&self, run_id: &str, pid: i64) -> Result<(), StorageError> {
        sqlx::query("update runs set worker_pid = ?1 where id = ?2")
            .bind(pid)
            .bind(run_id)
            .execute(&self.pool)
            .await?;
        self.changed("runs", "update");
        Ok(())
    }

    pub async fn set_run_session_info(
        &self,
        run_id: &str,
        info: &SessionInfoPayload,
    ) -> Result<(), StorageError> {
        sqlx::query("update runs set session_info = ?1 where id = ?2")
            .bind(serde_json::to_string(info)?)
            .bind(run_id)
            .execute(&self.pool)
            .await?;
        self.changed("runs", "update");
        Ok(())
    }

    pub async fn upsert_worker_heartbeat(
        &self,
        started_at: &str,
        worker_pid: i64,
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            insert into worker_heartbeat (id, started_at, last_beat_at, worker_pid)
            values ('worker', ?1, ?2, ?3)
            on conflict(id) do update set
              started_at = excluded.started_at,
              last_beat_at = excluded.last_beat_at,
              worker_pid = excluded.worker_pid
            "#,
        )
        .bind(started_at)
        .bind(now_iso())
        .bind(worker_pid)
        .execute(&self.pool)
        .await?;
        self.changed("worker_heartbeat", "upsert");
        Ok(())
    }

    pub async fn beat_worker_heartbeat(&self) -> Result<(), StorageError> {
        sqlx::query("update worker_heartbeat set last_beat_at = ?1 where id = 'worker'")
            .bind(now_iso())
            .execute(&self.pool)
            .await?;
        self.changed("worker_heartbeat", "update");
        Ok(())
    }

    pub async fn begin_workspace_cleanup(
        &self,
        id: &str,
        repo_name: &str,
        issue_identifier: &str,
        source_path: &str,
        quarantine_path: &str,
        now: &str,
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            insert into workspace_cleanup_queue (
              id, repo_name, issue_identifier, source_path, quarantine_path,
              status, next_attempt_at, updated_at
            ) values (?1, ?2, ?3, ?4, ?5, 'quarantining', ?6, ?6)
            "#,
        )
        .bind(id)
        .bind(repo_name)
        .bind(issue_identifier)
        .bind(source_path)
        .bind(quarantine_path)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.changed("workspace_cleanup_queue", "insert");
        Ok(())
    }

    pub async fn queue_workspace_cleanup(&self, id: &str) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            update workspace_cleanup_queue
            set status = 'queued', next_attempt_at = ?1, last_error = null, updated_at = ?1
            where id = ?2
            "#,
        )
        .bind(now_iso())
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.changed("workspace_cleanup_queue", "update");
        Ok(())
    }

    pub async fn recover_workspace_cleanup_queue(&self) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            update workspace_cleanup_queue
            set status = 'queued', next_attempt_at = ?1, updated_at = ?1
            where status = 'running'
            "#,
        )
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        self.changed("workspace_cleanup_queue", "update");
        Ok(())
    }

    pub async fn quarantining_workspace_cleanups(
        &self,
    ) -> Result<Vec<WorkspaceCleanupRow>, StorageError> {
        Ok(sqlx::query_as::<_, WorkspaceCleanupRow>(
            "select * from workspace_cleanup_queue where status = 'quarantining' order by created_at",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn due_workspace_cleanup(
        &self,
        now: &str,
    ) -> Result<Option<WorkspaceCleanupRow>, StorageError> {
        Ok(sqlx::query_as::<_, WorkspaceCleanupRow>(
            r#"
            select * from workspace_cleanup_queue
            where status in ('queued', 'retry_wait') and next_attempt_at <= ?1
            order by next_attempt_at, created_at
            limit 1
            "#,
        )
        .bind(now)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn claim_workspace_cleanup(&self, id: &str) -> Result<bool, StorageError> {
        let result = sqlx::query(
            r#"
            update workspace_cleanup_queue
            set status = 'running', attempts = attempts + 1, updated_at = ?1
            where id = ?2 and status in ('queued', 'retry_wait')
            "#,
        )
        .bind(now_iso())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() > 0 {
            self.changed("workspace_cleanup_queue", "update");
            return Ok(true);
        }
        Ok(false)
    }

    pub async fn retry_workspace_cleanup(
        &self,
        id: &str,
        due_at: &str,
        error: &str,
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            update workspace_cleanup_queue
            set status = 'retry_wait', next_attempt_at = ?1, last_error = ?2, updated_at = ?3
            where id = ?4
            "#,
        )
        .bind(due_at)
        .bind(error)
        .bind(now_iso())
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.changed("workspace_cleanup_queue", "update");
        Ok(())
    }

    pub async fn delete_workspace_cleanup(&self, id: &str) -> Result<(), StorageError> {
        sqlx::query("delete from workspace_cleanup_queue where id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        self.changed("workspace_cleanup_queue", "delete");
        Ok(())
    }

    pub async fn upsert_rate_limit(&self, input: &RateLimitPayload) -> Result<(), StorageError> {
        // Claude signals are hit events with partial info: a hit without a
        // reset time (the newer limit wordings carry none) must not erase a
        // reset learned from an earlier hit in the same window — clearing it
        // would lift the dispatch pause early. Codex signals are per-turn
        // snapshots, so they always overwrite, including clearing a reset
        // the CLI no longer reports.
        sqlx::query(
            r#"
            insert into rate_limit_state (source, remaining, reset_at, updated_at)
            values (?1, ?2, ?3, ?4)
            on conflict(source) do update set
              remaining = excluded.remaining,
              reset_at = case
                when excluded.source = 'claude'
                  then coalesce(excluded.reset_at, rate_limit_state.reset_at)
                else excluded.reset_at
              end,
              updated_at = excluded.updated_at
            "#,
        )
        .bind(&input.source)
        .bind(input.remaining)
        .bind(&input.reset_at)
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        self.events.emit(StorageEvent::RateLimitChanged {
            source: input.source.clone(),
        });
        self.changed("rate_limit_state", "upsert");
        Ok(())
    }

    /// Accumulate a run's final token counts into the per-provider totals.
    /// Both backends report usage exactly once per run (Codex at
    /// `turn.completed`, Claude at `result`), so each call also counts a run.
    pub async fn record_token_usage(
        &self,
        source: &str,
        tokens: &TokenCountPayload,
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            insert into token_usage (source, input_tokens, output_tokens, total_tokens, run_count, updated_at)
            values (?1, ?2, ?3, ?4, 1, ?5)
            on conflict(source) do update set
              input_tokens = input_tokens + excluded.input_tokens,
              output_tokens = output_tokens + excluded.output_tokens,
              total_tokens = total_tokens + excluded.total_tokens,
              run_count = run_count + 1,
              updated_at = excluded.updated_at
            "#,
        )
        .bind(source)
        .bind(tokens.input_tokens)
        .bind(tokens.output_tokens)
        .bind(tokens.total_tokens)
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        self.changed("token_usage", "upsert");
        Ok(())
    }

    pub async fn active_rate_limits(
        &self,
        now: &str,
    ) -> Result<Vec<RateLimitStateRow>, StorageError> {
        Ok(sqlx::query_as::<_, RateLimitStateRow>(
            "select * from rate_limit_state where reset_at is not null and reset_at > ?1",
        )
        .bind(now)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn upsert_live_session(
        &self,
        run_id: &str,
        session_id: &str,
        thread_id: &str,
        turn_id: &str,
        tokens: &TokenCountPayload,
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            insert into live_sessions (
              run_id, session_id, thread_id, turn_id, input_tokens,
              output_tokens, total_tokens, last_event_at
            )
            values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            on conflict(run_id) do update set
              session_id = excluded.session_id,
              thread_id = excluded.thread_id,
              turn_id = excluded.turn_id,
              -- The final identity-only upsert carries an all-zero payload;
              -- keep the cumulative token columns in that case.
              input_tokens = case
                when excluded.input_tokens = 0
                 and excluded.output_tokens = 0
                 and excluded.total_tokens = 0
                then input_tokens
                else excluded.input_tokens
              end,
              output_tokens = case
                when excluded.input_tokens = 0
                 and excluded.output_tokens = 0
                 and excluded.total_tokens = 0
                then output_tokens
                else excluded.output_tokens
              end,
              total_tokens = case
                when excluded.input_tokens = 0
                 and excluded.output_tokens = 0
                 and excluded.total_tokens = 0
                then total_tokens
                else excluded.total_tokens
              end,
              last_event_at = excluded.last_event_at
            "#,
        )
        .bind(run_id)
        .bind(session_id)
        .bind(thread_id)
        .bind(turn_id)
        .bind(tokens.input_tokens)
        .bind(tokens.output_tokens)
        .bind(tokens.total_tokens)
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        self.changed("live_sessions", "upsert");
        Ok(())
    }

    pub async fn delete_live_session(&self, run_id: &str) -> Result<(), StorageError> {
        sqlx::query("delete from live_sessions where run_id = ?1")
            .bind(run_id)
            .execute(&self.pool)
            .await?;
        self.changed("live_sessions", "delete");
        Ok(())
    }

    pub async fn delete_orphaned_pending_sessions(&self) -> Result<u64, StorageError> {
        let result = sqlx::query(
            r#"
            delete from live_sessions
            where session_id like 'pending-%'
              and run_id in (
                select id from runs
                where status in ('success', 'failure', 'timeout', 'cancelled')
              )
            "#,
        )
        .execute(&self.pool)
        .await?;
        if result.rows_affected() > 0 {
            self.changed("live_sessions", "delete");
        }
        Ok(result.rows_affected())
    }

    pub async fn append_event(
        &self,
        run_id: &str,
        kind: AgentEventKind,
        payload: &Value,
    ) -> Result<AgentEventRow, StorageError> {
        let payload = serde_json::to_string(payload)?;
        let result =
            sqlx::query("insert into agent_events (run_id, kind, payload) values (?1, ?2, ?3)")
                .bind(run_id)
                .bind(kind.as_db_str())
                .bind(payload)
                .execute(&self.pool)
                .await?;
        let id = result.last_insert_rowid();
        let row = sqlx::query_as::<_, AgentEventRow>("select * from agent_events where id = ?1")
            .bind(id)
            .fetch_one(&self.pool)
            .await?;
        self.events
            .emit(StorageEvent::AgentEvent { event: row.clone() });
        self.changed("agent_events", "insert");
        Ok(row)
    }

    pub async fn recent_events(
        &self,
        run_id: &str,
        limit: i64,
    ) -> Result<Vec<AgentEventRow>, StorageError> {
        Ok(sqlx::query_as::<_, AgentEventRow>(
            "select * from agent_events where run_id = ?1 order by id desc limit ?2",
        )
        .bind(run_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn prior_run(
        &self,
        issue_id: &str,
        before_run_id: &str,
    ) -> Result<Option<RunRow>, StorageError> {
        Ok(sqlx::query_as::<_, RunRow>(
            r#"
            select *
            from runs
            where issue_id = ?1 and run_number < (
              select run_number from runs where id = ?2
            )
            order by run_number desc
            limit 1
            "#,
        )
        .bind(issue_id)
        .bind(before_run_id)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn recent_events_for_issue(
        &self,
        issue_id: &str,
        limit: i64,
    ) -> Result<Vec<AgentEventRow>, StorageError> {
        Ok(sqlx::query_as::<_, AgentEventRow>(
            r#"
            select e.*
            from agent_events e
            join runs r on r.id = e.run_id
            where r.issue_id = ?1
            order by e.id desc
            limit ?2
            "#,
        )
        .bind(issue_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn schedule_retry(
        &self,
        issue_id: &str,
        run_number: i64,
        due_at: &str,
        error_class: Option<&str>,
        error_message: Option<&str>,
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            insert into retry_queue (issue_id, run_number, due_at, error_class, error_message)
            values (?1, ?2, ?3, ?4, ?5)
            on conflict(issue_id) do update set
              run_number = excluded.run_number,
              due_at = excluded.due_at,
              error_class = excluded.error_class,
              error_message = excluded.error_message,
              created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            "#,
        )
        .bind(issue_id)
        .bind(run_number)
        .bind(due_at)
        .bind(error_class)
        .bind(error_message)
        .execute(&self.pool)
        .await?;
        self.changed("retry_queue", "upsert");
        Ok(())
    }

    pub async fn due_retries(&self, now: &str) -> Result<Vec<RetryQueueRow>, StorageError> {
        Ok(sqlx::query_as::<_, RetryQueueRow>(
            "select * from retry_queue where due_at <= ?1 order by due_at asc",
        )
        .bind(now)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn trigger_retry_now(&self, issue_id: &str) -> Result<bool, StorageError> {
        if self.has_active_run(issue_id).await? {
            return Ok(false);
        }

        let result = sqlx::query("update retry_queue set due_at = ?1 where issue_id = ?2")
            .bind(now_iso())
            .bind(issue_id)
            .execute(&self.pool)
            .await?;
        let retry_due = result.rows_affected() > 0;
        if retry_due {
            self.changed("retry_queue", "update");
        }
        if retry_due {
            self.clear_all_issue_dispatch_suppressions(issue_id).await?;
            return Ok(true);
        }

        // A run the user stopped (not one that failed) may have no retry_queue
        // row at all. Only the latest run should be actionable from the
        // issue-scoped retry endpoint; older cancelled runs may already have
        // been superseded by a successful retry.
        let Some(latest_cancelled_run_number) = self.latest_cancelled_run_number(issue_id).await?
        else {
            return Ok(false);
        };

        self.clear_all_issue_dispatch_suppressions(issue_id).await?;
        let last_run_number = self.last_run_number(issue_id).await?;
        let run_number = std::cmp::max(latest_cancelled_run_number, last_run_number) + 1;
        self.schedule_retry(issue_id, run_number, &now_iso(), None, None)
            .await?;
        Ok(true)
    }

    async fn latest_cancelled_run_number(
        &self,
        issue_id: &str,
    ) -> Result<Option<i64>, StorageError> {
        let row: Option<(i64, String)> = sqlx::query_as(
            "select run_number, status from runs where issue_id = ?1 order by run_number desc limit 1",
        )
        .bind(issue_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|(run_number, status)| (status == "cancelled").then_some(run_number)))
    }

    async fn clear_all_issue_dispatch_suppressions(
        &self,
        issue_id: &str,
    ) -> Result<bool, StorageError> {
        let result = sqlx::query("delete from issue_dispatch_suppressions where issue_id = ?1")
            .bind(issue_id)
            .execute(&self.pool)
            .await?;
        let cleared = result.rows_affected() > 0;
        if cleared {
            self.changed("issue_dispatch_suppressions", "delete");
        }
        Ok(cleared)
    }

    pub async fn pending_retry_issue_ids(&self) -> Result<Vec<String>, StorageError> {
        let rows: Vec<(String,)> = sqlx::query_as("select issue_id from retry_queue")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(|r| r.0).collect())
    }

    pub async fn all_retry_issue_ids(&self) -> Result<Vec<String>, StorageError> {
        self.pending_retry_issue_ids().await
    }

    pub async fn clear_retry(&self, issue_id: &str) -> Result<(), StorageError> {
        sqlx::query("delete from retry_queue where issue_id = ?1")
            .bind(issue_id)
            .execute(&self.pool)
            .await?;
        self.changed("retry_queue", "delete");
        Ok(())
    }

    pub async fn record_hook(
        &self,
        run_id: &str,
        hook: HookName,
        exit_code: i64,
        duration_ms: i64,
        stderr_tail: Option<&str>,
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            insert into hook_runs (run_id, hook, exit_code, duration_ms, stderr_tail)
            values (?1, ?2, ?3, ?4, ?5)
            "#,
        )
        .bind(run_id)
        .bind(hook.as_env_value())
        .bind(exit_code)
        .bind(duration_ms)
        .bind(stderr_tail)
        .execute(&self.pool)
        .await?;
        self.changed("hook_runs", "insert");
        Ok(())
    }

    pub async fn overview(&self) -> Result<Overview, StorageError> {
        // Pending and running rows are both active from the user's perspective:
        // `try_reserve_run` commits a pending run before setup/claim work
        // promotes it to running. Running runs are bounded by
        // agent.max_concurrent_agents (no hard cap), and every live_session
        // belongs to one of them — the Overview's last-activity column joins
        // the two by run_id. Don't truncate, or a streaming run past an
        // arbitrary limit would vanish from Overview.
        let active_runs = self
            .runs_with_issue("where r.status in ('pending', 'running')", None)
            .await?;
        let retry_queue = sqlx::query_as::<_, RetryWithIssueRow>(
            r#"
            select q.*, i.identifier as issue_identifier, i.title as issue_title
            from retry_queue q
            join issues i on i.id = q.issue_id
            order by q.due_at asc
            limit 50
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        let (retry_count, failure_count, workspace_cleanup_count): (i64, i64, i64) =
            sqlx::query_as(
                r#"
            select
              (select count(*) from retry_queue),
              (select count(*) from runs where status in ('failure', 'timeout')),
              (select count(*) from workspace_cleanup_queue)
            "#,
            )
            .fetch_one(&self.pool)
            .await?;
        let recent_failures = self
            .runs_with_issue(
                "where r.status in ('failure', 'timeout') order by r.ended_at desc",
                Some(20),
            )
            .await?;
        let live_sessions = sqlx::query_as::<_, LiveSessionRow>(
            r#"
            select
              ls.run_id,
              ls.session_id,
              ls.thread_id,
              ls.turn_id,
              ls.input_tokens,
              ls.output_tokens,
              ls.total_tokens,
              max(
                ls.last_event_at,
                coalesce((
                  select e.created_at
                  from agent_events e
                  where e.run_id = ls.run_id
                  order by e.id desc
                  limit 1
                ), ls.last_event_at)
              ) as last_event_at,
              ls.started_at
            from live_sessions ls
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        let worker_heartbeat = sqlx::query_as::<_, WorkerHeartbeatRow>(
            "select * from worker_heartbeat where id = 'worker'",
        )
        .fetch_optional(&self.pool)
        .await?;
        let rate_limits = sqlx::query_as::<_, RateLimitStateRow>(
            "select * from rate_limit_state order by source",
        )
        .fetch_all(&self.pool)
        .await?;
        let token_usage =
            sqlx::query_as::<_, TokenUsageRow>("select * from token_usage order by source")
                .fetch_all(&self.pool)
                .await?;
        Ok(Overview {
            active_runs,
            retry_queue,
            retry_count,
            recent_failures,
            failure_count,
            workspace_cleanup_count,
            live_sessions,
            worker_heartbeat,
            rate_limits,
            token_usage,
        })
    }

    pub async fn list_runs(&self, limit: i64) -> Result<Vec<RunWithIssueRow>, StorageError> {
        self.runs_with_issue("order by r.created_at desc", Some(limit))
            .await
    }

    pub async fn list_issues(&self, limit: i64) -> Result<Vec<IssueRow>, StorageError> {
        Ok(sqlx::query_as::<_, IssueRow>(
            "select * from issues order by last_seen_at desc limit ?1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?)
    }

    /// Ids of issues whose stored state matches none of the given names,
    /// case-insensitively (states arrive lowercased from the tracker, but
    /// callers pass the names as configured, e.g. "Done"). An empty list
    /// excludes nothing, so every issue id is returned.
    pub async fn issue_ids_not_in_states(
        &self,
        states: &[String],
    ) -> Result<Vec<String>, StorageError> {
        if states.is_empty() {
            let rows = sqlx::query_as::<_, (String,)>("select id from issues")
                .fetch_all(&self.pool)
                .await?;
            return Ok(rows.into_iter().map(|r| r.0).collect());
        }
        let placeholders = (1..=states.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let query = format!("select id from issues where lower(state) not in ({placeholders})");
        let mut rows = sqlx::query_as::<_, (String,)>(&query);
        for state in states {
            rows = rows.bind(state.to_lowercase());
        }
        Ok(rows
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(|r| r.0)
            .collect())
    }

    pub async fn get_issue(&self, id: &str) -> Result<Option<IssueRow>, StorageError> {
        Ok(
            sqlx::query_as::<_, IssueRow>("select * from issues where id = ?1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    pub async fn get_run_detail(
        &self,
        id: &str,
    ) -> Result<Option<(RunWithIssueRow, Vec<AgentEventRow>)>, StorageError> {
        let run = sqlx::query_as::<_, RunWithIssueRow>(
            r#"
            select r.*, i.identifier as issue_identifier, i.title as issue_title, i.state as issue_state
            from runs r
            join issues i on i.id = r.issue_id
            where r.id = ?1
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(run) = run else {
            return Ok(None);
        };
        let events = sqlx::query_as::<_, AgentEventRow>(
            "select * from agent_events where run_id = ?1 order by id asc",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        Ok(Some((run, events)))
    }

    pub async fn create_retro(
        &self,
        since_at: &str,
        until_at: &str,
    ) -> Result<RetroRow, StorageError> {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            insert into retros (id, since_at, until_at, status)
            values (?1, ?2, ?3, 'running')
            "#,
        )
        .bind(&id)
        .bind(since_at)
        .bind(until_at)
        .execute(&self.pool)
        .await?;
        self.changed("retros", "insert");
        match self.get_retro(&id).await? {
            Some(retro) => Ok(retro),
            None => Err(sqlx::Error::RowNotFound.into()),
        }
    }

    pub async fn finish_retro(
        &self,
        retro_id: &str,
        report_json: &str,
        run_count: i64,
        issue_count: i64,
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            update retros
            set status = 'completed',
                report_json = ?1,
                run_count = ?2,
                issue_count = ?3,
                error_message = null,
                completed_at = ?4
            where id = ?5
            "#,
        )
        .bind(report_json)
        .bind(run_count)
        .bind(issue_count)
        .bind(now_iso())
        .bind(retro_id)
        .execute(&self.pool)
        .await?;
        self.changed("retros", "update");
        Ok(())
    }

    pub async fn fail_retro(
        &self,
        retro_id: &str,
        error_message: &str,
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            update retros
            set status = 'failed',
                error_message = ?1,
                completed_at = ?2
            where id = ?3
            "#,
        )
        .bind(error_message)
        .bind(now_iso())
        .bind(retro_id)
        .execute(&self.pool)
        .await?;
        self.changed("retros", "update");
        Ok(())
    }

    pub async fn fail_running_retros(&self, error_message: &str) -> Result<(), StorageError> {
        let result = sqlx::query(
            r#"
            update retros
            set status = 'failed',
                error_message = ?1,
                completed_at = ?2
            where status = 'running'
            "#,
        )
        .bind(error_message)
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() > 0 {
            self.changed("retros", "update");
        }
        Ok(())
    }

    pub async fn latest_completed_retro(&self) -> Result<Option<RetroRow>, StorageError> {
        Ok(sqlx::query_as::<_, RetroRow>(
            "select * from retros where status = 'completed' order by until_at desc limit 1",
        )
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn list_retros(&self, limit: i64) -> Result<Vec<RetroRow>, StorageError> {
        Ok(
            sqlx::query_as::<_, RetroRow>("select * from retros order by created_at desc limit ?1")
                .bind(limit)
                .fetch_all(&self.pool)
                .await?,
        )
    }

    pub async fn get_retro(&self, id: &str) -> Result<Option<RetroRow>, StorageError> {
        Ok(
            sqlx::query_as::<_, RetroRow>("select * from retros where id = ?1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    pub async fn delete_retro(&self, id: &str) -> Result<bool, StorageError> {
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"
            delete from retros
            where id = ?1
              and status != 'running'
              and (
                status != 'completed'
                or id = (
                  select id from retros
                  where status = 'completed'
                  order by until_at desc, created_at desc
                  limit 1
                )
              )
              and not exists (
                select 1 from retro_batches
                where retro_id = retros.id
                  and state in ('queued', 'running')
              )
            "#,
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            tx.rollback().await?;
            return Ok(false);
        }

        // Foreign keys normally cascade these rows. Keep the explicit cleanup
        // for databases opened by older builds or diagnostic tools without
        // SQLite foreign-key enforcement enabled.
        sqlx::query(
            r#"
            delete from retro_batch_items
            where batch_id in (select id from retro_batches where retro_id = ?1)
               or suggestion_id in (select id from retro_suggestions where retro_id = ?1)
            "#,
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("delete from retro_batches where retro_id = ?1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("delete from retro_suggestions where retro_id = ?1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("delete from retro_inputs where retro_id = ?1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        self.changed("retros", "delete");
        Ok(true)
    }

    pub async fn insert_retro_suggestions(
        &self,
        suggestions: &[RetroSuggestionRow],
    ) -> Result<(), StorageError> {
        if suggestions.is_empty() {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        for suggestion in suggestions {
            sqlx::query(
                r#"
                insert into retro_suggestions (
                  id, retro_id, repo_name, repo_url, finding_index,
                  target_type, target_id, target_path, title, body, rationale,
                  confidence, guidance, before_content, after_content, unified_diff,
                  base_ref, base_hash, proposal_status, proposal_error, decision,
                  decided_at, created_at
                ) values (
                  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                  ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21,
                  ?22, ?23
                )
                on conflict(id) do nothing
                "#,
            )
            .bind(&suggestion.id)
            .bind(&suggestion.retro_id)
            .bind(&suggestion.repo_name)
            .bind(&suggestion.repo_url)
            .bind(suggestion.finding_index)
            .bind(&suggestion.target_type)
            .bind(&suggestion.target_id)
            .bind(&suggestion.target_path)
            .bind(&suggestion.title)
            .bind(&suggestion.body)
            .bind(&suggestion.rationale)
            .bind(&suggestion.confidence)
            .bind(&suggestion.guidance)
            .bind(&suggestion.before_content)
            .bind(&suggestion.after_content)
            .bind(&suggestion.unified_diff)
            .bind(&suggestion.base_ref)
            .bind(&suggestion.base_hash)
            .bind(&suggestion.proposal_status)
            .bind(&suggestion.proposal_error)
            .bind(&suggestion.decision)
            .bind(&suggestion.decided_at)
            .bind(&suggestion.created_at)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        self.changed("retro_suggestions", "insert");
        Ok(())
    }

    pub async fn list_retro_suggestions(
        &self,
        retro_id: &str,
    ) -> Result<Vec<RetroSuggestionRow>, StorageError> {
        Ok(sqlx::query_as::<_, RetroSuggestionRow>(
            r#"
            select * from retro_suggestions
            where retro_id = ?1
            order by repo_name, finding_index, id
            "#,
        )
        .bind(retro_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn set_retro_suggestion_decision(
        &self,
        id: &str,
        decision: &str,
    ) -> Result<Option<RetroSuggestionRow>, StorageError> {
        let decided_at = (decision != "pending").then(now_iso);
        sqlx::query(
            r#"
            update retro_suggestions
            set decision = ?1, decided_at = ?2
            where id = ?3 and proposal_status = 'ready'
              and not exists (
                select 1 from retro_batches b
                where b.retro_id = retro_suggestions.retro_id
                  and b.state in ('queued', 'running', 'completed')
                  and (
                    (retro_suggestions.target_type = 'prompt'
                      and b.kind = 'workflow_update')
                    or (retro_suggestions.target_type in ('skill', 'repo_workflow')
                      and b.kind = 'repo_pr'
                      and b.repo_name = retro_suggestions.repo_name)
                  )
              )
            "#,
        )
        .bind(decision)
        .bind(decided_at)
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.changed("retro_suggestions", "update");
        Ok(
            sqlx::query_as::<_, RetroSuggestionRow>(
                "select * from retro_suggestions where id = ?1",
            )
            .bind(id)
            .fetch_optional(&self.pool)
            .await?,
        )
    }

    pub async fn reserve_retro_batch(
        &self,
        batch: &RetroBatchRow,
        suggestion_ids: &[String],
    ) -> Result<RetroBatchReservation, StorageError> {
        let mut tx = self.pool.begin().await?;
        // Acquire the SQLite write lock before reading the review state so a
        // decision update cannot commit between validation and reservation.
        sqlx::query("update retros set id = id where id = ?1")
            .bind(&batch.retro_id)
            .execute(&mut *tx)
            .await?;
        let review_incomplete: bool = sqlx::query_scalar(
            r#"
            select exists (
              select 1 from retro_suggestions
              where retro_id = ?1
                and proposal_status = 'ready'
                and decision = 'pending'
            )
            "#,
        )
        .bind(&batch.retro_id)
        .fetch_one(&mut *tx)
        .await?;
        if review_incomplete {
            tx.rollback().await?;
            return Ok(RetroBatchReservation::ReviewIncomplete);
        }
        let current_accepted_ids = sqlx::query_scalar::<_, String>(
            r#"
            select id from retro_suggestions
            where retro_id = ?1
              and proposal_status = 'ready'
              and decision = 'accepted'
              and (
                (?2 = 'workflow_update' and target_type = 'prompt')
                or (?2 = 'repo_pr'
                    and target_type in ('skill', 'repo_workflow')
                    and repo_name = ?3)
              )
            order by id
            "#,
        )
        .bind(&batch.retro_id)
        .bind(&batch.kind)
        .bind(&batch.repo_name)
        .fetch_all(&mut *tx)
        .await?;
        let mut expected_ids = suggestion_ids.to_vec();
        expected_ids.sort();
        if current_accepted_ids.is_empty() || current_accepted_ids != expected_ids {
            tx.rollback().await?;
            return Ok(RetroBatchReservation::AcceptedSetChanged);
        }
        let result = sqlx::query(
            r#"
            insert into retro_batches (
              id, retro_id, kind, repo_name, repo_url, base_ref, state,
              progress, error, pr_url, created_at, completed_at
            )
            select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
            where not exists (
              select 1 from retro_suggestions
              where retro_id = ?2
                and proposal_status = 'ready'
                and decision = 'pending'
            )
              and not exists (
                select 1 from retro_batches
                where retro_id = ?2
                  and kind = ?3
                  and (
                    (?3 = 'workflow_update' and repo_name is null)
                    or (?3 = 'repo_pr' and repo_name = ?4)
                  )
                  and state in ('queued', 'running', 'completed', 'stale')
              )
            "#,
        )
        .bind(&batch.id)
        .bind(&batch.retro_id)
        .bind(&batch.kind)
        .bind(&batch.repo_name)
        .bind(&batch.repo_url)
        .bind(&batch.base_ref)
        .bind(&batch.state)
        .bind(&batch.progress)
        .bind(&batch.error)
        .bind(&batch.pr_url)
        .bind(&batch.created_at)
        .bind(&batch.completed_at)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            tx.rollback().await?;
            return Ok(RetroBatchReservation::AlreadyReserved);
        }
        for suggestion_id in suggestion_ids {
            sqlx::query("insert into retro_batch_items (batch_id, suggestion_id) values (?1, ?2)")
                .bind(&batch.id)
                .bind(suggestion_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        self.changed("retro_batches", "insert");
        Ok(RetroBatchReservation::Created)
    }

    pub async fn fail_in_progress_retro_batches(
        &self,
        error_message: &str,
    ) -> Result<(), StorageError> {
        let result = sqlx::query(
            r#"
            update retro_batches
            set state = 'failed',
                progress = 'Interrupted before completion.',
                error = ?1,
                completed_at = ?2
            where state in ('queued', 'running')
            "#,
        )
        .bind(error_message)
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() > 0 {
            self.changed("retro_batches", "update");
        }
        Ok(())
    }

    pub async fn update_retro_batch(
        &self,
        id: &str,
        state: &str,
        progress: Option<&str>,
        error: Option<&str>,
        pr_url: Option<&str>,
    ) -> Result<(), StorageError> {
        let completed_at = matches!(state, "completed" | "failed" | "stale").then(now_iso);
        sqlx::query(
            r#"
            update retro_batches
            set state = ?1, progress = ?2, error = ?3, pr_url = ?4, completed_at = ?5
            where id = ?6
            "#,
        )
        .bind(state)
        .bind(progress)
        .bind(error)
        .bind(pr_url)
        .bind(completed_at)
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.changed("retro_batches", "update");
        Ok(())
    }

    pub async fn list_retro_batches(
        &self,
        retro_id: &str,
    ) -> Result<Vec<RetroBatchRow>, StorageError> {
        Ok(sqlx::query_as::<_, RetroBatchRow>(
            "select * from retro_batches where retro_id = ?1 order by created_at, id",
        )
        .bind(retro_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn has_in_progress_retro_batches(&self) -> Result<bool, StorageError> {
        Ok(sqlx::query_scalar::<_, bool>(
            "select exists(select 1 from retro_batches where state in ('queued', 'running'))",
        )
        .fetch_one(&self.pool)
        .await?)
    }

    pub async fn list_retro_runs(
        &self,
        since_at: &str,
        until_at: &str,
    ) -> Result<Vec<RunWithIssueRow>, StorageError> {
        Ok(sqlx::query_as::<_, RunWithIssueRow>(
            r#"
            select r.*, i.identifier as issue_identifier, i.title as issue_title, i.state as issue_state
            from runs r
            join issues i on i.id = r.issue_id
            where r.status in ('success', 'failure', 'timeout', 'cancelled')
              and coalesce(r.ended_at, r.created_at) > ?1
              and coalesce(r.ended_at, r.created_at) <= ?2
            order by coalesce(r.ended_at, r.created_at) asc
            "#,
        )
        .bind(since_at)
        .bind(until_at)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn events_for_run_ids(
        &self,
        run_ids: &[String],
    ) -> Result<Vec<AgentEventRow>, StorageError> {
        if run_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut events = Vec::new();
        for chunk in run_ids.chunks(SQLITE_BIND_CHUNK_SIZE) {
            let mut qb =
                QueryBuilder::<Sqlite>::new("select * from agent_events where run_id in (");
            let mut separated = qb.separated(", ");
            for run_id in chunk {
                separated.push_bind(run_id);
            }
            separated.push_unseparated(") order by run_id, id asc");
            events.extend(
                qb.build_query_as::<AgentEventRow>()
                    .fetch_all(&self.pool)
                    .await?,
            );
        }
        events.sort_by(|a, b| a.run_id.cmp(&b.run_id).then_with(|| a.id.cmp(&b.id)));
        Ok(events)
    }

    pub async fn previous_retro_workpad_hashes(
        &self,
        issue_ids: &[String],
        before_or_at: &str,
    ) -> Result<BTreeMap<String, String>, StorageError> {
        if issue_ids.is_empty() {
            return Ok(BTreeMap::new());
        }

        let mut hashes = BTreeMap::new();
        for chunk in issue_ids.chunks(SQLITE_BIND_CHUNK_SIZE) {
            let mut qb = QueryBuilder::<Sqlite>::new(
                r#"
                select ri.issue_id, ri.workpad_hash
                from retro_inputs ri
                join retros r on r.id = ri.retro_id
                where r.status = 'completed'
                  and r.until_at <=
                "#,
            );
            qb.push_bind(before_or_at);
            qb.push(" and ri.workpad_hash is not null and ri.issue_id in (");
            let mut separated = qb.separated(", ");
            for issue_id in chunk {
                separated.push_bind(issue_id);
            }
            separated.push_unseparated(") order by r.until_at desc, r.completed_at desc");

            let rows = qb
                .build_query_as::<(String, String)>()
                .fetch_all(&self.pool)
                .await?;
            for (issue_id, workpad_hash) in rows {
                hashes.entry(issue_id).or_insert(workpad_hash);
            }
        }
        Ok(hashes)
    }

    pub async fn insert_retro_inputs(&self, inputs: &[RetroInputRow]) -> Result<(), StorageError> {
        if inputs.is_empty() {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        for input in inputs {
            sqlx::query(
                r#"
                insert or replace into retro_inputs (
                  retro_id, run_id, issue_id, repo_name, workpad_comment_id, workpad_hash
                )
                values (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
            )
            .bind(&input.retro_id)
            .bind(&input.run_id)
            .bind(&input.issue_id)
            .bind(&input.repo_name)
            .bind(&input.workpad_comment_id)
            .bind(&input.workpad_hash)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        self.changed("retro_inputs", "upsert");
        Ok(())
    }

    pub async fn upsert_workpad_snapshot(
        &self,
        snapshot: &WorkpadSnapshotRow,
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            insert into workpad_snapshots (
              issue_id, comment_id, body_hash, body, comment_created_at,
              comment_updated_at, fetched_at
            )
            values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            on conflict(issue_id) do update set
              comment_id = excluded.comment_id,
              body_hash = excluded.body_hash,
              body = excluded.body,
              comment_created_at = excluded.comment_created_at,
              comment_updated_at = excluded.comment_updated_at,
              fetched_at = excluded.fetched_at
            "#,
        )
        .bind(&snapshot.issue_id)
        .bind(&snapshot.comment_id)
        .bind(&snapshot.body_hash)
        .bind(&snapshot.body)
        .bind(&snapshot.comment_created_at)
        .bind(&snapshot.comment_updated_at)
        .bind(&snapshot.fetched_at)
        .execute(&self.pool)
        .await?;
        self.changed("workpad_snapshots", "upsert");
        Ok(())
    }

    pub async fn issue_from_id(&self, id: &str) -> Result<Option<Issue>, StorageError> {
        let row = self.get_issue(id).await?;
        Ok(row
            .map(|row| serde_json::from_str::<Issue>(&row.raw))
            .transpose()?)
    }

    async fn runs_with_issue(
        &self,
        clause: &str,
        limit: Option<i64>,
    ) -> Result<Vec<RunWithIssueRow>, StorageError> {
        let mut qb = QueryBuilder::<Sqlite>::new(
            r#"
            select r.*, i.identifier as issue_identifier, i.title as issue_title, i.state as issue_state
            from runs r
            join issues i on i.id = r.issue_id
            "#,
        );
        qb.push(" ");
        qb.push(clause);
        if let Some(limit) = limit {
            qb.push(" limit ");
            qb.push_bind(limit);
        }
        Ok(qb
            .build_query_as::<RunWithIssueRow>()
            .fetch_all(&self.pool)
            .await?)
    }

    fn changed(&self, table: &str, op: &str) {
        self.events.emit(StorageEvent::DbChanged {
            table: table.to_string(),
            op: op.to_string(),
        });
    }
}

pub fn parse_agent_event_payload(row: &AgentEventRow) -> (AgentEventKind, Value) {
    let value = serde_json::from_str(&row.payload).unwrap_or(Value::Null);
    (kind_from_str(&row.kind), value)
}

#[allow(dead_code)]
fn _rows_affected(result: SqliteQueryResult) -> u64 {
    result.rows_affected()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{migrate, EventBus};
    use sqlx::sqlite::SqlitePoolOptions;

    async fn repo() -> Repository {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        migrate(&pool).await.unwrap();
        Repository::new(pool, EventBus::default())
    }

    fn issue() -> Issue {
        Issue {
            id: "lin-1".to_string(),
            identifier: "SYM-1".to_string(),
            title: "Test".to_string(),
            description: None,
            priority: 1,
            state: "todo".to_string(),
            branch: None,
            labels: vec![],
            blockers: vec![],
            pr_urls: vec![],
            project_id: None,
            project_slug_id: None,
        }
    }

    fn test_retro_suggestion(retro_id: &str, id: &str, decision: &str) -> RetroSuggestionRow {
        RetroSuggestionRow {
            id: id.to_string(),
            retro_id: retro_id.to_string(),
            repo_name: "widgets".to_string(),
            repo_url: Some("https://github.com/acme/widgets.git".to_string()),
            finding_index: 0,
            target_type: "repo_workflow".to_string(),
            target_id: "repository workflow".to_string(),
            target_path: "SYMPHONY-WORKFLOW.md".to_string(),
            title: "Record prerequisites".to_string(),
            body: "Add guidance".to_string(),
            rationale: "Repeated twice".to_string(),
            confidence: "high".to_string(),
            guidance: "Record reusable prerequisites.".to_string(),
            before_content: Some("before".to_string()),
            after_content: Some("after".to_string()),
            unified_diff: Some("--- before\n+++ after".to_string()),
            base_ref: Some("abc123".to_string()),
            base_hash: Some("hash".to_string()),
            proposal_status: "ready".to_string(),
            proposal_error: None,
            decision: decision.to_string(),
            decided_at: (decision != "pending").then(now_iso),
            created_at: now_iso(),
        }
    }

    fn test_retro_batch(
        retro_id: &str,
        id: &str,
        kind: &str,
        repo_name: Option<&str>,
    ) -> RetroBatchRow {
        RetroBatchRow {
            id: id.to_string(),
            retro_id: retro_id.to_string(),
            kind: kind.to_string(),
            repo_name: repo_name.map(str::to_string),
            repo_url: repo_name.map(|_| "https://github.com/acme/widgets.git".to_string()),
            base_ref: Some("abc123".to_string()),
            state: "queued".to_string(),
            progress: Some("Queued".to_string()),
            error: None,
            pr_url: None,
            created_at: now_iso(),
            completed_at: None,
        }
    }

    #[tokio::test]
    async fn finds_issue_ids_outside_state_names_case_insensitively() {
        let repo = repo().await;
        repo.upsert_issues(&[issue()]).await.unwrap();
        let ids = repo
            .issue_ids_not_in_states(&["Done".to_string(), "Canceled".to_string()])
            .await
            .unwrap();
        assert_eq!(ids, vec!["lin-1".to_string()]);
        let excluded = repo
            .issue_ids_not_in_states(&["TODO".to_string()])
            .await
            .unwrap();
        assert!(excluded.is_empty());
        let all = repo.issue_ids_not_in_states(&[]).await.unwrap();
        assert_eq!(all, vec!["lin-1".to_string()]);
    }

    #[tokio::test]
    async fn resetless_claude_hit_keeps_known_reset_but_codex_clears_it() {
        let repo = repo().await;
        for source in ["claude", "codex_primary"] {
            repo.upsert_rate_limit(&RateLimitPayload {
                source: source.to_string(),
                remaining: None,
                reset_at: Some("2099-01-01T00:00:00.000Z".to_string()),
            })
            .await
            .unwrap();
            repo.upsert_rate_limit(&RateLimitPayload {
                source: source.to_string(),
                remaining: None,
                reset_at: None,
            })
            .await
            .unwrap();
        }
        let active = repo
            .active_rate_limits("2026-06-11T00:00:00.000Z")
            .await
            .unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].source, "claude");
        assert_eq!(
            active[0].reset_at.as_deref(),
            Some("2099-01-01T00:00:00.000Z")
        );
    }

    #[tokio::test]
    async fn reserves_unique_run_numbers() {
        let repo = repo().await;
        repo.upsert_issues(&[issue()]).await.unwrap();
        let first = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap();
        assert_eq!(
            first.expect("first reservation").repo_name.as_deref(),
            Some("widgets")
        );
        let duplicate = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap();
        assert!(duplicate.is_none());
    }

    #[tokio::test]
    async fn stores_session_info_on_run() {
        let repo = repo().await;
        repo.upsert_issues(&[issue()]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run.session_info, None);
        let info = SessionInfoPayload {
            model: Some("claude-opus-4-8".to_string()),
            permission_mode: Some("acceptEdits".to_string()),
            ..Default::default()
        };
        repo.set_run_session_info(&run.id, &info).await.unwrap();
        let stored = repo
            .get_run(&run.id)
            .await
            .unwrap()
            .unwrap()
            .session_info
            .expect("session info should be stored");
        let parsed: SessionInfoPayload = serde_json::from_str(&stored).unwrap();
        assert_eq!(parsed, info);
    }

    #[tokio::test]
    async fn trigger_retry_now_makes_scheduled_retry_due() {
        let repo = repo().await;
        repo.upsert_issues(&[issue()]).await.unwrap();
        repo.schedule_retry(
            "lin-1",
            2,
            "2099-01-01T00:00:00.000Z",
            Some("agent_failure"),
            Some("failed"),
        )
        .await
        .unwrap();

        assert!(repo.trigger_retry_now("lin-1").await.unwrap());
        assert_eq!(
            repo.due_retries(&now_iso()).await.unwrap()[0].issue_id,
            "lin-1"
        );
        assert!(!repo.trigger_retry_now("missing").await.unwrap());
    }

    // A user-stopped (not failed) run has no retry_queue row -- it leaves an
    // issue_dispatch_suppressions row instead, which silently blocks the
    // dispatcher until the issue's fingerprint changes upstream. "Retry now"
    // must also clear that, or the button does nothing for a stopped run.
    #[tokio::test]
    async fn trigger_retry_now_clears_user_cancelled_suppression() {
        let repo = repo().await;
        repo.upsert_issues(&[issue()]).await.unwrap();
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
        repo.suppress_issue_dispatch("lin-1", "user_cancelled", "fingerprint-at-cancel-time")
            .await
            .unwrap();

        assert!(repo.trigger_retry_now("lin-1").await.unwrap());
        assert!(repo
            .issue_dispatch_suppression("lin-1", "user_cancelled")
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            repo.pending_retry_issue_ids().await.unwrap(),
            vec!["lin-1".to_string()]
        );
        assert_eq!(repo.due_retries(&now_iso()).await.unwrap()[0].run_number, 2);
    }

    // A cancelled run recorded without a suppression row still needs to be
    // retryable from the run-detail button.
    #[tokio::test]
    async fn trigger_retry_now_queues_cancelled_run_without_suppression() {
        let repo = repo().await;
        repo.upsert_issues(&[issue()]).await.unwrap();
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

        assert!(repo.trigger_retry_now("lin-1").await.unwrap());
        assert_eq!(
            repo.pending_retry_issue_ids().await.unwrap(),
            vec!["lin-1".to_string()]
        );
        assert_eq!(repo.due_retries(&now_iso()).await.unwrap()[0].run_number, 2);
    }

    #[tokio::test]
    async fn trigger_retry_now_noops_when_cancelled_run_is_not_latest() {
        let repo = repo().await;
        repo.upsert_issues(&[issue()]).await.unwrap();
        let cancelled = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        repo.finish_run(
            &cancelled.id,
            RunStatus::Cancelled,
            Some("cancelled"),
            Some("run cancelled"),
        )
        .await
        .unwrap();
        repo.suppress_issue_dispatch("lin-1", "user_cancelled", "fingerprint-at-cancel-time")
            .await
            .unwrap();
        let retried = repo
            .try_reserve_run("lin-1", 2, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        repo.finish_run(&retried.id, RunStatus::Success, None, None)
            .await
            .unwrap();

        assert!(!repo.trigger_retry_now("lin-1").await.unwrap());
        assert_eq!(
            repo.issue_dispatch_suppression("lin-1", "user_cancelled")
                .await
                .unwrap()
                .as_deref(),
            Some("fingerprint-at-cancel-time")
        );
        assert!(repo.pending_retry_issue_ids().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn trigger_retry_now_noops_when_issue_already_has_active_run() {
        let repo = repo().await;
        repo.upsert_issues(&[issue()]).await.unwrap();
        let cancelled = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        repo.finish_run(
            &cancelled.id,
            RunStatus::Cancelled,
            Some("cancelled"),
            Some("run cancelled"),
        )
        .await
        .unwrap();
        let active = repo
            .try_reserve_run("lin-1", 2, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();

        assert!(!repo.trigger_retry_now("lin-1").await.unwrap());
        assert!(repo.has_active_run("lin-1").await.unwrap());
        assert!(repo.pending_retry_issue_ids().await.unwrap().is_empty());
        assert_eq!(
            repo.get_run(&active.id).await.unwrap().unwrap().status,
            "pending"
        );
    }

    #[tokio::test]
    async fn marking_retry_run_running_clears_retry_queue() {
        let repo = repo().await;
        repo.upsert_issues(&[issue()]).await.unwrap();
        repo.schedule_retry(
            "lin-1",
            2,
            "2000-01-01T00:00:00.000Z",
            Some("agent_failure"),
            Some("failed"),
        )
        .await
        .unwrap();
        let run = repo
            .try_reserve_run("lin-1", 2, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();

        repo.mark_running(&run.id).await.unwrap();

        let overview = repo.overview().await.unwrap();
        assert_eq!(overview.active_runs.len(), 1);
        assert_eq!(overview.active_runs[0].id, run.id);
        assert!(overview.retry_queue.is_empty());
        assert!(repo.pending_retry_issue_ids().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn overview_includes_pending_runs_waiting_for_claim() {
        let repo = repo().await;
        repo.upsert_issues(&[issue()]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();

        let overview = repo.overview().await.unwrap();

        assert_eq!(overview.active_runs.len(), 1);
        assert_eq!(overview.active_runs[0].id, run.id);
        assert_eq!(overview.active_runs[0].status, "pending");
    }

    #[tokio::test]
    async fn workspace_cleanup_queue_drives_overview_and_recovers_claims() {
        let repo = repo().await;
        repo.begin_workspace_cleanup(
            "cleanup-1",
            "widgets",
            "SYM-1",
            "/tmp/widgets/SYM-1",
            "/tmp/widgets/.symphony-trash/SYM-1--cleanup-1",
            "2000-01-01T00:00:00.000Z",
        )
        .await
        .unwrap();

        assert_eq!(repo.overview().await.unwrap().workspace_cleanup_count, 1);
        assert_eq!(
            repo.quarantining_workspace_cleanups().await.unwrap().len(),
            1
        );

        repo.queue_workspace_cleanup("cleanup-1").await.unwrap();
        let queued = repo
            .due_workspace_cleanup("2099-01-01T00:00:00.000Z")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(queued.status, "queued");
        assert!(repo.claim_workspace_cleanup("cleanup-1").await.unwrap());
        assert!(!repo.claim_workspace_cleanup("cleanup-1").await.unwrap());

        repo.recover_workspace_cleanup_queue().await.unwrap();
        let recovered = repo
            .due_workspace_cleanup("2099-01-01T00:00:00.000Z")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.status, "queued");
        assert_eq!(recovered.attempts, 1);

        repo.retry_workspace_cleanup("cleanup-1", "2099-01-01T00:00:00.000Z", "busy")
            .await
            .unwrap();
        assert!(repo
            .due_workspace_cleanup("2000-01-01T00:00:00.000Z")
            .await
            .unwrap()
            .is_none());

        repo.delete_workspace_cleanup("cleanup-1").await.unwrap();
        assert_eq!(repo.overview().await.unwrap().workspace_cleanup_count, 0);
    }

    #[tokio::test]
    async fn overview_counts_all_failures_and_retries_beyond_preview_limits() {
        let repo = repo().await;
        let issues = (0..51)
            .map(|index| Issue {
                id: format!("lin-{index}"),
                identifier: format!("SYM-{index}"),
                ..issue()
            })
            .collect::<Vec<_>>();
        repo.upsert_issues(&issues).await.unwrap();

        for current_issue in &issues {
            let run = repo
                .try_reserve_run(&current_issue.id, 1, "/tmp/ws", Some("widgets"))
                .await
                .unwrap()
                .unwrap();
            repo.finish_run(
                &run.id,
                RunStatus::Failure,
                Some("agent_failure"),
                Some("failed"),
            )
            .await
            .unwrap();
            repo.schedule_retry(
                &current_issue.id,
                2,
                "2099-01-01T00:00:00.000Z",
                Some("agent_failure"),
                Some("failed"),
            )
            .await
            .unwrap();
        }

        let overview = repo.overview().await.unwrap();

        assert_eq!(overview.failure_count, 51);
        assert_eq!(overview.recent_failures.len(), 20);
        assert_eq!(overview.retry_count, 51);
        assert_eq!(overview.retry_queue.len(), 50);
    }

    #[tokio::test]
    async fn accumulates_token_usage_per_provider() {
        let repo = repo().await;
        repo.record_token_usage(
            "claude",
            &TokenCountPayload {
                input_tokens: 100,
                output_tokens: 10,
                total_tokens: 110,
            },
        )
        .await
        .unwrap();
        repo.record_token_usage(
            "claude",
            &TokenCountPayload {
                input_tokens: 200,
                output_tokens: 20,
                total_tokens: 220,
            },
        )
        .await
        .unwrap();
        repo.record_token_usage(
            "codex",
            &TokenCountPayload {
                input_tokens: 50,
                output_tokens: 5,
                total_tokens: 55,
            },
        )
        .await
        .unwrap();

        let usage = repo.overview().await.unwrap().token_usage;
        assert_eq!(usage.len(), 2);
        let claude = &usage[0];
        assert_eq!(claude.source, "claude");
        assert_eq!(claude.input_tokens, 300);
        assert_eq!(claude.output_tokens, 30);
        assert_eq!(claude.total_tokens, 330);
        assert_eq!(claude.run_count, 2);
        let codex = &usage[1];
        assert_eq!(codex.source, "codex");
        assert_eq!(codex.total_tokens, 55);
        assert_eq!(codex.run_count, 1);
    }

    #[tokio::test]
    async fn identity_upsert_preserves_accumulated_live_session_tokens() {
        let repo = repo().await;
        repo.upsert_issues(&[issue()]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();

        repo.upsert_live_session(
            &run.id,
            "pending-session",
            "",
            "",
            &TokenCountPayload {
                input_tokens: 120,
                output_tokens: 34,
                total_tokens: 154,
            },
        )
        .await
        .unwrap();
        repo.upsert_live_session(
            &run.id,
            "final-session",
            "thread-1",
            "turn-1",
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
        assert!(!session.last_event_at.is_empty());
    }

    #[tokio::test]
    async fn stores_retros_and_lists_terminal_runs_in_window() {
        let repo = repo().await;
        repo.upsert_issues(&[issue()]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        repo.mark_running(&run.id).await.unwrap();
        repo.append_event(
            &run.id,
            AgentEventKind::Status,
            &serde_json::json!({ "message": "done" }),
        )
        .await
        .unwrap();
        repo.finish_run(&run.id, RunStatus::Success, None, None)
            .await
            .unwrap();

        let pending = repo
            .try_reserve_run("lin-1", 2, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();

        let retro = repo
            .create_retro("1970-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z")
            .await
            .unwrap();
        let runs = repo
            .list_retro_runs(&retro.since_at, &retro.until_at)
            .await
            .unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, run.id);
        assert_ne!(runs[0].id, pending.id);

        let events = repo
            .events_for_run_ids(std::slice::from_ref(&run.id))
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        repo.upsert_workpad_snapshot(&WorkpadSnapshotRow {
            issue_id: "lin-1".to_string(),
            comment_id: "comment-1".to_string(),
            body_hash: "hash".to_string(),
            body: "## Symphony Workpad".to_string(),
            comment_created_at: None,
            comment_updated_at: None,
            fetched_at: now_iso(),
        })
        .await
        .unwrap();
        repo.insert_retro_inputs(&[RetroInputRow {
            retro_id: retro.id.clone(),
            run_id: run.id,
            issue_id: "lin-1".to_string(),
            repo_name: Some("widgets".to_string()),
            workpad_comment_id: Some("comment-1".to_string()),
            workpad_hash: Some("hash".to_string()),
        }])
        .await
        .unwrap();
        repo.finish_retro(&retro.id, r#"{"ok":true}"#, 1, 1)
            .await
            .unwrap();

        let latest = repo.latest_completed_retro().await.unwrap().unwrap();
        assert_eq!(latest.id, retro.id);
        assert_eq!(latest.status, "completed");
        assert_eq!(latest.run_count, 1);
        assert_eq!(repo.list_retros(10).await.unwrap().len(), 1);
        let previous_hashes = repo
            .previous_retro_workpad_hashes(&["lin-1".to_string()], "2099-01-01T00:00:00.000Z")
            .await
            .unwrap();
        assert_eq!(
            previous_hashes.get("lin-1").map(String::as_str),
            Some("hash")
        );

        let stale = repo
            .create_retro("2099-01-01T00:00:00.000Z", "2099-01-02T00:00:00.000Z")
            .await
            .unwrap();
        repo.fail_running_retros("Retro interrupted before completion.")
            .await
            .unwrap();
        let failed = repo.get_retro(&stale.id).await.unwrap().unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(
            failed.error_message.as_deref(),
            Some("Retro interrupted before completion.")
        );
    }

    #[tokio::test]
    async fn deletes_retro_artifacts_and_rolls_back_the_generation_marker() {
        let repo = repo().await;
        let earlier = repo
            .create_retro("1970-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")
            .await
            .unwrap();
        repo.finish_retro(&earlier.id, r#"{"id":"earlier"}"#, 0, 0)
            .await
            .unwrap();
        let latest = repo
            .create_retro("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")
            .await
            .unwrap();
        repo.finish_retro(&latest.id, r#"{"id":"latest"}"#, 1, 1)
            .await
            .unwrap();
        assert!(!repo.delete_retro(&earlier.id).await.unwrap());
        assert!(repo.get_retro(&earlier.id).await.unwrap().is_some());

        repo.upsert_issues(&[issue()]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", Some("widgets"))
            .await
            .unwrap()
            .unwrap();
        repo.insert_retro_inputs(&[RetroInputRow {
            retro_id: latest.id.clone(),
            run_id: run.id,
            issue_id: "lin-1".to_string(),
            repo_name: Some("widgets".to_string()),
            workpad_comment_id: None,
            workpad_hash: None,
        }])
        .await
        .unwrap();
        let suggestion = test_retro_suggestion(&latest.id, "delete-suggestion", "accepted");
        repo.insert_retro_suggestions(std::slice::from_ref(&suggestion))
            .await
            .unwrap();
        let batch = test_retro_batch(&latest.id, "delete-batch", "repo_pr", Some("widgets"));
        assert_eq!(
            repo.reserve_retro_batch(&batch, std::slice::from_ref(&suggestion.id))
                .await
                .unwrap(),
            RetroBatchReservation::Created
        );
        repo.update_retro_batch(&batch.id, "completed", Some("Done"), None, None)
            .await
            .unwrap();

        assert!(repo.delete_retro(&latest.id).await.unwrap());
        assert!(repo.get_retro(&latest.id).await.unwrap().is_none());
        assert!(repo
            .list_retro_suggestions(&latest.id)
            .await
            .unwrap()
            .is_empty());
        assert!(repo
            .list_retro_batches(&latest.id)
            .await
            .unwrap()
            .is_empty());
        let input_count: i64 =
            sqlx::query_scalar("select count(*) from retro_inputs where retro_id = ?1")
                .bind(&latest.id)
                .fetch_one(&repo.pool)
                .await
                .unwrap();
        let batch_item_count: i64 =
            sqlx::query_scalar("select count(*) from retro_batch_items where batch_id = ?1")
                .bind(&batch.id)
                .fetch_one(&repo.pool)
                .await
                .unwrap();
        assert_eq!(input_count, 0);
        assert_eq!(batch_item_count, 0);
        assert_eq!(
            repo.latest_completed_retro().await.unwrap().unwrap().id,
            earlier.id
        );

        let running = repo
            .create_retro("2027-01-01T00:00:00.000Z", "2028-01-01T00:00:00.000Z")
            .await
            .unwrap();
        assert!(!repo.delete_retro(&running.id).await.unwrap());
        assert!(repo.get_retro(&running.id).await.unwrap().is_some());

        repo.fail_retro(&running.id, "Finished for test.")
            .await
            .unwrap();
        let protected_suggestion =
            test_retro_suggestion(&running.id, "protected-suggestion", "accepted");
        repo.insert_retro_suggestions(std::slice::from_ref(&protected_suggestion))
            .await
            .unwrap();
        let protected_batch =
            test_retro_batch(&running.id, "protected-batch", "repo_pr", Some("widgets"));
        assert_eq!(
            repo.reserve_retro_batch(
                &protected_batch,
                std::slice::from_ref(&protected_suggestion.id),
            )
            .await
            .unwrap(),
            RetroBatchReservation::Created
        );
        assert!(!repo.delete_retro(&running.id).await.unwrap());
        repo.update_retro_batch(
            &protected_batch.id,
            "failed",
            None,
            Some("Stopped for test."),
            None,
        )
        .await
        .unwrap();
        assert!(repo.delete_retro(&running.id).await.unwrap());
    }

    #[tokio::test]
    async fn persists_retro_decisions_and_locks_the_entire_batch_target() {
        let repo = repo().await;
        let retro = repo
            .create_retro("1970-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z")
            .await
            .unwrap();
        let suggestion = RetroSuggestionRow {
            id: "suggestion-1".to_string(),
            retro_id: retro.id.clone(),
            repo_name: "widgets".to_string(),
            repo_url: Some("https://github.com/acme/widgets.git".to_string()),
            finding_index: 0,
            target_type: "skill".to_string(),
            target_id: "symphony-workpad".to_string(),
            target_path: ".agents/skills/symphony-workpad/SKILL.md".to_string(),
            title: "Record prerequisites".to_string(),
            body: "Add guidance".to_string(),
            rationale: "Repeated twice".to_string(),
            confidence: "high".to_string(),
            guidance: "Record reusable prerequisites.".to_string(),
            before_content: Some("before".to_string()),
            after_content: Some("after".to_string()),
            unified_diff: Some("--- before\n+++ after".to_string()),
            base_ref: Some("abc123".to_string()),
            base_hash: Some("hash".to_string()),
            proposal_status: "ready".to_string(),
            proposal_error: None,
            decision: "pending".to_string(),
            decided_at: None,
            created_at: now_iso(),
        };
        repo.insert_retro_suggestions(std::slice::from_ref(&suggestion))
            .await
            .unwrap();
        let mut rejected = test_retro_suggestion(&retro.id, "suggestion-2", "rejected");
        rejected.finding_index = 1;
        repo.insert_retro_suggestions(std::slice::from_ref(&rejected))
            .await
            .unwrap();
        let accepted = repo
            .set_retro_suggestion_decision(&suggestion.id, "accepted")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(accepted.decision, "accepted");
        assert!(accepted.decided_at.is_some());

        let batch = RetroBatchRow {
            id: "batch-1".to_string(),
            retro_id: retro.id.clone(),
            kind: "repo_pr".to_string(),
            repo_name: Some("widgets".to_string()),
            repo_url: suggestion.repo_url.clone(),
            base_ref: suggestion.base_ref.clone(),
            state: "queued".to_string(),
            progress: Some("Queued".to_string()),
            error: None,
            pr_url: None,
            created_at: now_iso(),
            completed_at: None,
        };
        assert_eq!(
            repo.reserve_retro_batch(&batch, std::slice::from_ref(&suggestion.id))
                .await
                .unwrap(),
            RetroBatchReservation::Created
        );

        let locked = repo
            .set_retro_suggestion_decision(&suggestion.id, "pending")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(locked.decision, "accepted");
        let rejected_locked = repo
            .set_retro_suggestion_decision(&rejected.id, "accepted")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rejected_locked.decision, "rejected");
        assert_eq!(repo.list_retro_batches(&retro.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn revalidates_the_exact_accepted_set_before_reserving_a_batch() {
        let repo = repo().await;
        let retro = repo
            .create_retro("1970-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z")
            .await
            .unwrap();
        let first = test_retro_suggestion(&retro.id, "accepted-a", "accepted");
        let mut second = test_retro_suggestion(&retro.id, "accepted-b", "accepted");
        second.finding_index = 1;
        repo.insert_retro_suggestions(&[first.clone(), second.clone()])
            .await
            .unwrap();
        let batch = test_retro_batch(&retro.id, "stale-selection", "repo_pr", Some("widgets"));

        assert_eq!(
            repo.reserve_retro_batch(&batch, std::slice::from_ref(&first.id))
                .await
                .unwrap(),
            RetroBatchReservation::AcceptedSetChanged
        );
        assert!(repo.list_retro_batches(&retro.id).await.unwrap().is_empty());

        assert_eq!(
            repo.reserve_retro_batch(&batch, &[first.id, second.id])
                .await
                .unwrap(),
            RetroBatchReservation::Created
        );
    }

    #[tokio::test]
    async fn refuses_batches_until_every_ready_suggestion_is_reviewed() {
        let repo = repo().await;
        let retro = repo
            .create_retro("1970-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z")
            .await
            .unwrap();
        let suggestion = test_retro_suggestion(&retro.id, "pending-suggestion", "pending");
        repo.insert_retro_suggestions(std::slice::from_ref(&suggestion))
            .await
            .unwrap();
        let batch = test_retro_batch(&retro.id, "partial-batch", "repo_pr", Some("widgets"));

        assert_eq!(
            repo.reserve_retro_batch(&batch, std::slice::from_ref(&suggestion.id))
                .await
                .unwrap(),
            RetroBatchReservation::ReviewIncomplete
        );
        assert!(repo.list_retro_batches(&retro.id).await.unwrap().is_empty());

        repo.set_retro_suggestion_decision(&suggestion.id, "accepted")
            .await
            .unwrap();
        assert_eq!(
            repo.reserve_retro_batch(&batch, std::slice::from_ref(&suggestion.id))
                .await
                .unwrap(),
            RetroBatchReservation::Created
        );
    }

    #[tokio::test]
    async fn atomically_reserves_one_active_batch_per_retro_repo() {
        let path = std::env::temp_dir().join(format!(
            "symphony-retro-reservation-{}.sqlite",
            Uuid::new_v4()
        ));
        let pool = crate::open_sqlite(&path).await.unwrap();
        let repo = Repository::new(pool.clone(), EventBus::default());
        let retro = repo
            .create_retro("1970-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z")
            .await
            .unwrap();
        let suggestion = test_retro_suggestion(&retro.id, "accepted-suggestion", "accepted");
        repo.insert_retro_suggestions(std::slice::from_ref(&suggestion))
            .await
            .unwrap();
        let first = test_retro_batch(&retro.id, "batch-a", "repo_pr", Some("widgets"));
        let second = test_retro_batch(&retro.id, "batch-b", "repo_pr", Some("widgets"));

        let (first_result, second_result) = tokio::join!(
            repo.reserve_retro_batch(&first, std::slice::from_ref(&suggestion.id)),
            repo.reserve_retro_batch(&second, std::slice::from_ref(&suggestion.id))
        );
        let results = [first_result.unwrap(), second_result.unwrap()];
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == RetroBatchReservation::Created)
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == RetroBatchReservation::AlreadyReserved)
                .count(),
            1
        );
        assert_eq!(repo.list_retro_batches(&retro.id).await.unwrap().len(), 1);

        pool.close().await;
        tokio::fs::remove_file(path).await.ok();
    }

    #[tokio::test]
    async fn fails_in_progress_retro_batches_after_restart() {
        let repo = repo().await;
        let retro = repo
            .create_retro("1970-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z")
            .await
            .unwrap();
        let suggestion = test_retro_suggestion(&retro.id, "accepted-suggestion", "accepted");
        let mut prompt_suggestion = test_retro_suggestion(&retro.id, "accepted-prompt", "accepted");
        prompt_suggestion.finding_index = 1;
        prompt_suggestion.target_type = "prompt".to_string();
        prompt_suggestion.target_id = "common prompt".to_string();
        prompt_suggestion.target_path = "Settings → Prompt template".to_string();
        repo.insert_retro_suggestions(&[suggestion.clone(), prompt_suggestion.clone()])
            .await
            .unwrap();
        let running = test_retro_batch(&retro.id, "running-batch", "repo_pr", Some("widgets"));
        let queued = test_retro_batch(&retro.id, "queued-batch", "workflow_update", None);
        assert_eq!(
            repo.reserve_retro_batch(&running, std::slice::from_ref(&suggestion.id))
                .await
                .unwrap(),
            RetroBatchReservation::Created
        );
        assert_eq!(
            repo.reserve_retro_batch(&queued, std::slice::from_ref(&prompt_suggestion.id))
                .await
                .unwrap(),
            RetroBatchReservation::Created
        );
        repo.update_retro_batch(&running.id, "running", Some("Working"), None, None)
            .await
            .unwrap();

        repo.fail_in_progress_retro_batches("Restarted before completion.")
            .await
            .unwrap();

        let batches = repo.list_retro_batches(&retro.id).await.unwrap();
        assert_eq!(batches.len(), 2);
        assert!(batches.iter().all(|batch| batch.state == "failed"));
        assert!(batches
            .iter()
            .all(|batch| batch.error.as_deref() == Some("Restarted before completion.")));
        assert!(batches.iter().all(|batch| batch.completed_at.is_some()));
    }

    #[tokio::test]
    async fn detects_in_progress_retro_batches_across_retros() {
        let repo = repo().await;
        let retro = repo
            .create_retro("1970-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z")
            .await
            .unwrap();
        let suggestion = test_retro_suggestion(&retro.id, "accepted-suggestion", "accepted");
        repo.insert_retro_suggestions(std::slice::from_ref(&suggestion))
            .await
            .unwrap();
        let batch = test_retro_batch(&retro.id, "queued-batch", "repo_pr", Some("widgets"));
        repo.reserve_retro_batch(&batch, std::slice::from_ref(&suggestion.id))
            .await
            .unwrap();

        assert!(repo.has_in_progress_retro_batches().await.unwrap());
        repo.update_retro_batch(&batch.id, "completed", Some("Done"), None, None)
            .await
            .unwrap();
        assert!(!repo.has_in_progress_retro_batches().await.unwrap());
    }

    #[tokio::test]
    async fn event_lookup_batches_large_run_sets() {
        let repo = repo().await;
        let issues = (0..=SQLITE_BIND_CHUNK_SIZE)
            .map(|index| {
                let mut issue = issue();
                issue.id = format!("lin-{index}");
                issue.identifier = format!("SYM-{index}");
                issue
            })
            .collect::<Vec<_>>();
        repo.upsert_issues(&issues).await.unwrap();

        let mut run_ids = Vec::new();
        for issue in &issues {
            let run = repo
                .try_reserve_run(&issue.id, 1, "/tmp/ws", Some("widgets"))
                .await
                .unwrap()
                .unwrap();
            repo.mark_running(&run.id).await.unwrap();
            repo.append_event(
                &run.id,
                AgentEventKind::Status,
                &serde_json::json!({ "message": "chunked" }),
            )
            .await
            .unwrap();
            run_ids.push(run.id);
        }

        let events = repo.events_for_run_ids(&run_ids).await.unwrap();
        assert_eq!(events.len(), run_ids.len());
        let event_run_ids = events
            .iter()
            .map(|event| event.run_id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(event_run_ids.len(), run_ids.len());
    }

    #[tokio::test]
    async fn migrates_databases_created_before_versioning() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        // Replay 0001 by hand to simulate a database that predates the
        // schema_migrations table, then migrate and migrate again.
        for statement in crate::MIGRATIONS[0].1.split(';') {
            let statement = statement.trim();
            if !statement.is_empty() {
                sqlx::query(statement).execute(&pool).await.unwrap();
            }
        }
        migrate(&pool).await.unwrap();
        migrate(&pool).await.unwrap();
        sqlx::query("select session_info from runs limit 1")
            .execute(&pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn failed_migrations_roll_back_atomically() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let broken: &[(&str, &str)] = &[(
            "0001_probe",
            "create table atomic_probe (id integer primary key); not valid sql;",
        )];
        assert!(crate::apply_migrations(&pool, broken).await.is_err());
        let marker: Option<(String,)> =
            sqlx::query_as("select id from schema_migrations where id = '0001_probe'")
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(marker.is_none(), "failed migration must not be recorded");
        // The partial schema change rolled back, so a fixed migration with
        // the same id applies cleanly instead of hitting "already exists".
        let fixed: &[(&str, &str)] = &[(
            "0001_probe",
            "create table atomic_probe (id integer primary key);",
        )];
        crate::apply_migrations(&pool, fixed).await.unwrap();
        sqlx::query("select id from atomic_probe")
            .execute(&pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn enforces_one_running_run_per_issue() {
        let repo = repo().await;
        repo.upsert_issues(&[issue()]).await.unwrap();
        let first = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        let second = repo
            .try_reserve_run("lin-1", 2, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        repo.mark_running(&first.id).await.unwrap();
        let result = repo.mark_running(&second.id).await;
        assert!(matches!(result, Err(StorageError::AlreadyRunning(_))));
    }

    #[tokio::test]
    async fn runtime_lifecycle_transition_matrix_enforces_issue_run_and_retry_invariants() {
        let repo = repo().await;
        let terminal_cases = [
            (RunStatus::Success, "success"),
            (RunStatus::Failure, "failure"),
            (RunStatus::Timeout, "timeout"),
            (RunStatus::Cancelled, "cancelled"),
        ];

        for (source_index, starts_running) in [false, true].into_iter().enumerate() {
            for (target_index, (target, expected)) in terminal_cases.iter().enumerate() {
                let mut current_issue = issue();
                current_issue.id = format!("matrix-{source_index}-{target_index}");
                current_issue.identifier = format!("MATRIX-{source_index}-{target_index}");
                repo.upsert_issues(std::slice::from_ref(&current_issue))
                    .await
                    .unwrap();
                let run = repo
                    .try_reserve_run(&current_issue.id, 1, "/tmp/ws", None)
                    .await
                    .unwrap()
                    .unwrap();
                if starts_running {
                    repo.mark_running(&run.id).await.unwrap();
                }

                assert!(
                    repo.finish_run(
                        &run.id,
                        target.clone(),
                        Some("first"),
                        Some("first terminal")
                    )
                    .await
                    .unwrap(),
                    "{starts_running:?} -> {expected} should be legal"
                );
                let terminal = repo.get_run(&run.id).await.unwrap().unwrap();
                assert_eq!(terminal.status, *expected);
                assert_eq!(terminal.error_class.as_deref(), Some("first"));
                let ended_at = terminal.ended_at.clone();

                let replacement = if *expected == "success" {
                    RunStatus::Failure
                } else {
                    RunStatus::Success
                };
                assert!(
                    !repo
                        .finish_run(&run.id, replacement, Some("late"), Some("late terminal"),)
                        .await
                        .unwrap(),
                    "terminal state {expected} must be immutable"
                );
                repo.mark_running(&run.id).await.unwrap();
                let unchanged = repo.get_run(&run.id).await.unwrap().unwrap();
                assert_eq!(unchanged.status, *expected);
                assert_eq!(unchanged.error_class.as_deref(), Some("first"));
                assert_eq!(unchanged.ended_at, ended_at);
            }
        }

        for target in [RunStatus::Pending, RunStatus::Running] {
            let mut current_issue = issue();
            current_issue.id = format!("illegal-{}", target.as_db_str());
            current_issue.identifier = format!("ILLEGAL-{}", target.as_db_str());
            repo.upsert_issues(std::slice::from_ref(&current_issue))
                .await
                .unwrap();
            let run = repo
                .try_reserve_run(&current_issue.id, 1, "/tmp/ws", None)
                .await
                .unwrap()
                .unwrap();

            let error = repo
                .finish_run(&run.id, target.clone(), None, None)
                .await
                .unwrap_err();
            assert!(matches!(
                error,
                StorageError::InvalidRunTransition { status, .. }
                    if status == target.as_db_str()
            ));
            assert_eq!(
                repo.get_run(&run.id).await.unwrap().unwrap().status,
                "pending"
            );
        }

        let mut synced_issue = issue();
        synced_issue.id = "issue-transition".to_string();
        synced_issue.identifier = "ISSUE-TRANSITION".to_string();
        for state in ["Todo", "In Progress", "Done"] {
            synced_issue.state = state.to_string();
            repo.upsert_issues(std::slice::from_ref(&synced_issue))
                .await
                .unwrap();
            assert_eq!(
                repo.get_issue(&synced_issue.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .state,
                state
            );
        }

        repo.schedule_retry(
            &synced_issue.id,
            2,
            "2000-01-01T00:00:00Z",
            Some("first"),
            None,
        )
        .await
        .unwrap();
        repo.schedule_retry(
            &synced_issue.id,
            3,
            "2000-01-02T00:00:00Z",
            Some("latest"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            repo.all_retry_issue_ids().await.unwrap(),
            vec![synced_issue.id]
        );
        let retries = repo.due_retries("9999-01-01T00:00:00Z").await.unwrap();
        assert_eq!(retries.len(), 1);
        assert_eq!(retries[0].run_number, 3);
        assert_eq!(retries[0].error_class.as_deref(), Some("latest"));
    }

    #[tokio::test]
    async fn count_active_includes_pending_runs() {
        // The max_concurrent_agents gate uses count_active. A run reserved into
        // `pending` (doing setup, not yet `running`) must still occupy a slot,
        // otherwise a single dispatch pass reserves many runs at once and blows
        // past the configured limit before any of them flips to `running`.
        let repo = repo().await;
        let issues: Vec<Issue> = (0..3)
            .map(|n| Issue {
                id: format!("lin-{n}"),
                identifier: format!("SYM-{n}"),
                ..issue()
            })
            .collect();
        repo.upsert_issues(&issues).await.unwrap();

        // Two pending, one running.
        let pending_a = repo
            .try_reserve_run("lin-0", 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        repo.try_reserve_run("lin-1", 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        let running = repo
            .try_reserve_run("lin-2", 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        repo.mark_running(&running.id).await.unwrap();

        assert_eq!(repo.count_active().await.unwrap(), 3);

        // A finished run no longer occupies a slot.
        repo.finish_run(&pending_a.id, RunStatus::Cancelled, None, None)
            .await
            .unwrap();
        assert_eq!(repo.count_active().await.unwrap(), 2);
    }

    #[tokio::test]
    async fn overview_keeps_all_running_runs_so_live_sessions_stay_visible() {
        // The Overview's last-activity column joins live_sessions to active_runs
        // by run_id, so every live session needs a matching active run. Running
        // runs are bounded only by max_concurrent_agents (no hard cap), so the
        // active_runs query must not truncate them. 25 exceeds the old limit of
        // 20; the live session sits past that boundary.
        let repo = repo().await;
        let issues: Vec<Issue> = (0..25)
            .map(|n| Issue {
                id: format!("lin-{n}"),
                identifier: format!("SYM-{n}"),
                ..issue()
            })
            .collect();
        repo.upsert_issues(&issues).await.unwrap();

        let mut run_ids = Vec::new();
        for n in 0..25 {
            let run = repo
                .try_reserve_run(&format!("lin-{n}"), 1, "/tmp/ws", None)
                .await
                .unwrap()
                .unwrap();
            repo.mark_running(&run.id).await.unwrap();
            run_ids.push(run.id);
        }

        // Stream tokens on the 25th run — past the old cap.
        repo.upsert_live_session(
            &run_ids[24],
            "sess",
            "thread",
            "turn",
            &TokenCountPayload {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
            },
        )
        .await
        .unwrap();

        let overview = repo.overview().await.unwrap();
        assert_eq!(overview.active_runs.len(), 25);
        for session in &overview.live_sessions {
            assert!(
                overview
                    .active_runs
                    .iter()
                    .any(|run| run.id == session.run_id),
                "live session {} missing from active_runs",
                session.run_id
            );
        }
    }

    #[tokio::test]
    async fn overview_last_activity_uses_latest_agent_event() {
        let repo = repo().await;
        repo.upsert_issues(&[issue()]).await.unwrap();
        let run = repo
            .try_reserve_run("lin-1", 1, "/tmp/ws", None)
            .await
            .unwrap()
            .unwrap();
        repo.mark_running(&run.id).await.unwrap();
        repo.upsert_live_session(
            &run.id,
            "sess",
            "thread",
            "turn",
            &TokenCountPayload {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
            },
        )
        .await
        .unwrap();
        sqlx::query("update live_sessions set last_event_at = ?1 where run_id = ?2")
            .bind("2026-01-01T00:00:00.000Z")
            .bind(&run.id)
            .execute(repo.pool())
            .await
            .unwrap();

        let event = repo
            .append_event(
                &run.id,
                AgentEventKind::Status,
                &serde_json::json!({ "message": "still working" }),
            )
            .await
            .unwrap();

        let overview = repo.overview().await.unwrap();
        let session = overview
            .live_sessions
            .iter()
            .find(|session| session.run_id == run.id)
            .expect("live session should be present");
        assert_eq!(session.last_event_at, event.created_at);
    }
}
