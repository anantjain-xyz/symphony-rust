use sha2::{Digest, Sha256};
use similar::TextDiff;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
pub use symphony_contracts::{
    RetroConfidence, RetroDetail, RetroEvidence, RetroFinding, RetroRepoReport, RetroReport,
    RetroRunState, RetroSeverity, RetroStatus, RetroSuggestion, RetroSuggestionTarget,
};
use symphony_storage::{
    now_iso, AgentEventRow, Repository, RetroBatchRow, RetroInputRow, RetroRow, RetroSuggestionRow,
    RunWithIssueRow, WorkpadSnapshotRow,
};
use symphony_tracker::{TrackerClient, WorkpadComment};
use symphony_worker::{resolve_repo_workflow_at_ref, RepoWorkflowSource};
use tokio::{process::Command, sync::Mutex};

const RETRO_BEGINNING: &str = "1970-01-01T00:00:00.000Z";
pub(crate) const INTERRUPTED_RETRO_MESSAGE: &str = "Retro interrupted before completion.";
const MAX_FINDINGS_PER_REPO: usize = 8;
const MAX_EVIDENCE_PER_FINDING: usize = 5;
const RETRO_SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Default)]
pub struct RetroManager {
    inner: Arc<Mutex<Option<RetroStatus>>>,
}

#[derive(Debug, Clone)]
pub struct RetroProposalConfig {
    pub prompt_template: String,
    pub workflow_hash: String,
    pub repos: BTreeMap<String, String>,
    pub workspace_root: PathBuf,
    pub session_env: BTreeMap<String, String>,
    pub skills: BTreeMap<String, String>,
}

impl RetroManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn status(&self) -> RetroStatus {
        self.inner
            .lock()
            .await
            .clone()
            .unwrap_or_else(RetroStatus::idle)
    }

    pub async fn forget(&self, retro_id: &str) {
        let mut guard = self.inner.lock().await;
        if guard.as_ref().and_then(|status| status.retro_id.as_deref()) == Some(retro_id)
            && !matches!(
                guard.as_ref().map(|status| &status.state),
                Some(RetroRunState::Running)
            )
        {
            *guard = None;
        }
    }

    pub async fn start<T>(
        &self,
        repo: Repository,
        tracker: T,
        proposal_config: RetroProposalConfig,
    ) -> Result<RetroStatus, String>
    where
        T: TrackerClient + 'static,
    {
        {
            let mut guard = self.inner.lock().await;
            if matches!(
                guard.as_ref().map(|status| &status.state),
                Some(RetroRunState::Running)
            ) {
                return Err("a retro is already running".to_string());
            }
            *guard = Some(RetroStatus {
                state: RetroRunState::Running,
                retro_id: None,
                message: Some("Preparing retro window...".to_string()),
                report: None,
                error: None,
            });
        }

        let retro = match create_retro_window(&repo).await {
            Ok(retro) => retro,
            Err(message) => {
                let mut guard = self.inner.lock().await;
                *guard = Some(RetroStatus {
                    state: RetroRunState::Failed,
                    retro_id: None,
                    message: None,
                    report: None,
                    error: Some(message.clone()),
                });
                return Err(message);
            }
        };

        {
            let mut guard = self.inner.lock().await;
            *guard = Some(RetroStatus {
                state: RetroRunState::Running,
                retro_id: Some(retro.id.clone()),
                message: Some("Collecting runs and agent events...".to_string()),
                report: None,
                error: None,
            });
        }

        let inner = self.inner.clone();
        tokio::spawn(async move {
            let result = build_retro(
                &inner,
                repo.clone(),
                tracker,
                retro.clone(),
                proposal_config,
            )
            .await;
            let mut guard = inner.lock().await;
            match result {
                Ok(report) => {
                    let report_json = match serde_json::to_string(&report) {
                        Ok(report_json) => report_json,
                        Err(err) => {
                            let message = err.to_string();
                            repo.fail_retro(&retro.id, &message).await.ok();
                            *guard = Some(RetroStatus {
                                state: RetroRunState::Failed,
                                retro_id: Some(retro.id),
                                message: None,
                                report: None,
                                error: Some(message),
                            });
                            return;
                        }
                    };
                    if let Err(err) = repo
                        .finish_retro(
                            &retro.id,
                            &report_json,
                            report.run_count,
                            report.issue_count,
                        )
                        .await
                    {
                        *guard = Some(RetroStatus {
                            state: RetroRunState::Failed,
                            retro_id: Some(retro.id),
                            message: None,
                            report: None,
                            error: Some(err.to_string()),
                        });
                        return;
                    }
                    *guard = Some(RetroStatus {
                        state: RetroRunState::Completed,
                        retro_id: Some(report.id.clone()),
                        message: None,
                        report: Some(report),
                        error: None,
                    });
                }
                Err(message) => {
                    repo.fail_retro(&retro.id, &message).await.ok();
                    *guard = Some(RetroStatus {
                        state: RetroRunState::Failed,
                        retro_id: Some(retro.id),
                        message: None,
                        report: None,
                        error: Some(message),
                    });
                }
            }
        });

        Ok(self.status().await)
    }
}

async fn create_retro_window(repo: &Repository) -> Result<RetroRow, String> {
    repo.fail_running_retros(INTERRUPTED_RETRO_MESSAGE)
        .await
        .map_err(|err| err.to_string())?;
    let since_at = repo
        .latest_completed_retro()
        .await
        .map_err(|err| err.to_string())?
        .map(|retro| retro.until_at)
        .unwrap_or_else(|| RETRO_BEGINNING.to_string());
    let until_at = now_iso();
    repo.create_retro(&since_at, &until_at)
        .await
        .map_err(|err| err.to_string())
}

pub fn parse_report(row: &RetroRow) -> Option<RetroReport> {
    row.report_json
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
}

async fn set_message(inner: &Arc<Mutex<Option<RetroStatus>>>, message: impl Into<String>) {
    let mut guard = inner.lock().await;
    if let Some(status) = guard.as_mut() {
        if status.state == RetroRunState::Running {
            status.message = Some(message.into());
        }
    }
}

async fn build_retro<T>(
    inner: &Arc<Mutex<Option<RetroStatus>>>,
    repo: Repository,
    tracker: T,
    retro: RetroRow,
    proposal_config: RetroProposalConfig,
) -> Result<RetroReport, String>
where
    T: TrackerClient,
{
    let runs = repo
        .list_retro_runs(&retro.since_at, &retro.until_at)
        .await
        .map_err(|err| err.to_string())?;
    let run_ids = runs.iter().map(|run| run.id.clone()).collect::<Vec<_>>();
    let events = repo
        .events_for_run_ids(&run_ids)
        .await
        .map_err(|err| err.to_string())?;

    set_message(inner, "Fetching workpads from Linear...").await;
    let issue_ids = runs
        .iter()
        .map(|run| run.issue_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let previous_workpad_hashes = repo
        .previous_retro_workpad_hashes(&issue_ids, &retro.since_at)
        .await
        .map_err(|err| err.to_string())?;
    let workpads = tracker
        .fetch_workpads(&issue_ids)
        .await
        .map_err(|err| err.to_string())?;
    let mut workpad_by_issue = BTreeMap::new();
    let mut workpad_input_by_issue = BTreeMap::new();
    let mut found_workpad_issue_ids = BTreeSet::new();
    for workpad in workpads {
        let body_hash = hash_body(&workpad.body);
        let retro_hash = retro_relevant_workpad_hash(&workpad.body);
        repo.upsert_workpad_snapshot(&WorkpadSnapshotRow {
            issue_id: workpad.issue_id.clone(),
            comment_id: workpad.comment_id.clone(),
            body_hash,
            body: workpad.body.clone(),
            comment_created_at: workpad.created_at.clone(),
            comment_updated_at: workpad.updated_at.clone(),
            fetched_at: now_iso(),
        })
        .await
        .map_err(|err| err.to_string())?;
        if !workpad_existed_by(&workpad, &retro.until_at) {
            continue;
        }
        found_workpad_issue_ids.insert(workpad.issue_id.clone());
        let workpad_hash =
            workpad_hash_available_in_window(&workpad, &retro.until_at).then(|| retro_hash.clone());
        workpad_input_by_issue.insert(
            workpad.issue_id.clone(),
            (Some(workpad.comment_id.clone()), workpad_hash),
        );
        if should_inspect_workpad(
            &workpad,
            &retro_hash,
            previous_workpad_hashes.get(&workpad.issue_id),
            &retro.since_at,
            &retro.until_at,
        ) {
            workpad_by_issue.insert(workpad.issue_id.clone(), (workpad, retro_hash));
        }
    }

    set_message(inner, "Analyzing confusion patterns...").await;
    let report = analyze_retro(
        &retro,
        &runs,
        &events,
        &workpad_by_issue,
        &found_workpad_issue_ids,
    );
    let inputs = runs
        .iter()
        .map(|run| {
            let (workpad_comment_id, workpad_hash) = workpad_input_by_issue
                .get(&run.issue_id)
                .cloned()
                .unwrap_or((None, None));
            RetroInputRow {
                retro_id: retro.id.clone(),
                run_id: run.id.clone(),
                issue_id: run.issue_id.clone(),
                repo_name: run.repo_name.clone(),
                workpad_comment_id,
                workpad_hash,
            }
        })
        .collect::<Vec<_>>();
    repo.insert_retro_inputs(&inputs)
        .await
        .map_err(|err| err.to_string())?;
    set_message(inner, "Preparing reviewable changes...").await;
    let suggestions = materialize_suggestions(&retro, &report, &proposal_config).await;
    repo.insert_retro_suggestions(&suggestions)
        .await
        .map_err(|err| err.to_string())?;
    Ok(report)
}

#[derive(Debug)]
pub(crate) struct RepoSnapshot {
    pub(crate) root: PathBuf,
    pub(crate) head: String,
}

async fn materialize_suggestions(
    retro: &RetroRow,
    report: &RetroReport,
    config: &RetroProposalConfig,
) -> Vec<RetroSuggestionRow> {
    let mut rows = Vec::new();
    for repo_report in &report.repos {
        let mut seen_changes = BTreeSet::new();
        let repo_url = config.repos.get(&repo_report.repo_name).cloned();
        let needs_repo_snapshot = !repo_report.suggestions.is_empty();
        let snapshot = if needs_repo_snapshot {
            match repo_url.as_deref() {
                Some(url) => {
                    clone_repo_snapshot(
                        url,
                        &config
                            .workspace_root
                            .join("_retro-proposals")
                            .join(&retro.id)
                            .join(path_key(&repo_report.repo_name)),
                        &config.session_env,
                    )
                    .await
                }
                None => Err("Repository is no longer configured.".to_string()),
            }
        } else {
            Err("No repository snapshot needed.".to_string())
        };
        let repo_workflow = match &snapshot {
            Ok(snapshot) => Ok(resolve_repo_workflow_at_ref(
                &snapshot.root,
                &snapshot.head,
                &config.prompt_template,
            )
            .await),
            Err(error) => Err(error.clone()),
        };

        for (index, suggestion) in repo_report.suggestions.iter().enumerate() {
            let finding = repo_report.findings.get(index);
            let guidance = finding
                .map(|finding| finding.detail.clone())
                .unwrap_or_else(|| suggestion.body.clone());
            let target_type = match (&suggestion.target_type, &repo_workflow) {
                (RetroSuggestionTarget::Prompt, Ok(workflow))
                    if workflow.source == RepoWorkflowSource::Repository =>
                {
                    "repo_workflow"
                }
                (RetroSuggestionTarget::Prompt, _) => "prompt",
                (RetroSuggestionTarget::Skill, _) => "skill",
            };
            let target_path = match (&suggestion.target_type, &repo_workflow) {
                (RetroSuggestionTarget::Prompt, Ok(workflow))
                    if workflow.source == RepoWorkflowSource::Repository =>
                {
                    workflow
                        .filename
                        .clone()
                        .unwrap_or_else(|| symphony_worker::WORKFLOW_FILE.to_string())
                }
                (RetroSuggestionTarget::Prompt, _) => "Settings → Default workflow".to_string(),
                (RetroSuggestionTarget::Skill, _) => {
                    format!(".agents/skills/{}/SKILL.md", suggestion.target_id)
                }
            };
            let target_id = if target_type == "repo_workflow" {
                "repository workflow".to_string()
            } else {
                suggestion.target_id.clone()
            };
            let change_key = format!("{target_type}|{target_id}|{guidance}");
            if !seen_changes.insert(change_key) {
                continue;
            }
            let stable_key = format!(
                "{}|{}|{}|{}|{}|{}",
                retro.id, repo_report.repo_name, target_type, target_id, index, suggestion.title
            );
            let id = format!("{}-{}", retro.id, &hash_body(&stable_key)[..16]);
            let created_at = now_iso();

            let materialized = match &suggestion.target_type {
                RetroSuggestionTarget::Prompt => match (&repo_workflow, &snapshot) {
                    (Ok(workflow), Ok(snapshot))
                        if workflow.source == RepoWorkflowSource::Repository =>
                    {
                        let before = workflow.prompt_template.clone();
                        let after =
                            integrate_retro_guidance(&before, std::slice::from_ref(&guidance));
                        Ok((
                            target_path.clone(),
                            before.clone(),
                            after.clone(),
                            unified_diff(&target_path, &before, &after),
                            snapshot.head.clone(),
                            hash_body(&before),
                        ))
                    }
                    (Ok(_), Ok(_)) => {
                        let before = config.prompt_template.clone();
                        let after =
                            integrate_retro_guidance(&before, std::slice::from_ref(&guidance));
                        Ok((
                            target_path.clone(),
                            before.clone(),
                            after.clone(),
                            unified_diff(&target_path, &before, &after),
                            config.workflow_hash.clone(),
                            hash_body(&before),
                        ))
                    }
                    (Err(error), _) | (_, Err(error)) => Err(error.clone()),
                },
                RetroSuggestionTarget::Skill => match &snapshot {
                    Ok(snapshot) => match safe_repo_target(&snapshot.root, &target_path).await {
                        Ok(file_path) => match repo_relative_target(&snapshot.root, &file_path)
                            .await
                        {
                            Ok(resolved_target_path) => {
                                match read_optional_text(&file_path, &resolved_target_path).await {
                                    Ok(before) => {
                                        let seed = if before.is_empty() {
                                            config.skills.get(&suggestion.target_id).cloned()
                                        } else {
                                            Some(before.clone())
                                        };
                                        match seed {
                                            Some(seed) => {
                                                let after = integrate_retro_guidance(
                                                    &seed,
                                                    std::slice::from_ref(&guidance),
                                                );
                                                Ok((
                                                    resolved_target_path.clone(),
                                                    before.clone(),
                                                    after.clone(),
                                                    unified_diff(
                                                        &resolved_target_path,
                                                        &before,
                                                        &after,
                                                    ),
                                                    snapshot.head.clone(),
                                                    hash_body(&before),
                                                ))
                                            }
                                            None => Err(format!(
                                                "Bundled skill `{}` was not found.",
                                                suggestion.target_id
                                            )),
                                        }
                                    }
                                    Err(error) => Err(error),
                                }
                            }
                            Err(error) => Err(error),
                        },
                        Err(error) => Err(error),
                    },
                    Err(error) => Err(error.clone()),
                },
            };

            let (
                target_path,
                before_content,
                after_content,
                diff,
                base_ref,
                base_hash,
                status,
                error,
            ) = match materialized {
                Ok((_, before, after, _, _, _)) if before == after => continue,
                Ok((resolved_target_path, before, after, diff, base_ref, base_hash)) => (
                    resolved_target_path,
                    Some(before),
                    Some(after),
                    Some(diff),
                    Some(base_ref),
                    Some(base_hash),
                    "ready".to_string(),
                    None,
                ),
                Err(error) => (
                    target_path,
                    None,
                    None,
                    None,
                    None,
                    None,
                    "unavailable".to_string(),
                    Some(error),
                ),
            };
            rows.push(RetroSuggestionRow {
                id,
                retro_id: retro.id.clone(),
                repo_name: repo_report.repo_name.clone(),
                repo_url: repo_url.clone(),
                finding_index: index as i64,
                target_type: target_type.to_string(),
                target_id,
                target_path,
                title: suggestion.title.clone(),
                body: suggestion.body.clone(),
                rationale: suggestion.rationale.clone(),
                confidence: confidence_label(&suggestion.confidence).to_string(),
                guidance,
                before_content,
                after_content,
                unified_diff: diff,
                base_ref,
                base_hash,
                proposal_status: status,
                proposal_error: error,
                decision: "pending".to_string(),
                decided_at: None,
                created_at,
            });
        }
        if let Ok(snapshot) = snapshot {
            tokio::fs::remove_dir_all(snapshot.root).await.ok();
        }
    }
    rows
}

fn guidance_for(finding: &RetroFinding) -> String {
    let context = format!("{} {}", finding.title, finding.detail).to_lowercase();
    if context.contains("commands exited unsuccessfully") {
        "Handle non-zero command exits according to context: expected probe failures should be quiet, while actionable setup or validation failures must be resolved before pushing and reusable prerequisites recorded in the workpad.".to_string()
    } else if context.contains("screenshot") || context.contains("playwright") {
        "For user-facing UI changes, capture the relevant desktop and responsive states after validation, and keep only the final evidence requested by the repository workflow.".to_string()
    } else if context.contains("workpad was not found") {
        "Create or update the Symphony Workpad for every dispatched issue, recording progress, validation, and reusable confusion before completing the task.".to_string()
    } else if context.contains("approval") || context.contains("follow-up") {
        "Unattended runs must not stop for interactive approval or a follow-up question; choose a safe in-scope path and record any genuine blocker in the workpad.".to_string()
    } else if context.contains("review") || context.contains("feedback") {
        "Before completing review work, inspect all unresolved review threads, address the actionable items, and verify the resulting diff and checks.".to_string()
    } else if context.contains("test")
        || context.contains("typecheck")
        || context.contains("validation")
        || context.contains("exit")
        || context.contains("failed")
    {
        "Run the repository's required validation before pushing; if it fails, resolve the root cause and record any reusable prerequisite in the workpad.".to_string()
    } else {
        "When a recurring issue blocks progress, resolve the root cause before completing the task and record any reusable prerequisite in the workpad.".to_string()
    }
}

pub fn integrate_retro_guidance(base: &str, guidance: &[String]) -> String {
    let mut seen = BTreeSet::new();
    let additions = guidance
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty() && !base.contains(item))
        .filter(|item| seen.insert((*item).to_string()))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if additions.is_empty() {
        return base.to_string();
    }

    let had_trailing_newline = base.ends_with('\n');
    let mut lines = base.lines().map(str::to_string).collect::<Vec<_>>();
    if lines.is_empty() {
        let mut result = additions
            .iter()
            .map(|item| format!("- {item}"))
            .collect::<Vec<_>>()
            .join("\n");
        result.push('\n');
        return result;
    }

    let preferred_headings = [
        "## Instructions",
        "## Steps",
        "## Goals",
        "## Acceptance criteria & validation",
        "## Preconditions",
        "## Loop",
        "## When to run",
    ];
    let section_start = preferred_headings
        .iter()
        .find_map(|heading| lines.iter().position(|line| line.trim() == *heading))
        .or_else(|| {
            lines
                .iter()
                .position(|line| line.trim_start().starts_with("## "))
        });

    if let Some(section_start) = section_start {
        let section_end = lines[section_start + 1..]
            .iter()
            .position(|line| line.trim_start().starts_with("## "))
            .map(|offset| section_start + 1 + offset)
            .unwrap_or(lines.len());
        let content_end = (section_start + 1..section_end)
            .rev()
            .find(|index| !lines[*index].trim().is_empty())
            .map(|index| index + 1)
            .unwrap_or(section_start + 1);
        let ordered_number = lines[section_start + 1..content_end]
            .iter()
            .filter_map(|line| markdown_ordered_item_number(line))
            .max();
        let has_unordered_items = lines[section_start + 1..content_end].iter().any(|line| {
            let line = line.trim_start();
            line.starts_with("- ") || line.starts_with("* ")
        });
        let mut inserted = Vec::new();
        if let Some(number) = ordered_number {
            inserted.extend(
                additions
                    .iter()
                    .enumerate()
                    .map(|(index, item)| format!("{}. {item}", number + index + 1)),
            );
        } else {
            if !has_unordered_items {
                inserted.push(String::new());
            }
            inserted.extend(additions.iter().map(|item| format!("- {item}")));
        }
        lines.splice(content_end..content_end, inserted);
    } else {
        while lines.last().is_some_and(|line| line.trim().is_empty()) {
            lines.pop();
        }
        lines.push(String::new());
        lines.extend(additions.iter().map(|item| format!("- {item}")));
    }

    let mut result = lines.join("\n");
    if had_trailing_newline {
        result.push('\n');
    }
    result
}

fn markdown_ordered_item_number(line: &str) -> Option<usize> {
    let (prefix, _) = line.trim_start().split_once(". ")?;
    prefix.parse().ok()
}

pub fn uses_legacy_retro_section(suggestion: &RetroSuggestionRow) -> bool {
    suggestion
        .after_content
        .as_deref()
        .is_some_and(|content| content.contains("## Retro guidance ("))
}

pub fn unified_diff(path: &str, before: &str, after: &str) -> String {
    let before_path = if before.is_empty() {
        "/dev/null".to_string()
    } else {
        format!("a/{path}")
    };
    let after_path = format!("b/{path}");
    TextDiff::from_lines(before, after)
        .unified_diff()
        .context_radius(3)
        .header(&before_path, &after_path)
        .to_string()
}

fn confidence_label(confidence: &RetroConfidence) -> &'static str {
    match confidence {
        RetroConfidence::Low => "low",
        RetroConfidence::Medium => "medium",
        RetroConfidence::High => "high",
    }
}

fn path_key(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

pub(crate) async fn clone_repo_snapshot(
    repo_url: &str,
    destination: &Path,
    session_env: &BTreeMap<String, String>,
) -> Result<RepoSnapshot, String> {
    tokio::fs::remove_dir_all(destination).await.ok();
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|err| format!("Could not create proposal workspace: {err}"))?;
    }
    let destination_arg = destination.display().to_string();
    let output = command_output(
        "git",
        &[
            "clone",
            "--depth",
            "1",
            "--single-branch",
            "--",
            repo_url,
            &destination_arg,
        ],
        None,
        session_env,
    )
    .await?;
    if !output.status.success() {
        return Err(format!(
            "Could not clone repository: {}",
            tail(&String::from_utf8_lossy(&output.stderr), 300)
        ));
    }
    let head = command_output(
        "git",
        &["rev-parse", "HEAD"],
        Some(destination),
        session_env,
    )
    .await?;
    if !head.status.success() {
        return Err("Could not resolve the repository revision.".to_string());
    }
    Ok(RepoSnapshot {
        root: destination.to_path_buf(),
        head: String::from_utf8_lossy(&head.stdout).trim().to_string(),
    })
}

pub async fn command_output(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    session_env: &BTreeMap<String, String>,
) -> Result<std::process::Output, String> {
    command_output_with_timeout(program, args, cwd, session_env, RETRO_SUBPROCESS_TIMEOUT).await
}

async fn command_output_with_timeout(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    session_env: &BTreeMap<String, String>,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(program);
    command.args(args);
    command.kill_on_drop(true);
    command.env_remove("LINEAR_API_KEY");
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    for (key, value) in session_env {
        if key != "LINEAR_API_KEY" {
            command.env(key, value);
        }
    }
    match tokio::time::timeout(timeout, command.output()).await {
        Ok(result) => result.map_err(|err| format!("Could not run {program}: {err}")),
        Err(_) => Err(format!(
            "{program} timed out after {} seconds.",
            timeout.as_secs()
        )),
    }
}

async fn remote_branch_matches_local(
    workspace: &Path,
    branch: &str,
    session_env: &BTreeMap<String, String>,
) -> Result<Option<bool>, String> {
    let remote_ref = format!("refs/heads/{branch}");
    let remote_branch = command_output(
        "git",
        &["ls-remote", "--heads", "origin", &remote_ref],
        Some(workspace),
        session_env,
    )
    .await?;
    if !remote_branch.status.success() {
        return Err(format!(
            "Could not inspect the existing retro branch: {}",
            tail(&String::from_utf8_lossy(&remote_branch.stderr), 300)
        ));
    }
    if String::from_utf8_lossy(&remote_branch.stdout)
        .trim()
        .is_empty()
    {
        return Ok(None);
    }

    let fetch = command_output(
        "git",
        &["fetch", "--depth", "1", "origin", branch],
        Some(workspace),
        session_env,
    )
    .await?;
    if !fetch.status.success() {
        return Err(format!(
            "Could not fetch the existing retro branch: {}",
            tail(&String::from_utf8_lossy(&fetch.stderr), 300)
        ));
    }
    let diff = command_output(
        "git",
        &["diff", "--quiet", "FETCH_HEAD", "HEAD", "--"],
        Some(workspace),
        session_env,
    )
    .await?;
    match diff.status.code() {
        Some(0) => Ok(Some(true)),
        Some(1) => Ok(Some(false)),
        _ => Err(format!(
            "Could not compare the existing retro branch: {}",
            tail(&String::from_utf8_lossy(&diff.stderr), 300)
        )),
    }
}

pub fn tail(value: &str, max_chars: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return value.trim().to_string();
    }
    chars[chars.len() - max_chars..]
        .iter()
        .collect::<String>()
        .trim()
        .to_string()
}

pub async fn run_repo_pr_batch(
    repository: Repository,
    batch: RetroBatchRow,
    suggestions: Vec<RetroSuggestionRow>,
    workspace: PathBuf,
    session_env: BTreeMap<String, String>,
) {
    if let Err(message) =
        execute_repo_pr_batch(&repository, &batch, &suggestions, &workspace, &session_env).await
    {
        repository
            .update_retro_batch(&batch.id, "failed", None, Some(&message), None)
            .await
            .ok();
    }
}

async fn execute_repo_pr_batch(
    repository: &Repository,
    batch: &RetroBatchRow,
    suggestions: &[RetroSuggestionRow],
    workspace: &Path,
    session_env: &BTreeMap<String, String>,
) -> Result<(), String> {
    repository
        .update_retro_batch(
            &batch.id,
            "running",
            Some("Cloning the repository…"),
            None,
            None,
        )
        .await
        .map_err(|err| err.to_string())?;
    if suggestions.iter().any(uses_legacy_retro_section) {
        repository
            .update_retro_batch(
                &batch.id,
                "stale",
                Some("The proposal format changed."),
                Some("Generate a new retro and review the updated in-place diff."),
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        return Ok(());
    }
    let repo_url = batch
        .repo_url
        .as_deref()
        .ok_or_else(|| "Batch has no repository URL.".to_string())?;
    // Clone the current default branch. We intentionally do NOT reject the batch
    // just because the branch HEAD moved since review — unrelated commits should
    // not invalidate a batch. Freshness is enforced per-file below by comparing
    // each reviewed file's content hash against the stored `base_hash`, which is
    // the property we actually care about (we apply the diff to the same content
    // that was reviewed).
    clone_repo_snapshot(repo_url, workspace, session_env).await?;

    let branch_output = command_output(
        "git",
        &["branch", "--show-current"],
        Some(workspace),
        session_env,
    )
    .await?;
    if !branch_output.status.success() {
        return Err("Could not determine the repository's default branch.".to_string());
    }
    let default_branch = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();
    let short_retro = batch.retro_id.get(..8).unwrap_or(batch.retro_id.as_str());
    let branch = format!("symphony/retro-{short_retro}");

    let existing = command_output(
        "gh",
        &[
            "pr",
            "list",
            "--head",
            &branch,
            "--state",
            "open",
            "--json",
            "url",
            "--jq",
            ".[0].url // empty",
        ],
        Some(workspace),
        session_env,
    )
    .await?;
    let existing_url = existing
        .status
        .success()
        .then(|| pr_url_from_output(&existing.stdout))
        .flatten();
    repository
        .update_retro_batch(
            &batch.id,
            "running",
            Some("Applying accepted changes…"),
            None,
            None,
        )
        .await
        .map_err(|err| err.to_string())?;
    let checkout = command_output(
        "git",
        &["checkout", "-b", &branch],
        Some(workspace),
        session_env,
    )
    .await?;
    if !checkout.status.success() {
        return Err(format!(
            "Could not create branch: {}",
            tail(&String::from_utf8_lossy(&checkout.stderr), 300)
        ));
    }

    let mut by_path = BTreeMap::<String, Vec<&RetroSuggestionRow>>::new();
    for suggestion in suggestions {
        by_path
            .entry(suggestion.target_path.clone())
            .or_default()
            .push(suggestion);
    }
    let mut changed_paths = Vec::new();
    for (path, items) in by_path {
        let destination = safe_repo_target(workspace, &path).await?;
        let current = read_optional_text(&destination, &path).await?;
        let expected_hashes = items
            .iter()
            .filter_map(|item| item.base_hash.as_deref())
            .collect::<BTreeSet<_>>();
        if expected_hashes.len() != 1 || !expected_hashes.contains(hash_body(&current).as_str()) {
            repository
                .update_retro_batch(
                    &batch.id,
                    "stale",
                    Some("A reviewed target file changed."),
                    Some("Generate a new retro and review the updated diff."),
                    None,
                )
                .await
                .map_err(|err| err.to_string())?;
            return Ok(());
        }
        let seed = if current.is_empty() {
            proposal_seed(items[0])?
        } else {
            current
        };
        let guidance = items
            .iter()
            .map(|item| item.guidance.clone())
            .collect::<Vec<_>>();
        let updated = integrate_retro_guidance(&seed, &guidance);
        if items.iter().any(|item| item.target_type == "repo_workflow") {
            symphony_core::validate_prompt_template(&updated)
                .map_err(|error| format!("The proposed repository workflow is invalid: {error}"))?;
        }
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|err| format!("Could not create target directory: {err}"))?;
        }
        tokio::fs::write(&destination, updated)
            .await
            .map_err(|err| format!("Could not write {path}: {err}"))?;
        changed_paths.push(path);
    }

    let diff_names = command_output(
        "git",
        &["status", "--porcelain", "--untracked-files=all"],
        Some(workspace),
        session_env,
    )
    .await?;
    let actual_paths = String::from_utf8_lossy(&diff_names.stdout)
        .lines()
        .filter_map(|line| line.get(3..).map(str::to_string))
        .collect::<BTreeSet<_>>();
    let allowed_paths = changed_paths.iter().cloned().collect::<BTreeSet<_>>();
    if actual_paths != allowed_paths {
        return Err("The generated change touched files outside the reviewed batch.".to_string());
    }

    repository
        .update_retro_batch(
            &batch.id,
            "running",
            Some("Committing accepted changes…"),
            None,
            None,
        )
        .await
        .map_err(|err| err.to_string())?;
    commit_retro_changes(workspace, &changed_paths, session_env).await?;

    let reuse_remote_branch = match remote_branch_matches_local(workspace, &branch, session_env)
        .await?
    {
        None => false,
        Some(true) => true,
        Some(false) => {
            return Err(format!(
                "Remote branch `{branch}` already exists with different changes. Review or remove that branch before retrying."
            ));
        }
    };
    if existing_url.is_some() && !reuse_remote_branch {
        return Err(format!(
            "The existing PR for `{branch}` no longer has a remote branch that matches the reviewed changes."
        ));
    }

    repository
        .update_retro_batch(
            &batch.id,
            "running",
            Some(if existing_url.is_some() {
                "Verifying existing retro PR…"
            } else if reuse_remote_branch {
                "Reusing pushed branch and opening PR…"
            } else {
                "Pushing branch and opening PR…"
            }),
            None,
            None,
        )
        .await
        .map_err(|err| err.to_string())?;
    if !reuse_remote_branch {
        let push = command_output(
            "git",
            &["push", "-u", "origin", &branch],
            Some(workspace),
            session_env,
        )
        .await?;
        if !push.status.success() {
            return Err(format!(
                "Could not push branch: {}",
                tail(&String::from_utf8_lossy(&push.stderr), 400)
            ));
        }
    }
    let title = format!("Apply Symphony retro suggestions ({short_retro})");
    let mut body = "## Accepted retro suggestions\n\n".to_string();
    for suggestion in suggestions {
        body.push_str(&format!("- {}\n", suggestion.title));
    }
    body.push_str("\nThe committed changes match the diffs reviewed in Symphony.\n");
    let (pr_url, completed_progress) = if let Some(existing_url) = existing_url {
        (existing_url, "Existing retro PR verified.")
    } else {
        let created = command_output(
            "gh",
            &[
                "pr",
                "create",
                "--base",
                &default_branch,
                "--head",
                &branch,
                "--title",
                &title,
                "--body",
                &body,
            ],
            Some(workspace),
            session_env,
        )
        .await?;
        if !created.status.success() {
            return Err(format!(
                "Could not create PR: {}",
                tail(&String::from_utf8_lossy(&created.stderr), 400)
            ));
        }
        let pr_url = pr_url_from_output(&created.stdout)
            .ok_or_else(|| "GitHub reported success but no PR URL was returned.".to_string())?;
        (pr_url, "Implementation PR created.")
    };
    repository
        .update_retro_batch(
            &batch.id,
            "completed",
            Some(completed_progress),
            None,
            Some(&pr_url),
        )
        .await
        .map_err(|err| err.to_string())?;
    tokio::fs::remove_dir_all(workspace).await.ok();
    Ok(())
}

fn pr_url_from_output(output: &[u8]) -> Option<String> {
    String::from_utf8_lossy(output)
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("https://") || line.starts_with("http://"))
        .map(str::to_string)
}

async fn commit_retro_changes(
    workspace: &Path,
    changed_paths: &[String],
    session_env: &BTreeMap<String, String>,
) -> Result<(), String> {
    let mut add_args = vec!["add", "--"];
    add_args.extend(changed_paths.iter().map(String::as_str));
    let add = command_output("git", &add_args, Some(workspace), session_env).await?;
    if !add.status.success() {
        return Err(format!(
            "Could not stage changes: {}",
            tail(&String::from_utf8_lossy(&add.stderr), 300)
        ));
    }
    let commit = command_output(
        "git",
        &["commit", "-m", "Apply Symphony retro suggestions"],
        Some(workspace),
        session_env,
    )
    .await?;
    if !commit.status.success() {
        let stderr = tail(&String::from_utf8_lossy(&commit.stderr), 300);
        if stderr.contains("Author identity unknown")
            || stderr.contains("unable to auto-detect email address")
        {
            return Err(
                "Could not commit with your Git identity. Configure `git config --global user.name` and `git config --global user.email`, then retry."
                    .to_string(),
            );
        }
        return Err(format!("Could not commit changes: {}", stderr));
    }
    Ok(())
}

fn proposal_seed(suggestion: &RetroSuggestionRow) -> Result<String, String> {
    let content = suggestion.after_content.as_deref().ok_or_else(|| {
        format!(
            "Could not reconstruct the base for {}.",
            suggestion.target_path
        )
    })?;
    let had_trailing_newline = content.ends_with('\n');
    let guidance = suggestion.guidance.trim();
    let mut lines = content.lines().map(str::to_string).collect::<Vec<_>>();
    let Some(index) = lines
        .iter()
        .position(|line| markdown_list_item_body(line).is_some_and(|body| body.trim() == guidance))
    else {
        return Err(format!(
            "Could not reconstruct the base for {}.",
            suggestion.target_path
        ));
    };
    lines.remove(index);
    let mut seed = lines.join("\n");
    if had_trailing_newline {
        seed.push('\n');
    }
    Ok(seed)
}

fn markdown_list_item_body(line: &str) -> Option<&str> {
    let line = line.trim_start();
    if let Some(body) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
        return Some(body);
    }
    let (prefix, body) = line.split_once(". ")?;
    prefix.parse::<usize>().ok().map(|_| body)
}

async fn safe_repo_target(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(format!("Unsafe retro target path: {relative}"));
    }
    let canonical_root = tokio::fs::canonicalize(root)
        .await
        .map_err(|err| format!("Could not resolve repository root: {err}"))?;
    let mut current = canonical_root.clone();
    for component in relative_path.components() {
        current.push(component.as_os_str());
        match tokio::fs::symlink_metadata(&current).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                let resolved = tokio::fs::canonicalize(&current).await.map_err(|err| {
                    format!("Could not resolve symbolic link in Retro target `{relative}`: {err}")
                })?;
                if !resolved.starts_with(&canonical_root) {
                    return Err(format!(
                        "Retro target `{relative}` resolves outside the repository."
                    ));
                }
                current = resolved;
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(format!(
                    "Could not inspect retro target `{relative}`: {err}"
                ));
            }
        }
    }
    Ok(current)
}

async fn repo_relative_target(root: &Path, target: &Path) -> Result<String, String> {
    let canonical_root = tokio::fs::canonicalize(root)
        .await
        .map_err(|err| format!("Could not resolve repository root: {err}"))?;
    let relative = target.strip_prefix(&canonical_root).map_err(|_| {
        format!(
            "Retro target `{}` resolves outside the repository.",
            target.display()
        )
    })?;
    Ok(relative
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/"))
}

async fn read_optional_text(path: &Path, label: &str) -> Result<String, String> {
    match tokio::fs::read_to_string(path).await {
        Ok(content) => Ok(content),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(format!("Could not read retro target `{label}`: {err}")),
    }
}

fn analyze_retro(
    retro: &RetroRow,
    runs: &[RunWithIssueRow],
    events: &[AgentEventRow],
    changed_workpads: &BTreeMap<String, (WorkpadComment, String)>,
    found_workpad_issue_ids: &BTreeSet<String>,
) -> RetroReport {
    let mut events_by_run: BTreeMap<&str, Vec<&AgentEventRow>> = BTreeMap::new();
    for event in events {
        events_by_run
            .entry(event.run_id.as_str())
            .or_default()
            .push(event);
    }
    let issue_identifier_by_id = runs
        .iter()
        .map(|run| (run.issue_id.as_str(), run.issue_identifier.as_str()))
        .collect::<BTreeMap<_, _>>();

    let mut repos: BTreeMap<String, RepoAccumulator> = BTreeMap::new();
    for run in runs {
        let repo_name = run
            .repo_name
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        let entry = repos
            .entry(repo_name.clone())
            .or_insert_with(|| RepoAccumulator::new(repo_name));
        entry.run_count += 1;
        entry.issue_ids.insert(run.issue_id.clone());
        if run.run_number > 1 {
            entry.retry_count += 1;
        }
        if matches!(run.status.as_str(), "failure" | "timeout") {
            entry.failure_count += 1;
            let title = if run.status == "timeout" {
                "Runs timed out".to_string()
            } else {
                format!(
                    "Runs failed with {}",
                    run.error_class.as_deref().unwrap_or("agent_failure")
                )
            };
            let detail = run
                .error_message
                .as_deref()
                .map(truncate_detail)
                .unwrap_or_else(|| format!("Run ended with status `{}`.", run.status));
            entry.push_finding(
                format!(
                    "run:{}:{}",
                    run.status,
                    run.error_class.clone().unwrap_or_default()
                ),
                title,
                detail,
                RetroSeverity::High,
                run_evidence(
                    run,
                    "run",
                    run.error_message.as_deref().unwrap_or(&run.status),
                ),
            );
        }

        if let Some(run_events) = events_by_run.get(run.id.as_str()) {
            for event in run_events {
                inspect_event(entry, run, event);
            }
        }
    }

    for issue_id in found_workpad_issue_ids {
        for repo in repos
            .values_mut()
            .filter(|repo| repo.issue_ids.contains(issue_id))
        {
            if repo.workpad_issue_ids.insert(issue_id.clone()) {
                repo.workpad_count += 1;
            }
        }
    }

    for (issue_id, (workpad, _hash)) in changed_workpads {
        for repo in repos
            .values_mut()
            .filter(|repo| repo.issue_ids.contains(issue_id))
        {
            let issue_identifier = issue_identifier_by_id
                .get(issue_id.as_str())
                .copied()
                .unwrap_or(issue_id.as_str());
            inspect_workpad(repo, workpad, issue_identifier);
        }
    }

    for run in runs {
        if !found_workpad_issue_ids.contains(&run.issue_id) {
            let repo_name = run
                .repo_name
                .clone()
                .unwrap_or_else(|| "unknown".to_string());
            if let Some(repo) = repos.get_mut(&repo_name) {
                repo.push_finding(
                    format!("missing-workpad:{}", run.issue_id),
                    "Workpad was not found for a dispatched issue".to_string(),
                    "The retro could not find a `## Symphony Workpad` comment for this issue."
                        .to_string(),
                    RetroSeverity::Low,
                    run_evidence(run, "workpad", "No Symphony Workpad comment found."),
                );
            }
        }
    }

    let repo_reports = repos
        .into_values()
        .map(RepoAccumulator::finish)
        .collect::<Vec<_>>();
    RetroReport {
        id: retro.id.clone(),
        since_at: retro.since_at.clone(),
        until_at: retro.until_at.clone(),
        generated_at: now_iso(),
        run_count: runs.len() as i64,
        issue_count: runs
            .iter()
            .map(|run| run.issue_id.as_str())
            .collect::<BTreeSet<_>>()
            .len() as i64,
        workpad_count: found_workpad_issue_ids.len() as i64,
        repos: repo_reports,
    }
}

fn should_inspect_workpad(
    workpad: &WorkpadComment,
    hash: &str,
    previous_hash: Option<&String>,
    since_at: &str,
    until_at: &str,
) -> bool {
    if previous_hash.is_some_and(|previous_hash| previous_hash == hash) {
        return false;
    }
    workpad_changed_in_window(workpad, since_at, until_at)
}

fn workpad_changed_in_window(workpad: &WorkpadComment, since_at: &str, until_at: &str) -> bool {
    workpad
        .updated_at
        .as_deref()
        .or(workpad.created_at.as_deref())
        .map(|changed_at| changed_at > since_at && changed_at <= until_at)
        .unwrap_or(true)
}

fn workpad_existed_by(workpad: &WorkpadComment, until_at: &str) -> bool {
    workpad
        .created_at
        .as_deref()
        .map(|created_at| created_at <= until_at)
        .unwrap_or(true)
}

fn workpad_hash_available_in_window(workpad: &WorkpadComment, until_at: &str) -> bool {
    workpad
        .updated_at
        .as_deref()
        .or(workpad.created_at.as_deref())
        .map(|changed_at| changed_at <= until_at)
        .unwrap_or(true)
}

fn inspect_event(repo: &mut RepoAccumulator, run: &RunWithIssueRow, event: &AgentEventRow) {
    let value = serde_json::from_str::<serde_json::Value>(&event.payload).ok();
    match event.kind.as_str() {
        "error" => {
            let class = value
                .as_ref()
                .and_then(|value| value.get("class"))
                .and_then(|value| value.as_str())
                .unwrap_or("agent_error");
            let message = value
                .as_ref()
                .and_then(|value| value.get("message"))
                .and_then(|value| value.as_str())
                .unwrap_or(&event.payload);
            repo.push_finding(
                format!("event-error:{class}"),
                format!("Agent reported `{class}` errors"),
                truncate_detail(message),
                RetroSeverity::High,
                event_evidence(run, event, "error", message),
            );
        }
        "approval" | "user_input" => {
            repo.push_finding(
                format!("interaction:{}", event.kind),
                "Run needed human-style interaction".to_string(),
                "Unattended runs work best when the prompt or skills avoid approval and follow-up paths."
                    .to_string(),
                RetroSeverity::Medium,
                event_evidence(run, event, &event.kind, &event.payload),
            );
        }
        "tool_call" => {
            let summary = value
                .as_ref()
                .and_then(|value| value.get("result_summary"))
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if should_report_tool_confusion(value.as_ref(), summary) {
                let tool = value
                    .as_ref()
                    .and_then(|value| value.get("tool"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("tool");
                let command = tool_command(value.as_ref());
                let (key, title, detail) = tool_confusion_finding(tool, summary);
                let evidence_summary = command
                    .map(|command| format!("{} → {summary}", truncate_detail(command)))
                    .unwrap_or_else(|| summary.to_string());
                repo.push_finding(
                    key,
                    title,
                    detail,
                    RetroSeverity::Medium,
                    event_evidence(run, event, "tool_call", &evidence_summary),
                );
            }
        }
        _ => {}
    }
}

fn inspect_workpad(repo: &mut RepoAccumulator, workpad: &WorkpadComment, issue_identifier: &str) {
    for line in markdown_section_items(&workpad.body, "Confusions") {
        let title = format!("Workpad confusion: {}", short_title(&line));
        repo.push_finding(
            format!("workpad-confusion:{}", normalized_key(&line)),
            title,
            line.clone(),
            RetroSeverity::Medium,
            RetroEvidence {
                issue_identifier: issue_identifier.to_string(),
                run_id: None,
                run_number: None,
                event_id: None,
                kind: "workpad_confusion".to_string(),
                summary: line,
            },
        );
    }
    for line in markdown_section_items(&workpad.body, "Notes")
        .into_iter()
        .filter(|line| looks_like_note_confusion(line))
    {
        repo.push_finding(
            format!("workpad-note:{}", normalized_key(&line)),
            format!("Workpad note signals confusion: {}", short_title(&line)),
            line.clone(),
            RetroSeverity::Low,
            RetroEvidence {
                issue_identifier: issue_identifier.to_string(),
                run_id: None,
                run_number: None,
                event_id: None,
                kind: "workpad_note".to_string(),
                summary: line,
            },
        );
    }
}

#[derive(Debug)]
struct RepoAccumulator {
    repo_name: String,
    run_count: i64,
    failure_count: i64,
    retry_count: i64,
    workpad_count: i64,
    issue_ids: BTreeSet<String>,
    workpad_issue_ids: BTreeSet<String>,
    findings: BTreeMap<String, RetroFinding>,
}

#[derive(Debug)]
struct SuggestionGroup {
    target_type: RetroSuggestionTarget,
    target_id: String,
    guidance: String,
    finding: RetroFinding,
}

impl RepoAccumulator {
    fn new(repo_name: String) -> Self {
        Self {
            repo_name,
            run_count: 0,
            failure_count: 0,
            retry_count: 0,
            workpad_count: 0,
            issue_ids: BTreeSet::new(),
            workpad_issue_ids: BTreeSet::new(),
            findings: BTreeMap::new(),
        }
    }

    fn push_finding(
        &mut self,
        key: String,
        title: String,
        detail: String,
        severity: RetroSeverity,
        evidence: RetroEvidence,
    ) {
        let finding = self.findings.entry(key).or_insert_with(|| RetroFinding {
            title,
            detail,
            severity: severity.clone(),
            occurrences: 0,
            evidence: Vec::new(),
        });
        finding.occurrences += 1;
        if severity > finding.severity {
            finding.severity = severity;
        }
        if finding.evidence.len() < MAX_EVIDENCE_PER_FINDING {
            finding.evidence.push(evidence);
        }
    }

    fn finish(self) -> RetroRepoReport {
        let mut raw_findings = self.findings.into_values().collect::<Vec<_>>();
        raw_findings.sort_by(|a, b| {
            b.severity
                .cmp(&a.severity)
                .then_with(|| b.occurrences.cmp(&a.occurrences))
                .then_with(|| a.title.cmp(&b.title))
        });

        let mut grouped =
            BTreeMap::<(RetroSuggestionTarget, String, String), SuggestionGroup>::new();
        for finding in raw_findings {
            let guidance = guidance_for(&finding);
            let (target_type, target_id) = suggestion_target(&finding);
            let key = (target_type.clone(), target_id.clone(), guidance.clone());
            if let Some(group) = grouped.get_mut(&key) {
                group.finding.occurrences += finding.occurrences;
                if finding.severity > group.finding.severity {
                    group.finding.severity = finding.severity;
                }
                let mut seen_evidence = group
                    .finding
                    .evidence
                    .iter()
                    .map(evidence_key)
                    .collect::<BTreeSet<_>>();
                for evidence in finding.evidence {
                    if group.finding.evidence.len() >= MAX_EVIDENCE_PER_FINDING {
                        break;
                    }
                    if seen_evidence.insert(evidence_key(&evidence)) {
                        group.finding.evidence.push(evidence);
                    }
                }
            } else {
                grouped.insert(
                    key,
                    SuggestionGroup {
                        target_type,
                        target_id,
                        finding: RetroFinding {
                            title: suggestion_topic(&guidance).to_string(),
                            detail: guidance.clone(),
                            severity: finding.severity,
                            occurrences: finding.occurrences,
                            evidence: finding.evidence,
                        },
                        guidance,
                    },
                );
            }
        }

        let mut groups = grouped.into_values().collect::<Vec<_>>();
        groups.sort_by(|a, b| {
            b.finding
                .severity
                .cmp(&a.finding.severity)
                .then_with(|| b.finding.occurrences.cmp(&a.finding.occurrences))
                .then_with(|| a.finding.title.cmp(&b.finding.title))
        });
        groups.truncate(MAX_FINDINGS_PER_REPO);
        let findings = groups
            .iter()
            .map(|group| group.finding.clone())
            .collect::<Vec<_>>();
        let suggestions = groups
            .iter()
            .map(|group| suggestion_for_group(&self.repo_name, group))
            .collect::<Vec<_>>();
        RetroRepoReport {
            repo_name: self.repo_name,
            run_count: self.run_count,
            issue_count: self.issue_ids.len() as i64,
            workpad_count: self.workpad_count,
            failure_count: self.failure_count,
            retry_count: self.retry_count,
            findings,
            suggestions,
        }
    }
}

fn suggestion_for_group(repo_name: &str, group: &SuggestionGroup) -> RetroSuggestion {
    suggestion_from_parts(
        repo_name,
        &group.finding,
        group.target_type.clone(),
        group.target_id.clone(),
        &group.guidance,
    )
}

fn suggestion_target(finding: &RetroFinding) -> (RetroSuggestionTarget, String) {
    let joined = finding.detail.to_lowercase();
    if let Some(skill) = skill_target(&joined) {
        (RetroSuggestionTarget::Skill, skill.to_string())
    } else {
        (RetroSuggestionTarget::Prompt, "common prompt".to_string())
    }
}

fn suggestion_from_parts(
    repo_name: &str,
    finding: &RetroFinding,
    target_type: RetroSuggestionTarget,
    target_id: String,
    guidance: &str,
) -> RetroSuggestion {
    let target_label = match target_type {
        RetroSuggestionTarget::Prompt => "common prompt".to_string(),
        RetroSuggestionTarget::Skill => target_id.clone(),
    };
    let confidence = if finding.occurrences >= 3 || finding.severity == RetroSeverity::High {
        RetroConfidence::High
    } else if finding.occurrences == 2 {
        RetroConfidence::Medium
    } else {
        RetroConfidence::Low
    };
    RetroSuggestion {
        target_type,
        target_id,
        title: format!("Clarify {} for {}", suggestion_topic(guidance), repo_name),
        body: format!("Update {target_label} with this guidance: {guidance}"),
        rationale: format!(
            "{} occurrence{} found in {} with {} severity.",
            finding.occurrences,
            if finding.occurrences == 1 { "" } else { "s" },
            repo_name,
            severity_label(&finding.severity)
        ),
        confidence,
    }
}

fn suggestion_topic(guidance: &str) -> &'static str {
    if guidance.starts_with("Handle non-zero command exits") {
        "non-zero command handling"
    } else if guidance.starts_with("For user-facing UI changes") {
        "UI evidence requirements"
    } else if guidance.starts_with("Create or update the Symphony Workpad") {
        "workpad requirements"
    } else if guidance.starts_with("Unattended runs must not stop") {
        "unattended-run behavior"
    } else if guidance.starts_with("Before completing review work") {
        "PR feedback handling"
    } else if guidance.starts_with("Run the repository's required validation") {
        "validation requirements"
    } else {
        "recurring issue handling"
    }
}

fn evidence_key(evidence: &RetroEvidence) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        evidence.issue_identifier,
        evidence.run_id.as_deref().unwrap_or_default(),
        evidence.event_id.unwrap_or_default(),
        evidence.kind,
        evidence.summary
    )
}

fn skill_target(text: &str) -> Option<&'static str> {
    if text.contains("screenshot") || text.contains("playwright") {
        Some("symphony-screenshot")
    } else if text.contains("review") || text.contains("feedback") || text.contains("inline") {
        Some("symphony-pr-feedback")
    } else if text.contains("push") || text.contains("github") || text.contains(" gh ") {
        Some("symphony-push")
    } else if text.contains("merge") || text.contains("land") {
        Some("symphony-land")
    } else if text.contains("conflict") || text.contains("origin/main") || text.contains("rebase") {
        Some("symphony-pull")
    } else if text.contains("commit") {
        Some("symphony-commit")
    } else if text.contains("workpad") {
        Some("symphony-workpad")
    } else {
        None
    }
}

fn markdown_section_items(body: &str, section: &str) -> Vec<String> {
    let wanted = format!("### {}", section.to_ascii_lowercase());
    let mut inside = false;
    let mut items = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("### ") {
            inside = trimmed.to_ascii_lowercase() == wanted;
            continue;
        }
        if inside && trimmed.starts_with("## ") {
            break;
        }
        if !inside {
            continue;
        }
        if let Some(item) = clean_markdown_item(trimmed) {
            items.push(item);
        }
    }
    items
}

fn clean_markdown_item(line: &str) -> Option<String> {
    let line = line
        .strip_prefix("- [ ] ")
        .or_else(|| line.strip_prefix("- [x] "))
        .or_else(|| line.strip_prefix("- [X] "))
        .or_else(|| line.strip_prefix("- "))
        .or_else(|| line.strip_prefix("* "))
        .unwrap_or(line)
        .trim();
    (!line.is_empty() && !line.starts_with('<')).then(|| line.to_string())
}

fn looks_like_tool_confusion(summary: &str) -> bool {
    let lower = summary.to_lowercase();
    looks_like_nonzero_exit(summary)
        || [
            "error",
            "failed",
            "denied",
            "not found",
            "missing",
            "unknown",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn should_report_tool_confusion(value: Option<&serde_json::Value>, summary: &str) -> bool {
    if !tool_result_failed(value, summary) {
        return false;
    }
    looks_like_tool_confusion(summary)
}

fn tool_command(value: Option<&serde_json::Value>) -> Option<&str> {
    value
        .and_then(|value| value.get("args"))
        .and_then(|args| args.get("command"))
        .and_then(|command| command.as_str())
        .map(str::trim)
        .filter(|command| !command.is_empty())
}

fn tool_confusion_finding(tool: &str, summary: &str) -> (String, String, String) {
    if looks_like_nonzero_exit(summary) {
        return (
            format!("tool:{tool}:nonzero-exit"),
            format!("`{tool}` commands exited unsuccessfully"),
            format!(
                "`{tool}` commands returned non-zero exits. The captured command context distinguishes expected probe failures from actionable setup or validation failures."
            ),
        );
    }
    (
        format!("tool:{tool}:{}", normalized_key(summary)),
        format!("`{tool}` calls produced confusing results"),
        truncate_detail(summary),
    )
}

fn tool_result_failed(value: Option<&serde_json::Value>, summary: &str) -> bool {
    value
        .and_then(|value| value.get("is_error"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
        || looks_like_nonzero_exit(summary)
        || summary.trim_start().to_lowercase().starts_with("error:")
}

fn looks_like_nonzero_exit(summary: &str) -> bool {
    let tokens = summary
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    tokens.windows(2).any(|pair| {
        pair[0].eq_ignore_ascii_case("exit")
            && pair[1]
                .parse::<i32>()
                .map(|code| code != 0)
                .unwrap_or(false)
    })
}

fn looks_like_note_confusion(line: &str) -> bool {
    let lower = line.to_lowercase();
    ["confus", "unclear", "blocked", "missing", "unknown"]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn run_evidence(run: &RunWithIssueRow, kind: &str, summary: &str) -> RetroEvidence {
    RetroEvidence {
        issue_identifier: run.issue_identifier.clone(),
        run_id: Some(run.id.clone()),
        run_number: Some(run.run_number),
        event_id: None,
        kind: kind.to_string(),
        summary: truncate_detail(summary),
    }
}

fn event_evidence(
    run: &RunWithIssueRow,
    event: &AgentEventRow,
    kind: &str,
    summary: &str,
) -> RetroEvidence {
    RetroEvidence {
        issue_identifier: run.issue_identifier.clone(),
        run_id: Some(run.id.clone()),
        run_number: Some(run.run_number),
        event_id: Some(event.id),
        kind: kind.to_string(),
        summary: truncate_detail(summary),
    }
}

fn normalized_key(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .take(12)
        .collect::<Vec<_>>()
        .join(" ")
}

fn short_title(value: &str) -> String {
    let value = value.trim();
    let value = value
        .strip_prefix('`')
        .and_then(|value| value.strip_suffix('`'))
        .unwrap_or(value);
    if value.chars().count() <= 72 {
        value.to_string()
    } else {
        let mut out = value.chars().take(69).collect::<String>();
        out.push_str("...");
        out
    }
}

fn truncate_detail(value: &str) -> String {
    if value.chars().count() <= 220 {
        value.to_string()
    } else {
        let mut out = value.chars().take(217).collect::<String>();
        out.push_str("...");
        out
    }
}

fn severity_label(severity: &RetroSeverity) -> &'static str {
    match severity {
        RetroSeverity::Low => "low",
        RetroSeverity::Medium => "medium",
        RetroSeverity::High => "high",
    }
}

pub(crate) fn hash_body(body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn retro_relevant_workpad_hash(body: &str) -> String {
    let mut relevant = Vec::new();
    relevant.extend(
        markdown_section_items(body, "Confusions")
            .into_iter()
            .map(|line| format!("confusion:{line}")),
    );
    relevant.extend(
        markdown_section_items(body, "Notes")
            .into_iter()
            .filter(|line| looks_like_note_confusion(line))
            .map(|line| format!("note:{line}")),
    );
    hash_body(&relevant.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn git_test_ok(cwd: Option<&Path>, args: &[&str]) {
        let output = command_output("git", args, cwd, &BTreeMap::new())
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn test_suggestion(after_content: String, guidance: &str) -> RetroSuggestionRow {
        RetroSuggestionRow {
            id: "suggestion-1".to_string(),
            retro_id: "retro-1".to_string(),
            repo_name: "widgets".to_string(),
            repo_url: Some("https://github.com/acme/widgets.git".to_string()),
            finding_index: 0,
            target_type: "skill".to_string(),
            target_id: "symphony-push".to_string(),
            target_path: ".agents/skills/symphony-push/SKILL.md".to_string(),
            title: "Improve push validation".to_string(),
            body: "Record the validation requirement.".to_string(),
            rationale: "Repeated failures".to_string(),
            confidence: "high".to_string(),
            guidance: guidance.to_string(),
            before_content: Some(String::new()),
            after_content: Some(after_content),
            unified_diff: None,
            base_ref: Some("abc123".to_string()),
            base_hash: Some(hash_body("")),
            proposal_status: "ready".to_string(),
            proposal_error: None,
            decision: "pending".to_string(),
            decided_at: None,
            created_at: now_iso(),
        }
    }

    #[test]
    fn produces_an_exact_reviewable_guidance_diff() {
        let before = "# Workflow\n\n## Instructions\n\n1. Existing guidance.\n";
        let after =
            integrate_retro_guidance(before, &["Run validation before pushing.".to_string()]);
        assert!(!after.contains("Retro guidance"));
        assert!(after.contains("2. Run validation before pushing."));
        assert_eq!(
            integrate_retro_guidance(&after, &["Run validation before pushing.".to_string()]),
            after
        );
        let diff = unified_diff("Settings → Prompt template", before, &after);
        assert!(diff.contains("--- a/Settings → Prompt template"));
        assert!(diff.contains("+2. Run validation before pushing."));
        assert!(!diff.contains("Retro guidance"));
    }

    #[test]
    fn accepts_only_actual_urls_from_pr_lookup_output() {
        assert_eq!(pr_url_from_output(b"null\n"), None);
        assert_eq!(pr_url_from_output(b"\n"), None);
        assert_eq!(
            pr_url_from_output(b"https://github.com/acme/widgets/pull/7\n"),
            Some("https://github.com/acme/widgets/pull/7".to_string())
        );
    }

    #[test]
    fn reconstructs_a_missing_skill_seed_after_in_place_guidance() {
        let seed = "# Push\n\n## Steps\n\n1. Push the current branch.\n";
        let guidance = "Run validation before pushing.";
        let after = integrate_retro_guidance(seed, &[guidance.to_string()]);
        let suggestion = test_suggestion(after, guidance);

        assert_eq!(proposal_seed(&suggestion).unwrap(), seed);
        assert!(!uses_legacy_retro_section(&suggestion));
    }

    #[tokio::test]
    async fn materializes_one_card_for_an_identical_target_change() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        tokio::fs::create_dir_all(&source).await.unwrap();
        git_test_ok(Some(&source), &["init", "-b", "main"]).await;
        git_test_ok(Some(&source), &["config", "user.name", "Symphony Test"]).await;
        git_test_ok(
            Some(&source),
            &["config", "user.email", "symphony@example.com"],
        )
        .await;
        tokio::fs::write(source.join("README.md"), "fixture\n")
            .await
            .unwrap();
        git_test_ok(Some(&source), &["add", "README.md"]).await;
        git_test_ok(Some(&source), &["commit", "-m", "fixture"]).await;
        let mut accumulator = RepoAccumulator::new("widgets".to_string());
        for (key, detail) in [("exit-one", "exit 1"), ("exit-two", "exit 2")] {
            accumulator.push_finding(
                key.to_string(),
                "`bash` commands exited unsuccessfully".to_string(),
                detail.to_string(),
                RetroSeverity::Medium,
                RetroEvidence {
                    issue_identifier: "SYM-1".to_string(),
                    run_id: None,
                    run_number: None,
                    event_id: None,
                    kind: "tool_call".to_string(),
                    summary: detail.to_string(),
                },
            );
        }
        let repo_report = accumulator.finish();
        assert_eq!(repo_report.findings.len(), 1);
        assert!(repo_report.findings[0]
            .detail
            .starts_with("Handle non-zero command exits"));
        let retro = RetroRow {
            id: "retro-1".to_string(),
            since_at: "1970-01-01T00:00:00.000Z".to_string(),
            until_at: "2099-01-01T00:00:00.000Z".to_string(),
            status: "completed".to_string(),
            run_count: 2,
            issue_count: 1,
            report_json: None,
            error_message: None,
            created_at: now_iso(),
            completed_at: Some(now_iso()),
        };
        let report = RetroReport {
            id: retro.id.clone(),
            since_at: retro.since_at.clone(),
            until_at: retro.until_at.clone(),
            generated_at: now_iso(),
            run_count: 2,
            issue_count: 1,
            workpad_count: 1,
            repos: vec![repo_report],
        };
        let config = RetroProposalConfig {
            prompt_template: "# Workflow\n\n## Instructions\n\n1. Do the work.\n".to_string(),
            workflow_hash: "workflow-hash".to_string(),
            repos: BTreeMap::from([("widgets".to_string(), source.display().to_string())]),
            workspace_root: temp.path().join("proposals"),
            session_env: BTreeMap::new(),
            skills: BTreeMap::new(),
        };

        let rows = materialize_suggestions(&retro, &report, &config).await;
        assert_eq!(rows.len(), 1);
        assert!(rows[0]
            .unified_diff
            .as_deref()
            .unwrap()
            .contains("+2. Handle non-zero command exits"));
        assert!(!rows[0]
            .unified_diff
            .as_deref()
            .unwrap()
            .contains("Retro guidance"));

        let mut already_applied = config.clone();
        already_applied.prompt_template = rows[0].after_content.clone().unwrap();
        assert!(materialize_suggestions(&retro, &report, &already_applied)
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn materializes_prompt_guidance_against_a_repository_workflow() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        tokio::fs::create_dir_all(&source).await.unwrap();
        git_test_ok(Some(&source), &["init", "-b", "main"]).await;
        git_test_ok(Some(&source), &["config", "user.name", "Symphony Test"]).await;
        git_test_ok(
            Some(&source),
            &["config", "user.email", "symphony@example.com"],
        )
        .await;
        tokio::fs::write(
            source.join(symphony_worker::WORKFLOW_FILE),
            "# Repo workflow\n\n## Instructions\n\n1. Do the work.\n",
        )
        .await
        .unwrap();
        git_test_ok(Some(&source), &["add", symphony_worker::WORKFLOW_FILE]).await;
        git_test_ok(Some(&source), &["commit", "-m", "workflow"]).await;

        let mut accumulator = RepoAccumulator::new("widgets".to_string());
        accumulator.push_finding(
            "recurring".to_string(),
            "Recurring orchestration confusion".to_string(),
            "Record the reusable prerequisite before retrying.".to_string(),
            RetroSeverity::Medium,
            RetroEvidence {
                issue_identifier: "SYM-1".to_string(),
                run_id: None,
                run_number: None,
                event_id: None,
                kind: "workpad".to_string(),
                summary: "confusion".to_string(),
            },
        );
        let retro = RetroRow {
            id: "retro-repo-workflow".to_string(),
            since_at: RETRO_BEGINNING.to_string(),
            until_at: "2099-01-01T00:00:00.000Z".to_string(),
            status: "completed".to_string(),
            run_count: 1,
            issue_count: 1,
            report_json: None,
            error_message: None,
            created_at: now_iso(),
            completed_at: Some(now_iso()),
        };
        let report = RetroReport {
            id: retro.id.clone(),
            since_at: retro.since_at.clone(),
            until_at: retro.until_at.clone(),
            generated_at: now_iso(),
            run_count: 1,
            issue_count: 1,
            workpad_count: 1,
            repos: vec![accumulator.finish()],
        };
        let config = RetroProposalConfig {
            prompt_template: "# Default\n".to_string(),
            workflow_hash: "default-hash".to_string(),
            repos: BTreeMap::from([("widgets".to_string(), source.display().to_string())]),
            workspace_root: temp.path().join("proposals"),
            session_env: BTreeMap::new(),
            skills: BTreeMap::new(),
        };

        let rows = materialize_suggestions(&retro, &report, &config).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].target_type, "repo_workflow");
        assert_eq!(rows[0].target_path, symphony_worker::WORKFLOW_FILE);
        assert!(rows[0]
            .before_content
            .as_deref()
            .is_some_and(|content| content.contains("# Repo workflow")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_skill_targets_that_escape_through_symlinks() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("symphony-retro-{}", uuid::Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("symphony-outside-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(root.join(".agents"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        symlink(&outside, root.join(".agents/skills")).unwrap();

        let error = safe_repo_target(&root, ".agents/skills/symphony-workpad/SKILL.md")
            .await
            .unwrap_err();
        assert!(error.contains("outside the repository"));

        tokio::fs::remove_dir_all(root).await.ok();
        tokio::fs::remove_dir_all(outside).await.ok();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resolves_supported_in_repo_skill_symlinks() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("symphony-retro-{}", uuid::Uuid::new_v4()));
        let shared_skill = root.join("shared/symphony-workpad");
        tokio::fs::create_dir_all(root.join(".agents/skills"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(&shared_skill).await.unwrap();
        tokio::fs::write(shared_skill.join("SKILL.md"), "# Workpad\n")
            .await
            .unwrap();
        symlink(
            "../../shared/symphony-workpad",
            root.join(".agents/skills/symphony-workpad"),
        )
        .unwrap();

        let target = safe_repo_target(&root, ".agents/skills/symphony-workpad/SKILL.md")
            .await
            .unwrap();
        assert_eq!(
            repo_relative_target(&root, &target).await.unwrap(),
            "shared/symphony-workpad/SKILL.md"
        );

        tokio::fs::remove_dir_all(root).await.ok();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn times_out_stalled_retro_subprocesses() {
        let error = command_output_with_timeout(
            "sh",
            &["-c", "sleep 2"],
            None,
            &BTreeMap::new(),
            Duration::from_millis(25),
        )
        .await
        .unwrap_err();
        assert!(error.contains("timed out"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn retro_commits_use_the_users_git_identity() {
        let root = std::env::temp_dir().join(format!("symphony-retro-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("workspace");
        let global_config = root.join("gitconfig");
        tokio::fs::create_dir_all(&root).await.unwrap();

        let workspace_arg = workspace.display().to_string();
        let config_arg = global_config.display().to_string();
        git_test_ok(None, &["init", &workspace_arg]).await;
        git_test_ok(
            None,
            &["config", "--file", &config_arg, "user.name", "Retro User"],
        )
        .await;
        git_test_ok(
            None,
            &[
                "config",
                "--file",
                &config_arg,
                "user.email",
                "retro-user@example.com",
            ],
        )
        .await;
        tokio::fs::write(workspace.join("change.md"), "reviewed change\n")
            .await
            .unwrap();
        let env = BTreeMap::from([
            ("GIT_CONFIG_GLOBAL".to_string(), config_arg),
            ("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string()),
        ]);

        commit_retro_changes(&workspace, &["change.md".to_string()], &env)
            .await
            .unwrap();

        let author = command_output(
            "git",
            &["log", "-1", "--format=%an%n%ae"],
            Some(&workspace),
            &env,
        )
        .await
        .unwrap();
        assert!(author.status.success());
        assert_eq!(
            String::from_utf8_lossy(&author.stdout).trim(),
            "Retro User\nretro-user@example.com"
        );
        let local_email = command_output(
            "git",
            &["config", "--local", "--get", "user.email"],
            Some(&workspace),
            &env,
        )
        .await
        .unwrap();
        assert!(!local_email.status.success());

        tokio::fs::remove_dir_all(root).await.ok();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reuses_a_pushed_branch_when_its_reviewed_tree_matches() {
        let root = std::env::temp_dir().join(format!("symphony-retro-{}", uuid::Uuid::new_v4()));
        let remote = root.join("remote.git");
        let seed = root.join("seed");
        let retry = root.join("retry");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let remote_arg = remote.display().to_string();
        let seed_arg = seed.display().to_string();
        let retry_arg = retry.display().to_string();
        let branch = "symphony/retro-12345678";

        git_test_ok(None, &["init", "--bare", &remote_arg]).await;
        git_test_ok(None, &["init", &seed_arg]).await;
        git_test_ok(Some(&seed), &["config", "user.name", "Test"]).await;
        git_test_ok(Some(&seed), &["config", "user.email", "test@example.com"]).await;
        tokio::fs::write(seed.join("SKILL.md"), "base\n")
            .await
            .unwrap();
        git_test_ok(Some(&seed), &["add", "SKILL.md"]).await;
        git_test_ok(Some(&seed), &["commit", "-m", "base"]).await;
        git_test_ok(Some(&seed), &["branch", "-M", "main"]).await;
        git_test_ok(Some(&seed), &["remote", "add", "origin", &remote_arg]).await;
        git_test_ok(Some(&seed), &["push", "-u", "origin", "main"]).await;
        git_test_ok(Some(&seed), &["checkout", "-b", branch]).await;
        tokio::fs::write(seed.join("SKILL.md"), "reviewed change\n")
            .await
            .unwrap();
        git_test_ok(Some(&seed), &["add", "SKILL.md"]).await;
        git_test_ok(Some(&seed), &["commit", "-m", "reviewed"]).await;
        git_test_ok(Some(&seed), &["push", "-u", "origin", branch]).await;

        git_test_ok(
            None,
            &[
                "clone",
                "--branch",
                "main",
                "--single-branch",
                &remote_arg,
                &retry_arg,
            ],
        )
        .await;
        git_test_ok(Some(&retry), &["config", "user.name", "Test"]).await;
        git_test_ok(Some(&retry), &["config", "user.email", "test@example.com"]).await;
        git_test_ok(Some(&retry), &["checkout", "-b", branch]).await;
        tokio::fs::write(retry.join("SKILL.md"), "reviewed change\n")
            .await
            .unwrap();
        git_test_ok(Some(&retry), &["add", "SKILL.md"]).await;
        git_test_ok(Some(&retry), &["commit", "-m", "retry"]).await;

        assert_eq!(
            remote_branch_matches_local(&retry, branch, &BTreeMap::new())
                .await
                .unwrap(),
            Some(true)
        );

        tokio::fs::write(retry.join("SKILL.md"), "different change\n")
            .await
            .unwrap();
        git_test_ok(Some(&retry), &["add", "SKILL.md"]).await;
        git_test_ok(Some(&retry), &["commit", "-m", "different"]).await;
        assert_eq!(
            remote_branch_matches_local(&retry, branch, &BTreeMap::new())
                .await
                .unwrap(),
            Some(false)
        );

        tokio::fs::remove_dir_all(root).await.ok();
    }

    #[test]
    fn parses_workpad_sections() {
        let body = r#"
## Symphony Workpad

### Notes

- clean
- blocked by missing token

### Confusions

- unclear whether screenshots are required
- [ ] PR feedback state was unknown

### Validation

- [x] cargo test
"#;
        assert_eq!(
            markdown_section_items(body, "Confusions"),
            vec![
                "unclear whether screenshots are required".to_string(),
                "PR feedback state was unknown".to_string(),
            ]
        );
        assert_eq!(
            markdown_section_items(body, "Notes"),
            vec!["clean".to_string(), "blocked by missing token".to_string()]
        );
    }

    #[test]
    fn maps_common_confusions_to_skills() {
        assert_eq!(
            skill_target("playwright screenshot failed"),
            Some("symphony-screenshot")
        );
        assert_eq!(
            skill_target("review feedback was unclear"),
            Some("symphony-pr-feedback")
        );
        assert_eq!(
            skill_target("workpad confusion unclear whether screenshots are required"),
            Some("symphony-screenshot")
        );
        assert_eq!(skill_target("unrelated"), None);
    }

    #[test]
    fn treats_nonzero_exits_as_tool_confusion() {
        assert!(should_report_tool_confusion(None, "exit 1"));
        assert!(should_report_tool_confusion(
            None,
            "command exited with exit 127"
        ));
        assert!(should_report_tool_confusion(
            None,
            "error: permission denied"
        ));
        assert!(should_report_tool_confusion(
            Some(&serde_json::json!({ "is_error": true })),
            "missing dependency"
        ));
        assert!(!should_report_tool_confusion(None, "exit 0"));
        assert!(!should_report_tool_confusion(
            None,
            "read succeeded and source mentioned a missing file"
        ));

        let exit_one = tool_confusion_finding("bash", "exit 1");
        let exit_two = tool_confusion_finding("bash", "exit 2");
        assert_eq!(exit_one, exit_two);
        assert_eq!(exit_one.0, "tool:bash:nonzero-exit");
        assert_eq!(exit_one.1, "`bash` commands exited unsuccessfully");

        let payload = serde_json::json!({
            "args": { "command": "/bin/zsh -lc 'npm run db:start'" },
            "result_summary": "exit 1",
            "tool": "bash"
        });
        assert_eq!(
            tool_command(Some(&payload)),
            Some("/bin/zsh -lc 'npm run db:start'")
        );
    }

    #[test]
    fn aggregates_nonzero_exit_codes_into_one_contextual_finding() {
        let mut repo = RepoAccumulator::new("widgets".to_string());
        for (summary, command) in [
            ("exit 1", "npm run db:start"),
            ("exit 2", "cargo test --workspace"),
        ] {
            let (key, title, detail) = tool_confusion_finding("bash", summary);
            repo.push_finding(
                key,
                title,
                detail,
                RetroSeverity::Medium,
                RetroEvidence {
                    issue_identifier: "SYM-1".to_string(),
                    run_id: Some("run-1".to_string()),
                    run_number: Some(1),
                    event_id: None,
                    kind: "tool_call".to_string(),
                    summary: format!("{command} → {summary}"),
                },
            );
        }

        let report = repo.finish();
        assert_eq!(report.findings.len(), 1);
        assert_eq!(report.findings[0].occurrences, 2);
        assert_eq!(report.findings[0].evidence.len(), 2);
        assert_eq!(report.suggestions.len(), 1);
        assert_eq!(
            report.suggestions[0].title,
            "Clarify non-zero command handling for widgets"
        );
    }

    #[test]
    fn consolidates_findings_that_generate_the_same_suggestion() {
        let mut repo = RepoAccumulator::new("widgets".to_string());
        for (key, issue, run_id, detail) in [
            (
                "run:failure:worker_restarted",
                "SYM-1",
                "run-1",
                "Worker restarted while run was in-flight.",
            ),
            (
                "run:failure:agent_failure",
                "SYM-2",
                "run-2",
                "Validation failed after the worker resumed.",
            ),
        ] {
            repo.push_finding(
                key.to_string(),
                "Runs failed while work was in progress".to_string(),
                detail.to_string(),
                RetroSeverity::High,
                RetroEvidence {
                    issue_identifier: issue.to_string(),
                    run_id: Some(run_id.to_string()),
                    run_number: Some(1),
                    event_id: None,
                    kind: "run".to_string(),
                    summary: detail.to_string(),
                },
            );
        }

        let report = repo.finish();

        assert_eq!(report.findings.len(), 1);
        assert_eq!(report.suggestions.len(), 1);
        assert_eq!(report.findings[0].occurrences, 2);
        assert_eq!(report.findings[0].evidence.len(), 2);
        assert_eq!(
            report.suggestions[0].title,
            "Clarify validation requirements for widgets"
        );
        assert_eq!(
            report.suggestions[0].rationale,
            "2 occurrences found in widgets with high severity."
        );
        assert!(!report.suggestions[0].body.contains("Observed pattern"));
        assert!(!report.suggestions[0].body.contains("Worker restarted"));
        assert!(report.suggestions[0]
            .body
            .contains("Run the repository's required validation before pushing"));
    }

    #[test]
    fn skips_workpads_that_match_previous_retro_hash() {
        let workpad = WorkpadComment {
            issue_id: "lin-1".to_string(),
            comment_id: "comment-1".to_string(),
            body: "## Symphony Workpad\n\n### Confusions\n\n- already reported".to_string(),
            created_at: Some("2026-06-17T00:00:00.000Z".to_string()),
            updated_at: Some("2026-06-19T00:00:00.000Z".to_string()),
        };
        let hash = hash_body(&workpad.body);

        assert!(!should_inspect_workpad(
            &workpad,
            &hash,
            Some(&hash),
            "2026-06-18T00:00:00.000Z",
            "2026-06-20T00:00:00.000Z",
        ));
    }

    #[test]
    fn inspects_changed_or_new_workpads_only_when_the_change_is_in_the_window() {
        let workpad = WorkpadComment {
            issue_id: "lin-1".to_string(),
            comment_id: "comment-1".to_string(),
            body: "## Symphony Workpad\n\n### Confusions\n\n- new confusion".to_string(),
            created_at: Some("2026-06-17T00:00:00.000Z".to_string()),
            updated_at: Some("2026-06-19T00:00:00.000Z".to_string()),
        };
        let hash = hash_body(&workpad.body);
        let previous_hash = "older-hash".to_string();

        assert!(should_inspect_workpad(
            &workpad,
            &hash,
            Some(&previous_hash),
            "2026-06-18T00:00:00.000Z",
            "2026-06-20T00:00:00.000Z",
        ));
        assert!(should_inspect_workpad(
            &workpad,
            &hash,
            None,
            "2026-06-18T00:00:00.000Z",
            "2026-06-20T00:00:00.000Z",
        ));
        assert!(!should_inspect_workpad(
            &workpad,
            &hash,
            None,
            "2026-06-20T00:00:00.000Z",
            "2026-06-21T00:00:00.000Z",
        ));
        assert!(!should_inspect_workpad(
            &workpad,
            &hash,
            Some(&previous_hash),
            "2026-06-18T00:00:00.000Z",
            "2026-06-18T12:00:00.000Z",
        ));
    }

    #[test]
    fn workpad_existence_and_hashes_do_not_pull_future_edits_into_the_window() {
        let future_workpad = WorkpadComment {
            issue_id: "lin-1".to_string(),
            comment_id: "comment-1".to_string(),
            body: "## Symphony Workpad".to_string(),
            created_at: Some("2026-06-21T00:00:00.000Z".to_string()),
            updated_at: Some("2026-06-21T00:00:00.000Z".to_string()),
        };
        assert!(!workpad_existed_by(
            &future_workpad,
            "2026-06-20T00:00:00.000Z"
        ));

        let updated_after_window = WorkpadComment {
            created_at: Some("2026-06-17T00:00:00.000Z".to_string()),
            updated_at: Some("2026-06-21T00:00:00.000Z".to_string()),
            ..future_workpad
        };
        assert!(workpad_existed_by(
            &updated_after_window,
            "2026-06-20T00:00:00.000Z"
        ));
        assert!(!workpad_hash_available_in_window(
            &updated_after_window,
            "2026-06-20T00:00:00.000Z"
        ));
    }

    #[test]
    fn workpad_retro_hash_ignores_uninspected_sections() {
        let base = r#"
## Symphony Workpad

### Confusions

- unclear screenshots

### Validation

- [ ] cargo test
"#;
        let validation_changed = r#"
## Symphony Workpad

### Confusions

- unclear screenshots

### Validation

- [x] cargo test
"#;
        let confusion_changed = r#"
## Symphony Workpad

### Confusions

- unclear screenshots
- unclear review state

### Validation

- [x] cargo test
"#;

        assert_eq!(
            retro_relevant_workpad_hash(base),
            retro_relevant_workpad_hash(validation_changed)
        );
        assert_ne!(
            retro_relevant_workpad_hash(base),
            retro_relevant_workpad_hash(confusion_changed)
        );
    }
}
