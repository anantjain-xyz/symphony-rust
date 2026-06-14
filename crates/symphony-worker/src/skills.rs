//! Symphony agent skills: detect whether the target repo ships them, and
//! install them via a one-off bootstrap agent session that opens a PR.
//!
//! Detection talks to GitHub through the `gh` CLI (the same dependency every
//! skill assumes), so it works without a local checkout. Installation clones
//! the repo into a throwaway workspace, writes the bundled skill files
//! deterministically, then hands off to the configured agent backend to adapt
//! the validation-gate commands to the repo's toolchain and open the PR.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use symphony_agents::{AgentDriver, AgentRunRequest, ClaudeRunOptions, NativeAgentDriver};
use symphony_core::{
    AgentBackend, AgentOutcome, ClaudePermissionMode, ParsedWorkflow, ThreadSandbox,
    TurnSandboxPolicy,
};
use thiserror::Error;
use tokio::{process::Command, sync::Mutex};
use tokio_util::sync::CancellationToken;
use tracing::{error, info};

/// Canonical, runner-agnostic skill location in the target repo.
pub const SKILLS_DIR: &str = ".agents/skills";
/// Claude Code auto-discovery location; entries are symlinks into SKILLS_DIR.
pub const CLAUDE_SKILLS_DIR: &str = ".claude/skills";
/// Branch the bootstrap session pushes; detection also looks for an open PR
/// from this branch so the UI can show "install in review".
pub const INSTALL_BRANCH: &str = "symphony/install-skills";

const INSTALL_WORKSPACE_KEY: &str = "_skills-install";

#[derive(Debug, Error)]
pub enum SkillsError {
    #[error("a skills install is already running")]
    AlreadyRunning,
}

/// One bundled skill: `name` is the directory under `.agents/skills/`,
/// `content` the full SKILL.md body.
#[derive(Debug, Clone)]
pub struct SkillFile {
    pub name: String,
    pub content: String,
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
struct GithubRemote {
    host: String,
    owner: String,
    name: String,
}

impl GithubRemote {
    fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }

    fn gh_repo_arg(&self) -> String {
        if self.host == "github.com" {
            self.slug()
        } else {
            format!("{}/{}", self.host, self.slug())
        }
    }

    fn auth_hint(&self) -> String {
        if self.host == "github.com" {
            "`gh auth status`".to_string()
        } else {
            format!("`gh auth status --hostname {}`", self.host)
        }
    }
}

#[cfg(test)]
fn parse_github_repo(url: &str) -> Option<String> {
    parse_github_remote(url).map(|remote| remote.slug())
}

/// Extract the GitHub host and `owner/repo` from github.com or GHE.com remote
/// URL forms users paste into Settings.
fn parse_github_remote(url: &str) -> Option<GithubRemote> {
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
    let host = host.trim_end_matches('.').to_ascii_lowercase();
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

fn parse_scp_like_remote(url: &str) -> Option<(&str, &str)> {
    let (user_and_host, rest) = url.split_once(':')?;
    let (_, host) = user_and_host.rsplit_once('@')?;
    Some((host, rest))
}

fn is_supported_github_host(host: &str) -> bool {
    host == "github.com" || host == "ghe.com" || host.ends_with(".ghe.com")
}

/// Check the repo's default branch for the bundled skills without cloning.
///
/// One GraphQL call resolves `.agents/skills/` and each child's entries, so a
/// skill only counts as present when `<name>/SKILL.md` actually exists — a
/// directory listing alone would accept partial or corrupt installs. It also
/// keeps "repo not accessible" (bad URL, missing gh auth) distinct from
/// "skills missing": only the latter should offer the install PR.
pub async fn check_skills(repo_url: &str, skill_names: &[String]) -> SkillsStatus {
    if repo_url.trim().is_empty() {
        return SkillsStatus::unavailable("No repository configured.");
    }
    let Some(remote) = parse_github_remote(repo_url) else {
        return SkillsStatus::unavailable(
            "Skill detection needs a github.com or GHE.com repository URL.",
        );
    };
    let repo_arg = remote.gh_repo_arg();

    let query = format!(
        r#"query {{ repository(owner: "{}", name: "{}") {{ object(expression: "HEAD:{SKILLS_DIR}") {{ ... on Tree {{ entries {{ name type object {{ ... on Tree {{ entries {{ name type }} }} }} }} }} }} }} }}"#,
        remote.owner, remote.name
    );
    let listing = run_shell(
        None,
        &format!(
            "gh api graphql --hostname {} -f query={}",
            shell_quote(&remote.host),
            shell_quote(&query)
        ),
    )
    .await;
    let present: Vec<String> = match listing {
        Ok(output) if output.status.success() => {
            match skills_with_manifest(&String::from_utf8_lossy(&output.stdout)) {
                Ok(present) => present,
                Err(err) => {
                    return SkillsStatus::unavailable(format!(
                        "Could not parse the GitHub response: {err}"
                    ))
                }
            }
        }
        Ok(output) => {
            if output.status.code() == Some(127) {
                return SkillsStatus::unavailable(
                    "GitHub CLI (gh) not found. Install it to enable skill detection.",
                );
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("Could not resolve to a Repository") {
                return SkillsStatus::unavailable(format!(
                    "Could not access {repo_arg}. Check the repo URL and {}.",
                    remote.auth_hint()
                ));
            }
            return SkillsStatus::unavailable(format!(
                "Could not check {repo_arg}: {}",
                tail(&stderr, 200)
            ));
        }
        Err(err) => return SkillsStatus::unavailable(format!("Could not run gh: {err}")),
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
    let workspace = config.workspace_root.join(INSTALL_WORKSPACE_KEY);
    tokio::fs::remove_dir_all(&workspace).await.ok();
    tokio::fs::create_dir_all(&workspace)
        .await
        .map_err(|err| format!("could not create workspace: {err}"))?;

    set_message(inner, "Cloning repository…").await;
    let clone = run_shell(
        Some(&workspace),
        &format!("git clone --depth 1 {} .", shell_quote(&config.repo_url)),
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
    let request = install_run_request(&config, &workspace);

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
        AgentOutcome::Success => match find_pr_url(&workspace).await {
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
fn install_run_request(config: &SkillsInstallConfig, workspace: &Path) -> AgentRunRequest {
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
        },
        cwd: workspace.to_path_buf(),
        prompt: install_prompt(&config.repo_url, &config.skills),
        thread_sandbox: ThreadSandbox::WorkspaceWrite,
        turn_sandbox_policy: TurnSandboxPolicy::WorkspaceWrite,
        network_access: true,
        turn_timeout_ms: match backend {
            AgentBackend::Codex => front.codex.turn_timeout_ms,
            AgentBackend::Claude => front.claude.turn_timeout_ms,
        },
        claude: ClaudeRunOptions {
            permission_mode: ClaudePermissionMode::Auto,
            allowed_tools,
            disallowed_tools: Vec::new(),
            add_dirs: front.claude.add_dirs.clone(),
            session_id: None,
        },
        env: Vec::new(),
    }
}

/// Remove whatever exists at `path` — file, directory, or symlink — without
/// following links. Missing paths are fine.
async fn remove_existing(path: &Path) -> std::io::Result<()> {
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

async fn write_skills(workspace: &Path, skills: &[SkillFile]) -> std::io::Result<()> {
    // The clone is untrusted input: any level of either skills path could be
    // a symlink pointing outside the workspace, so each is normalized to a
    // real directory before anything is written.
    ensure_real_dir_all(workspace, Path::new(SKILLS_DIR)).await?;
    ensure_real_dir_all(workspace, Path::new(CLAUDE_SKILLS_DIR)).await?;
    for skill in skills {
        let dir = workspace.join(SKILLS_DIR).join(&skill.name);
        ensure_real_dir(&dir).await?;
        let manifest = dir.join("SKILL.md");
        remove_existing(&manifest).await?;
        tokio::fs::write(&manifest, &skill.content).await?;

        let link = workspace.join(CLAUDE_SKILLS_DIR).join(&skill.name);
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

/// Best-effort PR URL lookup for the branch the agent pushed.
async fn find_pr_url(workspace: &Path) -> Option<String> {
    let output = run_shell(
        Some(workspace),
        &format!(
            "gh pr list --head {} --state open --json url --jq '.[0].url'",
            shell_quote(INSTALL_BRANCH)
        ),
    )
    .await
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!url.is_empty()).then_some(url)
}

fn install_prompt(repo_url: &str, skills: &[SkillFile]) -> String {
    let names = skills
        .iter()
        .map(|skill| skill.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"You are bootstrapping Symphony's agent skills in this repository so Symphony-dispatched agents can use them.

This workspace is a fresh clone of {repo_url}. The skill files have already been written to `{skills_dir}/<name>/SKILL.md`, with `{claude_dir}/<name>` symlinks for Claude Code auto-discovery: {names}.

Do the following, in order:

1. Detect this repo's real toolchain and validation commands (check package.json scripts, Cargo.toml, Makefile, CI workflows). The skill files assume `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` as the validation gate (referenced in the `symphony-pull` and `symphony-push` skills). Replace that gate with this repo's actual equivalents; if the repo has no such commands, use the closest meaningful subset. Do not change anything else in the skill files — the procedures are canonical.
2. Create a branch named `{branch}`, stage only the new skill files and symlinks, and commit with the message "Add Symphony agent skills".
3. Push the branch to origin and open a pull request titled "Install Symphony agent skills". In the description, briefly explain that these are procedural guides Symphony-dispatched agents follow (committing, syncing, pushing, PR feedback, screenshots, merging, and Linear workpad updates) and list any validation commands you adapted for this repo. If a PR for this branch already exists, update it instead of opening a duplicate.

Rules:
- Only add files under `{skills_dir}/` and `{claude_dir}/`; do not modify any other files.
- Never force-push, never use --no-verify, never rewrite history.
- This is unattended: do not ask a human anything.
- End your final message with the PR URL on its own line."#,
        repo_url = repo_url,
        skills_dir = SKILLS_DIR,
        claude_dir = CLAUDE_SKILLS_DIR,
        names = names,
        branch = INSTALL_BRANCH,
    )
}

async fn run_shell(dir: Option<&Path>, script: &str) -> std::io::Result<std::process::Output> {
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-lc").arg(script);
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    cmd.output().await
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn tail(value: &str, max: usize) -> String {
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
        let prompt = install_prompt("git@github.com:acme/widgets.git", &skills);
        assert!(prompt.contains("symphony-workpad, symphony-push"));
        assert!(prompt.contains(INSTALL_BRANCH));
        assert!(prompt.contains(SKILLS_DIR));
        assert!(prompt.contains("never use --no-verify"));
    }

    #[tokio::test]
    async fn writes_skill_files_and_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let skills = vec![SkillFile {
            name: "commit".to_string(),
            content: "body".to_string(),
        }];
        write_skills(temp.path(), &skills).await.unwrap();

        let canonical = temp.path().join(".agents/skills/commit/SKILL.md");
        assert_eq!(std::fs::read_to_string(&canonical).unwrap(), "body");
        let link = temp.path().join(".claude/skills/commit");
        assert_eq!(
            std::fs::read_to_string(link.join("SKILL.md")).unwrap(),
            "body"
        );
        #[cfg(unix)]
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
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
                ..Default::default()
            },
            "body".to_string(),
        );
        let config = SkillsInstallConfig {
            repo_url: "git@github.com:acme/widgets.git".to_string(),
            workspace_root: PathBuf::from("/tmp"),
            workflow,
            skills: Vec::new(),
        };

        let request = install_run_request(&config, Path::new("/tmp/ws"));

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
    }

    #[tokio::test]
    async fn replaces_stale_claude_discovery_entries() {
        let temp = tempfile::tempdir().unwrap();
        // A previous partial install left a real directory (not a symlink)
        // with outdated content at the discovery path.
        let stale = temp.path().join(".claude/skills/commit");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("SKILL.md"), "stale").unwrap();

        let skills = vec![SkillFile {
            name: "commit".to_string(),
            content: "fresh".to_string(),
        }];
        write_skills(temp.path(), &skills).await.unwrap();

        let link = temp.path().join(".claude/skills/commit");
        assert_eq!(
            std::fs::read_to_string(link.join("SKILL.md")).unwrap(),
            "fresh"
        );
        #[cfg(unix)]
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
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
        };
        assert!(matches!(
            installer.start(config).await,
            Err(SkillsError::AlreadyRunning)
        ));
    }
}
