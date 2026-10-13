//! Deliberate desktop projections; no SQL or worker implementation types.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use symphony_core::{
    AgentEventKind, BatchKind, BatchState, ProposalState, RetroState, RunStatus,
    SessionInfoPayload, SuggestionConfidence, SuggestionDecision, SuggestionTarget,
};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct IssueSummary {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub priority: i64,
    pub state: String,
    pub branch: Option<String>,
    pub labels: Vec<String>,
    pub blockers: Vec<String>,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RunSummary {
    pub id: String,
    pub issue_id: String,
    pub run_number: i64,
    pub workspace_path: String,
    pub status: RunStatus,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub error_class: Option<String>,
    pub error_message: Option<String>,
    pub session_info: Option<SessionInfoPayload>,
    pub repo_name: Option<String>,
    pub created_at: String,
    pub issue_identifier: String,
    pub issue_title: String,
    pub issue_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RetrySummary {
    pub issue_id: String,
    pub run_number: i64,
    pub due_at: String,
    pub error_class: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub issue_identifier: String,
    pub issue_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LiveSession {
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RateLimitState {
    pub source: String,
    pub remaining: Option<i64>,
    pub reset_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TokenUsage {
    pub source: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub run_count: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DashboardOverview {
    pub active_runs: Vec<RunSummary>,
    pub retry_queue: Vec<RetrySummary>,
    pub retry_count: i64,
    pub recent_failures: Vec<RunSummary>,
    pub workspace_cleanup_count: i64,
    pub live_sessions: Vec<LiveSession>,
    pub rate_limits: Vec<RateLimitState>,
    pub token_usage: Vec<TokenUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RetroSummary {
    pub id: String,
    pub since_at: String,
    pub until_at: String,
    pub status: RetroState,
    pub run_count: i64,
    pub issue_count: i64,
    pub error_message: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RetroSuggestionReview {
    pub id: String,
    pub retro_id: String,
    pub repo_name: String,
    pub repo_url: Option<String>,
    pub finding_index: i64,
    pub target_type: SuggestionTarget,
    pub target_id: String,
    pub target_path: String,
    pub title: String,
    pub body: String,
    pub rationale: String,
    pub confidence: SuggestionConfidence,
    pub guidance: String,
    pub before_content: Option<String>,
    pub after_content: Option<String>,
    pub unified_diff: Option<String>,
    pub base_ref: Option<String>,
    pub base_hash: Option<String>,
    pub proposal_status: ProposalState,
    pub proposal_error: Option<String>,
    pub decision: SuggestionDecision,
    pub decided_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RetroChangeBatch {
    pub id: String,
    pub retro_id: String,
    pub kind: BatchKind,
    pub repo_name: Option<String>,
    pub repo_url: Option<String>,
    pub base_ref: Option<String>,
    pub state: BatchState,
    pub progress: Option<String>,
    pub error: Option<String>,
    pub pr_url: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

/// JSON is opaque until a consumer narrows its shape; it is never `any` in IPC.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum JsonValue {
    Null,
    Boolean(bool),
    Number(f64),
    String(String),
    Array(Vec<JsonValue>),
    Object(std::collections::BTreeMap<String, JsonValue>),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AgentEvent {
    pub id: i64,
    pub run_id: String,
    pub kind: AgentEventKind,
    #[specta(type = JsonValue)]
    pub payload: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StorageNotification {
    DbChanged { table: String, op: String },
    AgentEvent { event: AgentEvent },
    RateLimitChanged { source: String },
    WorkflowReady,
}
