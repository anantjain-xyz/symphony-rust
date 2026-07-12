use crate::skills::{
    clone_default_branch_command, gh_auth_status, github_graphql, github_open_pr_url,
    github_token_for_host, install_agent_env, parse_github_remote, remove_existing,
    resolve_default_branch_with_env, run_shell, run_shell_with_env, shell_quote, tail,
    GhAuthStatus,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Output,
    sync::Arc,
    time::Duration,
};
use symphony_core::validate_prompt_template;
use tokio::{process::Command, sync::Mutex};
use tokio_util::sync::CancellationToken;

pub const WORKFLOW_FILE: &str = "SYMPHONY-WORKFLOW.md";
pub const WORKFLOW_FILE_LOWER: &str = "symphony-workflow.md";
const WORKFLOW_CACHE_REF: &str = "refs/symphony/workflow-default";
pub const WORKFLOW_TRANSFER_BRANCH: &str = "symphony/install-workflow";
const WORKFLOW_ACTIONS_DIR: &str = ".symphony-actions";
const WORKFLOW_TRANSFER_WORKSPACE: &str = "workflow-transfer";
const WORKFLOW_FETCH_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepoWorkflowSource {
    Repository,
    Default,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct RepoWorkflowStatus {
    pub source: RepoWorkflowSource,
    pub filename: Option<String>,
    pub fallback_reason: Option<String>,
    pub detail: Option<String>,
    pub pr_url: Option<String>,
    pub can_transfer: bool,
}

impl RepoWorkflowStatus {
    fn unknown(detail: impl Into<String>) -> Self {
        Self {
            source: RepoWorkflowSource::Unknown,
            filename: None,
            fallback_reason: Some("unavailable".to_string()),
            detail: Some(detail.into()),
            pr_url: None,
            can_transfer: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRepoWorkflow {
    pub prompt_template: String,
    pub source: RepoWorkflowSource,
    pub filename: Option<String>,
    pub revision: Option<String>,
    pub detail: Option<String>,
    pub cached: bool,
}

impl ResolvedRepoWorkflow {
    fn default(prompt_template: &str, detail: impl Into<String>) -> Self {
        Self {
            prompt_template: prompt_template.to_string(),
            source: RepoWorkflowSource::Default,
            filename: None,
            revision: None,
            detail: Some(detail.into()),
            cached: false,
        }
    }
}

/// Resolve the workflow on the configured repository's default branch without
/// checking out or otherwise touching the issue branch. A private ref keeps a
/// last-known-good default-branch snapshot for transient network failures.
pub async fn resolve_repo_workflow(
    workspace: &Path,
    repo_url: &str,
    default_prompt: &str,
    cancel: &CancellationToken,
) -> ResolvedRepoWorkflow {
    let timeout = WORKFLOW_FETCH_TIMEOUT;
    let default_branch = git_output(
        workspace,
        ["ls-remote", "--symref", repo_url, "HEAD"],
        timeout,
        cancel,
    )
    .await
    .ok()
    .filter(|output| output.status.success())
    .and_then(|output| default_branch_from_ls_remote(&output.stdout));

    let refreshed = if let Some(branch) = default_branch.as_deref() {
        let source = format!("refs/heads/{branch}");
        let refspec = format!("+{source}:{WORKFLOW_CACHE_REF}");
        git_output(
            workspace,
            ["fetch", "--no-tags", "--depth", "1", repo_url, &refspec],
            timeout,
            cancel,
        )
        .await
        .is_ok_and(|output| output.status.success())
    } else {
        false
    };

    if refreshed {
        return resolve_at_ref(
            workspace,
            WORKFLOW_CACHE_REF,
            default_prompt,
            timeout,
            cancel,
            false,
        )
        .await;
    }

    if git_ref_exists(workspace, WORKFLOW_CACHE_REF, timeout, cancel).await {
        let mut resolved = resolve_at_ref(
            workspace,
            WORKFLOW_CACHE_REF,
            default_prompt,
            timeout,
            cancel,
            true,
        )
        .await;
        resolved.cached = true;
        resolved.detail = Some(match resolved.source {
            RepoWorkflowSource::Repository => {
                "Could not refresh the default branch; using the cached repository workflow."
                    .to_string()
            }
            _ => {
                "Could not refresh the default branch; the cached branch uses the default workflow."
                    .to_string()
            }
        });
        return resolved;
    }

    if let Some(origin_ref) = origin_head_ref(workspace, timeout, cancel).await {
        let mut resolved = resolve_at_ref(
            workspace,
            &origin_ref,
            default_prompt,
            timeout,
            cancel,
            true,
        )
        .await;
        resolved.cached = true;
        resolved.detail = Some(match resolved.source {
            RepoWorkflowSource::Repository => {
                "Could not refresh the default branch; using the clone's cached repository workflow."
                    .to_string()
            }
            _ => "Could not refresh the default branch; the clone's default branch uses the default workflow."
                .to_string(),
        });
        return resolved;
    }

    ResolvedRepoWorkflow::default(
        default_prompt,
        "Could not read the repository default branch; using the default workflow.",
    )
}

/// Resolve a workflow from an already cloned repository snapshot. Retro uses
/// this to materialize diffs against the exact default-branch revision it
/// records for staleness checks.
pub async fn resolve_repo_workflow_at_ref(
    workspace: &Path,
    reference: &str,
    default_prompt: &str,
) -> ResolvedRepoWorkflow {
    resolve_at_ref(
        workspace,
        reference,
        default_prompt,
        Duration::from_secs(60),
        &CancellationToken::new(),
        false,
    )
    .await
}

/// Inspect the GitHub/GHE default branch without cloning so Settings can show
/// the effective source for every repository card.
pub async fn check_repo_workflow(
    repo_url: &str,
    session_env: &BTreeMap<String, String>,
) -> RepoWorkflowStatus {
    if repo_url.trim().is_empty() {
        return RepoWorkflowStatus::unknown("No repository configured.");
    }
    let Some(remote) = parse_github_remote(repo_url) else {
        return RepoWorkflowStatus::unknown(
            "Workflow status needs a github.com or GHE.com repository URL.",
        );
    };
    let query = format!(
        r#"query {{ repository(owner: "{}", name: "{}") {{ root: object(expression: "HEAD:") {{ ... on Tree {{ entries {{ name type mode }} }} }} upper: object(expression: "HEAD:{WORKFLOW_FILE}") {{ ... on Blob {{ text isBinary }} }} lower: object(expression: "HEAD:{WORKFLOW_FILE_LOWER}") {{ ... on Blob {{ text isBinary }} }} }} }}"#,
        remote.owner, remote.name
    );
    let auth = gh_auth_status(&remote.host).await;
    if auth == GhAuthStatus::MissingCli {
        return RepoWorkflowStatus::unknown(
            "GitHub CLI (gh) not found. Install it to enable workflow detection.",
        );
    }
    let token = github_token_for_host(&remote.host, session_env);
    let listing = if auth == GhAuthStatus::Authenticated {
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
            Ok(output) if output.status.success() => {
                String::from_utf8_lossy(&output.stdout).to_string()
            }
            Ok(output) => {
                if let Some(token) = token.as_deref() {
                    match github_graphql(&remote, token, &query).await {
                        Ok(body) => body,
                        Err(error) => {
                            return RepoWorkflowStatus::unknown(format!(
                                "Could not inspect {}. {error}",
                                remote.gh_repo_arg()
                            ))
                        }
                    }
                } else {
                    return RepoWorkflowStatus::unknown(format!(
                        "Could not inspect {}: {}",
                        remote.gh_repo_arg(),
                        tail(&String::from_utf8_lossy(&output.stderr), 250)
                    ));
                }
            }
            Err(error) => return RepoWorkflowStatus::unknown(format!("Could not run gh: {error}")),
        }
    } else if let Some(token) = token.as_deref() {
        match github_graphql(&remote, token, &query).await {
            Ok(body) => body,
            Err(error) => return RepoWorkflowStatus::unknown(error),
        }
    } else {
        return RepoWorkflowStatus::unknown(format!(
            "Could not access {}. Check the repo URL and {}.",
            remote.gh_repo_arg(),
            remote.auth_hint()
        ));
    };

    let mut status = workflow_status_from_github_listing(&listing);
    if status.source != RepoWorkflowSource::Default {
        return status;
    }

    status.pr_url = find_open_workflow_pr(&remote, token.as_deref()).await;
    if status.pr_url.is_some() {
        status.can_transfer = false;
        return status;
    }
    let git_env = install_agent_env(repo_url, &BTreeMap::new(), session_env);
    match resolve_default_branch_with_env(repo_url, &git_env).await {
        Ok(_) => status.can_transfer = true,
        Err(error) => {
            status.can_transfer = false;
            status.detail = Some(format!(
                "The default workflow is active, but a transfer PR needs Git clone and push credentials. {error}"
            ));
        }
    }
    status
}

fn workflow_status_from_github_listing(raw: &str) -> RepoWorkflowStatus {
    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(error) => {
            return RepoWorkflowStatus::unknown(format!(
                "Could not parse the GitHub response: {error}"
            ))
        }
    };
    let repository = &value["data"]["repository"];
    let Some(entries) = repository["root"]["entries"].as_array() else {
        return RepoWorkflowStatus::unknown("GitHub did not return the repository root tree.");
    };
    let selected = entries
        .iter()
        .find(|entry| entry["name"].as_str() == Some(WORKFLOW_FILE))
        .or_else(|| {
            entries
                .iter()
                .find(|entry| entry["name"].as_str() == Some(WORKFLOW_FILE_LOWER))
        });
    let Some(entry) = selected else {
        return RepoWorkflowStatus {
            source: RepoWorkflowSource::Default,
            filename: None,
            fallback_reason: Some("missing".to_string()),
            detail: Some("No repository workflow was found on the default branch.".to_string()),
            pr_url: None,
            can_transfer: false,
        };
    };
    let filename = entry["name"].as_str().unwrap_or(WORKFLOW_FILE).to_string();
    let blob = if filename == WORKFLOW_FILE {
        &repository["upper"]
    } else {
        &repository["lower"]
    };
    let regular_mode = entry["mode"]
        .as_u64()
        .is_some_and(|mode| matches!(mode, 33_188 | 33_261))
        || entry["mode"]
            .as_str()
            .is_some_and(|mode| mode.starts_with("100"));
    let regular = entry["type"].as_str() == Some("blob") && regular_mode;
    let text = blob["text"].as_str();
    let validation = if !regular {
        Err("The selected path is not a regular file.".to_string())
    } else if blob["isBinary"].as_bool() == Some(true) || text.is_none() {
        Err("The selected file is not UTF-8 text.".to_string())
    } else {
        validate_prompt_template(text.unwrap_or_default())
    };
    match validation {
        Ok(()) => RepoWorkflowStatus {
            source: RepoWorkflowSource::Repository,
            filename: Some(filename),
            fallback_reason: None,
            detail: None,
            pr_url: None,
            can_transfer: false,
        },
        Err(error) => RepoWorkflowStatus {
            source: RepoWorkflowSource::Default,
            filename: Some(filename.clone()),
            fallback_reason: Some("invalid".to_string()),
            detail: Some(format!("{filename} is invalid: {error}")),
            pr_url: None,
            can_transfer: false,
        },
    }
}

async fn find_open_workflow_pr(
    remote: &crate::skills::GithubRemote,
    token: Option<&str>,
) -> Option<String> {
    let output = run_shell(
        None,
        &format!(
            "gh pr list --repo {} --head {} --state open --json url --jq '.[0].url'",
            shell_quote(&remote.gh_repo_arg()),
            shell_quote(WORKFLOW_TRANSFER_BRANCH)
        ),
    )
    .await
    .ok();
    if let Some(output) = output.filter(|output| output.status.success()) {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    match token {
        Some(token) => github_open_pr_url(remote, token, WORKFLOW_TRANSFER_BRANCH)
            .await
            .ok()
            .flatten(),
        None => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowTransferState {
    Idle,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct WorkflowTransferStatus {
    pub state: WorkflowTransferState,
    pub repo_url: Option<String>,
    pub message: Option<String>,
    pub pr_url: Option<String>,
    pub error: Option<String>,
}

impl WorkflowTransferStatus {
    fn idle() -> Self {
        Self {
            state: WorkflowTransferState::Idle,
            repo_url: None,
            message: None,
            pr_url: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkflowTransferConfig {
    pub repo_url: String,
    pub prompt_template: String,
    pub workspace_root: PathBuf,
    pub env: BTreeMap<String, String>,
    pub session_env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default)]
pub struct WorkflowTransferManager {
    inner: Arc<Mutex<Option<WorkflowTransferStatus>>>,
}

impl WorkflowTransferManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn status(&self) -> WorkflowTransferStatus {
        self.inner
            .lock()
            .await
            .clone()
            .unwrap_or_else(WorkflowTransferStatus::idle)
    }

    pub async fn start(
        &self,
        config: WorkflowTransferConfig,
    ) -> Result<WorkflowTransferStatus, String> {
        validate_prompt_template(&config.prompt_template)?;
        {
            let mut guard = self.inner.lock().await;
            if guard
                .as_ref()
                .is_some_and(|status| status.state == WorkflowTransferState::Running)
            {
                return Err("a workflow transfer is already running".to_string());
            }
            *guard = Some(WorkflowTransferStatus {
                state: WorkflowTransferState::Running,
                repo_url: Some(config.repo_url.clone()),
                message: Some("Preparing workspace…".to_string()),
                pr_url: None,
                error: None,
            });
        }
        let inner = self.inner.clone();
        let repo_url = config.repo_url.clone();
        tokio::spawn(async move {
            let result = run_workflow_transfer(&inner, config).await;
            let mut guard = inner.lock().await;
            *guard = Some(match result {
                Ok(pr_url) => WorkflowTransferStatus {
                    state: WorkflowTransferState::Completed,
                    repo_url: Some(repo_url),
                    message: None,
                    pr_url: Some(pr_url),
                    error: None,
                },
                Err(error) => WorkflowTransferStatus {
                    state: WorkflowTransferState::Failed,
                    repo_url: Some(repo_url),
                    message: None,
                    pr_url: None,
                    error: Some(error),
                },
            });
        });
        Ok(self.status().await)
    }
}

async fn set_transfer_message(
    inner: &Arc<Mutex<Option<WorkflowTransferStatus>>>,
    message: impl Into<String>,
) {
    if let Some(status) = inner.lock().await.as_mut() {
        if status.state == WorkflowTransferState::Running {
            status.message = Some(message.into());
        }
    }
}

async fn run_workflow_transfer(
    inner: &Arc<Mutex<Option<WorkflowTransferStatus>>>,
    config: WorkflowTransferConfig,
) -> Result<String, String> {
    set_transfer_message(inner, "Resolving default branch…").await;
    let env = install_agent_env(&config.repo_url, &config.env, &config.session_env);
    let default_branch = resolve_default_branch_with_env(&config.repo_url, &env).await?;
    let workspace = workflow_transfer_workspace(&config.workspace_root);
    tokio::fs::remove_dir_all(&workspace).await.ok();
    tokio::fs::create_dir_all(&workspace)
        .await
        .map_err(|error| format!("could not create transfer workspace: {error}"))?;
    set_transfer_message(inner, "Cloning repository…").await;
    let clone = run_shell_with_env(
        Some(&workspace),
        &clone_default_branch_command(&config.repo_url, &default_branch),
        &env,
    )
    .await
    .map_err(|error| format!("could not run git: {error}"))?;
    if !clone.status.success() {
        return Err(format!(
            "git clone failed: {}",
            tail(&String::from_utf8_lossy(&clone.stderr), 300)
        ));
    }
    let existing_pr = run_shell_with_env(
        Some(&workspace),
        &format!(
            "gh pr list --head {} --state open --json url --jq '.[0].url'",
            shell_quote(WORKFLOW_TRANSFER_BRANCH)
        ),
        &env,
    )
    .await
    .ok()
    .filter(|output| output.status.success())
    .and_then(|output| {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (!value.is_empty()).then_some(value)
    });
    let remote_ref = format!("refs/heads/{WORKFLOW_TRANSFER_BRANCH}");
    let remote_branch = run_shell_with_env(
        Some(&workspace),
        &format!("git ls-remote --heads origin {}", shell_quote(&remote_ref)),
        &env,
    )
    .await
    .map_err(|error| error.to_string())?;
    if !remote_branch.status.success() {
        return Err(format!(
            "could not inspect the existing workflow branch: {}",
            tail(&String::from_utf8_lossy(&remote_branch.stderr), 300)
        ));
    }
    if !String::from_utf8_lossy(&remote_branch.stdout)
        .trim()
        .is_empty()
    {
        let fetch = run_shell_with_env(
            Some(&workspace),
            &format!(
                "git fetch --depth 1 origin {}",
                shell_quote(WORKFLOW_TRANSFER_BRANCH)
            ),
            &env,
        )
        .await
        .map_err(|error| error.to_string())?;
        if !fetch.status.success() {
            return Err(format!(
                "could not fetch the existing workflow branch: {}",
                tail(&String::from_utf8_lossy(&fetch.stderr), 300)
            ));
        }
        let names = run_shell_with_env(
            Some(&workspace),
            "git diff --name-only HEAD FETCH_HEAD --",
            &env,
        )
        .await
        .map_err(|error| error.to_string())?;
        let content = run_shell_with_env(
            Some(&workspace),
            &format!("git show FETCH_HEAD:{}", shell_quote(WORKFLOW_FILE)),
            &env,
        )
        .await
        .map_err(|error| error.to_string())?;
        let matching = names.status.success()
            && content.status.success()
            && workflow_branch_matches(&names.stdout, &content.stdout, &config.prompt_template);
        if !matching {
            return Err(format!(
                "Remote branch `{WORKFLOW_TRANSFER_BRANCH}` already exists with different changes. Review or remove it before retrying."
            ));
        }
        if let Some(url) = existing_pr {
            return Ok(url);
        }
        let body = "Adds the saved default Symphony workflow to this repository. Once merged, Symphony will use this file for runs routed here.";
        let pr = run_shell_with_env(
            Some(&workspace),
            &format!(
                "gh pr create --base {} --head {} --title {} --body {}",
                shell_quote(&default_branch),
                shell_quote(WORKFLOW_TRANSFER_BRANCH),
                shell_quote("Add Symphony workflow"),
                shell_quote(body)
            ),
            &env,
        )
        .await
        .map_err(|error| error.to_string())?;
        if !pr.status.success() {
            return Err(format!(
                "could not create workflow PR: {}",
                tail(&String::from_utf8_lossy(&pr.stderr), 400)
            ));
        }
        return String::from_utf8_lossy(&pr.stdout)
            .lines()
            .map(str::trim)
            .find(|line| line.starts_with("http://") || line.starts_with("https://"))
            .map(str::to_string)
            .ok_or_else(|| "GitHub reported success but no PR URL was returned.".to_string());
    }
    if existing_pr.is_some() {
        return Err(format!(
            "An open workflow PR exists, but its remote branch `{WORKFLOW_TRANSFER_BRANCH}` is missing. Close the stale PR before retrying."
        ));
    }
    let existing = resolve_at_ref(
        &workspace,
        "HEAD",
        &config.prompt_template,
        Duration::from_secs(60),
        &CancellationToken::new(),
        false,
    )
    .await;
    if existing.source == RepoWorkflowSource::Repository {
        return Err(format!(
            "The repository already uses {}.",
            existing.filename.as_deref().unwrap_or(WORKFLOW_FILE)
        ));
    }

    let target = workspace.join(WORKFLOW_FILE);
    if let Ok(metadata) = tokio::fs::symlink_metadata(&target).await {
        if metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(format!(
                "Refusing to replace unsafe repository path {WORKFLOW_FILE}."
            ));
        }
    }
    set_transfer_message(inner, "Writing workflow…").await;
    remove_existing(&target)
        .await
        .map_err(|error| format!("could not prepare {WORKFLOW_FILE}: {error}"))?;
    tokio::fs::write(&target, &config.prompt_template)
        .await
        .map_err(|error| format!("could not write {WORKFLOW_FILE}: {error}"))?;

    let checkout = run_shell_with_env(
        Some(&workspace),
        &format!("git checkout -b {}", shell_quote(WORKFLOW_TRANSFER_BRANCH)),
        &env,
    )
    .await
    .map_err(|error| error.to_string())?;
    if !checkout.status.success() {
        return Err(format!(
            "could not create branch: {}",
            tail(&String::from_utf8_lossy(&checkout.stderr), 300)
        ));
    }
    let status = run_shell_with_env(
        Some(&workspace),
        "git status --porcelain --untracked-files=all",
        &env,
    )
    .await
    .map_err(|error| error.to_string())?;
    let changed = String::from_utf8_lossy(&status.stdout)
        .lines()
        .filter_map(|line| line.get(3..).map(str::to_string))
        .collect::<Vec<_>>();
    if changed != vec![WORKFLOW_FILE.to_string()] {
        return Err("The generated transfer touched unexpected repository files.".to_string());
    }

    set_transfer_message(inner, "Committing workflow…").await;
    let commit = run_shell_with_env(
        Some(&workspace),
        &format!(
            "git add -- {} && git commit -m {}",
            shell_quote(WORKFLOW_FILE),
            shell_quote("Add Symphony workflow")
        ),
        &env,
    )
    .await
    .map_err(|error| error.to_string())?;
    if !commit.status.success() {
        return Err(format!(
            "could not commit workflow: {}",
            tail(&String::from_utf8_lossy(&commit.stderr), 300)
        ));
    }

    set_transfer_message(inner, "Pushing branch and opening PR…").await;
    let push = run_shell_with_env(
        Some(&workspace),
        &format!(
            "git push -u origin {}",
            shell_quote(WORKFLOW_TRANSFER_BRANCH)
        ),
        &env,
    )
    .await
    .map_err(|error| error.to_string())?;
    if !push.status.success() {
        return Err(format!(
            "could not push workflow branch: {}",
            tail(&String::from_utf8_lossy(&push.stderr), 400)
        ));
    }
    let body = "Adds the saved default Symphony workflow to this repository. Once merged, Symphony will use this file for runs routed here.";
    let pr = run_shell_with_env(
        Some(&workspace),
        &format!(
            "gh pr create --base {} --head {} --title {} --body {}",
            shell_quote(&default_branch),
            shell_quote(WORKFLOW_TRANSFER_BRANCH),
            shell_quote("Add Symphony workflow"),
            shell_quote(body)
        ),
        &env,
    )
    .await
    .map_err(|error| error.to_string())?;
    if !pr.status.success() {
        return Err(format!(
            "could not create workflow PR: {}",
            tail(&String::from_utf8_lossy(&pr.stderr), 400)
        ));
    }
    String::from_utf8_lossy(&pr.stdout)
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("http://") || line.starts_with("https://"))
        .map(str::to_string)
        .ok_or_else(|| "GitHub reported success but no PR URL was returned.".to_string())
}

fn workflow_transfer_workspace(workspace_root: &Path) -> PathBuf {
    workspace_root
        .join(WORKFLOW_ACTIONS_DIR)
        .join(WORKFLOW_TRANSFER_WORKSPACE)
}

fn workflow_branch_matches(changed_names: &[u8], content: &[u8], prompt_template: &str) -> bool {
    String::from_utf8_lossy(changed_names).trim() == WORKFLOW_FILE
        && content == prompt_template.as_bytes()
}

async fn resolve_at_ref(
    workspace: &Path,
    reference: &str,
    default_prompt: &str,
    timeout: Duration,
    cancel: &CancellationToken,
    cached: bool,
) -> ResolvedRepoWorkflow {
    let revision = git_output(workspace, ["rev-parse", reference], timeout, cancel)
        .await
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string());

    let upper = git_tree_entry(workspace, reference, WORKFLOW_FILE, timeout, cancel).await;
    let lower = git_tree_entry(workspace, reference, WORKFLOW_FILE_LOWER, timeout, cancel).await;
    let selected = upper
        .map(|entry| (WORKFLOW_FILE, entry))
        .or_else(|| lower.map(|entry| (WORKFLOW_FILE_LOWER, entry)));
    let Some((filename, entry)) = selected else {
        return ResolvedRepoWorkflow {
            revision,
            cached,
            ..ResolvedRepoWorkflow::default(
                default_prompt,
                "No repository workflow was found; using the default workflow.",
            )
        };
    };
    if entry.kind != "blob" || !entry.mode.starts_with("100") {
        return ResolvedRepoWorkflow {
            revision,
            cached,
            ..ResolvedRepoWorkflow::default(
                default_prompt,
                format!("{filename} is not a regular file; using the default workflow."),
            )
        };
    }
    let spec = format!("{reference}:{filename}");
    let output = match git_output(workspace, ["cat-file", "-p", &spec], timeout, cancel).await {
        Ok(output) if output.status.success() => output,
        _ => {
            return ResolvedRepoWorkflow {
                revision,
                cached,
                ..ResolvedRepoWorkflow::default(
                    default_prompt,
                    format!("Could not read {filename}; using the default workflow."),
                )
            }
        }
    };
    let prompt_template = match String::from_utf8(output.stdout) {
        Ok(content) => content,
        Err(_) => {
            return ResolvedRepoWorkflow {
                revision,
                cached,
                ..ResolvedRepoWorkflow::default(
                    default_prompt,
                    format!("{filename} is not UTF-8; using the default workflow."),
                )
            }
        }
    };
    if let Err(error) = validate_prompt_template(&prompt_template) {
        return ResolvedRepoWorkflow {
            revision,
            cached,
            ..ResolvedRepoWorkflow::default(
                default_prompt,
                format!("{filename} is invalid: {error} Using the default workflow."),
            )
        };
    }
    ResolvedRepoWorkflow {
        prompt_template,
        source: RepoWorkflowSource::Repository,
        filename: Some(filename.to_string()),
        revision,
        detail: None,
        cached,
    }
}

#[derive(Debug)]
struct GitTreeEntry {
    mode: String,
    kind: String,
}

async fn git_tree_entry(
    workspace: &Path,
    reference: &str,
    path: &str,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Option<GitTreeEntry> {
    let output = git_output(
        workspace,
        ["ls-tree", reference, "--", path],
        timeout,
        cancel,
    )
    .await
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let metadata = raw.split('\t').next()?.trim();
    let mut fields = metadata.split_whitespace();
    Some(GitTreeEntry {
        mode: fields.next()?.to_string(),
        kind: fields.next()?.to_string(),
    })
}

async fn git_ref_exists(
    workspace: &Path,
    reference: &str,
    timeout: Duration,
    cancel: &CancellationToken,
) -> bool {
    git_output(
        workspace,
        ["show-ref", "--verify", "--quiet", reference],
        timeout,
        cancel,
    )
    .await
    .is_ok_and(|output| output.status.success())
}

async fn origin_head_ref(
    workspace: &Path,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Option<String> {
    let output = git_output(
        workspace,
        ["symbolic-ref", "refs/remotes/origin/HEAD"],
        timeout,
        cancel,
    )
    .await
    .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok())
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn default_branch_from_ls_remote(raw: &[u8]) -> Option<String> {
    String::from_utf8_lossy(raw).lines().find_map(|line| {
        line.strip_prefix("ref: refs/heads/")
            .and_then(|value| value.strip_suffix("\tHEAD"))
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

async fn git_output<const N: usize>(
    workspace: &Path,
    args: [&str; N],
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<Output, String> {
    let mut command = Command::new("git");
    command.args(args).current_dir(workspace).kill_on_drop(true);
    tokio::select! {
        _ = cancel.cancelled() => Err("cancelled".to_string()),
        result = tokio::time::timeout(timeout, command.output()) => match result {
            Ok(Ok(output)) => Ok(output),
            Ok(Err(error)) => Err(error.to_string()),
            Err(_) => Err("timed out".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn git_ok(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    async fn commit_file(repo: &Path, path: &str, content: &str, message: &str) {
        tokio::fs::write(repo.join(path), content).await.unwrap();
        git_ok(repo, &["add", path]).await;
        git_ok(repo, &["commit", "-m", message]).await;
    }

    #[test]
    fn parses_default_branch() {
        assert_eq!(
            default_branch_from_ls_remote(b"ref: refs/heads/release/next\tHEAD\nabc\tHEAD\n"),
            Some("release/next".to_string())
        );
    }

    #[test]
    fn transfer_workspace_uses_reserved_actions_namespace() {
        let root = Path::new("/tmp/symphony-workspaces");
        assert_eq!(
            workflow_transfer_workspace(root),
            root.join(".symphony-actions/workflow-transfer")
        );
        assert_ne!(
            workflow_transfer_workspace(root),
            root.join(WORKFLOW_TRANSFER_WORKSPACE)
        );
    }

    #[test]
    fn existing_workflow_branch_must_match_current_prompt_exactly() {
        assert!(workflow_branch_matches(
            format!("{WORKFLOW_FILE}\n").as_bytes(),
            b"current workflow\n",
            "current workflow\n"
        ));
        assert!(!workflow_branch_matches(
            format!("{WORKFLOW_FILE}\n").as_bytes(),
            b"stale workflow\n",
            "current workflow\n"
        ));
        assert!(!workflow_branch_matches(
            format!("{WORKFLOW_FILE}\nREADME.md\n").as_bytes(),
            b"current workflow\n",
            "current workflow\n"
        ));
    }

    #[test]
    fn github_listing_prefers_uppercase_and_reports_invalid_fallback() {
        let listing = serde_json::json!({
            "data": { "repository": {
                "root": { "entries": [
                    { "name": WORKFLOW_FILE_LOWER, "type": "blob", "mode": 33188 },
                    { "name": WORKFLOW_FILE, "type": "blob", "mode": 33188 }
                ]},
                "upper": { "text": "{{issue.unknown}}", "isBinary": false },
                "lower": { "text": "lower", "isBinary": false }
            }}
        });
        let status = workflow_status_from_github_listing(&listing.to_string());
        assert_eq!(status.source, RepoWorkflowSource::Default);
        assert_eq!(status.filename.as_deref(), Some(WORKFLOW_FILE));
        assert_eq!(status.fallback_reason.as_deref(), Some("invalid"));
    }

    #[tokio::test]
    async fn dispatch_uses_refreshed_default_branch_and_then_cached_copy() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let workspace = temp.path().join("workspace");
        tokio::fs::create_dir_all(&source).await.unwrap();
        git_ok(&source, &["init", "-b", "main"]).await;
        git_ok(&source, &["config", "user.name", "Symphony Test"]).await;
        git_ok(&source, &["config", "user.email", "symphony@example.com"]).await;
        commit_file(&source, WORKFLOW_FILE, "default v1\n", "initial").await;

        let clone = Command::new("git")
            .args([
                "clone",
                source.to_str().unwrap(),
                workspace.to_str().unwrap(),
            ])
            .output()
            .await
            .unwrap();
        assert!(clone.status.success());
        git_ok(&workspace, &["config", "user.name", "Symphony Test"]).await;
        git_ok(
            &workspace,
            &["config", "user.email", "symphony@example.com"],
        )
        .await;
        git_ok(&workspace, &["checkout", "-b", "issue-branch"]).await;
        commit_file(&workspace, WORKFLOW_FILE, "issue branch\n", "issue change").await;

        commit_file(&source, WORKFLOW_FILE, "default v2\n", "update default").await;
        let resolved = resolve_repo_workflow(
            &workspace,
            source.to_str().unwrap(),
            "app default",
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(resolved.source, RepoWorkflowSource::Repository);
        assert_eq!(resolved.prompt_template, "default v2\n");
        assert!(!resolved.cached);

        let unavailable = temp.path().join("source-unavailable");
        tokio::fs::rename(&source, &unavailable).await.unwrap();
        let cached = resolve_repo_workflow(
            &workspace,
            source.to_str().unwrap(),
            "app default",
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(cached.source, RepoWorkflowSource::Repository);
        assert_eq!(cached.prompt_template, "default v2\n");
        assert!(cached.cached);
    }
}
