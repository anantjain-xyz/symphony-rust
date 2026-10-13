use crate::{validate_prompt_template, AgentBackend, ParsedWorkflow, RepoConfig};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ValidationCode {
    MissingActiveStates,
    MissingRepository,
    MissingRepositoryName,
    MissingRepositoryUrl,
    RepositoryNameCollision,
    MultipleDefaultRepositories,
    InvalidEnvironmentName,
    InvalidEnvironmentValue,
    InvalidPrompt,
    InvalidPositiveLimit,
    InvalidAgentCommand,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ValidationField {
    ActiveStates,
    Repositories,
    SessionEnv,
    PromptTemplate,
    PollingIntervalMs,
    MaxConcurrentAgents,
    MaxRetryBackoffMs,
    HookTimeoutMs,
    TurnTimeoutMs,
    AgentCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct ValidationIssue {
    pub code: ValidationCode,
    pub field: ValidationField,
    pub message: String,
    /// Incomplete setup can be saved as a draft, but cannot start a worker.
    pub blocking: bool,
}

impl ValidationIssue {
    fn new(code: ValidationCode, field: ValidationField, message: impl Into<String>) -> Self {
        Self {
            code,
            field,
            message: message.into(),
            blocking: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidRuntimeConfig(pub Vec<ValidationIssue>);

impl std::fmt::Display for InvalidRuntimeConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (index, issue) in self.0.iter().enumerate() {
            if index > 0 {
                formatter.write_str("; ")?;
            }
            formatter.write_str(&issue.message)?;
        }
        Ok(())
    }
}
impl std::error::Error for InvalidRuntimeConfig {}

/// Constructed only after structural validation. Draft settings remain separate.
/// Credentials and external executables are checked by runtime preflight.
#[derive(Clone)]
pub struct RunnableConfig {
    settings_revision: u64,
    workflow: ParsedWorkflow,
    repos: Vec<RepoConfig>,
    session_env: BTreeMap<String, String>,
}

impl std::fmt::Debug for RunnableConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RunnableConfig")
            .field("settings_revision", &self.settings_revision)
            .field("repository_count", &self.repos.len())
            .field("session_environment_entry_count", &self.session_env.len())
            .finish_non_exhaustive()
    }
}

impl RunnableConfig {
    pub fn new(
        settings_revision: u64,
        workflow: ParsedWorkflow,
        repos: Vec<RepoConfig>,
        session_env: BTreeMap<String, String>,
    ) -> Result<Self, InvalidRuntimeConfig> {
        let issues = validate_runtime_config(&workflow, &repos, &session_env);
        if !issues.is_empty() {
            return Err(InvalidRuntimeConfig(issues));
        }
        Ok(Self {
            settings_revision,
            workflow,
            repos,
            session_env,
        })
    }

    pub fn settings_revision(&self) -> u64 {
        self.settings_revision
    }

    pub fn workflow(&self) -> &ParsedWorkflow {
        &self.workflow
    }

    pub fn into_parts(self) -> (ParsedWorkflow, Vec<RepoConfig>, BTreeMap<String, String>) {
        (self.workflow, self.repos, self.session_env)
    }
}

pub fn validate_runtime_config(
    workflow: &ParsedWorkflow,
    repos: &[RepoConfig],
    session_env: &BTreeMap<String, String>,
) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    let config = &workflow.front_matter;
    if config
        .tracker
        .active_states
        .iter()
        .all(|state| state.trim().is_empty())
    {
        issues.push(ValidationIssue::new(ValidationCode::MissingActiveStates, ValidationField::ActiveStates,
            "Active states is empty — the worker would never pick up an issue. Add at least one Linear state under Settings → Linear."));
    }
    issues.extend(validate_repositories(repos));
    issues.extend(validate_session_environment(session_env));
    if let Err(error) = validate_prompt_template(&workflow.prompt_template) {
        issues.push(ValidationIssue::new(
            ValidationCode::InvalidPrompt,
            ValidationField::PromptTemplate,
            error.replace("The workflow is empty.", "The prompt template is empty."),
        ));
    }
    let (command, turn_timeout) = match config.agent.backend {
        AgentBackend::Codex => (&config.codex.command, config.codex.turn_timeout_ms),
        AgentBackend::Claude => (&config.claude.command, config.claude.turn_timeout_ms),
        AgentBackend::Cursor => (&config.cursor.command, config.cursor.turn_timeout_ms),
        AgentBackend::Opencode => (&config.opencode.command, config.opencode.turn_timeout_ms),
    };
    if command.trim().is_empty() || command.contains('\0') {
        issues.push(ValidationIssue::new(
            ValidationCode::InvalidAgentCommand,
            ValidationField::AgentCommand,
            "The selected agent command must be nonempty and contain no NUL bytes.",
        ));
    }
    for (field, value, name) in [
        (
            ValidationField::PollingIntervalMs,
            config.polling.interval_ms,
            "Polling interval",
        ),
        (
            ValidationField::MaxConcurrentAgents,
            config.agent.max_concurrent_agents as u64,
            "Agent concurrency",
        ),
        (
            ValidationField::MaxRetryBackoffMs,
            config.agent.max_retry_backoff_ms,
            "Retry backoff",
        ),
        (
            ValidationField::HookTimeoutMs,
            config.hooks.timeout_ms,
            "Hook timeout",
        ),
        (ValidationField::TurnTimeoutMs, turn_timeout, "Turn timeout"),
    ] {
        if value == 0 || value > i64::MAX as u64 {
            issues.push(ValidationIssue::new(
                ValidationCode::InvalidPositiveLimit,
                field,
                format!("{name} must be positive and fit in a signed 64-bit value."),
            ));
        }
    }
    issues
}

pub fn validate_repositories(repos: &[RepoConfig]) -> Vec<ValidationIssue> {
    let field = ValidationField::Repositories;
    if repos.is_empty() {
        return vec![ValidationIssue {
            code: ValidationCode::MissingRepository,
            field,
            message: "No repository configured — add one under Settings → Repositories.".into(),
            blocking: false,
        }];
    }
    let mut issues = Vec::new();
    let mut names = HashMap::new();
    for repo in repos {
        let name = repo.name.trim();
        if name.is_empty() {
            issues.push(ValidationIssue::new(ValidationCode::MissingRepositoryName, field,
                "Every repository needs a name — it is the key issues route by (repo:<name> or matching bare labels) and the workspace folder."));
        }
        if repo.url.trim().is_empty() {
            issues.push(ValidationIssue::new(
                ValidationCode::MissingRepositoryUrl,
                field,
                format!("Repository \"{name}\" has no Git URL."),
            ));
        }
        if let Some(other) = names.insert(sanitize_key(name).to_lowercase(), name) {
            let message = if other.eq_ignore_ascii_case(name) {
                format!("Two repositories share the name \"{name}\".")
            } else {
                format!("Repository names \"{other}\" and \"{name}\" collide — they map to the same workspace folder.")
            };
            issues.push(ValidationIssue::new(
                ValidationCode::RepositoryNameCollision,
                field,
                message,
            ));
        }
    }
    if repos.iter().filter(|repo| repo.is_default).count() > 1 {
        issues.push(ValidationIssue::new(
            ValidationCode::MultipleDefaultRepositories,
            field,
            "Only one repository can be marked as the default.",
        ));
    }
    issues
}

pub fn validate_session_environment(env: &BTreeMap<String, String>) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    for (key, value) in env {
        let mut chars = key.chars();
        if !matches!(chars.next(), Some(first) if first.is_ascii_alphabetic() || first == '_')
            || !chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            issues.push(ValidationIssue::new(ValidationCode::InvalidEnvironmentName, ValidationField::SessionEnv,
                format!("Session environment variable name is invalid: {key}. Use letters, numbers, and underscores, and do not start with a number.")));
        }
        if value.contains('\0') {
            issues.push(ValidationIssue::new(
                ValidationCode::InvalidEnvironmentValue,
                ValidationField::SessionEnv,
                format!("Session environment variable value must not contain a NUL byte: {key}."),
            ));
        }
    }
    issues
}

/// Canonical namespace shared by configuration validation and workspace paths.
pub fn sanitize_key(identifier: &str) -> String {
    if identifier.is_empty() || identifier == "." || identifier == ".." {
        return "_".into();
    }
    identifier
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{build_parsed_workflow, WorkflowFrontMatter};

    fn valid() -> (ParsedWorkflow, Vec<RepoConfig>) {
        let mut config = WorkflowFrontMatter::default();
        config.tracker.active_states.push("Todo".into());
        (
            build_parsed_workflow(config, "Work on {{issue.title}}".into()),
            vec![RepoConfig {
                name: "app".into(),
                url: "https://example.test/app.git".into(),
                ..Default::default()
            }],
        )
    }

    #[test]
    fn only_validated_configuration_can_become_runnable() {
        let (workflow, repos) = valid();
        assert!(RunnableConfig::new(0, workflow.clone(), repos.clone(), BTreeMap::new()).is_ok());
        let mut invalid = workflow;
        invalid.front_matter.polling.interval_ms = 0;
        invalid.front_matter.agent.max_concurrent_agents = 0;
        let error = RunnableConfig::new(0, invalid, repos, BTreeMap::new()).unwrap_err();
        assert_eq!(
            error.0.iter().map(|issue| issue.field).collect::<Vec<_>>(),
            [
                ValidationField::PollingIntervalMs,
                ValidationField::MaxConcurrentAgents
            ]
        );
    }

    #[test]
    fn incomplete_drafts_are_saveable_but_not_runnable() {
        let (workflow, _) = valid();
        let error = RunnableConfig::new(0, workflow, vec![], BTreeMap::new()).unwrap_err();
        assert_eq!(error.0[0].code, ValidationCode::MissingRepository);
        assert!(!error.0[0].blocking);
    }

    #[test]
    fn runnable_debug_omits_credentials_and_user_content() {
        let (mut workflow, mut repos) = valid();
        workflow.front_matter.tracker.api_key = "tracker-secret".into();
        workflow.prompt_template = "private prompt".into();
        repos[0].url = "https://private-secret@example.com/private.git".into();
        let runtime = RunnableConfig::new(
            7,
            workflow,
            repos,
            BTreeMap::from([("SECRET".into(), "environment-secret".into())]),
        )
        .unwrap();
        let debug = format!("{runtime:?}");
        for private in [
            "tracker-secret",
            "private prompt",
            "private-secret",
            "environment-secret",
        ] {
            assert!(!debug.contains(private));
        }
        assert!(debug.contains("settings_revision: 7"));
    }

    #[test]
    fn validation_codes_do_not_depend_on_error_wording() {
        let (mut workflow, mut repos) = valid();
        workflow.prompt_template = "{{issue.no_such_field}}".into();
        repos.push(RepoConfig {
            name: "APP".into(),
            ..repos[0].clone()
        });
        let env = BTreeMap::from([("1BAD".into(), "secret\0value".into())]);
        let issues = validate_runtime_config(&workflow, &repos, &env);
        assert!(issues
            .iter()
            .any(|issue| issue.code == ValidationCode::RepositoryNameCollision));
        assert!(issues
            .iter()
            .any(|issue| issue.field == ValidationField::PromptTemplate));
        assert!(issues
            .iter()
            .any(|issue| issue.code == ValidationCode::InvalidEnvironmentValue));
        assert!(issues.iter().all(|issue| !issue.message.contains("secret")));
    }
}
