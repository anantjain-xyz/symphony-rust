//! Symphony agent skills: detect whether the target repo ships them, and
//! install them via a one-off bootstrap agent session that opens a PR.
//!
//! Detection talks to GitHub through the `gh` CLI (the same dependency every
//! skill assumes), so it works without a local checkout. Installation clones
//! the repo into a throwaway workspace, writes the bundled skill files
//! deterministically, then hands off to the configured agent backend to adapt
//! the validation-gate commands to the repo's toolchain and open the PR.
//! Issue workspaces also get local fallback copies of any missing bundled
//! skills so a repo does not need to accept the install PR before agents can
//! use Symphony's procedures.

use reqwest::Url;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    path::{Path, PathBuf},
    sync::Arc,
};
use symphony_agents::{
    AgentDriver, AgentRunRequest, ClaudeRunOptions, CursorRunOptions, NativeAgentDriver,
    OpencodeRunOptions,
};
use symphony_core::{
    AgentBackend, AgentOutcome, ClaudePermissionMode, CursorAgentMode, CursorSandboxMode,
    ParsedWorkflow, ThreadSandbox, TurnSandboxPolicy,
};
use thiserror::Error;
use tokio::{process::Command, sync::Mutex};
use tokio_util::sync::CancellationToken;
use tracing::{error, info};

/// Canonical, runner-agnostic skill location in the target repo.
pub const SKILLS_DIR: &str = ".agents/skills";
/// Claude Code auto-discovery location.
pub const CLAUDE_SKILLS_DIR: &str = ".claude/skills";
/// Branch the bootstrap session pushes; detection also looks for an open PR
/// from this branch so the UI can show "install in review".
pub const INSTALL_BRANCH: &str = "symphony/install-skills";

const CLAUDE_DIR: &str = ".claude";
const INSTALL_WORKSPACE_KEY: &str = "_skills-install";

#[derive(Debug, Error)]
pub enum SkillsError {
    #[error("a skills install is already running")]
    AlreadyRunning,
}

/// One bundled skill: `name` is the directory under `.agents/skills/`,
/// `content` the full SKILL.md body.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct SkillFile {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkspaceSkillsUpdate {
    pub injected: Vec<String>,
    pub excluded_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillsState {
    Installed,
    PrOpen,
    Missing,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SkillsStatus {
    pub state: SkillsState,
    /// Bundled skills absent from the repo's default branch.
    pub missing: Vec<String>,
    pub pr_url: Option<String>,
    /// Why detection could not run (no repo URL, non-GitHub remote, gh failure).
    pub detail: Option<String>,
}

impl SkillsStatus {
    fn unavailable(detail: impl Into<String>) -> Self {
        Self {
            state: SkillsState::Unavailable,
            missing: Vec::new(),
            pr_url: None,
            detail: Some(detail.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GithubRemote {
    pub(crate) host: String,
    pub(crate) owner: String,
    pub(crate) name: String,
}

impl GithubRemote {
    fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }

    pub(crate) fn gh_repo_arg(&self) -> String {
        if self.host == "github.com" {
            self.slug()
        } else {
            format!("{}/{}", self.host, self.slug())
        }
    }

    fn api_base(&self) -> String {
        if self.host == "github.com" {
            "https://api.github.com".to_string()
        } else if is_ghe_dotcom_host(&self.host) {
            format!("https://api.{}", self.host)
        } else {
            format!("https://{}/api/v3", self.host)
        }
    }

    fn graphql_endpoint(&self) -> String {
        if self.host == "github.com" {
            "https://api.github.com/graphql".to_string()
        } else if is_ghe_dotcom_host(&self.host) {
            format!("https://api.{}/graphql", self.host)
        } else {
            format!("https://{}/api/graphql", self.host)
        }
    }

    pub(crate) fn auth_hint(&self) -> String {
        if self.host == "github.com" {
            "`gh auth status` or set `GITHUB_TOKEN`/`GH_TOKEN`".to_string()
        } else if is_ghe_dotcom_host(&self.host) {
            format!(
                "`gh auth status --hostname {}` or set `GITHUB_TOKEN`/`GH_TOKEN`",
                self.host
            )
        } else {
            format!(
                "`gh auth status --hostname {}` or set `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN`",
                self.host
            )
        }
    }
}

const GITHUB_DOTCOM_TOKEN_ENV_VARS: &[&str] = &["GH_TOKEN", "GITHUB_TOKEN"];
const GITHUB_TOKEN_ENV_VARS: &[&str] = &[
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GhAuthStatus {
    Authenticated,
    MissingCli,
    Unauthenticated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SkillsListingSource {
    Gh,
    Token,
}

fn github_token_env_vars_for_host(host: &str) -> &'static [&'static str] {
    if host == "github.com" || is_ghe_dotcom_host(host) {
        GITHUB_DOTCOM_TOKEN_ENV_VARS
    } else {
        &[]
    }
}

pub(crate) fn github_token_env_vars_for_repo_url(repo_url: &str) -> &'static [&'static str] {
    remote_host(repo_url)
        .as_deref()
        .map(github_token_env_vars_for_host)
        .unwrap_or(&[])
}

pub(crate) fn github_token_env_has_token_for_repo_url(
    repo_url: &str,
    env: &BTreeMap<String, String>,
) -> bool {
    github_token_env_vars_for_repo_url(repo_url)
        .iter()
        .any(|key| env.get(*key).is_some_and(|value| !value.trim().is_empty()))
}

pub(crate) fn github_token_for_host(
    host: &str,
    session_env: &BTreeMap<String, String>,
) -> Option<String> {
    github_token_for_host_from_sources(host, env::vars(), session_env)
}

fn github_token_for_host_from_sources(
    host: &str,
    process_env: impl IntoIterator<Item = (String, String)>,
    session_env: &BTreeMap<String, String>,
) -> Option<String> {
    github_token_for_host_from(
        host,
        session_env
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    )
    .or_else(|| github_token_for_host_from(host, process_env))
}

fn github_token_for_host_from(
    host: &str,
    vars: impl IntoIterator<Item = (String, String)>,
) -> Option<String> {
    let vars = vars.into_iter().collect::<BTreeMap<_, _>>();
    github_token_env_vars_for_host(host)
        .iter()
        .find_map(|key| vars.get(*key).filter(|value| !value.trim().is_empty()))
        .cloned()
}

pub(crate) async fn gh_auth_status(host: &str) -> GhAuthStatus {
    let command = format!("gh auth status --hostname {}", shell_quote(host));
    gh_auth_status_from_output(run_shell(None, &command).await)
}

fn gh_auth_status_from_output(output: std::io::Result<std::process::Output>) -> GhAuthStatus {
    match output {
        Ok(output) if output.status.success() => GhAuthStatus::Authenticated,
        Ok(output) if output.status.code() == Some(127) => GhAuthStatus::MissingCli,
        _ => GhAuthStatus::Unauthenticated,
    }
}

fn gh_repo_access_error(stderr: &str) -> bool {
    stderr.contains("Could not resolve to a Repository")
        || stderr.contains("Repository not found")
        || stderr.contains("HTTP 404")
}

pub(crate) async fn github_graphql(
    remote: &GithubRemote,
    token: &str,
    query: &str,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("symphony-rust")
        .build()
        .map_err(|err| format!("could not build GitHub client: {err}"))?;
    let response = client
        .post(remote.graphql_endpoint())
        .bearer_auth(token)
        .json(&serde_json::json!({ "query": query }))
        .send()
        .await
        .map_err(|err| format!("GitHub GraphQL request failed: {err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("could not read GitHub GraphQL response: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "GitHub GraphQL request failed with {status}: {}",
            tail(&body, 200)
        ));
    }
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|err| format!("could not parse GitHub GraphQL response: {err}"))?;
    if let Some(errors) = value.get("errors").and_then(|errors| errors.as_array()) {
        if !errors.is_empty() {
            let errors = serde_json::to_string(errors).unwrap_or_else(|_| "[]".to_string());
            return Err(format!(
                "GitHub GraphQL returned errors: {}",
                tail(&errors, 200)
            ));
        }
    }
    Ok(body)
}

pub(crate) async fn github_open_pr_url(
    remote: &GithubRemote,
    token: &str,
    branch: &str,
) -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .user_agent("symphony-rust")
        .build()
        .map_err(|err| format!("could not build GitHub client: {err}"))?;
    let mut url = Url::parse(&format!(
        "{}/repos/{}/{}/pulls",
        remote.api_base(),
        remote.owner,
        remote.name
    ))
    .map_err(|err| format!("could not build GitHub PR URL: {err}"))?;
    url.query_pairs_mut()
        .append_pair("head", &format!("{}:{branch}", remote.owner))
        .append_pair("state", "open")
        .append_pair("per_page", "1");

    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|err| format!("GitHub PR lookup failed: {err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("could not read GitHub PR response: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "GitHub PR lookup failed with {status}: {}",
            tail(&body, 200)
        ));
    }
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|err| format!("could not parse GitHub PR response: {err}"))?;
    Ok(value
        .as_array()
        .and_then(|prs| prs.first())
        .and_then(|pr| pr.get("html_url"))
        .and_then(|url| url.as_str())
        .map(ToOwned::to_owned))
}

#[cfg(test)]
fn parse_github_repo(url: &str) -> Option<String> {
    parse_github_remote(url).map(|remote| remote.slug())
}

/// Extract the GitHub host and `owner/repo` from github.com or GHE.com remote
/// URL forms users paste into Settings.
pub(crate) fn parse_github_remote(url: &str) -> Option<GithubRemote> {
    let (host, rest) = remote_host_and_path(url)?;
    if !is_supported_github_host(&host) {
        return None;
    }
    let rest = rest.trim_end_matches(".git");
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|part| !part.is_empty())?.to_string();
    let name = parts.next().filter(|part| !part.is_empty())?.to_string();
    if parts.next().is_some() {
        return None;
    }
    Some(GithubRemote { host, owner, name })
}

fn remote_host(url: &str) -> Option<String> {
    remote_host_and_path(url).map(|(host, _)| host)
}

fn remote_host_and_path(url: &str) -> Option<(String, &str)> {
    let trimmed = url.trim().trim_end_matches('/');
    let (host, rest) = if let Some((host, rest)) = parse_scp_like_remote(trimmed) {
        (host, rest)
    } else if let Some(rest) = trimmed.strip_prefix("ssh://") {
        let rest = rest
            .split_once('@')
            .map_or(rest, |(_, host_and_path)| host_and_path);
        rest.split_once('/')?
    } else if let Some(rest) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
    {
        rest.split_once('/')?
    } else {
        trimmed.split_once('/')?
    };
    Some((host.trim_end_matches('.').to_ascii_lowercase(), rest))
}

fn parse_scp_like_remote(url: &str) -> Option<(&str, &str)> {
    let (user_and_host, rest) = url.split_once(':')?;
    let (_, host) = user_and_host.rsplit_once('@')?;
    Some((host, rest))
}

fn is_supported_github_host(host: &str) -> bool {
    host == "github.com" || host == "ghe.com" || host.ends_with(".ghe.com")
}

fn is_ghe_dotcom_host(host: &str) -> bool {
    host == "ghe.com" || host.ends_with(".ghe.com")
}

/// Check the repo's default branch for the bundled skills without cloning.
///
/// One GraphQL call resolves `.agents/skills/` and each child's entries, so a
/// skill only counts as present when `<name>/SKILL.md` actually exists — a
/// directory listing alone would accept partial or corrupt installs. It also
/// keeps "repo not accessible" (bad URL, missing gh auth) distinct from
/// "skills missing": only the latter should offer the install PR.
pub async fn check_skills(
    repo_url: &str,
    skill_names: &[String],
    session_env: &BTreeMap<String, String>,
) -> SkillsStatus {
    if repo_url.trim().is_empty() {
        return SkillsStatus::unavailable("No repository configured.");
    }
    let Some(remote) = parse_github_remote(repo_url) else {
        return SkillsStatus::unavailable(
            "Skill detection needs a github.com or GHE.com repository URL.",
        );
    };
    let repo_arg = remote.gh_repo_arg();
    let gh_auth = gh_auth_status(&remote.host).await;
    if gh_auth == GhAuthStatus::MissingCli {
        return SkillsStatus::unavailable(
            "GitHub CLI (gh) not found. Install it to enable skill detection.",
        );
    }
    let gh_authenticated = gh_auth == GhAuthStatus::Authenticated;
    let token = github_token_for_host(&remote.host, session_env);

    let query = format!(
        r#"query {{ repository(owner: "{}", name: "{}") {{ object(expression: "HEAD:{SKILLS_DIR}") {{ ... on Tree {{ entries {{ name type object {{ ... on Tree {{ entries {{ name type }} }} }} }} }} }} }} }}"#,
        remote.owner, remote.name
    );
    let (listing, listing_source) = if gh_authenticated {
        match run_shell(
            None,
            &format!(
                "gh api graphql --hostname {} -f query={}",
                shell_quote(&remote.host),
                shell_quote(&query)
            ),
        )
        .await
        {
            Ok(output) if output.status.success() => (
                String::from_utf8_lossy(&output.stdout).to_string(),
                SkillsListingSource::Gh,
            ),
            Ok(output) => {
                if output.status.code() == Some(127) {
                    return SkillsStatus::unavailable(
                        "GitHub CLI (gh) not found. Install it to enable skill detection.",
                    );
                }
                let stderr = String::from_utf8_lossy(&output.stderr);
                if gh_repo_access_error(&stderr) {
                    if let Some(token) = token.as_deref() {
                        match github_graphql(&remote, token, &query).await {
                            Ok(body) => (body, SkillsListingSource::Token),
                            Err(err) => {
                                return SkillsStatus::unavailable(format!(
                                    "Could not access {repo_arg}. Check the repo URL and {}. GitHub API fallback failed: {err}",
                                    remote.auth_hint()
                                ))
                            }
                        }
                    } else {
                        return SkillsStatus::unavailable(format!(
                            "Could not access {repo_arg}. Check the repo URL and {}.",
                            remote.auth_hint()
                        ));
                    }
                } else {
                    return SkillsStatus::unavailable(format!(
                        "Could not check {repo_arg}: {}",
                        tail(&stderr, 200)
                    ));
                }
            }
            Err(err) => return SkillsStatus::unavailable(format!("Could not run gh: {err}")),
        }
    } else if let Some(token) = token.as_deref() {
        match github_graphql(&remote, token, &query).await {
            Ok(body) => (body, SkillsListingSource::Token),
            Err(err) => {
                return SkillsStatus::unavailable(format!(
                    "Could not access {repo_arg}. Check the repo URL and {}. GitHub API fallback failed: {err}",
                    remote.auth_hint()
                ))
            }
        }
    } else {
        return SkillsStatus::unavailable(format!(
            "Could not access {repo_arg}. Check the repo URL and {}.",
            remote.auth_hint()
        ));
    };
    let present: Vec<String> = match skills_with_manifest(&listing) {
        Ok(present) => present,
        Err(err) => {
            return SkillsStatus::unavailable(format!("Could not parse the GitHub response: {err}"))
        }
    };

    let missing: Vec<String> = skill_names
        .iter()
        .filter(|name| !present.contains(name))
        .cloned()
        .collect();
    if missing.is_empty() {
        return SkillsStatus {
            state: SkillsState::Installed,
            missing,
            pr_url: None,
            detail: None,
        };
    }

    if listing_source == SkillsListingSource::Gh {
        let pr = run_shell(
            None,
            &format!(
                "gh pr list --repo {} --head {} --state open --json url --jq '.[0].url'",
                shell_quote(&repo_arg),
                shell_quote(INSTALL_BRANCH)
            ),
        )
        .await;
        if let Ok(output) = pr {
            if output.status.success() {
                let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !url.is_empty() {
                    return SkillsStatus {
                        state: SkillsState::PrOpen,
                        missing,
                        pr_url: Some(url),
                        detail: None,
                    };
                }
            }
        }
    }
    if let Some(token) = token.as_deref() {
        if let Ok(Some(url)) = github_open_pr_url(&remote, token, INSTALL_BRANCH).await {
            return SkillsStatus {
                state: SkillsState::PrOpen,
                missing,
                pr_url: Some(url),
                detail: None,
            };
        }
    }

    if listing_source == SkillsListingSource::Token {
        if let Err(err) = resolve_default_branch(repo_url).await {
            return SkillsStatus::unavailable(format!(
                "Could not offer an install PR for {repo_arg}: the GitHub API token can read the repo, but skills installation also needs plain git credentials for clone and push. Run `gh auth setup-git` for the repo host or configure SSH credentials, then retry. Git check failed: {}",
                tail(&err, 300)
            ));
        }
    }

    SkillsStatus {
        state: SkillsState::Missing,
        missing,
        pr_url: None,
        detail: None,
    }
}

/// Names of skill directories under `.agents/skills/` that contain a
/// `SKILL.md` blob, from the GraphQL response of `check_skills`. A missing
/// path resolves to `object: null`, which is simply "none present".
fn skills_with_manifest(raw: &str) -> Result<Vec<String>, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_str(raw)?;
    let entries = value["data"]["repository"]["object"]["entries"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(entries
        .iter()
        .filter(|entry| {
            entry["type"].as_str() == Some("tree")
                && entry["object"]["entries"]
                    .as_array()
                    .is_some_and(|children| {
                        children.iter().any(|child| {
                            child["name"].as_str() == Some("SKILL.md")
                                && child["type"].as_str() == Some("blob")
                        })
                    })
        })
        .filter_map(|entry| entry["name"].as_str().map(ToOwned::to_owned))
        .collect())
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillsInstallState {
    Idle,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SkillsInstallStatus {
    pub state: SkillsInstallState,
    /// Repository this install run targets; lets the UI attribute a running
    /// or finished install to one of several configured repos.
    pub repo_url: Option<String>,
    /// Latest progress message while running.
    pub message: Option<String>,
    pub pr_url: Option<String>,
    pub error: Option<String>,
}

impl SkillsInstallStatus {
    fn idle() -> Self {
        Self {
            state: SkillsInstallState::Idle,
            repo_url: None,
            message: None,
            pr_url: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SkillsInstallConfig {
    pub repo_url: String,
    /// Resolved workspace root (same directory per-issue workspaces live in).
    pub workspace_root: PathBuf,
    /// Parsed workflow supplying the agent backend and its CLI options.
    pub workflow: ParsedWorkflow,
    pub skills: Vec<SkillFile>,
    /// Base environment captured after app-level fixes such as login-shell PATH
    /// repair. Install sessions do not go through per-issue run_env, so they
    /// need this explicitly.
    pub env: BTreeMap<String, String>,
    /// Custom session env from settings (e.g. `CURSOR_API_KEY`).
    pub session_env: BTreeMap<String, String>,
}

/// One-at-a-time background install; status is polled by the UI.
#[derive(Debug, Clone, Default)]
pub struct SkillsInstaller {
    inner: Arc<Mutex<Option<SkillsInstallStatus>>>,
}

impl SkillsInstaller {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn status(&self) -> SkillsInstallStatus {
        self.inner
            .lock()
            .await
            .clone()
            .unwrap_or_else(SkillsInstallStatus::idle)
    }

    pub async fn start(
        &self,
        config: SkillsInstallConfig,
    ) -> Result<SkillsInstallStatus, SkillsError> {
        {
            let mut inner = self.inner.lock().await;
            if matches!(
                inner.as_ref().map(|status| &status.state),
                Some(SkillsInstallState::Running)
            ) {
                return Err(SkillsError::AlreadyRunning);
            }
            *inner = Some(SkillsInstallStatus {
                state: SkillsInstallState::Running,
                repo_url: Some(config.repo_url.clone()),
                message: Some("Preparing workspace…".to_string()),
                pr_url: None,
                error: None,
            });
        }
        let inner = self.inner.clone();
        let repo_url = config.repo_url.clone();
        tokio::spawn(async move {
            let result = run_install(&inner, config).await;
            let mut guard = inner.lock().await;
            match result {
                Ok(pr_url) => {
                    info!(target: "symphony", %pr_url, "skills install completed");
                    *guard = Some(SkillsInstallStatus {
                        state: SkillsInstallState::Completed,
                        repo_url: Some(repo_url),
                        message: None,
                        pr_url: Some(pr_url),
                        error: None,
                    });
                }
                Err(message) => {
                    error!(target: "symphony", %message, "skills install failed");
                    *guard = Some(SkillsInstallStatus {
                        state: SkillsInstallState::Failed,
                        repo_url: Some(repo_url),
                        message: None,
                        pr_url: None,
                        error: Some(message),
                    });
                }
            }
        });
        Ok(self.status().await)
    }
}

async fn set_message(inner: &Arc<Mutex<Option<SkillsInstallStatus>>>, message: impl Into<String>) {
    let mut guard = inner.lock().await;
    if let Some(status) = guard.as_mut() {
        if status.state == SkillsInstallState::Running {
            status.message = Some(message.into());
        }
    }
}

async fn run_install(
    inner: &Arc<Mutex<Option<SkillsInstallStatus>>>,
    config: SkillsInstallConfig,
) -> Result<String, String> {
    set_message(inner, "Resolving default branch…").await;
    let default_branch = resolve_default_branch(&config.repo_url).await?;

    let workspace = config.workspace_root.join(INSTALL_WORKSPACE_KEY);
    tokio::fs::remove_dir_all(&workspace).await.ok();
    tokio::fs::create_dir_all(&workspace)
        .await
        .map_err(|err| format!("could not create workspace: {err}"))?;

    set_message(inner, "Cloning repository…").await;
    let clone = run_shell(
        Some(&workspace),
        &clone_default_branch_command(&config.repo_url, &default_branch),
    )
    .await
    .map_err(|err| format!("could not run git: {err}"))?;
    if !clone.status.success() {
        return Err(format!(
            "git clone failed: {}",
            tail(&String::from_utf8_lossy(&clone.stderr), 300)
        ));
    }

    set_message(inner, "Writing skill files…").await;
    write_skills(&workspace, &config.skills)
        .await
        .map_err(|err| format!("could not write skill files: {err}"))?;

    set_message(inner, "Agent is adapting the skills and opening a PR…").await;
    let request = install_run_request(&config, &workspace, &default_branch);
    let verification_env = request.env.clone();

    let (tx, mut rx) = tokio::sync::mpsc::channel(256);
    let driver = NativeAgentDriver;
    let mut run_fut = Box::pin(driver.run(request, tx, CancellationToken::new()));
    let result = loop {
        tokio::select! {
            maybe_event = rx.recv() => {
                if let Some(event) = maybe_event {
                    if let Some(summary) = event.humanized {
                        set_message(inner, tail(&summary, 200)).await;
                    }
                }
            }
            result = &mut run_fut => break result,
        }
    };

    let result = result.map_err(|err| format!("agent run failed: {err}"))?;
    match result.outcome {
        // An agent can exit "successfully" while merely summarizing why it
        // could not push or open the PR — completion is only real if the PR
        // exists.
        AgentOutcome::Success => match find_pr_url(&workspace, &verification_env).await {
            Some(url) => Ok(url),
            None => Err(format!(
                "the agent finished but no open PR exists for {INSTALL_BRANCH} — \
                 check `gh auth status` and push access, then retry"
            )),
        },
        AgentOutcome::Cancelled => Err("install was cancelled".to_string()),
        AgentOutcome::Failure => Err(result
            .error_message
            .unwrap_or_else(|| "agent reported failure".to_string())),
    }
}

pub(crate) async fn resolve_default_branch(repo_url: &str) -> Result<String, String> {
    resolve_default_branch_with_env(repo_url, &[]).await
}

pub(crate) async fn resolve_default_branch_with_env(
    repo_url: &str,
    env: &[(String, String)],
) -> Result<String, String> {
    let output = run_shell_with_env(
        None,
        &format!("git ls-remote --symref {} HEAD", shell_quote(repo_url)),
        env,
    )
    .await
    .map_err(|err| format!("could not run git: {err}"))?;
    if !output.status.success() {
        if output.status.code() == Some(127) {
            return Err("Git not found. Install it to enable skills installation.".to_string());
        }
        return Err(format!(
            "could not determine the default branch: {}",
            tail(&String::from_utf8_lossy(&output.stderr), 300)
        ));
    }
    default_branch_from_ls_remote(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| {
        "could not determine the default branch: remote HEAD is not a branch".to_string()
    })
}

fn default_branch_from_ls_remote(raw: &str) -> Option<String> {
    raw.lines().find_map(|line| {
        let line = line.trim_end_matches('\r');
        let branch = line
            .strip_prefix("ref: refs/heads/")?
            .strip_suffix("\tHEAD")?;
        (!branch.is_empty()).then(|| branch.to_string())
    })
}

pub(crate) fn clone_default_branch_command(repo_url: &str, default_branch: &str) -> String {
    format!(
        "git clone --depth 1 --branch {} --single-branch -- {} .",
        shell_quote(default_branch),
        shell_quote(repo_url)
    )
}

/// Tools the Claude install session needs regardless of how the user
/// customized the workflow: git/gh for the branch + PR work (destructive git
/// forms intentionally omitted, mirroring the default workflow) and the file
/// tools for adapting validation gates — allow-listed explicitly because some
/// claude CLI versions drop the startup permission mode and then deny writes.
const INSTALL_ALLOWED_TOOLS: &[&str] = &[
    "Edit",
    "Write",
    "Bash(gh *)",
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
    "Bash(git remote*)",
    "Bash(git rev-parse*)",
    "Bash(git ls-files*)",
    "Bash(git config --get*)",
    "Bash(which *)",
];

/// The install session must edit the written skill files and reach GitHub to
/// push and open the PR, so it pins install-safe agent options instead of
/// inheriting worker settings: locked-down sandboxes (Codex read-only /
/// no-network) or restrictive Claude permission modes and tool lists are
/// valid for issue runs but would guarantee this run fails. The user's
/// allowed tools are merged in on top, never subtracted from.
fn install_run_request(
    config: &SkillsInstallConfig,
    workspace: &Path,
    default_branch: &str,
) -> AgentRunRequest {
    let front = &config.workflow.front_matter;
    let backend = front.agent.backend.clone();
    let mut allowed_tools: Vec<String> = INSTALL_ALLOWED_TOOLS
        .iter()
        .map(ToString::to_string)
        .collect();
    for tool in &front.claude.allowed_tools {
        if !allowed_tools.contains(tool) {
            allowed_tools.push(tool.clone());
        }
    }
    AgentRunRequest {
        backend: backend.clone(),
        command: match backend {
            AgentBackend::Codex => front.codex.command.clone(),
            AgentBackend::Claude => front.claude.command.clone(),
            AgentBackend::Cursor => front.cursor.command.clone(),
            AgentBackend::Opencode => front.opencode.command.clone(),
        },
        cwd: workspace.to_path_buf(),
        prompt: install_prompt(&config.repo_url, default_branch, &config.skills),
        thread_sandbox: ThreadSandbox::WorkspaceWrite,
        turn_sandbox_policy: TurnSandboxPolicy::WorkspaceWrite,
        network_access: true,
        turn_timeout_ms: match backend {
            AgentBackend::Codex => front.codex.turn_timeout_ms,
            AgentBackend::Claude => front.claude.turn_timeout_ms,
            AgentBackend::Cursor => front.cursor.turn_timeout_ms,
            AgentBackend::Opencode => front.opencode.turn_timeout_ms,
        },
        claude: ClaudeRunOptions {
            permission_mode: ClaudePermissionMode::Auto,
            allowed_tools,
            disallowed_tools: Vec::new(),
            add_dirs: front.claude.add_dirs.clone(),
            session_id: None,
        },
        cursor: CursorRunOptions {
            mode: CursorAgentMode::Agent,
            force: true,
            trust: true,
            approve_mcps: false,
            // Disable the sandbox: the bootstrap run must reach the remote to
            // push a branch and open the install PR (including GHE remotes),
            // and Cursor's sandbox filters network access. Pinning it open
            // keeps installs working regardless of the user's run config.
            sandbox: CursorSandboxMode::Disabled,
            // Honor the user's configured model so installs behave like
            // ordinary Cursor runs.
            model: front.cursor.model.clone(),
        },
        opencode: OpencodeRunOptions {
            model: front.opencode.model.clone(),
            // Don't inherit the user's primary agent: a read-only one (plan)
            // can't edit .agents/skills, commit, push, or open the PR. None
            // falls back to opencode's default writable agent, so installs work
            // regardless of the configured run agent.
            agent: None,
            // Bootstrap installs must run tools unattended (clone, push, open
            // the PR), so always skip permissions regardless of the user's
            // configured run setting.
            skip_permissions: true,
        },
        env: install_agent_env(&config.repo_url, &config.env, &config.session_env),
    }
}

pub(crate) fn install_agent_env(
    repo_url: &str,
    env: &BTreeMap<String, String>,
    session_env: &BTreeMap<String, String>,
) -> Vec<(String, String)> {
    install_agent_env_from(repo_url, env, session_env, env::vars())
}

fn install_agent_env_from(
    repo_url: &str,
    env: &BTreeMap<String, String>,
    session_env: &BTreeMap<String, String>,
    process_env: impl IntoIterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    let process_env = process_env.into_iter().collect::<BTreeMap<_, _>>();
    let mut injected = env.clone();
    let token_keys = github_token_env_vars_for_repo_url(repo_url);
    let session_has_token = github_token_env_has_token_for_repo_url(repo_url, session_env);
    if session_has_token {
        for key in token_keys {
            injected.remove(*key);
        }
    } else {
        for key in token_keys {
            if let Some(value) = env
                .get(*key)
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    process_env
                        .get(*key)
                        .filter(|value| !value.trim().is_empty())
                })
            {
                injected.insert((*key).to_string(), value.clone());
            }
        }
    }
    injected.extend(
        session_env
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    injected.into_iter().collect()
}

/// Remove whatever exists at `path` — file, directory, or symlink — without
/// following links. Missing paths are fine.
pub(crate) async fn remove_existing(path: &Path) -> std::io::Result<()> {
    match tokio::fs::symlink_metadata(path).await {
        // symlink_metadata never follows: is_dir() means a real directory.
        Ok(meta) if meta.is_dir() => tokio::fs::remove_dir_all(path).await,
        Ok(_) => tokio::fs::remove_file(path).await,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

/// Make `path` a real directory. A symlink or regular file the cloned repo
/// tracks at this location is removed first — writes below it must not be
/// able to escape the throwaway workspace through a hostile link.
async fn ensure_real_dir(path: &Path) -> std::io::Result<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(meta) if meta.is_dir() => return Ok(()),
        Ok(_) => tokio::fs::remove_file(path).await?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    tokio::fs::create_dir(path).await
}

/// Make every level of `relative` under `workspace` a real directory.
async fn ensure_real_dir_all(workspace: &Path, relative: &Path) -> std::io::Result<()> {
    let mut current = workspace.to_path_buf();
    for component in relative.components() {
        current.push(component);
        ensure_real_dir(&current).await?;
    }
    Ok(())
}

/// Ensure a live issue workspace can use every bundled skill without requiring
/// those files to be checked in upstream. Tracked manifests win; local fallback
/// manifests are refreshed from the current bundle on every dispatch.
pub(crate) async fn ensure_workspace_skills(
    workspace: &Path,
    skills: &[SkillFile],
) -> std::io::Result<WorkspaceSkillsUpdate> {
    let mut update = WorkspaceSkillsUpdate::default();
    if skills.is_empty() {
        return Ok(update);
    }

    for skill in skills {
        let manifest_rel = Path::new(SKILLS_DIR).join(&skill.name).join("SKILL.md");
        if git_path_or_parent_blob_in_head(workspace, &manifest_rel).await? {
            continue;
        }
        ensure_real_dir_all(workspace, Path::new(SKILLS_DIR)).await?;
        let dir = workspace.join(SKILLS_DIR).join(&skill.name);
        ensure_real_dir(&dir).await?;
        let manifest = dir.join("SKILL.md");
        remove_existing(&manifest).await?;
        tokio::fs::write(&manifest, &skill.content).await?;
        git_unstage_path(workspace, &manifest_rel).await?;
        update.injected.push(skill.name.clone());
        update
            .excluded_paths
            .push(format!("/{SKILLS_DIR}/{}/SKILL.md", skill.name));
    }

    update
        .excluded_paths
        .extend(ensure_missing_claude_discovery(workspace, skills).await?);
    write_git_excludes(workspace, &update.excluded_paths).await?;
    Ok(update)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum GitPathKind {
    Tree,
    Other,
}

async fn git_head_path_kind(
    workspace: &Path,
    relative: &Path,
) -> std::io::Result<Option<GitPathKind>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .arg("cat-file")
        .arg("-t")
        .arg(format!("HEAD:{}", git_tree_path(relative)))
        .output()
        .await;
    match output {
        Ok(output) if output.status.success() => {
            let kind = match String::from_utf8_lossy(&output.stdout).trim() {
                "tree" => GitPathKind::Tree,
                _ => GitPathKind::Other,
            };
            Ok(Some(kind))
        }
        Ok(_) => Ok(None),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

async fn git_path_in_head(workspace: &Path, relative: &Path) -> std::io::Result<bool> {
    Ok(git_head_path_kind(workspace, relative).await?.is_some())
}

async fn git_path_or_parent_blob_in_head(
    workspace: &Path,
    relative: &Path,
) -> std::io::Result<bool> {
    let mut current = PathBuf::new();
    for component in relative.components() {
        current.push(component);
        if let Some(kind) = git_head_path_kind(workspace, &current).await? {
            if kind != GitPathKind::Tree || current == relative {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

async fn git_unstage_path(workspace: &Path, relative: &Path) -> std::io::Result<()> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .arg("rm")
        .arg("--cached")
        .arg("--force")
        .arg("-q")
        .arg("--ignore-unmatch")
        .arg("--")
        .arg(relative)
        .output()
        .await;
    match output {
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

async fn git_unstage_fallback_path(workspace: &Path, relative: &Path) -> std::io::Result<()> {
    if git_path_in_head(workspace, relative).await? {
        return Ok(());
    }
    git_unstage_path(workspace, relative).await
}

fn git_tree_path(relative: &Path) -> String {
    relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

async fn ensure_missing_claude_discovery(
    workspace: &Path,
    skills: &[SkillFile],
) -> std::io::Result<Vec<String>> {
    let claude = workspace.join(CLAUDE_DIR);
    if let Ok(meta) = tokio::fs::symlink_metadata(&claude).await {
        if !meta.is_dir() && git_path_in_head(workspace, Path::new(CLAUDE_DIR)).await? {
            return Ok(Vec::new());
        }
    }
    ensure_real_dir_all(workspace, Path::new(CLAUDE_DIR)).await?;
    let discovery = workspace.join(CLAUDE_SKILLS_DIR);
    match tokio::fs::symlink_metadata(&discovery).await {
        Ok(meta) if meta.is_dir() => {
            ensure_missing_per_skill_claude_entries(workspace, &discovery, skills).await
        }
        Ok(meta) if meta.file_type().is_symlink() => {
            #[cfg(unix)]
            {
                let target = tokio::fs::read_link(&discovery).await?;
                if is_expected_claude_skills_link(&target, workspace) {
                    if git_path_in_head(workspace, Path::new(CLAUDE_SKILLS_DIR)).await? {
                        return Ok(Vec::new());
                    }
                    git_unstage_path(workspace, Path::new(CLAUDE_SKILLS_DIR)).await?;
                    return Ok(vec![format!("/{CLAUDE_SKILLS_DIR}")]);
                }
            }
            remove_existing(&discovery).await?;
            create_claude_skills_discovery(&discovery, skills).await?;
            git_unstage_fallback_path(workspace, Path::new(CLAUDE_SKILLS_DIR)).await?;
            Ok(vec![format!("/{CLAUDE_SKILLS_DIR}")])
        }
        Ok(_) => {
            remove_existing(&discovery).await?;
            create_claude_skills_discovery(&discovery, skills).await?;
            git_unstage_fallback_path(workspace, Path::new(CLAUDE_SKILLS_DIR)).await?;
            Ok(vec![format!("/{CLAUDE_SKILLS_DIR}")])
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            create_claude_skills_discovery(&discovery, skills).await?;
            git_unstage_fallback_path(workspace, Path::new(CLAUDE_SKILLS_DIR)).await?;
            Ok(vec![format!("/{CLAUDE_SKILLS_DIR}")])
        }
        Err(err) => Err(err),
    }
}

async fn ensure_missing_per_skill_claude_entries(
    workspace: &Path,
    discovery: &Path,
    skills: &[SkillFile],
) -> std::io::Result<Vec<String>> {
    let mut excluded = Vec::new();
    for skill in skills {
        let link = discovery.join(&skill.name);
        let link_rel = Path::new(CLAUDE_SKILLS_DIR).join(&skill.name);
        let manifest_rel = link_rel.join("SKILL.md");
        if git_path_in_head(workspace, &link_rel).await?
            || git_path_in_head(workspace, &manifest_rel).await?
        {
            continue;
        }
        remove_existing(&link).await?;
        #[cfg(unix)]
        {
            let target = PathBuf::from("../..").join(SKILLS_DIR).join(&skill.name);
            tokio::fs::symlink(&target, &link).await?;
        }
        #[cfg(not(unix))]
        {
            tokio::fs::create_dir_all(&link).await?;
            tokio::fs::write(link.join("SKILL.md"), &skill.content).await?;
        }
        git_unstage_fallback_path(workspace, &link_rel).await?;
        excluded.push(format!("/{CLAUDE_SKILLS_DIR}/{}", skill.name));
    }
    Ok(excluded)
}

const GIT_EXCLUDE_HEADER: &str = "# Symphony local skill fallbacks";

async fn write_git_excludes(workspace: &Path, paths: &[String]) -> std::io::Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let Some(exclude) = git_exclude_path(workspace).await? else {
        return Ok(());
    };
    if let Some(info_dir) = exclude.parent() {
        tokio::fs::create_dir_all(info_dir).await?;
    }
    let mut content = match tokio::fs::read_to_string(&exclude).await {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(err),
    };
    let additions = {
        let existing = content.lines().collect::<BTreeSet<_>>();
        paths
            .iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|path| !existing.contains(path.as_str()))
            .cloned()
            .collect::<Vec<_>>()
    };
    if additions.is_empty() {
        return Ok(());
    }

    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    if !content.lines().any(|line| line == GIT_EXCLUDE_HEADER) {
        content.push_str(GIT_EXCLUDE_HEADER);
        content.push('\n');
    }
    for path in additions {
        content.push_str(&path);
        content.push('\n');
    }
    tokio::fs::write(exclude, content).await
}

async fn git_exclude_path(workspace: &Path) -> std::io::Result<Option<PathBuf>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .arg("rev-parse")
        .arg("--git-path")
        .arg("info/exclude")
        .output()
        .await;
    match output {
        Ok(output) if output.status.success() => {
            let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if raw.is_empty() {
                return Ok(None);
            }
            let path = PathBuf::from(raw);
            if path.is_absolute() {
                Ok(Some(path))
            } else {
                Ok(Some(workspace.join(path)))
            }
        }
        Ok(_) => Ok(None),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

async fn write_skills(workspace: &Path, skills: &[SkillFile]) -> std::io::Result<()> {
    // The clone is untrusted input: any level of the canonical skills path
    // could be a symlink pointing outside the workspace, so each is normalized
    // to a real directory before anything is written.
    ensure_real_dir_all(workspace, Path::new(SKILLS_DIR)).await?;
    for skill in skills {
        let dir = workspace.join(SKILLS_DIR).join(&skill.name);
        ensure_real_dir(&dir).await?;
        let manifest = dir.join("SKILL.md");
        remove_existing(&manifest).await?;
        tokio::fs::write(&manifest, &skill.content).await?;
    }

    write_claude_discovery(workspace, skills).await
}

async fn write_claude_discovery(workspace: &Path, skills: &[SkillFile]) -> std::io::Result<()> {
    // Keep `.claude` itself real so a top-level discovery link cannot be
    // created through a repo-controlled parent symlink.
    ensure_real_dir_all(workspace, Path::new(CLAUDE_DIR)).await?;
    let discovery = workspace.join(CLAUDE_SKILLS_DIR);
    match tokio::fs::symlink_metadata(&discovery).await {
        Ok(meta) if meta.is_dir() => write_per_skill_claude_entries(&discovery, skills).await,
        Ok(meta) if meta.file_type().is_symlink() => {
            #[cfg(unix)]
            {
                let target = tokio::fs::read_link(&discovery).await?;
                if is_expected_claude_skills_link(&target, workspace) {
                    return Ok(());
                }
            }
            remove_existing(&discovery).await?;
            create_claude_skills_discovery(&discovery, skills).await
        }
        Ok(_) => {
            remove_existing(&discovery).await?;
            create_claude_skills_discovery(&discovery, skills).await
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            create_claude_skills_discovery(&discovery, skills).await
        }
        Err(err) => Err(err),
    }
}

async fn write_per_skill_claude_entries(
    discovery: &Path,
    skills: &[SkillFile],
) -> std::io::Result<()> {
    for skill in skills {
        let link = discovery.join(&skill.name);
        // Replace whatever the repo previously tracked at the discovery path.
        // Keeping a stale entry would leave Claude Code pointing at the old
        // target even after the install PR merges.
        remove_existing(&link).await?;
        #[cfg(unix)]
        {
            let target = PathBuf::from("../..").join(SKILLS_DIR).join(&skill.name);
            tokio::fs::symlink(&target, &link).await?;
        }
        #[cfg(not(unix))]
        {
            // Symlinks need extra privileges on Windows; a copy still lets
            // Claude Code discover the skill.
            tokio::fs::create_dir_all(&link).await?;
            tokio::fs::write(link.join("SKILL.md"), &skill.content).await?;
        }
    }
    Ok(())
}

#[cfg(unix)]
async fn create_claude_skills_discovery(
    discovery: &Path,
    _skills: &[SkillFile],
) -> std::io::Result<()> {
    tokio::fs::symlink(claude_skills_symlink_target(), discovery).await
}

#[cfg(not(unix))]
async fn create_claude_skills_discovery(
    discovery: &Path,
    skills: &[SkillFile],
) -> std::io::Result<()> {
    tokio::fs::create_dir(discovery).await?;
    write_per_skill_claude_entries(discovery, skills).await
}

#[cfg(unix)]
fn claude_skills_symlink_target() -> PathBuf {
    PathBuf::from("..").join(SKILLS_DIR)
}

#[cfg(unix)]
fn is_expected_claude_skills_link(target: &Path, workspace: &Path) -> bool {
    target == claude_skills_symlink_target() || target == workspace.join(SKILLS_DIR)
}

/// Best-effort PR URL lookup for the branch the agent pushed.
async fn find_pr_url(workspace: &Path, env: &[(String, String)]) -> Option<String> {
    let output = run_shell_with_env(
        Some(workspace),
        &format!(
            "gh pr list --head {} --state open --json url --jq '.[0].url'",
            shell_quote(INSTALL_BRANCH)
        ),
        env,
    )
    .await
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!url.is_empty()).then_some(url)
}

fn install_prompt(repo_url: &str, default_branch: &str, skills: &[SkillFile]) -> String {
    let names = skills
        .iter()
        .map(|skill| skill.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"You are bootstrapping Symphony's agent skills in this repository so Symphony-dispatched agents can use them.

This workspace is a fresh clone of {repo_url}'s default branch, `{default_branch}`. The skill files have already been written to `{skills_dir}/<name>/SKILL.md`: {names}. Claude Code discovery uses `{claude_dir}` — fresh installs link that path to `{skills_dir}`, while repos that already had a real `{claude_dir}` directory receive per-skill compatibility entries inside it. Cursor loads skills from `{skills_dir}` automatically and does not need a separate discovery path.

Do the following, in order:

1. Detect this repo's real toolchain and canonical validation entrypoint (check package.json scripts, Cargo.toml, Makefile, CI workflows). The `symphony-pull` and `symphony-push` skills deliberately refer to the target repository's documented validation gate without assuming a package manager. Replace only those generic validation-gate sentences with this repo's canonical command; if the repo has no single entrypoint, use the closest meaningful command set. Do not change anything else in the skill files — the procedures are canonical.
2. Create a branch named `{branch}` from `{default_branch}`, stage only the new skill files and Claude discovery links or entries, and commit with the message "Add Symphony agent skills".
3. Push the branch to origin and open a pull request titled "Install Symphony agent skills" targeting `{default_branch}`. In the description, briefly explain that these are procedural guides Symphony-dispatched agents follow (committing, syncing, pushing, PR feedback, screenshots, merging, and Linear workpad updates) and list any validation commands you adapted for this repo. If a PR for this branch already exists, update it instead of opening a duplicate.

Rules:
- Only add files under `{skills_dir}/` and the Claude discovery links or entries at `{claude_dir}`; do not modify any other files.
- Never force-push, never use --no-verify, never rewrite history.
- This is unattended: do not ask a human anything.
- End your final message with the PR URL on its own line."#,
        repo_url = repo_url,
        default_branch = default_branch,
        skills_dir = SKILLS_DIR,
        claude_dir = CLAUDE_SKILLS_DIR,
        names = names,
        branch = INSTALL_BRANCH,
    )
}

pub(crate) async fn run_shell(
    dir: Option<&Path>,
    script: &str,
) -> std::io::Result<std::process::Output> {
    shell_command(dir, script).output().await
}

pub(crate) async fn run_shell_with_env(
    dir: Option<&Path>,
    script: &str,
    env: &[(String, String)],
) -> std::io::Result<std::process::Output> {
    let mut cmd = shell_command(dir, script);
    if env_has_github_token(env) {
        for key in GITHUB_TOKEN_ENV_VARS {
            cmd.env_remove(key);
        }
    }
    cmd.envs(env.iter().map(|(key, value)| (key, value)));
    cmd.output().await
}

fn env_has_github_token(env: &[(String, String)]) -> bool {
    env.iter().any(|(key, value)| {
        GITHUB_TOKEN_ENV_VARS.contains(&key.as_str()) && !value.trim().is_empty()
    })
}

fn shell_command(dir: Option<&Path>, script: &str) -> Command {
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-lc").arg(script);
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    cmd
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) fn tail(value: &str, max: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let skip = trimmed.chars().count() - max;
    trimmed.chars().skip(skip).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_git(workspace: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(workspace)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git -C {} {} failed: {}",
            workspace.display(),
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn commit_staged(workspace: &Path, message: &str) {
        run_git(
            workspace,
            &[
                "-c",
                "user.email=symphony@example.com",
                "-c",
                "user.name=Symphony Test",
                "commit",
                "--allow-empty",
                "-m",
                message,
            ],
        );
    }

    fn git_stdout(workspace: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(workspace)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git -C {} {} failed: {}",
            workspace.display(),
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).to_string()
    }

    fn git_path_stdout(workspace: &Path, args: &[&str]) -> PathBuf {
        let raw = git_stdout(workspace, args).trim().to_string();
        let path = PathBuf::from(raw);
        if path.is_absolute() {
            path
        } else {
            workspace.join(path)
        }
    }

    #[test]
    fn parses_github_urls() {
        for url in [
            "git@github.com:acme/widgets.git",
            "git@github.com:acme/widgets",
            "ssh://git@github.com/acme/widgets.git",
            "https://github.com/acme/widgets",
            "https://github.com/acme/widgets.git",
            "https://github.com/acme/widgets/",
            "  https://github.com/acme/widgets  ",
        ] {
            assert_eq!(
                parse_github_repo(url).as_deref(),
                Some("acme/widgets"),
                "failed for {url}"
            );
        }
    }

    #[test]
    fn parses_ghe_urls() {
        for url in [
            "git@octocorp.ghe.com:acme/widgets.git",
            "git@octocorp.ghe.com:acme/widgets",
            "octocorp@octocorp.ghe.com:acme/widgets.git",
            "ssh://git@octocorp.ghe.com/acme/widgets.git",
            "ssh://octocorp.ghe.com/acme/widgets.git",
            "https://octocorp.ghe.com/acme/widgets",
            "https://octocorp.ghe.com/acme/widgets.git",
            "http://octocorp.ghe.com/acme/widgets",
            "octocorp.ghe.com/acme/widgets",
            "  https://octocorp.ghe.com/acme/widgets  ",
        ] {
            let remote = parse_github_remote(url).unwrap_or_else(|| panic!("failed for {url}"));
            assert_eq!(remote.host, "octocorp.ghe.com", "failed for {url}");
            assert_eq!(remote.slug(), "acme/widgets", "failed for {url}");
            assert_eq!(
                remote.gh_repo_arg(),
                "octocorp.ghe.com/acme/widgets",
                "failed for {url}"
            );
            assert_eq!(
                parse_github_repo(url).as_deref(),
                Some("acme/widgets"),
                "failed for {url}"
            );
        }
    }

    #[test]
    fn omits_github_com_from_gh_repo_arg() {
        let remote = parse_github_remote("https://github.com/acme/widgets").unwrap();
        assert_eq!(remote.gh_repo_arg(), "acme/widgets");
    }

    #[test]
    fn ghe_dotcom_hosts_use_dotcom_token_envs() {
        assert_eq!(
            github_token_env_vars_for_host("github.com"),
            GITHUB_DOTCOM_TOKEN_ENV_VARS
        );
        assert_eq!(
            github_token_env_vars_for_host("octocorp.ghe.com"),
            GITHUB_DOTCOM_TOKEN_ENV_VARS
        );
    }

    #[test]
    fn ghe_dotcom_hosts_use_dedicated_api_domain() {
        let remote = parse_github_remote("https://octocorp.ghe.com/acme/widgets").unwrap();
        assert_eq!(remote.api_base(), "https://api.octocorp.ghe.com");
        assert_eq!(
            remote.graphql_endpoint(),
            "https://api.octocorp.ghe.com/graphql"
        );
    }

    #[test]
    fn token_lookup_skips_blank_env_values() {
        let vars = [
            ("GH_TOKEN".to_string(), " ".to_string()),
            ("GITHUB_TOKEN".to_string(), "github-token".to_string()),
            (
                "GH_ENTERPRISE_TOKEN".to_string(),
                "enterprise-token".to_string(),
            ),
        ];

        assert_eq!(
            github_token_for_host_from("github.com", vars.clone()),
            Some("github-token".to_string())
        );
        assert_eq!(
            github_token_for_host_from("octocorp.ghe.com", vars),
            Some("github-token".to_string())
        );
        let empty: &[&str] = &[];
        assert_eq!(github_token_env_vars_for_host("gitlab.com"), empty);
    }

    #[test]
    fn token_lookup_includes_session_env_values() {
        let process_env = [
            ("GITHUB_TOKEN".to_string(), "from-process".to_string()),
            (
                "GH_ENTERPRISE_TOKEN".to_string(),
                "enterprise-process".to_string(),
            ),
        ];
        let session_env = BTreeMap::from([
            ("GH_TOKEN".to_string(), "from-session".to_string()),
            (
                "GH_ENTERPRISE_TOKEN".to_string(),
                "enterprise-session".to_string(),
            ),
        ]);

        assert_eq!(
            github_token_for_host_from_sources("github.com", process_env.clone(), &session_env),
            Some("from-session".to_string())
        );
        assert_eq!(
            github_token_for_host_from_sources("gitlab.com", process_env, &session_env),
            None
        );

        let process_env = [("GH_TOKEN".to_string(), "stale-process".to_string())];
        let session_env = BTreeMap::from([(
            "GITHUB_TOKEN".to_string(),
            "repo-scoped-session".to_string(),
        )]);
        assert_eq!(
            github_token_for_host_from_sources("github.com", process_env, &session_env),
            Some("repo-scoped-session".to_string())
        );
    }

    #[test]
    fn shell_env_detects_github_tokens() {
        assert!(env_has_github_token(&[(
            "GITHUB_TOKEN".to_string(),
            "repo-scoped-session".to_string(),
        )]));
        assert!(!env_has_github_token(&[(
            "GITHUB_TOKEN".to_string(),
            " ".to_string(),
        )]));
        assert!(!env_has_github_token(&[(
            "OPENAI_API_KEY".to_string(),
            "sk-test".to_string(),
        )]));
    }

    #[test]
    fn repo_url_token_selection_uses_the_repo_host() {
        assert_eq!(
            github_token_env_vars_for_repo_url("git@github.com:acme/widgets.git"),
            GITHUB_DOTCOM_TOKEN_ENV_VARS
        );
        assert_eq!(
            github_token_env_vars_for_repo_url("https://octocorp.ghe.com/acme/widgets"),
            GITHUB_DOTCOM_TOKEN_ENV_VARS
        );
        let empty: &[&str] = &[];
        assert_eq!(
            github_token_env_vars_for_repo_url("git@enterprise.internal:acme/widgets.git"),
            empty
        );
        assert_eq!(
            github_token_env_vars_for_repo_url("git@gitlab.com:acme/widgets.git"),
            empty
        );
    }

    #[test]
    fn classifies_gh_repository_access_errors() {
        assert!(gh_repo_access_error(
            "GraphQL: Could not resolve to a Repository with the name 'acme/widgets'."
        ));
        assert!(gh_repo_access_error("HTTP 404: Repository not found"));
        assert!(!gh_repo_access_error("network timed out"));
    }

    #[cfg(unix)]
    #[test]
    fn gh_auth_status_preserves_missing_cli() {
        use std::os::unix::process::ExitStatusExt;

        let output = std::process::Output {
            status: std::process::ExitStatus::from_raw(127 << 8),
            stdout: Vec::new(),
            stderr: Vec::new(),
        };

        assert_eq!(
            gh_auth_status_from_output(Ok(output)),
            GhAuthStatus::MissingCli
        );
    }

    #[test]
    fn rejects_non_github_urls() {
        for url in [
            "",
            "git@gitlab.com:acme/widgets.git",
            "https://github.com/acme",
            "https://github.com/acme/widgets/tree/main",
            "/local/path/repo",
        ] {
            assert_eq!(parse_github_repo(url), None, "should reject {url}");
        }
    }

    #[test]
    fn counts_only_skill_dirs_with_a_manifest() {
        let raw = r#"{"data":{"repository":{"object":{"entries":[
            {"name":"commit","type":"tree","object":{"entries":[{"name":"SKILL.md","type":"blob"}]}},
            {"name":"push","type":"tree","object":{"entries":[{"name":"README.md","type":"blob"}]}},
            {"name":"land","type":"blob","object":null},
            {"name":"pull","type":"tree","object":{"entries":[]}}
        ]}}}}"#;
        assert_eq!(skills_with_manifest(raw).unwrap(), vec!["commit"]);
    }

    #[test]
    fn missing_skills_path_means_nothing_present() {
        for raw in [
            r#"{"data":{"repository":{"object":null}}}"#,
            r#"{"data":{"repository":null}}"#,
        ] {
            assert_eq!(skills_with_manifest(raw).unwrap(), Vec::<String>::new());
        }
        assert!(skills_with_manifest("not json").is_err());
    }

    #[test]
    fn install_prompt_names_every_skill_and_the_branch() {
        let skills = vec![
            SkillFile {
                name: "symphony-workpad".to_string(),
                content: "---\nname: symphony-workpad\n---".to_string(),
            },
            SkillFile {
                name: "symphony-push".to_string(),
                content: "---\nname: symphony-push\n---".to_string(),
            },
        ];
        let prompt = install_prompt("git@github.com:acme/widgets.git", "develop", &skills);
        assert!(prompt.contains("symphony-workpad, symphony-push"));
        assert!(prompt.contains(INSTALL_BRANCH));
        assert!(prompt.contains("default branch, `develop`"));
        assert!(prompt.contains("targeting `develop`"));
        assert!(prompt.contains(SKILLS_DIR));
        assert!(prompt.contains(CLAUDE_SKILLS_DIR));
        assert!(prompt.contains("fresh installs link that path"));
        assert!(prompt.contains("per-skill compatibility entries"));
        assert!(prompt.contains("without assuming a package manager"));
        let legacy_gate = ["pnpm ", "format:check"].concat();
        assert!(!prompt.contains(&legacy_gate));
        assert!(prompt.contains("never use --no-verify"));
    }

    #[test]
    fn parses_default_branch_from_ls_remote_symref() {
        let raw = "ref: refs/heads/release/2026.06\tHEAD\nabc123\tHEAD\n";
        assert_eq!(
            default_branch_from_ls_remote(raw).as_deref(),
            Some("release/2026.06")
        );
    }

    #[test]
    fn rejects_ls_remote_without_branch_symref() {
        assert_eq!(default_branch_from_ls_remote("abc123\tHEAD\n"), None);
        assert_eq!(
            default_branch_from_ls_remote("ref: refs/tags/v1\tHEAD\n"),
            None
        );
        assert_eq!(
            default_branch_from_ls_remote("ref: refs/heads/\tHEAD\n"),
            None
        );
    }

    #[test]
    fn clone_command_pins_resolved_default_branch() {
        assert_eq!(
            clone_default_branch_command("git@github.com:acme/widgets.git", "release/2026.06"),
            "git clone --depth 1 --branch 'release/2026.06' --single-branch -- 'git@github.com:acme/widgets.git' ."
        );
    }

    #[tokio::test]
    async fn writes_skill_files_and_top_level_claude_discovery_link() {
        let temp = tempfile::tempdir().unwrap();
        let skills = vec![SkillFile {
            name: "commit".to_string(),
            content: "body".to_string(),
        }];
        write_skills(temp.path(), &skills).await.unwrap();

        let canonical = temp.path().join(".agents/skills/commit/SKILL.md");
        assert_eq!(std::fs::read_to_string(&canonical).unwrap(), "body");
        let discovery = temp.path().join(CLAUDE_SKILLS_DIR);
        assert_eq!(
            std::fs::read_to_string(discovery.join("commit/SKILL.md")).unwrap(),
            "body"
        );
        #[cfg(unix)]
        {
            assert!(std::fs::symlink_metadata(&discovery)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(
                std::fs::read_link(&discovery).unwrap(),
                claude_skills_symlink_target()
            );
        }
    }

    #[tokio::test]
    async fn local_injection_preserves_tracked_skills_and_refreshes_fallbacks() {
        let temp = tempfile::tempdir().unwrap();
        run_git(temp.path(), &["init"]);
        let existing = temp.path().join(SKILLS_DIR).join("symphony-commit");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(existing.join("SKILL.md"), "repo-owned").unwrap();
        run_git(
            temp.path(),
            &["add", ".agents/skills/symphony-commit/SKILL.md"],
        );
        commit_staged(temp.path(), "track repo skill");
        let stale = temp.path().join(SKILLS_DIR).join("symphony-workpad");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("SKILL.md"), "stale fallback").unwrap();
        let skills = vec![
            SkillFile {
                name: "symphony-commit".to_string(),
                content: "bundled commit".to_string(),
            },
            SkillFile {
                name: "symphony-workpad".to_string(),
                content: "bundled workpad".to_string(),
            },
        ];

        let update = ensure_workspace_skills(temp.path(), &skills).await.unwrap();

        assert_eq!(update.injected, vec!["symphony-workpad"]);
        assert_eq!(
            std::fs::read_to_string(existing.join("SKILL.md")).unwrap(),
            "repo-owned"
        );
        assert_eq!(
            std::fs::read_to_string(
                temp.path()
                    .join(SKILLS_DIR)
                    .join("symphony-workpad/SKILL.md")
            )
            .unwrap(),
            "bundled workpad"
        );
        let exclude = std::fs::read_to_string(temp.path().join(".git/info/exclude")).unwrap();
        assert!(exclude.contains(GIT_EXCLUDE_HEADER));
        assert!(exclude.contains("/.agents/skills/symphony-workpad/SKILL.md"));
        assert!(!exclude.contains("/.agents/skills/symphony-commit/SKILL.md"));
        assert!(exclude.contains("/.claude/skills"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_injection_preserves_tracked_symlink_manifests() {
        let temp = tempfile::tempdir().unwrap();
        run_git(temp.path(), &["init"]);
        let docs = temp.path().join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(docs.join("commit.md"), "repo-owned through symlink").unwrap();
        let existing = temp.path().join(SKILLS_DIR).join("symphony-commit");
        std::fs::create_dir_all(&existing).unwrap();
        std::os::unix::fs::symlink("../../../docs/commit.md", existing.join("SKILL.md")).unwrap();
        run_git(
            temp.path(),
            &[
                "add",
                "docs/commit.md",
                ".agents/skills/symphony-commit/SKILL.md",
            ],
        );
        commit_staged(temp.path(), "track symlink skill");
        let skills = vec![SkillFile {
            name: "symphony-commit".to_string(),
            content: "bundled commit".to_string(),
        }];

        let update = ensure_workspace_skills(temp.path(), &skills).await.unwrap();

        assert!(update.injected.is_empty());
        let manifest = existing.join("SKILL.md");
        assert!(std::fs::symlink_metadata(&manifest)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(&manifest).unwrap(),
            "repo-owned through symlink"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_injection_preserves_tracked_canonical_skills_dir_symlink() {
        let temp = tempfile::tempdir().unwrap();
        run_git(temp.path(), &["init"]);
        let shared = temp.path().join("shared/skills/symphony-workpad");
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::write(shared.join("SKILL.md"), "repo-owned shared skill").unwrap();
        std::fs::create_dir_all(temp.path().join(".agents")).unwrap();
        std::os::unix::fs::symlink("../shared/skills", temp.path().join(SKILLS_DIR)).unwrap();
        run_git(
            temp.path(),
            &["add", "shared/skills/symphony-workpad/SKILL.md", SKILLS_DIR],
        );
        commit_staged(temp.path(), "track shared skills symlink");
        let skills = vec![SkillFile {
            name: "symphony-workpad".to_string(),
            content: "bundled workpad".to_string(),
        }];

        let update = ensure_workspace_skills(temp.path(), &skills).await.unwrap();

        assert!(update.injected.is_empty());
        assert!(std::fs::symlink_metadata(temp.path().join(SKILLS_DIR))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(
                temp.path()
                    .join(SKILLS_DIR)
                    .join("symphony-workpad/SKILL.md")
            )
            .unwrap(),
            "repo-owned shared skill"
        );
        assert_eq!(
            git_stdout(temp.path(), &["status", "--short", "--", SKILLS_DIR]).trim(),
            ""
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_injection_preserves_tracked_canonical_skill_entry_symlink() {
        let temp = tempfile::tempdir().unwrap();
        run_git(temp.path(), &["init"]);
        let shared = temp.path().join("shared/symphony-workpad");
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::write(shared.join("SKILL.md"), "repo-owned entry skill").unwrap();
        std::fs::create_dir_all(temp.path().join(SKILLS_DIR)).unwrap();
        std::os::unix::fs::symlink(
            "../../shared/symphony-workpad",
            temp.path().join(SKILLS_DIR).join("symphony-workpad"),
        )
        .unwrap();
        run_git(
            temp.path(),
            &[
                "add",
                "shared/symphony-workpad/SKILL.md",
                ".agents/skills/symphony-workpad",
            ],
        );
        commit_staged(temp.path(), "track shared skill entry symlink");
        let skills = vec![SkillFile {
            name: "symphony-workpad".to_string(),
            content: "bundled workpad".to_string(),
        }];

        let update = ensure_workspace_skills(temp.path(), &skills).await.unwrap();

        assert!(update.injected.is_empty());
        assert!(
            std::fs::symlink_metadata(temp.path().join(SKILLS_DIR).join("symphony-workpad"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            std::fs::read_to_string(
                temp.path()
                    .join(SKILLS_DIR)
                    .join("symphony-workpad/SKILL.md")
            )
            .unwrap(),
            "repo-owned entry skill"
        );
        assert_eq!(
            git_stdout(
                temp.path(),
                &["status", "--short", "--", ".agents/skills/symphony-workpad"]
            )
            .trim(),
            ""
        );
    }

    #[tokio::test]
    async fn local_injection_adds_missing_claude_entries_without_replacing_existing() {
        let temp = tempfile::tempdir().unwrap();
        run_git(temp.path(), &["init"]);
        for (name, body) in [
            ("symphony-commit", "repo-owned commit"),
            ("symphony-workpad", "repo-owned workpad"),
        ] {
            let dir = temp.path().join(SKILLS_DIR).join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), body).unwrap();
        }
        run_git(temp.path(), &["add", ".agents/skills"]);
        let existing_discovery = temp.path().join(CLAUDE_SKILLS_DIR).join("symphony-commit");
        std::fs::create_dir_all(&existing_discovery).unwrap();
        std::fs::write(existing_discovery.join("SKILL.md"), "custom discovery").unwrap();
        run_git(temp.path(), &["add", ".agents/skills", CLAUDE_SKILLS_DIR]);
        commit_staged(temp.path(), "track repo skills and claude entry");
        let skills = vec![
            SkillFile {
                name: "symphony-commit".to_string(),
                content: "bundled commit".to_string(),
            },
            SkillFile {
                name: "symphony-workpad".to_string(),
                content: "bundled workpad".to_string(),
            },
        ];

        let update = ensure_workspace_skills(temp.path(), &skills).await.unwrap();

        assert!(update.injected.is_empty());
        assert_eq!(
            std::fs::read_to_string(existing_discovery.join("SKILL.md")).unwrap(),
            "custom discovery"
        );
        assert_eq!(
            std::fs::read_to_string(
                temp.path()
                    .join(CLAUDE_SKILLS_DIR)
                    .join("symphony-workpad/SKILL.md")
            )
            .unwrap(),
            "repo-owned workpad"
        );
        let exclude = std::fs::read_to_string(temp.path().join(".git/info/exclude")).unwrap();
        assert!(exclude.contains("/.claude/skills/symphony-workpad"));
        assert!(!exclude.contains("/.claude/skills/symphony-commit\n"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_injection_preserves_tracked_claude_discovery_link() {
        let temp = tempfile::tempdir().unwrap();
        run_git(temp.path(), &["init"]);
        let canonical = temp.path().join(SKILLS_DIR).join("symphony-workpad");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::write(canonical.join("SKILL.md"), "repo-owned workpad").unwrap();
        std::fs::create_dir_all(temp.path().join(CLAUDE_DIR)).unwrap();
        std::os::unix::fs::symlink(
            claude_skills_symlink_target(),
            temp.path().join(CLAUDE_SKILLS_DIR),
        )
        .unwrap();
        run_git(
            temp.path(),
            &[
                "add",
                ".agents/skills/symphony-workpad/SKILL.md",
                CLAUDE_SKILLS_DIR,
            ],
        );
        commit_staged(temp.path(), "track claude discovery link");
        let skills = vec![SkillFile {
            name: "symphony-workpad".to_string(),
            content: "bundled workpad".to_string(),
        }];

        let update = ensure_workspace_skills(temp.path(), &skills).await.unwrap();

        assert!(update.excluded_paths.is_empty());
        assert_eq!(
            std::fs::read_link(temp.path().join(CLAUDE_SKILLS_DIR)).unwrap(),
            claude_skills_symlink_target()
        );
        assert_eq!(
            git_stdout(temp.path(), &["status", "--short", "--", CLAUDE_SKILLS_DIR]).trim(),
            ""
        );
    }

    #[tokio::test]
    async fn local_injection_refreshes_and_unstages_staged_fallback_files() {
        let temp = tempfile::tempdir().unwrap();
        run_git(temp.path(), &["init"]);
        commit_staged(temp.path(), "base");
        let staged = temp.path().join(SKILLS_DIR).join("symphony-workpad");
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("SKILL.md"), "staged stale fallback").unwrap();
        run_git(
            temp.path(),
            &["add", ".agents/skills/symphony-workpad/SKILL.md"],
        );
        let skills = vec![SkillFile {
            name: "symphony-workpad".to_string(),
            content: "bundled workpad".to_string(),
        }];

        let update = ensure_workspace_skills(temp.path(), &skills).await.unwrap();

        assert_eq!(update.injected, vec!["symphony-workpad"]);
        assert_eq!(
            std::fs::read_to_string(staged.join("SKILL.md")).unwrap(),
            "bundled workpad"
        );
        assert_eq!(
            git_stdout(
                temp.path(),
                &[
                    "diff",
                    "--cached",
                    "--name-only",
                    "--",
                    ".agents/skills/symphony-workpad/SKILL.md"
                ]
            )
            .trim(),
            ""
        );
        assert_eq!(
            git_stdout(
                temp.path(),
                &[
                    "status",
                    "--short",
                    "--",
                    ".agents/skills/symphony-workpad/SKILL.md"
                ]
            )
            .trim(),
            ""
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_injection_preserves_tracked_top_level_claude_symlink() {
        let temp = tempfile::tempdir().unwrap();
        run_git(temp.path(), &["init"]);
        let shared = temp.path().join("shared-claude");
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::write(shared.join("settings.json"), "{}").unwrap();
        std::os::unix::fs::symlink("shared-claude", temp.path().join(CLAUDE_DIR)).unwrap();
        run_git(
            temp.path(),
            &["add", "shared-claude/settings.json", CLAUDE_DIR],
        );
        commit_staged(temp.path(), "track claude symlink");
        let skills = vec![SkillFile {
            name: "symphony-workpad".to_string(),
            content: "bundled workpad".to_string(),
        }];

        let update = ensure_workspace_skills(temp.path(), &skills).await.unwrap();

        assert_eq!(update.injected, vec!["symphony-workpad"]);
        assert_eq!(
            std::fs::read_link(temp.path().join(CLAUDE_DIR)).unwrap(),
            PathBuf::from("shared-claude")
        );
        assert_eq!(
            std::fs::read_to_string(
                temp.path()
                    .join(SKILLS_DIR)
                    .join("symphony-workpad/SKILL.md")
            )
            .unwrap(),
            "bundled workpad"
        );
        let exclude = std::fs::read_to_string(temp.path().join(".git/info/exclude")).unwrap();
        assert!(!exclude.contains("/.claude"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_injection_unstages_existing_claude_discovery_link() {
        let temp = tempfile::tempdir().unwrap();
        run_git(temp.path(), &["init"]);
        commit_staged(temp.path(), "base");
        std::fs::create_dir_all(temp.path().join(CLAUDE_DIR)).unwrap();
        std::os::unix::fs::symlink(
            claude_skills_symlink_target(),
            temp.path().join(CLAUDE_SKILLS_DIR),
        )
        .unwrap();
        run_git(temp.path(), &["add", CLAUDE_SKILLS_DIR]);
        let skills = vec![SkillFile {
            name: "symphony-workpad".to_string(),
            content: "bundled workpad".to_string(),
        }];

        let update = ensure_workspace_skills(temp.path(), &skills).await.unwrap();

        assert!(update
            .excluded_paths
            .contains(&format!("/{CLAUDE_SKILLS_DIR}")));
        assert_eq!(
            git_stdout(
                temp.path(),
                &["diff", "--cached", "--name-only", "--", CLAUDE_SKILLS_DIR]
            )
            .trim(),
            ""
        );
    }

    #[tokio::test]
    async fn local_injection_refreshes_untracked_claude_discovery_entries() {
        let temp = tempfile::tempdir().unwrap();
        run_git(temp.path(), &["init"]);
        commit_staged(temp.path(), "base");
        let stale = temp.path().join(CLAUDE_SKILLS_DIR).join("symphony-workpad");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("SKILL.md"), "stale discovery").unwrap();
        let skills = vec![SkillFile {
            name: "symphony-workpad".to_string(),
            content: "bundled workpad".to_string(),
        }];

        let update = ensure_workspace_skills(temp.path(), &skills).await.unwrap();

        assert_eq!(
            std::fs::read_to_string(stale.join("SKILL.md")).unwrap(),
            "bundled workpad"
        );
        assert!(update
            .excluded_paths
            .contains(&"/.claude/skills/symphony-workpad".to_string()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_injection_preserves_tracked_per_skill_discovery_symlink() {
        let temp = tempfile::tempdir().unwrap();
        run_git(temp.path(), &["init"]);
        let canonical = temp.path().join(SKILLS_DIR).join("symphony-workpad");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::write(canonical.join("SKILL.md"), "repo-owned workpad").unwrap();
        std::fs::create_dir_all(temp.path().join(CLAUDE_SKILLS_DIR)).unwrap();
        std::os::unix::fs::symlink(
            PathBuf::from("../..")
                .join(SKILLS_DIR)
                .join("symphony-workpad"),
            temp.path().join(CLAUDE_SKILLS_DIR).join("symphony-workpad"),
        )
        .unwrap();
        run_git(
            temp.path(),
            &[
                "add",
                ".agents/skills/symphony-workpad/SKILL.md",
                ".claude/skills/symphony-workpad",
            ],
        );
        commit_staged(temp.path(), "track per-skill claude discovery link");
        let skills = vec![SkillFile {
            name: "symphony-workpad".to_string(),
            content: "bundled workpad".to_string(),
        }];

        let update = ensure_workspace_skills(temp.path(), &skills).await.unwrap();

        assert!(update.excluded_paths.is_empty());
        assert!(std::fs::symlink_metadata(
            temp.path().join(CLAUDE_SKILLS_DIR).join("symphony-workpad")
        )
        .unwrap()
        .file_type()
        .is_symlink());
        assert_eq!(
            git_stdout(
                temp.path(),
                &["status", "--short", "--", ".claude/skills/symphony-workpad"]
            )
            .trim(),
            ""
        );
    }

    #[tokio::test]
    async fn local_injection_resolves_linked_worktree_excludes_through_git() {
        let repo = tempfile::tempdir().unwrap();
        run_git(repo.path(), &["init"]);
        commit_staged(repo.path(), "base");
        let worktree_parent = tempfile::tempdir().unwrap();
        let worktree = worktree_parent.path().join("linked");
        run_git(
            repo.path(),
            &[
                "worktree",
                "add",
                "--detach",
                worktree.to_str().unwrap(),
                "HEAD",
            ],
        );

        write_git_excludes(
            &worktree,
            &["/.agents/skills/symphony-workpad/SKILL.md".to_string()],
        )
        .await
        .unwrap();

        let exclude = git_path_stdout(&worktree, &["rev-parse", "--git-path", "info/exclude"]);
        let content = std::fs::read_to_string(&exclude).unwrap();
        assert!(content.contains(GIT_EXCLUDE_HEADER));
        assert!(content.contains("/.agents/skills/symphony-workpad/SKILL.md"));
        let fallback = worktree.join(".agents/skills/symphony-workpad");
        std::fs::create_dir_all(&fallback).unwrap();
        std::fs::write(fallback.join("SKILL.md"), "local fallback").unwrap();
        assert_eq!(
            git_stdout(
                &worktree,
                &[
                    "status",
                    "--short",
                    "--",
                    ".agents/skills/symphony-workpad/SKILL.md"
                ]
            )
            .trim(),
            ""
        );
    }

    #[test]
    fn install_run_overrides_locked_down_agent_settings() {
        let workflow = symphony_core::build_parsed_workflow(
            symphony_core::WorkflowFrontMatter {
                tracker: symphony_core::TrackerConfig {
                    api_key: "k".to_string(),
                    active_states: vec!["Todo".to_string()],
                    terminal_states: vec!["Done".to_string()],
                    ..Default::default()
                },
                codex: symphony_core::CodexConfig {
                    thread_sandbox: ThreadSandbox::ReadOnly,
                    turn_sandbox_policy: TurnSandboxPolicy::ReadOnly,
                    network_access: false,
                    ..Default::default()
                },
                claude: symphony_core::ClaudeConfig {
                    permission_mode: ClaudePermissionMode::Plan,
                    allowed_tools: vec!["Bash(npm *)".to_string()],
                    disallowed_tools: vec!["Bash(git push*)".to_string()],
                    ..Default::default()
                },
                cursor: symphony_core::CursorConfig {
                    model: Some("sonnet-4-thinking".to_string()),
                    ..Default::default()
                },
                ..Default::default()
            },
            "body".to_string(),
        );
        let config = SkillsInstallConfig {
            repo_url: "git@github.com:acme/widgets.git".to_string(),
            workspace_root: PathBuf::from("/tmp"),
            workflow,
            skills: Vec::new(),
            env: BTreeMap::new(),
            session_env: BTreeMap::new(),
        };

        let request = install_run_request(&config, Path::new("/tmp/ws"), "master");

        assert_eq!(request.thread_sandbox, ThreadSandbox::WorkspaceWrite);
        assert_eq!(
            request.turn_sandbox_policy,
            TurnSandboxPolicy::WorkspaceWrite
        );
        assert!(request.network_access);
        assert_eq!(request.claude.permission_mode, ClaudePermissionMode::Auto);
        assert!(request.claude.disallowed_tools.is_empty());
        for tool in ["Edit", "Write", "Bash(gh *)", "Bash(git push)"] {
            assert!(
                request.claude.allowed_tools.iter().any(|t| t == tool),
                "install allowlist is missing {tool}"
            );
        }
        // The user's own additions ride along rather than being dropped.
        assert!(request
            .claude
            .allowed_tools
            .iter()
            .any(|t| t == "Bash(npm *)"));
        // The configured Cursor model rides along so installs match issue runs.
        assert_eq!(request.cursor.model.as_deref(), Some("sonnet-4-thinking"));
        // The Cursor sandbox is pinned open so the install can reach the remote.
        assert_eq!(request.cursor.sandbox, CursorSandboxMode::Disabled);
        assert!(request.prompt.contains("targeting `master`"));
    }

    #[test]
    fn install_run_forwards_session_env() {
        let workflow = symphony_core::build_parsed_workflow(
            symphony_core::WorkflowFrontMatter {
                tracker: symphony_core::TrackerConfig {
                    api_key: "k".to_string(),
                    active_states: vec!["Todo".to_string()],
                    terminal_states: vec!["Done".to_string()],
                    ..Default::default()
                },
                ..Default::default()
            },
            "body".to_string(),
        );
        let config = SkillsInstallConfig {
            repo_url: "git@github.com:acme/widgets.git".to_string(),
            workspace_root: PathBuf::from("/tmp"),
            workflow,
            skills: Vec::new(),
            env: BTreeMap::from([
                (
                    "PATH".to_string(),
                    "/opt/homebrew/bin:/usr/bin:/bin".to_string(),
                ),
                ("GH_TOKEN".to_string(), "from-env".to_string()),
            ]),
            session_env: BTreeMap::from([
                ("CURSOR_API_KEY".to_string(), "test-key".to_string()),
                ("GH_TOKEN".to_string(), "from-session".to_string()),
            ]),
        };

        let request = install_run_request(&config, Path::new("/tmp/ws"), "master");
        assert!(request
            .env
            .iter()
            .any(|(key, value)| key == "CURSOR_API_KEY" && value == "test-key"));
        assert!(request
            .env
            .iter()
            .any(|(key, value)| key == "PATH" && value == "/opt/homebrew/bin:/usr/bin:/bin"));
        assert!(request
            .env
            .iter()
            .any(|(key, value)| key == "GH_TOKEN" && value == "from-session"));
    }

    #[test]
    fn install_agent_env_forwards_process_github_tokens() {
        let base = BTreeMap::from([("PATH".to_string(), "/usr/bin".to_string())]);
        let session = BTreeMap::from([("CURSOR_API_KEY".to_string(), "test-key".to_string())]);
        let env = install_agent_env_from(
            "git@github.com:acme/widgets.git",
            &base,
            &session,
            [
                ("GH_TOKEN".to_string(), "from-process".to_string()),
                ("GITHUB_TOKEN".to_string(), "fallback".to_string()),
                (
                    "GH_ENTERPRISE_TOKEN".to_string(),
                    "do-not-forward-enterprise".to_string(),
                ),
                ("LINEAR_API_KEY".to_string(), "do-not-forward".to_string()),
            ],
        )
        .into_iter()
        .collect::<BTreeMap<_, _>>();

        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(
            env.get("GH_TOKEN").map(String::as_str),
            Some("from-process")
        );
        assert!(!env.contains_key("GH_ENTERPRISE_TOKEN"));
        assert_eq!(
            env.get("CURSOR_API_KEY").map(String::as_str),
            Some("test-key")
        );
        assert!(!env.contains_key("LINEAR_API_KEY"));
    }

    #[test]
    fn install_agent_env_session_token_suppresses_process_precedence_tokens() {
        let base = BTreeMap::from([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("GH_TOKEN".to_string(), "stale-base".to_string()),
        ]);
        let session = BTreeMap::from([(
            "GITHUB_TOKEN".to_string(),
            "repo-scoped-session".to_string(),
        )]);
        let env = install_agent_env_from(
            "git@github.com:acme/widgets.git",
            &base,
            &session,
            [("GH_TOKEN".to_string(), "stale-process".to_string())],
        )
        .into_iter()
        .collect::<BTreeMap<_, _>>();

        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert!(!env.contains_key("GH_TOKEN"));
        assert_eq!(
            env.get("GITHUB_TOKEN").map(String::as_str),
            Some("repo-scoped-session")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn find_pr_url_uses_install_env() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let gh = bin.join("gh");
        std::fs::write(
            &gh,
            "#!/bin/sh\n[ \"$GITHUB_TOKEN\" = repo-scoped-session ] || exit 42\nprintf 'https://github.com/acme/widgets/pull/7\\n'\n",
        )
        .unwrap();
        let mut perms = std::fs::metadata(&gh).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&gh, perms).unwrap();
        let env = vec![
            (
                "PATH".to_string(),
                format!("{}:/usr/bin:/bin", bin.display()),
            ),
            (
                "GITHUB_TOKEN".to_string(),
                "repo-scoped-session".to_string(),
            ),
        ];

        assert_eq!(
            find_pr_url(temp.path(), &env).await.as_deref(),
            Some("https://github.com/acme/widgets/pull/7")
        );
    }

    #[tokio::test]
    async fn replaces_stale_claude_discovery_entries() {
        let temp = tempfile::tempdir().unwrap();
        // A previous partial install left a real directory (not a symlink)
        // with outdated content at the discovery path.
        let stale = temp.path().join(".claude/skills/commit");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("SKILL.md"), "stale").unwrap();
        let custom = temp.path().join(".claude/skills/local");
        std::fs::create_dir_all(&custom).unwrap();
        std::fs::write(custom.join("SKILL.md"), "custom").unwrap();

        let skills = vec![SkillFile {
            name: "commit".to_string(),
            content: "fresh".to_string(),
        }];
        write_skills(temp.path(), &skills).await.unwrap();

        let discovery = temp.path().join(CLAUDE_SKILLS_DIR);
        assert!(!std::fs::symlink_metadata(&discovery)
            .unwrap()
            .file_type()
            .is_symlink());
        let link = temp.path().join(".claude/skills/commit");
        assert_eq!(
            std::fs::read_to_string(link.join("SKILL.md")).unwrap(),
            "fresh"
        );
        assert_eq!(
            std::fs::read_to_string(custom.join("SKILL.md")).unwrap(),
            "custom"
        );
        #[cfg(unix)]
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn replaces_unexpected_claude_skills_symlink() {
        let outside = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join(CLAUDE_DIR)).unwrap();
        std::os::unix::fs::symlink(outside.path(), workspace.path().join(CLAUDE_SKILLS_DIR))
            .unwrap();

        let skills = vec![SkillFile {
            name: "commit".to_string(),
            content: "fresh".to_string(),
        }];
        write_skills(workspace.path(), &skills).await.unwrap();

        let discovery = workspace.path().join(CLAUDE_SKILLS_DIR);
        assert_eq!(
            std::fs::read_link(&discovery).unwrap(),
            claude_skills_symlink_target()
        );
        assert_eq!(
            std::fs::read_to_string(discovery.join("commit/SKILL.md")).unwrap(),
            "fresh"
        );
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_to_write_through_hostile_symlinks() {
        let outside = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        // A malicious clone tracks `.agents` as a symlink escaping the
        // workspace, and a manifest symlink pointing at a victim file.
        std::os::unix::fs::symlink(outside.path(), workspace.path().join(".agents")).unwrap();
        let victim = outside.path().join("victim.md");
        std::fs::write(&victim, "untouched").unwrap();
        let claude_dir = workspace.path().join(".claude/skills/commit");
        std::fs::create_dir_all(&claude_dir).unwrap();

        let skills = vec![SkillFile {
            name: "commit".to_string(),
            content: "fresh".to_string(),
        }];
        write_skills(workspace.path(), &skills).await.unwrap();

        // Nothing escaped: the outside dir holds only the victim file, and
        // the skills landed inside the workspace in a real directory.
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "untouched");
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 1);
        let agents = workspace.path().join(".agents");
        assert!(!std::fs::symlink_metadata(&agents)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(agents.join("skills/commit/SKILL.md")).unwrap(),
            "fresh"
        );

        // Second scenario: only the manifest itself is a hostile symlink.
        let manifest = workspace.path().join(".agents/skills/commit/SKILL.md");
        std::fs::remove_file(&manifest).unwrap();
        std::os::unix::fs::symlink(&victim, &manifest).unwrap();
        write_skills(workspace.path(), &skills).await.unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "untouched");
        assert_eq!(std::fs::read_to_string(&manifest).unwrap(), "fresh");
    }

    #[tokio::test]
    async fn installer_reports_idle_then_rejects_concurrent_start() {
        let installer = SkillsInstaller::new();
        assert_eq!(installer.status().await.state, SkillsInstallState::Idle);

        {
            let mut guard = installer.inner.lock().await;
            *guard = Some(SkillsInstallStatus {
                state: SkillsInstallState::Running,
                repo_url: None,
                message: None,
                pr_url: None,
                error: None,
            });
        }
        let config = SkillsInstallConfig {
            repo_url: "git@github.com:acme/widgets.git".to_string(),
            workspace_root: PathBuf::from("/tmp"),
            workflow: symphony_core::build_parsed_workflow(
                symphony_core::WorkflowFrontMatter {
                    tracker: symphony_core::TrackerConfig {
                        api_key: "k".to_string(),
                        active_states: vec!["Todo".to_string()],
                        terminal_states: vec!["Done".to_string()],
                        ..Default::default()
                    },
                    ..Default::default()
                },
                "body".to_string(),
            ),
            skills: Vec::new(),
            env: BTreeMap::new(),
            session_env: BTreeMap::new(),
        };
        assert!(matches!(
            installer.start(config).await,
            Err(SkillsError::AlreadyRunning)
        ));
    }
}
