mod repo;

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use std::path::Path;
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
    let url = format!("sqlite://{}?mode=rwc", path.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect(&url)
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
        "0003_token_usage",
        include_str!("migrations/0003_token_usage.sql"),
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
