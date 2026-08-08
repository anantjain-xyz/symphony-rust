use serde::Deserialize;
pub use symphony_contracts::{default_prompt_template, AppSettings};
use symphony_core::{
    build_parsed_workflow, strip_front_matter, AgentBackend, AgentConfig, ClaudeConfig,
    CodexConfig, CursorConfig, HooksConfig, OpencodeConfig, ParsedWorkflow, PollingConfig,
    RepoConfig, TrackerConfig, WorkflowFrontMatter, WorkspaceConfig,
};

fn normalize_opt(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn normalized_team_keys(values: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    values
        .iter()
        .map(|value| value.trim().trim_end_matches('-').to_ascii_uppercase())
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

fn normalized_project_ids(values: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    values
        .iter()
        .filter_map(|value| {
            let value = value.trim();
            let project = symphony_core::LinearProjectRef::parse(value)?;
            seen.insert(project.canonical_key())
                .then(|| value.to_string())
        })
        .collect()
}

pub(crate) fn normalize_linear_filters(settings: &mut AppSettings) {
    settings.tracker_team_keys = normalized_team_keys(&settings.tracker_team_keys);
    settings.tracker_project_ids = normalized_project_ids(&settings.tracker_project_ids);
}

fn effective_command(override_cmd: &Option<String>, default: &str) -> String {
    normalize_opt(override_cmd).unwrap_or_else(|| default.to_string())
}

/// Resolve the Cursor CLI: configured override, then `agent`, then `cursor-agent`.
pub(crate) fn effective_cursor_command(override_cmd: &Option<String>) -> String {
    if let Some(cmd) = normalize_opt(override_cmd) {
        return cmd;
    }
    for candidate in ["agent", "cursor-agent"] {
        if which::which(candidate).is_ok() {
            return candidate.to_string();
        }
    }
    "agent".to_string()
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
            team_keys: normalized_team_keys(&settings.tracker_team_keys),
            project_ids: normalized_project_ids(&settings.tracker_project_ids),
            assigned_to_me: settings.tracker_assigned_to_me,
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
            permission_mode: settings.codex_permission_mode.clone(),
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
        cursor: CursorConfig {
            command: effective_cursor_command(&settings.cursor_command),
            mode: settings.cursor_mode.clone(),
            force: settings.cursor_force,
            trust: settings.cursor_trust,
            approve_mcps: settings.cursor_approve_mcps,
            sandbox: settings.cursor_sandbox.clone(),
            model: normalize_opt(&settings.cursor_model),
            turn_timeout_ms: settings.turn_timeout_ms,
        },
        opencode: OpencodeConfig {
            command: effective_command(&settings.opencode_command, "opencode"),
            model: normalize_opt(&settings.opencode_model),
            agent: normalize_opt(&settings.opencode_agent),
            skip_permissions: settings.opencode_skip_permissions,
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

/// Parse a settings.json payload, migrating older shapes when present: the
/// legacy `workflow_source` blob, and the single-repo `repo_url`/`install_cmd`
/// fields that predate the `repos` list. Returns the settings and whether a
/// migration happened (so the caller can back up and rewrite the file).
pub fn parse_settings(raw: &str) -> Result<(AppSettings, bool), String> {
    let mut value: serde_json::Value = serde_json::from_str(raw).map_err(|err| err.to_string())?;
    let permission_mode_migrated = migrate_codex_permission_mode(&mut value);
    let is_legacy = value
        .as_object()
        .is_some_and(|obj| obj.contains_key("workflow_source"));
    if !is_legacy {
        let linear_filters_migrated = migrate_linear_filter_lists(&mut value);
        let single_repo = value
            .as_object()
            .filter(|obj| !obj.contains_key("repos"))
            .map(|obj| {
                (
                    obj.get("repo_url")
                        .and_then(|url| url.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    obj.get("install_cmd")
                        .and_then(|cmd| cmd.as_str())
                        .map(str::to_string),
                )
            });
        let mut settings =
            serde_json::from_value::<AppSettings>(value).map_err(|err| err.to_string())?;
        if let Some((repo_url, install_cmd)) = single_repo {
            settings.repos = repos_from_single(&repo_url, install_cmd);
            return Ok((settings, true));
        }
        return Ok((
            settings,
            permission_mode_migrated || linear_filters_migrated,
        ));
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
        repos: repos_from_single(&legacy.repo_url, legacy.install_cmd),
        tracker_workspace: legacy.tracker_workspace,
        tracker_team_keys: split_legacy_list(legacy.tracker_prefix.as_deref()),
        tracker_project_ids: split_legacy_list(legacy.tracker_project_id.as_deref()),
        // This field did not exist in the legacy shape; preserve the old opt-out.
        tracker_assigned_to_me: false,
        workspace_root: legacy.workspace_root,
        agent_backend: legacy.agent_backend,
        codex_command: legacy.codex_command,
        claude_command: legacy.claude_command,
        ..AppSettings::default()
    };
    Ok((settings, true))
}

fn split_legacy_list(value: Option<&str>) -> Vec<String> {
    value
        .into_iter()
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

/// Move the old single global filters and repository-scoped routing rules into
/// the new global filter lists. Stable-order de-duplication keeps the explicit
/// global values first, followed by repository values in configured order.
fn migrate_linear_filter_lists(value: &mut serde_json::Value) -> bool {
    let Some(settings) = value.as_object_mut() else {
        return false;
    };
    let has_legacy_global =
        settings.contains_key("tracker_prefix") || settings.contains_key("tracker_project_id");
    let has_legacy_repo = settings
        .get("repos")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|repos| {
            repos.iter().any(|repo| {
                repo.as_object().is_some_and(|repo| {
                    repo.contains_key("team_prefixes") || repo.contains_key("project_ids")
                })
            })
        });
    if !has_legacy_global && !has_legacy_repo {
        return false;
    }

    let mut teams = settings
        .get("tracker_team_keys")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut projects = settings
        .get("tracker_project_ids")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    teams.extend(split_legacy_list(
        settings
            .get("tracker_prefix")
            .and_then(serde_json::Value::as_str),
    ));
    projects.extend(split_legacy_list(
        settings
            .get("tracker_project_id")
            .and_then(serde_json::Value::as_str),
    ));

    if let Some(repos) = settings
        .get_mut("repos")
        .and_then(serde_json::Value::as_array_mut)
    {
        for repo in repos {
            let Some(repo) = repo.as_object_mut() else {
                continue;
            };
            if let Some(values) = repo
                .remove("team_prefixes")
                .and_then(|value| value.as_array().cloned())
            {
                teams.extend(
                    values
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_string),
                );
            }
            if let Some(values) = repo
                .remove("project_ids")
                .and_then(|value| value.as_array().cloned())
            {
                projects.extend(
                    values
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_string),
                );
            }
        }
    }

    settings.remove("tracker_prefix");
    settings.remove("tracker_project_id");
    settings.insert(
        "tracker_team_keys".to_string(),
        serde_json::to_value(normalized_team_keys(&teams)).expect("team filters serialize"),
    );
    settings.insert(
        "tracker_project_ids".to_string(),
        serde_json::to_value(normalized_project_ids(&projects)).expect("project filters serialize"),
    );
    true
}

/// Replace the unused legacy approval setting with Codex's current permission
/// modes. Every legacy value maps to Symphony's unattended Auto-review mode
/// without broadening the sandbox.
fn migrate_codex_permission_mode(value: &mut serde_json::Value) -> bool {
    let Some(settings) = value.as_object_mut() else {
        return false;
    };
    if settings.contains_key("codex_permission_mode") {
        return settings.remove("codex_approval_policy").is_some();
    }
    if settings.remove("codex_approval_policy").is_none() {
        return false;
    }
    settings.insert(
        "codex_permission_mode".to_string(),
        serde_json::Value::String("approve-for-me".to_string()),
    );
    true
}

/// The repos list a pre-multi-repo config maps to: its one repo, as the
/// default. An unset repo URL maps to "no repos configured".
fn repos_from_single(repo_url: &str, install_cmd: Option<String>) -> Vec<RepoConfig> {
    let url = repo_url.trim();
    if url.is_empty() {
        return Vec::new();
    }
    vec![RepoConfig {
        name: repo_name_from_url(url),
        url: url.to_string(),
        install_cmd,
        is_default: true,
        skills_marked_installed: false,
    }]
}

/// A routing-friendly name derived from a Git URL's last path segment, e.g.
/// `git@github.com:acme/widgets.git` → `widgets`.
fn repo_name_from_url(url: &str) -> String {
    let name = url
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .rsplit(['/', ':'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name.is_empty() {
        "default".to_string()
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use symphony_core::{ClaudePermissionMode, CodexPermissionMode};

    #[test]
    fn defaults_match_the_previously_bundled_workflow() {
        let settings = AppSettings::default();
        assert!(settings.tracker_assigned_to_me);
        assert_eq!(
            settings.active_states,
            ["Todo", "In Progress", "Rework", "Merging"]
        );
        assert_eq!(settings.terminal_states, ["Done", "Canceled"]);
        assert_eq!(settings.max_concurrent_agents, 3);
        assert!(settings.session_env.is_empty());
        assert!(settings.codex_network_access);
        assert_eq!(
            settings.codex_permission_mode,
            CodexPermissionMode::ApproveForMe
        );
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
        assert!(workflow.front_matter.tracker.team_keys.is_empty());
        assert!(workflow.front_matter.tracker.project_ids.is_empty());
        assert_eq!(workflow.front_matter.codex.command, "codex");
        assert_eq!(
            workflow.front_matter.codex.permission_mode,
            CodexPermissionMode::ApproveForMe
        );
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
        assert!(settings.repos.is_empty());
    }

    #[test]
    fn omitted_assignee_filter_stays_disabled_for_existing_settings() {
        let (settings, migrated) = parse_settings(r#"{"repos":[]}"#).unwrap();
        assert!(!migrated);
        assert!(!settings.tracker_assigned_to_me);
    }

    #[test]
    fn normalizes_linear_filter_lists_before_persisting() {
        let mut settings = AppSettings {
            tracker_team_keys: vec![" eng- ".to_string(), "ENG".to_string(), "sim".to_string()],
            tracker_project_ids: vec![" project-a ".to_string(), "project-a".to_string()],
            ..AppSettings::default()
        };

        normalize_linear_filters(&mut settings);
        assert_eq!(settings.tracker_team_keys, ["ENG", "SIM"]);
        assert_eq!(settings.tracker_project_ids, ["project-a"]);
    }

    #[test]
    fn migrates_legacy_codex_approval_policies_to_permission_modes() {
        for (legacy, expected) in [
            ("never", CodexPermissionMode::ApproveForMe),
            ("on-request", CodexPermissionMode::ApproveForMe),
            ("on-failure", CodexPermissionMode::ApproveForMe),
            ("always", CodexPermissionMode::ApproveForMe),
        ] {
            let mut value = serde_json::to_value(AppSettings::default()).unwrap();
            let object = value.as_object_mut().unwrap();
            object.remove("codex_permission_mode");
            object.insert(
                "codex_approval_policy".to_string(),
                serde_json::Value::String(legacy.to_string()),
            );

            let (settings, migrated) = parse_settings(&value.to_string()).unwrap();
            assert!(migrated, "{legacy} was not marked as migrated");
            assert_eq!(settings.codex_permission_mode, expected, "legacy {legacy}");
        }
    }

    #[test]
    fn migrates_single_repo_settings_to_a_default_repos_entry() {
        let raw = serde_json::json!({
            "prompt_template": "My prompt {{issue.title}}",
            "repo_url": "git@github.com:acme/Widgets.git",
            "install_cmd": "pnpm install",
            "agent_backend": "claude"
        })
        .to_string();
        let (settings, migrated) = parse_settings(&raw).unwrap();
        assert!(migrated);
        assert_eq!(settings.prompt_template, "My prompt {{issue.title}}");
        assert_eq!(settings.repos.len(), 1);
        let repo = &settings.repos[0];
        assert_eq!(repo.name, "widgets");
        assert_eq!(repo.url, "git@github.com:acme/Widgets.git");
        assert_eq!(repo.install_cmd.as_deref(), Some("pnpm install"));
        assert!(repo.is_default);

        // Re-parsing the migrated output is stable: no second migration.
        let rewritten = serde_json::to_string(&settings).unwrap();
        let (again, migrated_again) = parse_settings(&rewritten).unwrap();
        assert!(!migrated_again);
        assert_eq!(again.repos, settings.repos);
    }

    #[test]
    fn migrates_repository_routing_rules_and_single_filters_to_global_lists() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("tracker_team_keys");
        object.remove("tracker_project_ids");
        object.insert(
            "tracker_prefix".to_string(),
            serde_json::json!("CBIZPAY, sim"),
        );
        object.insert(
            "tracker_project_id".to_string(),
            serde_json::json!("global-project"),
        );
        object.insert(
            "repos".to_string(),
            serde_json::json!([
                {
                    "name": "api",
                    "url": "git@github.com:acme/api.git",
                    "team_prefixes": ["cbizpay", "WAL-"],
                    "project_ids": ["global-project", "repo-project"],
                    "is_default": false,
                    "skills_marked_installed": false
                },
                {
                    "name": "web",
                    "url": "git@github.com:acme/web.git",
                    "team_prefixes": ["SIM"],
                    "project_ids": ["repo-project"],
                    "is_default": false,
                    "skills_marked_installed": false
                }
            ]),
        );

        let (settings, migrated) = parse_settings(&value.to_string()).unwrap();
        assert!(migrated);
        assert_eq!(settings.tracker_team_keys, ["CBIZPAY", "SIM", "WAL"]);
        assert_eq!(
            settings.tracker_project_ids,
            ["global-project", "repo-project"]
        );
        assert_eq!(settings.repos.len(), 2);

        let rewritten = serde_json::to_string(&settings).unwrap();
        let (_, migrated_again) = parse_settings(&rewritten).unwrap();
        assert!(!migrated_again);
    }

    #[test]
    fn migrates_empty_single_repo_settings_to_no_repos() {
        let raw = serde_json::json!({ "repo_url": "", "install_cmd": "npm ci" }).to_string();
        let (settings, migrated) = parse_settings(&raw).unwrap();
        assert!(migrated);
        assert!(settings.repos.is_empty());
    }

    #[test]
    fn derives_repo_names_from_common_url_forms() {
        for url in [
            "git@github.com:acme/widgets.git",
            "https://github.com/acme/widgets",
            "https://github.com/acme/widgets.git/",
            "ssh://git@github.com/acme/widgets",
        ] {
            assert_eq!(repo_name_from_url(url), "widgets", "failed for {url}");
        }
        assert_eq!(repo_name_from_url(""), "default");
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
        assert_eq!(settings.repos.len(), 1);
        assert_eq!(settings.repos[0].name, "widgets");
        assert_eq!(settings.repos[0].url, "git@github.com:acme/widgets.git");
        assert_eq!(
            settings.repos[0].install_cmd.as_deref(),
            Some("pnpm install")
        );
        assert!(settings.repos[0].is_default);
        assert_eq!(settings.tracker_workspace.as_deref(), Some("acme"));
        assert_eq!(settings.tracker_team_keys, ["ENG"]);
        assert!(settings.tracker_project_ids.is_empty());
        assert!(!settings.tracker_assigned_to_me);
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
