#[cfg(test)]
mod migration_contract_tests;
mod repo;

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    SqlitePool,
};
use std::path::Path;
use std::time::Duration;
use symphony_core::AgentEventKind;
use thiserror::Error;
use tokio::sync::broadcast;

pub use repo::*;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("run {0} lost the one-running-run race")]
    AlreadyRunning(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StorageEvent {
    DbChanged { table: String, op: String },
    AgentEvent { event: AgentEventRow },
    RateLimitChanged { source: String },
}

#[derive(Debug, Clone)]
pub struct EventBus {
    tx: broadcast::Sender<StorageEvent>,
}

impl Default for EventBus {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self { tx }
    }
}

impl EventBus {
    pub fn subscribe(&self) -> broadcast::Receiver<StorageEvent> {
        self.tx.subscribe()
    }

    pub fn emit(&self, event: StorageEvent) {
        let _ = self.tx.send(event);
    }
}

pub async fn open_sqlite(path: impl AsRef<Path>) -> Result<SqlitePool, StorageError> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(sqlx::Error::Io)?;
    }
    // WAL lets readers run concurrently with a writer, and a non-zero
    // busy_timeout makes a blocked writer wait-and-retry instead of failing
    // immediately with SQLITE_BUSY. Without these, the rollback-journal default
    // serializes every writer on a whole-database lock, so the worker's
    // concurrent agents plus the 2s heartbeat contend and a losing write
    // surfaces as an error that can strand a run. NORMAL synchronous is the
    // standard, crash-safe companion to WAL.
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(10))
        .synchronous(SqliteSynchronous::Normal);
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;
    migrate(&pool).await?;
    Ok(pool)
}

pub(crate) const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("migrations/0001_init.sql")),
    (
        "0002_run_session_info",
        include_str!("migrations/0002_run_session_info.sql"),
    ),
    (
        "0003_run_repo_name",
        include_str!("migrations/0003_run_repo_name.sql"),
    ),
    (
        "0004_token_usage",
        include_str!("migrations/0004_token_usage.sql"),
    ),
    (
        "0005_issue_dispatch_suppressions",
        include_str!("migrations/0005_issue_dispatch_suppressions.sql"),
    ),
    ("0006_retros", include_str!("migrations/0006_retros.sql")),
    (
        "0007_retro_review",
        include_str!("migrations/0007_retro_review.sql"),
    ),
    (
        "0008_repo_workflow_retro_targets",
        include_str!("migrations/0008_repo_workflow_retro_targets.sql"),
    ),
];

pub async fn migrate(pool: &SqlitePool) -> Result<(), StorageError> {
    apply_migrations(pool, MIGRATIONS).await
}

pub(crate) async fn apply_migrations(
    pool: &SqlitePool,
    migrations: &[(&str, &str)],
) -> Result<(), StorageError> {
    // 0001 predates this table and stays idempotent, so databases created
    // before migrations were versioned replay it harmlessly and catch up.
    sqlx::query(
        r#"
        create table if not exists schema_migrations (
          id text primary key,
          applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
        "#,
    )
    .execute(pool)
    .await?;
    for (id, sql) in migrations {
        let applied: Option<(String,)> =
            sqlx::query_as("select id from schema_migrations where id = ?1")
                .bind(id)
                .fetch_optional(pool)
                .await?;
        if applied.is_some() {
            continue;
        }
        // The statements and the marker commit together: an interrupted
        // migration rolls back whole instead of leaving the schema changed
        // with no marker, which would make every later startup retry the
        // migration and fail (e.g. on a duplicate column).
        let mut tx = pool.begin().await?;
        for statement in sql.split(';') {
            let statement = statement.trim();
            if statement.is_empty() {
                continue;
            }
            sqlx::query(statement).execute(&mut *tx).await?;
        }
        sqlx::query("insert into schema_migrations (id) values (?1)")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    Ok(())
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) fn kind_from_str(kind: &str) -> AgentEventKind {
    match kind {
        "tool_call" => AgentEventKind::ToolCall,
        "approval" => AgentEventKind::Approval,
        "token_count" => AgentEventKind::TokenCount,
        "error" => AgentEventKind::Error,
        "user_input" => AgentEventKind::UserInput,
        "humanized" => AgentEventKind::Humanized,
        "rate_limit" => AgentEventKind::RateLimit,
        _ => AgentEventKind::Status,
    }
}
