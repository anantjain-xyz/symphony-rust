use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentBackend {
    #[default]
    Codex,
    Claude,
}

impl AgentBackend {
    /// The provider key stored in source-keyed tables (`rate_limit_state`
    /// uses it as a prefix, `token_usage` as the whole key).
    pub fn as_source_str(&self) -> &'static str {
        match self {
            AgentBackend::Codex => "codex",
            AgentBackend::Claude => "claude",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
pub enum ApprovalPolicy {
    #[serde(rename = "never")]
    #[default]
    Never,
    #[serde(rename = "on-request")]
    OnRequest,
    #[serde(rename = "on-failure")]
    OnFailure,
    #[serde(rename = "always")]
    Always,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
pub enum ThreadSandbox {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "workspace-write")]
    #[default]
    WorkspaceWrite,
    #[serde(rename = "read-only")]
    ReadOnly,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
pub enum TurnSandboxPolicy {
    #[serde(rename = "inherit")]
    #[default]
    Inherit,
    #[serde(rename = "workspace-write")]
    WorkspaceWrite,
    #[serde(rename = "read-only")]
    ReadOnly,
    #[serde(rename = "danger-full-access")]
    DangerFullAccess,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ClaudePermissionMode {
    Default,
    #[default]
    AcceptEdits,
    Auto,
    BypassPermissions,
    DontAsk,
    Plan,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Pending,
    Running,
    Success,
    Failure,
    Timeout,
    Cancelled,
}

impl RunStatus {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Success => "success",
            Self::Failure => "failure",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Success | Self::Failure | Self::Timeout | Self::Cancelled
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentEventKind {
    Status,
    ToolCall,
    Approval,
    TokenCount,
    Error,
    UserInput,
    Humanized,
    RateLimit,
}

impl AgentEventKind {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::ToolCall => "tool_call",
            Self::Approval => "approval",
            Self::TokenCount => "token_count",
            Self::Error => "error",
            Self::UserInput => "user_input",
            Self::Humanized => "humanized",
            Self::RateLimit => "rate_limit",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookName {
    AfterCreate,
    BeforeRun,
    AfterRun,
    BeforeRemove,
}

impl HookName {
    pub fn as_env_value(&self) -> &'static str {
        match self {
            Self::AfterCreate => "after_create",
            Self::BeforeRun => "before_run",
            Self::AfterRun => "after_run",
            Self::BeforeRemove => "before_remove",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentOutcome {
    Success,
    Failure,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct TrackerConfig {
    #[serde(default = "default_tracker_endpoint")]
    pub endpoint: String,
    pub api_key: String,
    pub active_states: Vec<String>,
    pub terminal_states: Vec<String>,
    pub identifier_prefix: Option<String>,
    pub project_id: Option<String>,
}

impl Default for TrackerConfig {
    fn default() -> Self {
        Self {
            endpoint: default_tracker_endpoint(),
            api_key: String::new(),
            active_states: Vec::new(),
            terminal_states: Vec::new(),
            identifier_prefix: None,
            project_id: None,
        }
    }
}

fn default_tracker_endpoint() -> String {
    "https://api.linear.app/graphql".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct PollingConfig {
    pub interval_ms: u64,
}

impl Default for PollingConfig {
    fn default() -> Self {
        Self {
            interval_ms: 30_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct WorkspaceConfig {
    pub root: String,
}

impl Default for WorkspaceConfig {
    fn default() -> Self {
        Self {
            root: "${TMPDIR}/symphony-workspaces".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct HooksConfig {
    pub after_create: Option<String>,
    pub before_run: Option<String>,
    pub after_run: Option<String>,
    pub before_remove: Option<String>,
    #[serde(default = "default_hook_timeout_ms")]
    pub timeout_ms: u64,
}

impl Default for HooksConfig {
    fn default() -> Self {
        Self {
            after_create: None,
            before_run: None,
            after_run: None,
            before_remove: None,
            timeout_ms: default_hook_timeout_ms(),
        }
    }
}

fn default_hook_timeout_ms() -> u64 {
    60_000
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct AgentConfig {
    #[serde(default)]
    pub backend: AgentBackend,
    #[serde(default = "default_max_concurrent_agents")]
    pub max_concurrent_agents: usize,
    #[serde(default = "default_max_retry_backoff_ms")]
    pub max_retry_backoff_ms: u64,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            backend: AgentBackend::Codex,
            max_concurrent_agents: default_max_concurrent_agents(),
            max_retry_backoff_ms: default_max_retry_backoff_ms(),
        }
    }
}

fn default_max_concurrent_agents() -> usize {
    10
}

fn default_max_retry_backoff_ms() -> u64 {
    300_000
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct CodexConfig {
    #[serde(default = "default_codex_command")]
    pub command: String,
    #[serde(default)]
    pub approval_policy: ApprovalPolicy,
    #[serde(default)]
    pub thread_sandbox: ThreadSandbox,
    #[serde(default)]
    pub turn_sandbox_policy: TurnSandboxPolicy,
    #[serde(default = "default_turn_timeout_ms")]
    pub turn_timeout_ms: u64,
    #[serde(default)]
    pub network_access: bool,
}

impl Default for CodexConfig {
    fn default() -> Self {
        Self {
            command: default_codex_command(),
            approval_policy: ApprovalPolicy::Never,
            thread_sandbox: ThreadSandbox::WorkspaceWrite,
            turn_sandbox_policy: TurnSandboxPolicy::Inherit,
            turn_timeout_ms: default_turn_timeout_ms(),
            network_access: false,
        }
    }
}

fn default_codex_command() -> String {
    "codex".to_string()
}

fn default_turn_timeout_ms() -> u64 {
    3_600_000
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct ClaudeConfig {
    #[serde(default = "default_claude_command")]
    pub command: String,
    #[serde(default)]
    pub permission_mode: ClaudePermissionMode,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
    #[serde(default)]
    pub add_dirs: Vec<String>,
    #[serde(default = "default_turn_timeout_ms")]
    pub turn_timeout_ms: u64,
}

impl Default for ClaudeConfig {
    fn default() -> Self {
        Self {
            command: default_claude_command(),
            permission_mode: ClaudePermissionMode::AcceptEdits,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            add_dirs: Vec::new(),
            turn_timeout_ms: default_turn_timeout_ms(),
        }
    }
}

fn default_claude_command() -> String {
    "claude".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct WorkflowFrontMatter {
    pub tracker: TrackerConfig,
    #[serde(default)]
    pub polling: PollingConfig,
    #[serde(default)]
    pub workspace: WorkspaceConfig,
    #[serde(default)]
    pub hooks: HooksConfig,
    #[serde(default)]
    pub agent: AgentConfig,
    #[serde(default)]
    pub codex: CodexConfig,
    #[serde(default)]
    pub claude: ClaudeConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct ParsedWorkflow {
    pub front_matter: WorkflowFrontMatter,
    pub prompt_template: String,
    pub source_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct Issue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub priority: i16,
    pub state: String,
    pub branch: Option<String>,
    pub labels: Vec<String>,
    pub blockers: Vec<String>,
    pub pr_urls: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct RetryEntry {
    pub issue_id: String,
    pub run_number: i64,
    pub due_at_ms: i64,
    pub error_class: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct LiveSession {
    pub run_id: String,
    pub session_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub last_event_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct StatusPayload {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct ToolCallPayload {
    pub tool: String,
    pub args: Option<Value>,
    pub call_id: Option<String>,
    pub result_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct ApprovalPayload {
    pub reason: String,
    pub call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct TokenCountPayload {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct ErrorPayload {
    pub class: String,
    pub message: String,
    pub recoverable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct UserInputPayload {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct HumanizedPayload {
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct RateLimitPayload {
    pub source: String,
    pub remaining: Option<i64>,
    pub reset_at: Option<String>,
}

/// Session-level metadata reported by the agent CLI once a run starts
/// (Claude Code's `system/init` stream-json event). Every field is optional
/// because older CLIs and the Codex backend report fewer of them.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct SessionInfoPayload {
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub agent_version: Option<String>,
    pub output_style: Option<String>,
    pub fast_mode: Option<String>,
    /// Cumulative thinking-token estimate from `system/thinking_tokens` events.
    pub thinking_tokens: Option<i64>,
}

impl SessionInfoPayload {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct MappedAgentEvent {
    pub kind: AgentEventKind,
    pub payload: Value,
    pub humanized: Option<String>,
    pub tokens: Option<TokenCountPayload>,
    pub rate_limit: Option<RateLimitPayload>,
    pub session_info: Option<SessionInfoPayload>,
}
