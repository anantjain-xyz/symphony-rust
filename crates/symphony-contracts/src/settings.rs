use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use symphony_core::{
    AgentBackend, ApprovalPolicy, ClaudePermissionMode, CursorAgentMode, CursorSandboxMode,
    RepoConfig, ThreadSandbox, TurnSandboxPolicy,
};

/// Structured app settings — the single source of truth for worker, tracker,
/// and agent configuration. Defaults mirror the workflow Symphony used to
/// ship as a YAML front matter (states, hooks, sandbox/permission options).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppSettings {
    #[serde(default = "default_prompt_template")]
    pub prompt_template: String,
    // Repositories; each issue routes to one by repo:<name> or bare repo-name
    // label, project, team key, or the default flag (symphony_core::route_issue).
    #[serde(default)]
    pub repos: Vec<RepoConfig>,
    #[serde(default)]
    pub workspace_root: Option<String>,
    // Linear / tracker
    #[serde(default)]
    pub tracker_workspace: Option<String>,
    #[serde(default)]
    pub tracker_prefix: Option<String>,
    #[serde(default)]
    pub tracker_project_id: Option<String>,
    #[serde(default)]
    pub tracker_assigned_to_me: bool,
    #[serde(default = "default_active_states")]
    pub active_states: Vec<String>,
    #[serde(default = "default_terminal_states")]
    pub terminal_states: Vec<String>,
    // Worker
    #[serde(default = "default_polling_interval_ms")]
    pub polling_interval_ms: u64,
    #[serde(default = "default_max_concurrent_agents")]
    pub max_concurrent_agents: u32,
    #[serde(default = "default_max_retry_backoff_ms")]
    pub max_retry_backoff_ms: u64,
    // Hooks (shell scripts; env vars resolve at execution time)
    #[serde(default = "default_after_create_hook")]
    pub hook_after_create: Option<String>,
    #[serde(default)]
    pub hook_before_run: Option<String>,
    #[serde(default)]
    pub hook_after_run: Option<String>,
    #[serde(default)]
    pub hook_before_remove: Option<String>,
    #[serde(default = "default_hook_timeout_ms")]
    pub hook_timeout_ms: u64,
    // Agent
    #[serde(default)]
    pub agent_backend: AgentBackend,
    #[serde(default)]
    pub codex_command: Option<String>,
    #[serde(default)]
    pub claude_command: Option<String>,
    #[serde(default = "default_turn_timeout_ms")]
    pub turn_timeout_ms: u64,
    #[serde(default)]
    pub session_env: BTreeMap<String, String>,
    // Codex options
    #[serde(default)]
    pub codex_approval_policy: ApprovalPolicy,
    #[serde(default)]
    pub codex_thread_sandbox: ThreadSandbox,
    #[serde(default)]
    pub codex_turn_sandbox_policy: TurnSandboxPolicy,
    #[serde(default = "default_true")]
    pub codex_network_access: bool,
    // Claude options
    #[serde(default = "default_claude_permission_mode")]
    pub claude_permission_mode: ClaudePermissionMode,
    #[serde(default = "default_claude_allowed_tools")]
    pub claude_allowed_tools: Vec<String>,
    #[serde(default)]
    pub claude_disallowed_tools: Vec<String>,
    #[serde(default)]
    pub claude_add_dirs: Vec<String>,
    // Cursor options
    #[serde(default)]
    pub cursor_command: Option<String>,
    #[serde(default)]
    pub cursor_mode: CursorAgentMode,
    #[serde(default = "default_true")]
    pub cursor_force: bool,
    #[serde(default = "default_true")]
    pub cursor_trust: bool,
    #[serde(default)]
    pub cursor_approve_mcps: bool,
    #[serde(default)]
    pub cursor_sandbox: CursorSandboxMode,
    #[serde(default)]
    pub cursor_model: Option<String>,
    // Opencode options
    #[serde(default)]
    pub opencode_command: Option<String>,
    #[serde(default)]
    pub opencode_model: Option<String>,
    #[serde(default)]
    pub opencode_agent: Option<String>,
    #[serde(default = "default_true")]
    pub opencode_skip_permissions: bool,
    // Derived from the OS keychain; never user-edited.
    #[serde(default)]
    pub linear_api_key_set: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            prompt_template: default_prompt_template(),
            repos: Vec::new(),
            workspace_root: None,
            tracker_workspace: None,
            tracker_prefix: None,
            tracker_project_id: None,
            tracker_assigned_to_me: false,
            active_states: default_active_states(),
            terminal_states: default_terminal_states(),
            polling_interval_ms: default_polling_interval_ms(),
            max_concurrent_agents: default_max_concurrent_agents(),
            max_retry_backoff_ms: default_max_retry_backoff_ms(),
            hook_after_create: default_after_create_hook(),
            hook_before_run: None,
            hook_after_run: None,
            hook_before_remove: None,
            hook_timeout_ms: default_hook_timeout_ms(),
            agent_backend: AgentBackend::Codex,
            codex_command: None,
            claude_command: None,
            turn_timeout_ms: default_turn_timeout_ms(),
            session_env: BTreeMap::new(),
            codex_approval_policy: ApprovalPolicy::Never,
            codex_thread_sandbox: ThreadSandbox::WorkspaceWrite,
            codex_turn_sandbox_policy: TurnSandboxPolicy::Inherit,
            codex_network_access: true,
            claude_permission_mode: default_claude_permission_mode(),
            claude_allowed_tools: default_claude_allowed_tools(),
            claude_disallowed_tools: Vec::new(),
            claude_add_dirs: Vec::new(),
            cursor_command: None,
            cursor_mode: CursorAgentMode::Agent,
            cursor_force: true,
            cursor_trust: true,
            cursor_approve_mcps: false,
            cursor_sandbox: CursorSandboxMode::Enabled,
            cursor_model: None,
            opencode_command: None,
            opencode_model: None,
            opencode_agent: None,
            opencode_skip_permissions: true,
            linear_api_key_set: false,
        }
    }
}

pub fn default_prompt_template() -> String {
    include_str!("../../../src-tauri/assets/default-prompt.md").to_string()
}

fn default_active_states() -> Vec<String> {
    ["Todo", "In Progress", "Rework", "Merging"]
        .map(String::from)
        .to_vec()
}

fn default_terminal_states() -> Vec<String> {
    ["Done", "Canceled"].map(String::from).to_vec()
}

fn default_polling_interval_ms() -> u64 {
    30_000
}

fn default_max_concurrent_agents() -> u32 {
    3
}

fn default_max_retry_backoff_ms() -> u64 {
    300_000
}

fn default_hook_timeout_ms() -> u64 {
    60_000
}

fn default_turn_timeout_ms() -> u64 {
    3_600_000
}

fn default_true() -> bool {
    // The workflow pushes branches and talks to GitHub/Linear — network on.
    true
}

fn default_claude_permission_mode() -> ClaudePermissionMode {
    ClaudePermissionMode::Auto
}

/// Runs once per fresh workspace. $REPO_URL, $ISSUE_IDENTIFIER, and
/// $ISSUE_BRANCH are provided by Symphony at execution time.
fn default_after_create_hook() -> Option<String> {
    Some(
        [
            r#"git clone "$REPO_URL" ."#,
            r#"git checkout -B "${ISSUE_BRANCH:-symphony/${ISSUE_IDENTIFIER}}""#,
            r#"eval "${SYMPHONY_INSTALL_CMD:-npm ci}""#,
            "",
        ]
        .join("\n"),
    )
}

/// Workflow-essential tools the agent needs in every target repo. The target
/// repo's .claude/settings.json can layer in repo-specific extras on top.
/// Destructive git forms (reset --hard, push --force*, clean -f*) are
/// intentionally omitted.
fn default_claude_allowed_tools() -> Vec<String> {
    [
        // GitHub CLI (PR create/view/comment/merge, gh api, gh auth status, gh run)
        "Bash(gh *)",
        // Git read + the mutating ops the workflow needs (commit/push/branch/etc).
        "Bash(git status*)",
        "Bash(git log*)",
        "Bash(git diff*)",
        "Bash(git show*)",
        "Bash(git branch*)",
        "Bash(git checkout*)",
        "Bash(git switch*)",
        "Bash(git add*)",
        "Bash(git commit*)",
        "Bash(git push)",
        "Bash(git push origin*)",
        "Bash(git pull*)",
        "Bash(git fetch*)",
        "Bash(git merge*)",
        "Bash(git rebase*)",
        "Bash(git remote*)",
        "Bash(git stash*)",
        "Bash(git rev-parse*)",
        "Bash(git ls-files*)",
        "Bash(git config --get*)",
        // Read-only diagnostics the agent commonly probes for.
        "Bash(which *)",
        "Bash(node --version)",
        "Bash(npm --version)",
        "Bash(pnpm --version)",
        "Bash(python3 --version)",
        // Fetching canonical boilerplate docs and the Linear GraphQL API.
        "Bash(curl *)",
    ]
    .map(String::from)
    .to_vec()
}
