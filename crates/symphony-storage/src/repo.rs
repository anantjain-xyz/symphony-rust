use crate::{kind_from_str, now_iso, EventBus, StorageError, StorageEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use sqlx::{sqlite::SqliteQueryResult, FromRow, QueryBuilder, Sqlite, SqlitePool};
use symphony_core::{
    AgentEventKind, HookName, Issue, ParsedWorkflow, RateLimitPayload, RunStatus,
    SessionInfoPayload, TokenCountPayload,
};
use uuid::Uuid;

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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Overview {
    pub active_runs: Vec<RunWithIssueRow>,
    pub retry_queue: Vec<RetryWithIssueRow>,
    pub recent_failures: Vec<RunWithIssueRow>,
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
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            update runs
            set status = ?1, ended_at = ?2, error_class = ?3, error_message = ?4
            where id = ?5
            "#,
        )
        .bind(status.as_db_str())
        .bind(now_iso())
        .bind(error_class)
        .bind(error_message)
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        self.changed("runs", "update");
        Ok(())
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

    pub async fn count_running(&self) -> Result<i64, StorageError> {
        let (count,): (i64,) = sqlx::query_as("select count(*) from runs where status = 'running'")
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
              input_tokens = excluded.input_tokens,
              output_tokens = excluded.output_tokens,
              total_tokens = excluded.total_tokens,
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

    pub async fn update_tokens(
        &self,
        run_id: &str,
        tokens: &TokenCountPayload,
    ) -> Result<(), StorageError> {
        sqlx::query(
            r#"
            update live_sessions
            set input_tokens = ?1, output_tokens = ?2, total_tokens = ?3, last_event_at = ?4
            where run_id = ?5
            "#,
        )
        .bind(tokens.input_tokens)
        .bind(tokens.output_tokens)
        .bind(tokens.total_tokens)
        .bind(now_iso())
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        self.changed("live_sessions", "update");
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
        let result = sqlx::query("update retry_queue set due_at = ?1 where issue_id = ?2")
            .bind(now_iso())
            .bind(issue_id)
            .execute(&self.pool)
            .await?;
        let updated = result.rows_affected() > 0;
        if updated {
            self.changed("retry_queue", "update");
        }
        Ok(updated)
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
        // Running runs are bounded by agent.max_concurrent_agents (no hard cap),
        // and every live_session belongs to one of them — the Overview's
        // last-activity column joins the two by run_id. Don't truncate, or a
        // streaming run past an arbitrary limit would vanish from Overview.
        let active_runs = self
            .runs_with_issue("where r.status = 'running'", None)
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
        let recent_failures = self
            .runs_with_issue(
                "where r.status in ('failure', 'timeout') order by r.ended_at desc",
                Some(20),
            )
            .await?;
        let live_sessions = sqlx::query_as::<_, LiveSessionRow>("select * from live_sessions")
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
            recent_failures,
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
}
