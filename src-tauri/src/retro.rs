use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use symphony_storage::{
    now_iso, AgentEventRow, Repository, RetroInputRow, RetroRow, RunWithIssueRow,
    WorkpadSnapshotRow,
};
use symphony_tracker::{TrackerClient, WorkpadComment};
use tokio::sync::Mutex;

const RETRO_BEGINNING: &str = "1970-01-01T00:00:00.000Z";
const INTERRUPTED_RETRO_MESSAGE: &str = "Retro interrupted before completion.";
const MAX_FINDINGS_PER_REPO: usize = 8;
const MAX_EVIDENCE_PER_FINDING: usize = 5;

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
    fn idle() -> Self {
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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

#[derive(Debug, Clone, Default)]
pub struct RetroManager {
    inner: Arc<Mutex<Option<RetroStatus>>>,
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

    pub async fn start<T>(&self, repo: Repository, tracker: T) -> Result<RetroStatus, String>
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
            let result = build_retro(&inner, repo.clone(), tracker, retro.clone()).await;
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
    Ok(report)
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
                repo.push_finding(
                    format!("tool:{tool}:{}", normalized_key(summary)),
                    format!("`{tool}` calls produced confusing results"),
                    truncate_detail(summary),
                    RetroSeverity::Medium,
                    event_evidence(run, event, "tool_call", summary),
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
        let mut findings = self.findings.into_values().collect::<Vec<_>>();
        findings.sort_by(|a, b| {
            b.severity
                .cmp(&a.severity)
                .then_with(|| b.occurrences.cmp(&a.occurrences))
                .then_with(|| a.title.cmp(&b.title))
        });
        findings.truncate(MAX_FINDINGS_PER_REPO);
        let suggestions = findings
            .iter()
            .map(|finding| suggestion_for(&self.repo_name, finding))
            .collect();
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

fn suggestion_for(repo_name: &str, finding: &RetroFinding) -> RetroSuggestion {
    let joined = finding.detail.to_lowercase();
    let (target_type, target_id) = if let Some(skill) = skill_target(&joined) {
        (RetroSuggestionTarget::Skill, skill.to_string())
    } else {
        (RetroSuggestionTarget::Prompt, "common prompt".to_string())
    };
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
        title: format!(
            "Clarify `{}` for {}",
            short_title(&finding.title),
            repo_name
        ),
        body: format!(
            "Add guidance to {target_label} for this repeated pattern: {}",
            finding.detail
        ),
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
    let value = value.trim_matches('`').trim();
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

fn hash_body(body: &str) -> String {
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
