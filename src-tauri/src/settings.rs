use serde::{Deserialize, Serialize};
use specta::Type;
use symphony_core::{
    build_parsed_workflow, strip_front_matter, AgentBackend, AgentConfig, ApprovalPolicy,
    ClaudeConfig, ClaudePermissionMode, CodexConfig, HooksConfig, ParsedWorkflow, PollingConfig,
    ThreadSandbox, TrackerConfig, TurnSandboxPolicy, WorkflowFrontMatter, WorkspaceConfig,
};

/// Structured app settings — the single source of truth for worker, tracker,
/// and agent configuration. Defaults mirror the workflow Symphony used to
/// ship as a YAML front matter (states, hooks, sandbox/permission options).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppSettings {
    #[serde(default = "default_prompt_template")]
    pub prompt_template: String,
    // Repository
    #[serde(default)]
    pub repo_url: String,
    #[serde(default)]
    pub install_cmd: Option<String>,
    #[serde(default)]
    pub workspace_root: Option<String>,
    // Linear / tracker
    #[serde(default)]
    pub tracker_workspace: Option<String>,
    #[serde(default)]
    pub tracker_prefix: Option<String>,
    #[serde(default)]
    pub tracker_project_id: Option<String>,
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
    // Derived from the OS keychain; never user-edited.
    #[serde(default)]
    pub linear_api_key_set: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            prompt_template: default_prompt_template(),
            repo_url: String::new(),
            install_cmd: None,
            workspace_root: None,
            tracker_workspace: None,
            tracker_prefix: None,
            tracker_project_id: None,
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
            codex_approval_policy: ApprovalPolicy::Never,
            codex_thread_sandbox: ThreadSandbox::WorkspaceWrite,
            codex_turn_sandbox_policy: TurnSandboxPolicy::Inherit,
            codex_network_access: true,
            claude_permission_mode: default_claude_permission_mode(),
            claude_allowed_tools: default_claude_allowed_tools(),
            claude_disallowed_tools: Vec::new(),
            claude_add_dirs: Vec::new(),
            linear_api_key_set: false,
        }
    }
}

pub fn default_prompt_template() -> String {
    include_str!("../assets/default-prompt.md").to_string()
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

fn normalize_opt(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn effective_command(override_cmd: &Option<String>, default: &str) -> String {
    normalize_opt(override_cmd).unwrap_or_else(|| default.to_string())
}

/// Build the runtime workflow config from structured settings. The Linear API
/// key comes from the OS keychain, not from settings.
pub fn workflow_from_settings(
    settings: &AppSettings,
    linear_api_key: Option<&str>,
) -> ParsedWorkflow {
    let front_matter = WorkflowFrontMatter {
        tracker: TrackerConfig {
            api_key: linear_api_key.unwrap_or_default().to_string(),
            active_states: settings.active_states.clone(),
            terminal_states: settings.terminal_states.clone(),
            identifier_prefix: normalize_opt(&settings.tracker_prefix),
            project_id: normalize_opt(&settings.tracker_project_id),
            ..TrackerConfig::default()
        },
        polling: PollingConfig {
            interval_ms: settings.polling_interval_ms,
        },
        workspace: WorkspaceConfig {
            root: normalize_opt(&settings.workspace_root).unwrap_or_default(),
        },
        hooks: HooksConfig {
            after_create: normalize_opt(&settings.hook_after_create),
            before_run: normalize_opt(&settings.hook_before_run),
            after_run: normalize_opt(&settings.hook_after_run),
            before_remove: normalize_opt(&settings.hook_before_remove),
            timeout_ms: settings.hook_timeout_ms,
        },
        agent: AgentConfig {
            backend: settings.agent_backend.clone(),
            max_concurrent_agents: settings.max_concurrent_agents as usize,
            max_retry_backoff_ms: settings.max_retry_backoff_ms,
        },
        codex: CodexConfig {
            command: effective_command(&settings.codex_command, "codex"),
            approval_policy: settings.codex_approval_policy.clone(),
            thread_sandbox: settings.codex_thread_sandbox.clone(),
            turn_sandbox_policy: settings.codex_turn_sandbox_policy.clone(),
            turn_timeout_ms: settings.turn_timeout_ms,
            network_access: settings.codex_network_access,
        },
        claude: ClaudeConfig {
            command: effective_command(&settings.claude_command, "claude"),
            permission_mode: settings.claude_permission_mode.clone(),
            allowed_tools: settings.claude_allowed_tools.clone(),
            disallowed_tools: settings.claude_disallowed_tools.clone(),
            add_dirs: settings.claude_add_dirs.clone(),
            turn_timeout_ms: settings.turn_timeout_ms,
        },
    };
    build_parsed_workflow(front_matter, settings.prompt_template.clone())
}

/// The pre-structured-settings shape: workflow YAML + prompt in one blob.
/// Forgiving on purpose — migration should salvage what it can.
#[derive(Debug, Deserialize)]
struct LegacySettings {
    #[serde(default)]
    workflow_source: String,
    #[serde(default)]
    repo_url: String,
    #[serde(default)]
    tracker_workspace: Option<String>,
    #[serde(default)]
    tracker_prefix: Option<String>,
    #[serde(default)]
    tracker_project_id: Option<String>,
    #[serde(default)]
    workspace_root: Option<String>,
    #[serde(default)]
    install_cmd: Option<String>,
    #[serde(default)]
    agent_backend: AgentBackend,
    #[serde(default)]
    codex_command: Option<String>,
    #[serde(default)]
    claude_command: Option<String>,
}

/// Parse a settings.json payload, migrating the legacy `workflow_source`
/// shape when present. Returns the settings and whether a migration happened
/// (so the caller can back up and rewrite the file).
pub fn parse_settings(raw: &str) -> Result<(AppSettings, bool), String> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|err| err.to_string())?;
    let is_legacy = value
        .as_object()
        .is_some_and(|obj| obj.contains_key("workflow_source"));
    if !is_legacy {
        let settings =
            serde_json::from_value::<AppSettings>(value).map_err(|err| err.to_string())?;
        return Ok((settings, false));
    }

    let legacy: LegacySettings = serde_json::from_value(value).map_err(|err| err.to_string())?;
    // Keep only the prompt body; customized front matter values are dropped
    // (the caller preserves the original file as settings.json.bak).
    let prompt_template = strip_front_matter(&legacy.workflow_source)
        .map(str::trim)
        .filter(|body| !body.is_empty())
        .map(str::to_string)
        .unwrap_or_else(default_prompt_template);
    let settings = AppSettings {
        prompt_template,
        repo_url: legacy.repo_url,
        tracker_workspace: legacy.tracker_workspace,
        tracker_prefix: legacy.tracker_prefix,
        tracker_project_id: legacy.tracker_project_id,
        workspace_root: legacy.workspace_root,
        install_cmd: legacy.install_cmd,
        agent_backend: legacy.agent_backend,
        codex_command: legacy.codex_command,
        claude_command: legacy.claude_command,
        ..AppSettings::default()
    };
    Ok((settings, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_previously_bundled_workflow() {
        let settings = AppSettings::default();
        assert_eq!(
            settings.active_states,
            ["Todo", "In Progress", "Rework", "Merging"]
        );
        assert_eq!(settings.terminal_states, ["Done", "Canceled"]);
        assert_eq!(settings.max_concurrent_agents, 3);
        assert!(settings.codex_network_access);
        assert_eq!(settings.claude_permission_mode, ClaudePermissionMode::Auto);
        assert!(settings
            .claude_allowed_tools
            .iter()
            .any(|tool| tool == "Bash(gh *)"));
        let hook = settings.hook_after_create.expect("default hook");
        assert!(hook.contains("${ISSUE_BRANCH:-symphony/${ISSUE_IDENTIFIER}}"));
        assert!(hook.contains("${SYMPHONY_INSTALL_CMD:-npm ci}"));
    }

    #[test]
    fn workflow_from_settings_maps_fields_and_falls_back_on_commands() {
        let settings = AppSettings {
            codex_command: Some("  ".to_string()),
            claude_command: Some("mycode --agent claude".to_string()),
            turn_timeout_ms: 1234,
            ..AppSettings::default()
        };
        let workflow = workflow_from_settings(&settings, Some("lin_api_test"));

        assert_eq!(workflow.front_matter.tracker.api_key, "lin_api_test");
        assert_eq!(workflow.front_matter.tracker.identifier_prefix, None);
        assert_eq!(workflow.front_matter.codex.command, "codex");
        assert_eq!(
            workflow.front_matter.claude.command,
            "mycode --agent claude"
        );
        // One shared turn timeout fans out to both backends.
        assert_eq!(workflow.front_matter.codex.turn_timeout_ms, 1234);
        assert_eq!(workflow.front_matter.claude.turn_timeout_ms, 1234);
        assert_eq!(workflow.prompt_template, settings.prompt_template);
    }

    #[test]
    fn parses_current_shape_without_migration() {
        let raw = serde_json::to_string(&AppSettings::default()).unwrap();
        let (settings, migrated) = parse_settings(&raw).unwrap();
        assert!(!migrated);
        assert_eq!(settings.repo_url, "");
    }

    #[test]
    fn migrates_legacy_settings_keeping_prompt_and_shared_fields() {
        let raw = serde_json::json!({
            "workflow_source": "---\ntracker:\n  kind: linear\n  api_key: ${LINEAR_API_KEY}\n  active_states: [Custom]\n  terminal_states: [Done]\n---\nMy custom prompt {{issue.title}}\n",
            "repo_url": "git@github.com:acme/widgets.git",
            "tracker_workspace": "acme",
            "tracker_prefix": "ENG",
            "tracker_project_id": null,
            "workspace_root": "/tmp/ws",
            "install_cmd": "pnpm install",
            "agent_backend": "claude",
            "codex_command": null,
            "claude_command": "mycode --agent claude",
            "linear_api_key_set": true
        })
        .to_string();
        let (settings, migrated) = parse_settings(&raw).unwrap();
        assert!(migrated);
        assert_eq!(settings.prompt_template, "My custom prompt {{issue.title}}");
        assert_eq!(settings.repo_url, "git@github.com:acme/widgets.git");
        assert_eq!(settings.tracker_workspace.as_deref(), Some("acme"));
        assert_eq!(settings.install_cmd.as_deref(), Some("pnpm install"));
        assert_eq!(settings.agent_backend, AgentBackend::Claude);
        assert_eq!(
            settings.claude_command.as_deref(),
            Some("mycode --agent claude")
        );
        // Customized front matter values are NOT imported — defaults apply.
        assert_eq!(
            settings.active_states,
            ["Todo", "In Progress", "Rework", "Merging"]
        );
    }

    #[test]
    fn migrates_legacy_settings_with_unusable_workflow_to_default_prompt() {
        let raw = serde_json::json!({
            "workflow_source": "no front matter here",
            "repo_url": "",
            "agent_backend": "codex"
        })
        .to_string();
        let (settings, migrated) = parse_settings(&raw).unwrap();
        assert!(migrated);
        assert_eq!(settings.prompt_template, default_prompt_template());
    }
}
