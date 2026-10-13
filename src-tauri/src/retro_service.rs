//! Retro application owner: review policy, reservations, settings CAS and PR
//! work live here. The desktop adapter supplies runtime values and projects IPC
//! types; no GUI runtime or state container participates in these operations.
use crate::{
    retro::{
        clone_repo_snapshot, hash_body, integrate_retro_guidance, parse_report, run_repo_pr_batch,
        uses_legacy_retro_section, RetroManager, RetroProposalConfig, RetroReport, RetroStatus,
    },
    settings::workflow_from_settings,
    settings_store::SettingsStore,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Arc,
};
use symphony_contracts::AppSettings;
use symphony_core::{
    BatchKind, BatchState, ProposalState, RunnableConfig, SuggestionDecision, SuggestionTarget,
};
use symphony_storage::{
    now_iso, Repository, RetroBatchReservation, RetroBatchRow, RetroRow, RetroSuggestionRow,
};
use symphony_tracker::LinearTracker;
use symphony_worker::{
    resolve_repo_workflow_at_ref, resolve_workspace_root_dir, sanitize_key, RepoWorkflowSource,
    SkillFile, WorkerManager, WorkerStartConfig,
};
use tokio::{sync::Mutex, task::JoinSet};
use uuid::Uuid;

const RETRO_REVIEW_INCOMPLETE_MESSAGE: &str =
    "Review every available suggestion before creating a change batch.";
const RETRO_ACCEPTED_SET_CHANGED_MESSAGE: &str = "Accepted suggestions changed while the batch was starting. Review the latest decisions and retry.";

/// A fresh command-time snapshot. No service reads process environment or OS
/// credentials, and a settings write cannot replace unrelated saved fields.
pub struct RetroRuntime {
    pub app_data_dir: PathBuf,
    pub api_key: Option<String>,
    pub env: BTreeMap<String, String>,
    pub skills: Vec<SkillFile>,
}

impl RetroRuntime {
    fn worker_config(&self, settings: &AppSettings) -> Result<WorkerStartConfig, String> {
        Ok(WorkerStartConfig {
            runtime: RunnableConfig::new(
                settings.settings_revision,
                workflow_from_settings(settings, self.api_key.as_deref()),
                settings.repos.clone(),
                settings.session_env.clone(),
            )
            .map_err(|error| error.to_string())?,
            skills: self.skills.clone(),
            env: self.env.clone(),
            app_data_dir: self.app_data_dir.clone(),
        })
    }
}

#[async_trait::async_trait]
trait RetroEffects: Send + Sync {
    async fn confirm_default_source(
        &self,
        settings: &AppSettings,
        suggestions: &[RetroSuggestionRow],
        root: &Path,
    ) -> Result<(), String>;
    async fn run_pr_batch(
        &self,
        repository: Repository,
        batch: RetroBatchRow,
        suggestions: Vec<RetroSuggestionRow>,
        workspace: PathBuf,
        session_env: BTreeMap<String, String>,
    );
}

struct NativeRetroEffects;

#[async_trait::async_trait]
impl RetroEffects for NativeRetroEffects {
    async fn confirm_default_source(
        &self,
        settings: &AppSettings,
        suggestions: &[RetroSuggestionRow],
        root: &Path,
    ) -> Result<(), String> {
        let mut checked_repos = BTreeSet::new();
        let mut source_changed = None;
        for suggestion in suggestions {
            if !checked_repos.insert(suggestion.repo_name.clone()) {
                continue;
            }
            let repo_url = current_retro_repo_url(
                settings,
                &suggestion.repo_name,
                suggestion.repo_url.as_deref(),
            );
            let Some(repo_url) = repo_url else {
                source_changed = Some(format!(
                    "Repository `{}` was removed or reconfigured.",
                    suggestion.repo_name
                ));
                break;
            };
            let workspace = root.join(sanitize_key(&suggestion.repo_name));
            match clone_repo_snapshot(&repo_url, &workspace, &settings.session_env).await {
                Ok(snapshot) => {
                    let resolved = resolve_repo_workflow_at_ref(
                        &snapshot.root,
                        &snapshot.head,
                        &settings.prompt_template,
                    )
                    .await;
                    tokio::fs::remove_dir_all(&snapshot.root).await.ok();
                    if resolved.source != RepoWorkflowSource::Default {
                        source_changed = Some(format!(
                            "Repository `{}` now uses a checked-in workflow.",
                            suggestion.repo_name
                        ));
                        break;
                    }
                }
                Err(error) => {
                    source_changed = Some(format!(
                        "Could not confirm the workflow source for `{}`: {error}",
                        suggestion.repo_name
                    ));
                    break;
                }
            }
        }
        tokio::fs::remove_dir_all(root).await.ok();

        match source_changed {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
    async fn run_pr_batch(
        &self,
        repository: Repository,
        batch: RetroBatchRow,
        suggestions: Vec<RetroSuggestionRow>,
        workspace: PathBuf,
        session_env: BTreeMap<String, String>,
    ) {
        run_repo_pr_batch(repository, batch, suggestions, workspace, session_env).await;
    }
}

#[derive(Clone)]
pub struct RetroService {
    repo: Repository,
    settings: SettingsStore,
    worker: WorkerManager,
    generation: RetroManager,
    effects: Arc<dyn RetroEffects>,
    jobs: Arc<Mutex<JoinSet<()>>>,
}

pub struct RetroSnapshot {
    pub row: RetroRow,
    pub report: Option<RetroReport>,
    pub suggestions: Vec<RetroSuggestionRow>,
    pub batches: Vec<RetroBatchRow>,
}

impl RetroService {
    pub fn new(repo: Repository, settings: SettingsStore, worker: WorkerManager) -> Self {
        Self {
            repo,
            settings,
            worker,
            generation: RetroManager::new(),
            effects: Arc::new(NativeRetroEffects),
            jobs: Arc::default(),
        }
    }

    // The owned task keeps a reserved operation alive if its caller disconnects.
    pub async fn apply_workflow(
        &self,
        retro_id: String,
        runtime: RetroRuntime,
    ) -> Result<RetroBatchRow, String> {
        let service = self.clone();
        tokio::spawn(async move { service.apply_workflow_inner(retro_id, runtime).await })
            .await
            .map_err(|error| error.to_string())?
    }

    pub async fn start_prs(
        &self,
        retro_id: String,
        runtime: RetroRuntime,
    ) -> Result<Vec<RetroBatchRow>, String> {
        let service = self.clone();
        tokio::spawn(async move { service.start_prs_inner(retro_id, runtime).await })
            .await
            .map_err(|error| error.to_string())?
    }

    pub async fn start(&self, runtime: RetroRuntime) -> Result<RetroStatus, String> {
        let service = self.clone();
        tokio::spawn(async move { service.start_inner(runtime).await })
            .await
            .map_err(|error| error.to_string())?
    }

    async fn start_inner(&self, runtime: RetroRuntime) -> Result<RetroStatus, String> {
        let Some(api_key) = runtime.api_key.clone() else {
            return Err(
                "No Linear API key configured. Add one under Settings → Linear, then run a retro."
                    .to_string(),
            );
        };
        let settings = self.settings.load().await?;
        let workflow = workflow_from_settings(&settings, Some(&api_key));
        let tracker = LinearTracker::new(workflow.front_matter.tracker.clone());
        let workspace_root = resolve_workspace_root_dir(
            &workflow.front_matter.workspace.root,
            &runtime.app_data_dir,
        );
        let proposal_config = RetroProposalConfig {
            prompt_template: settings.prompt_template.clone(),
            workflow_hash: workflow.source_hash.clone(),
            repos: settings
                .repos
                .iter()
                .map(|repo| (repo.name.clone(), repo.url.clone()))
                .collect(),
            workspace_root,
            session_env: settings.session_env.clone(),
            skills: runtime
                .skills
                .clone()
                .into_iter()
                .map(|skill| (skill.name, skill.content))
                .collect(),
        };
        self.generation
            .start(self.repo.clone(), tracker, proposal_config)
            .await
    }

    pub async fn status(&self) -> Result<RetroStatus, String> {
        Ok(self.generation.status().await)
    }

    pub async fn list(&self) -> Result<Vec<RetroRow>, String> {
        self.repo
            .list_retros(50)
            .await
            .map_err(|err| err.to_string())
    }

    pub async fn detail(&self, id: String) -> Result<Option<RetroSnapshot>, String> {
        let Some(row) = self
            .repo
            .get_retro(&id)
            .await
            .map_err(|err| err.to_string())?
        else {
            return Ok(None);
        };
        let suggestions = self
            .repo
            .list_retro_suggestions(&id)
            .await
            .map_err(|err| err.to_string())?;
        let batches = self
            .repo
            .list_retro_batches(&id)
            .await
            .map_err(|err| err.to_string())?;
        Ok(Some(RetroSnapshot {
            report: parse_report(&row)?,
            row,
            suggestions,
            batches,
        }))
    }

    pub async fn has_in_progress_batches(&self) -> Result<bool, String> {
        self.repo
            .has_in_progress_retro_batches()
            .await
            .map_err(|err| err.to_string())
    }

    pub async fn delete(&self, id: String) -> Result<(), String> {
        let deleted = self
            .repo
            .delete_retro(&id)
            .await
            .map_err(|err| err.to_string())?;
        if !deleted {
            return Err(
            "This retro was not found, is not the latest completed retro, or still has generation or batch work in progress."
                .to_string(),
        );
        }
        self.generation.forget(&id).await;
        Ok(())
    }

    pub async fn review(
        &self,
        id: String,
        decision: SuggestionDecision,
    ) -> Result<RetroSuggestionRow, String> {
        self.repo
            .set_retro_suggestion_decision(&id, decision)
            .await
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "Suggestion was not found.".to_string())
    }

    async fn apply_workflow_inner(
        &self,
        retro_id: String,
        runtime: RetroRuntime,
    ) -> Result<RetroBatchRow, String> {
        let plan = WorkflowPlan::prepare(
            self.repo
                .list_retro_suggestions(&retro_id)
                .await
                .map_err(|error| error.to_string())?,
        )?;
        let settings = self.settings.load().await?;
        let WorkflowPlan {
            suggestions,
            expected_ref,
            expected_prompt_hash,
        } = plan;
        let batch = RetroBatchRow {
            id: Uuid::new_v4().to_string(),
            retro_id: retro_id.clone(),
            kind: BatchKind::WorkflowUpdate,
            repo_name: None,
            repo_url: None,
            base_ref: Some(expected_ref.clone()),
            state: BatchState::Running,
            progress: Some("Checking workflow freshness…".to_string()),
            error: None,
            pr_url: None,
            created_at: now_iso(),
            completed_at: None,
        };
        let suggestion_ids = suggestions
            .iter()
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        self.repo
            .reserve_retro_batch(&batch, &suggestion_ids)
            .await
            .map_err(|err| err.to_string())
            .and_then(|reservation| match reservation {
                RetroBatchReservation::Created => Ok(()),
                RetroBatchReservation::ReviewIncomplete => {
                    Err(RETRO_REVIEW_INCOMPLETE_MESSAGE.to_string())
                }
                RetroBatchReservation::AcceptedSetChanged => {
                    Err(RETRO_ACCEPTED_SET_CHANGED_MESSAGE.to_string())
                }
                RetroBatchReservation::AlreadyReserved => {
                    Err("A workflow change batch already exists for this retro.".to_string())
                }
            })?;
        if suggestions.iter().any(uses_legacy_retro_section) {
            self.repo
                .update_retro_batch(
                    &batch.id,
                    BatchState::Stale,
                    Some("The proposal format changed."),
                    Some("Generate a new retro and review the updated in-place diff."),
                    None,
                )
                .await
                .map_err(|err| err.to_string())?;
            return self.workflow_batch(&batch).await;
        }
        if prompt_revision(&settings) != expected_prompt_hash {
            self.repo
                .update_retro_batch(
                    &batch.id,
                    BatchState::Stale,
                    Some("Prompt changed since this diff was prepared."),
                    Some("Generate a new retro and review the updated diff."),
                    None,
                )
                .await
                .map_err(|err| err.to_string())?;
            return self.workflow_batch(&batch).await;
        }

        // A prompt proposal targets the saved default only while every repository
        // represented by the batch still falls back to that default. If a repo
        // added a valid checked-in workflow after review, applying the old batch
        // would update the wrong source of truth.
        let source_check_root = resolve_workspace_root_dir(
            &workflow_from_settings(&settings, runtime.api_key.clone().as_deref())
                .front_matter
                .workspace
                .root,
            &runtime.app_data_dir,
        )
        .join("_retro-source-check")
        .join(&retro_id);
        let source_changed = self
            .effects
            .confirm_default_source(&settings, &suggestions, &source_check_root)
            .await
            .err();
        if let Some(error) = source_changed {
            self.repo
                .update_retro_batch(
                    &batch.id,
                    BatchState::Stale,
                    Some("A repository workflow source changed."),
                    Some(&format!(
                        "{error} Generate a new retro and review the updated diff."
                    )),
                    None,
                )
                .await
                .map_err(|err| err.to_string())?;
            return self.workflow_batch(&batch).await;
        }

        let guidance = suggestions
            .iter()
            .map(|suggestion| suggestion.guidance.clone())
            .collect::<Vec<_>>();
        let mut updated = settings;
        updated.prompt_template = integrate_retro_guidance(&updated.prompt_template, &guidance);
        if let Err(error) = runtime.worker_config(&updated) {
            self.repo
                .update_retro_batch(&batch.id, BatchState::Failed, None, Some(&error), None)
                .await
                .map_err(|err| err.to_string())?;
            return Err(error);
        }
        let updated = match self
            .settings
            .apply_prompt(
                updated.settings_revision,
                expected_prompt_hash,
                updated.prompt_template.clone(),
            )
            .await
        {
            Ok(updated) => updated,
            Err(error) => {
                self.repo
                    .update_retro_batch(&batch.id, BatchState::Failed, None, Some(&error), None)
                    .await
                    .map_err(|update_err| update_err.to_string())?;
                return Err(error);
            }
        };
        self.worker
            .reconfigure(runtime.worker_config(&updated)?)
            .await;
        self.repo
            .update_retro_batch(
                &batch.id,
                BatchState::Completed,
                Some("Workflow prompt updated."),
                None,
                None,
            )
            .await
            .map_err(|err| err.to_string())?;
        self.workflow_batch(&batch).await
    }

    async fn workflow_batch(&self, batch: &RetroBatchRow) -> Result<RetroBatchRow, String> {
        self.repo
            .list_retro_batches(&batch.retro_id)
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .find(|current| current.id == batch.id)
            .ok_or_else(|| "Workflow batch was not found.".to_string())
    }

    async fn start_prs_inner(
        &self,
        retro_id: String,
        runtime: RetroRuntime,
    ) -> Result<Vec<RetroBatchRow>, String> {
        let settings = self.settings.load().await?;
        let reviewed = ReviewedSuggestions::select(
            self.repo
                .list_retro_suggestions(&retro_id)
                .await
                .map_err(|error| error.to_string())?,
            ReviewTarget::Repository,
        )?;
        let by_repo = reviewed.by_repository();
        let blocked_repos = self
            .repo
            .list_retro_batches(&retro_id)
            .await
            .map_err(|err| err.to_string())?
            .into_iter()
            .filter(|batch| {
                batch.kind == BatchKind::RepoPr
                    && matches!(
                        batch.state,
                        BatchState::Queued
                            | BatchState::Running
                            | BatchState::Completed
                            | BatchState::Stale
                    )
            })
            .filter_map(|batch| batch.repo_name)
            .collect::<BTreeSet<_>>();
        let workspace_root = resolve_workspace_root_dir(
            &workflow_from_settings(&settings, runtime.api_key.clone().as_deref())
                .front_matter
                .workspace
                .root,
            &runtime.app_data_dir,
        );
        for (repo_name, suggestions) in by_repo {
            if blocked_repos.contains(&repo_name) {
                continue;
            }
            let stored_url = suggestions
                .first()
                .and_then(|suggestion| suggestion.repo_url.as_deref());
            let repo_url = current_retro_repo_url(&settings, &repo_name, stored_url);
            let legacy_proposal = suggestions.iter().any(uses_legacy_retro_section);
            let stale_error = if legacy_proposal {
                Some(
                "The proposal format changed. Generate a new retro and review the updated in-place diff."
                    .to_string(),
            )
            } else {
                repo_url.is_none().then(|| {
                format!(
                    "Repository `{repo_name}` was removed or its URL changed after this retro was generated. Generate a new retro before opening a PR."
                )
            })
            };
            let batch = RetroBatchRow {
                id: Uuid::new_v4().to_string(),
                retro_id: retro_id.clone(),
                kind: BatchKind::RepoPr,
                repo_name: Some(repo_name.clone()),
                repo_url,
                base_ref: suggestions.first().and_then(|item| item.base_ref.clone()),
                state: if stale_error.is_some() {
                    BatchState::Stale
                } else {
                    BatchState::Queued
                },
                progress: stale_error
                    .as_ref()
                    .map(|_| {
                        if legacy_proposal {
                            "Proposal format changed.".to_string()
                        } else {
                            "Repository configuration changed.".to_string()
                        }
                    })
                    .or_else(|| Some("Queued for PR creation…".to_string())),
                error: stale_error.clone(),
                pr_url: None,
                created_at: now_iso(),
                completed_at: stale_error.as_ref().map(|_| now_iso()),
            };
            let ids = suggestions
                .iter()
                .map(|item| item.id.clone())
                .collect::<Vec<_>>();
            let reservation = self
                .repo
                .reserve_retro_batch(&batch, &ids)
                .await
                .map_err(|err| err.to_string())?;
            match reservation {
                RetroBatchReservation::Created => {}
                RetroBatchReservation::ReviewIncomplete => {
                    return Err(RETRO_REVIEW_INCOMPLETE_MESSAGE.to_string());
                }
                RetroBatchReservation::AcceptedSetChanged => {
                    return Err(RETRO_ACCEPTED_SET_CHANGED_MESSAGE.to_string());
                }
                RetroBatchReservation::AlreadyReserved => continue,
            }
            if stale_error.is_some() {
                continue;
            }
            let repository = self.repo.clone();
            let session_env = settings.session_env.clone();
            let workspace = workspace_root
                .join("_retro-actions")
                .join(&retro_id)
                .join(sanitize_key(&repo_name));
            let effects = self.effects.clone();
            let mut jobs = self.jobs.lock().await;
            while jobs.try_join_next().is_some() {}
            jobs.spawn(async move {
                effects
                    .run_pr_batch(repository, batch, suggestions, workspace, session_env)
                    .await;
            });
        }
        self.repo
            .list_retro_batches(&retro_id)
            .await
            .map_err(|err| err.to_string())
    }
}

#[derive(Clone, Copy)]
enum ReviewTarget {
    Workflow,
    Repository,
}

/// A reviewed selection is the only input admitted to batch planning. Review
/// completeness applies to the whole retro, even when creating just one kind.
struct ReviewedSuggestions(Vec<RetroSuggestionRow>);

impl ReviewedSuggestions {
    fn select(all: Vec<RetroSuggestionRow>, target: ReviewTarget) -> Result<Self, String> {
        ensure_retro_review_complete(&all)?;
        let selected = all
            .into_iter()
            .filter(|suggestion| {
                let relevant = match target {
                    ReviewTarget::Workflow => suggestion.target_type == SuggestionTarget::Prompt,
                    ReviewTarget::Repository => {
                        matches!(
                            suggestion.target_type,
                            SuggestionTarget::Skill | SuggestionTarget::RepoWorkflow
                        )
                    }
                };
                relevant
                    && suggestion.decision == SuggestionDecision::Accepted
                    && suggestion.proposal_status == ProposalState::Ready
            })
            .collect::<Vec<_>>();
        if selected.is_empty() {
            return Err(match target {
                ReviewTarget::Workflow => "Accept at least one workflow suggestion first.",
                ReviewTarget::Repository => "Accept at least one repository suggestion first.",
            }
            .to_string());
        }
        Ok(Self(selected))
    }

    fn by_repository(self) -> BTreeMap<String, Vec<RetroSuggestionRow>> {
        let mut grouped = BTreeMap::<String, Vec<RetroSuggestionRow>>::new();
        for suggestion in self.0 {
            grouped
                .entry(suggestion.repo_name.clone())
                .or_default()
                .push(suggestion);
        }
        grouped
    }
}

struct WorkflowPlan {
    suggestions: Vec<RetroSuggestionRow>,
    expected_ref: String,
    expected_prompt_hash: String,
}

impl WorkflowPlan {
    fn prepare(all: Vec<RetroSuggestionRow>) -> Result<Self, String> {
        let suggestions = ReviewedSuggestions::select(all, ReviewTarget::Workflow)?.0;
        let expected_ref = suggestions
            .first()
            .and_then(|suggestion| suggestion.base_ref.clone())
            .ok_or_else(|| "Workflow proposal has no base revision.".to_string())?;
        let hashes = suggestions
            .iter()
            .filter_map(|suggestion| suggestion.base_hash.clone())
            .collect::<BTreeSet<_>>();
        if hashes.len() != 1 {
            return Err("Workflow proposals do not share one prompt revision.".to_string());
        }
        Ok(Self {
            suggestions,
            expected_ref,
            expected_prompt_hash: hashes.into_iter().next().expect("one prompt hash checked"),
        })
    }
}

fn ensure_retro_review_complete(suggestions: &[RetroSuggestionRow]) -> Result<(), String> {
    if suggestions.iter().any(|suggestion| {
        suggestion.proposal_status == ProposalState::Ready
            && suggestion.decision == SuggestionDecision::Pending
    }) {
        Err(RETRO_REVIEW_INCOMPLETE_MESSAGE.to_string())
    } else {
        Ok(())
    }
}

fn current_retro_repo_url(
    settings: &AppSettings,
    repo_name: &str,
    stored_url: Option<&str>,
) -> Option<String> {
    let stored_url = stored_url?.trim();
    let configured_url = settings
        .repos
        .iter()
        .find(|repo| repo.name == repo_name)?
        .url
        .trim();
    (!stored_url.is_empty() && stored_url == configured_url).then(|| configured_url.to_string())
}

fn prompt_revision(settings: &AppSettings) -> String {
    hash_body(&settings.prompt_template)
}

#[cfg(test)]
#[path = "retro_service_tests.rs"]
mod tests;
