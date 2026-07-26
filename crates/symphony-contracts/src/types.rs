use serde::{Deserialize, Serialize};
use specta::Type;
use symphony_storage::{
    AgentEventRow, IssueRow, RetroBatchRow, RetroRow, RetroSuggestionRow, RunWithIssueRow,
};

use crate::AppSettings;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SaveSettingsRequest {
    pub settings: AppSettings,
    pub linear_api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ValidationResult {
    pub workflow_ok: bool,
    /// Whether `workflow_error` should stop a save. Genuine configuration
    /// mistakes block; an unfinished setup (see `workflow_setup_incomplete`)
    /// does not, so partial progress stays saveable.
    pub workflow_blocking: bool,
    pub workflow_error: Option<String>,
    pub codex_found: bool,
    pub claude_found: bool,
    pub cursor_found: bool,
    pub opencode_found: bool,
    pub codex_command: String,
    pub claude_command: String,
    pub cursor_command: String,
    pub opencode_command: String,
    pub app_data_dir: String,
    pub database_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TrackerTestResult {
    pub ok: bool,
    pub message: String,
    pub active_issue_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LinearViewerProfile {
    pub id: String,
    pub username: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RunDetail {
    pub run: RunWithIssueRow,
    pub events: Vec<AgentEventRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct IssueDetail {
    pub issue: IssueRow,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RetroRunState {
    Idle,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RetroStatus {
    pub state: RetroRunState,
    pub retro_id: Option<String>,
    pub message: Option<String>,
    pub report: Option<RetroReport>,
    pub error: Option<String>,
}

impl RetroStatus {
    pub fn idle() -> Self {
        Self {
            state: RetroRunState::Idle,
            retro_id: None,
            message: None,
            report: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RetroDetail {
    pub row: RetroRow,
    pub report: Option<RetroReport>,
    pub suggestions: Vec<RetroSuggestionRow>,
    pub batches: Vec<RetroBatchRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RetroReport {
    pub id: String,
    pub since_at: String,
    pub until_at: String,
    pub generated_at: String,
    pub run_count: i64,
    pub issue_count: i64,
    pub workpad_count: i64,
    pub repos: Vec<RetroRepoReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RetroRepoReport {
    pub repo_name: String,
    pub run_count: i64,
    pub issue_count: i64,
    pub workpad_count: i64,
    pub failure_count: i64,
    pub retry_count: i64,
    pub findings: Vec<RetroFinding>,
    pub suggestions: Vec<RetroSuggestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RetroFinding {
    pub title: String,
    pub detail: String,
    pub severity: RetroSeverity,
    pub occurrences: i64,
    pub evidence: Vec<RetroEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum RetroSeverity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RetroEvidence {
    pub issue_identifier: String,
    pub run_id: Option<String>,
    pub run_number: Option<i64>,
    pub event_id: Option<i64>,
    pub kind: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RetroSuggestion {
    pub target_type: RetroSuggestionTarget,
    pub target_id: String,
    pub title: String,
    pub body: String,
    pub rationale: String,
    pub confidence: RetroConfidence,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum RetroSuggestionTarget {
    Prompt,
    Skill,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RetroConfidence {
    Low,
    Medium,
    High,
}
