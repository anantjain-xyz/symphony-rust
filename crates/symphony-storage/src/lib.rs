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

pub async fn migrate(pool: &SqlitePool) -> Result<(), StorageError> {
    let sql = include_str!("migrations/0001_init.sql");
    for statement in sql.split(';') {
        let statement = statement.trim();
        if statement.is_empty() {
            continue;
        }
        sqlx::query(statement).execute(pool).await?;
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
