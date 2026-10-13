use super::*;
use crate::settings_store::Credentials;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use symphony_core::RepoConfig;
use tokio::sync::Notify;

struct FakeCredentials;
impl Credentials for FakeCredentials {
    fn read(&self) -> Result<Option<String>, String> {
        Ok(Some("synthetic-test-key".into()))
    }
    fn set(&self, _value: Option<&str>) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Default)]
struct FakeEffects {
    checks: AtomicUsize,
    block_check: AtomicBool,
    entered: Notify,
    release: Notify,
    block_pr: AtomicBool,
    pr_entered: Notify,
    pr_release: Notify,
    jobs: Mutex<Vec<(String, Vec<String>)>>,
}

#[async_trait::async_trait]
impl RetroEffects for FakeEffects {
    async fn confirm_default_source(
        &self,
        _settings: &AppSettings,
        _suggestions: &[RetroSuggestionRow],
        _root: &Path,
    ) -> Result<(), String> {
        self.checks.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        if self.block_check.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        Ok(())
    }
    async fn run_pr_batch(
        &self,
        repository: Repository,
        batch: RetroBatchRow,
        suggestions: Vec<RetroSuggestionRow>,
        _workspace: PathBuf,
        _env: BTreeMap<String, String>,
    ) {
        self.jobs.lock().await.push((
            batch.repo_name.clone().unwrap(),
            suggestions.into_iter().map(|s| s.id).collect(),
        ));
        self.pr_entered.notify_one();
        if self.block_pr.load(Ordering::SeqCst) {
            self.pr_release.notified().await;
        }
        repository
            .update_retro_batch(
                &batch.id,
                "completed",
                Some("Fake PR completed"),
                None,
                Some("https://example.test/pr/1"),
            )
            .await
            .unwrap();
    }
}

fn configured_settings() -> AppSettings {
    AppSettings {
        prompt_template: "# Workflow\n\n## Instructions\n\n1. Existing guidance.\n".into(),
        repos: vec![RepoConfig {
            name: "widgets".into(),
            url: "git@github.com:acme/widgets.git".into(),
            is_default: true,
            ..Default::default()
        }],
        ..Default::default()
    }
}

struct Fixture {
    directory: tempfile::TempDir,
    service: RetroService,
    effects: Arc<FakeEffects>,
    retro: RetroRow,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(directory.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let settings = SettingsStore::new(
            directory.path().join("settings.json"),
            Arc::new(FakeCredentials),
        );
        settings.save(configured_settings(), None).await.unwrap();
        let worker = WorkerManager::new(repo.clone());
        let mut service = RetroService::new(
            repo.clone(),
            settings,
            worker,
            crate::validate_workflow_settings,
        );
        let effects = Arc::new(FakeEffects::default());
        service.effects = effects.clone();
        let retro = repo
            .create_retro("2000-01-01T00:00:00Z", "2000-01-02T00:00:00Z")
            .await
            .unwrap();
        repo.finish_retro(&retro.id, "{}", 0, 0).await.unwrap();
        Self {
            directory,
            service,
            effects,
            retro,
        }
    }
    fn runtime(&self) -> RetroRuntime {
        RetroRuntime {
            app_data_dir: self.directory.path().into(),
            api_key: Some("synthetic-test-key".into()),
            env: BTreeMap::new(),
            skills: vec![],
        }
    }
    async fn suggestion(&self, id: &str, target: &str, decision: &str) -> RetroSuggestionRow {
        let settings = self.service.settings.load().await.unwrap();
        let row = RetroSuggestionRow {
            id: id.into(),
            retro_id: self.retro.id.clone(),
            repo_name: "widgets".into(),
            repo_url: Some(settings.repos[0].url.clone()),
            finding_index: 0,
            target_type: target.into(),
            target_id: id.into(),
            target_path: "WORKFLOW.md".into(),
            title: "Validate changes".into(),
            body: "Run checks".into(),
            rationale: "Repeated failure".into(),
            confidence: "high".into(),
            guidance: "Validate changes before pushing.".into(),
            before_content: Some(settings.prompt_template.clone()),
            after_content: Some(integrate_retro_guidance(
                &settings.prompt_template,
                &["Validate changes before pushing.".into()],
            )),
            unified_diff: None,
            base_ref: Some("reviewed-ref".into()),
            base_hash: Some(prompt_revision(&settings)),
            proposal_status: "ready".into(),
            proposal_error: None,
            decision: decision.into(),
            decided_at: None,
            created_at: now_iso(),
        };
        self.service
            .repo
            .insert_retro_suggestions(std::slice::from_ref(&row))
            .await
            .unwrap();
        row
    }
    async fn join_jobs(&self) {
        while let Some(result) = self.service.jobs.lock().await.join_next().await {
            result.unwrap();
        }
    }
}

#[tokio::test]
async fn whole_retro_review_is_required_before_either_batch_kind() {
    let fixture = Fixture::new().await;
    fixture.suggestion("prompt", "prompt", "accepted").await;
    let pending = fixture.suggestion("skill", "skill", "pending").await;
    assert_eq!(
        fixture
            .service
            .apply_workflow(fixture.retro.id.clone(), fixture.runtime())
            .await
            .unwrap_err(),
        RETRO_REVIEW_INCOMPLETE_MESSAGE
    );
    assert_eq!(
        fixture
            .service
            .start_prs(fixture.retro.id.clone(), fixture.runtime())
            .await
            .unwrap_err(),
        RETRO_REVIEW_INCOMPLETE_MESSAGE
    );
    assert!(fixture
        .service
        .repo
        .list_retro_batches(&fixture.retro.id)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(fixture.effects.checks.load(Ordering::SeqCst), 0);
    assert!(fixture
        .service
        .review(pending.id.clone(), "invalid".into())
        .await
        .is_err());
    assert_eq!(
        fixture
            .service
            .review(pending.id, "rejected".into())
            .await
            .unwrap()
            .decision,
        "rejected"
    );
    let batch = fixture
        .service
        .apply_workflow(fixture.retro.id.clone(), fixture.runtime())
        .await
        .unwrap();
    assert_eq!(batch.state, "completed");
}

#[tokio::test]
async fn workflow_apply_uses_settings_cas_after_source_check() {
    let fixture = Fixture::new().await;
    fixture.suggestion("prompt", "prompt", "accepted").await;
    fixture.effects.block_check.store(true, Ordering::SeqCst);
    let service = fixture.service.clone();
    let id = fixture.retro.id.clone();
    let runtime = fixture.runtime();
    let applying = tokio::spawn(async move { service.apply_workflow(id, runtime).await });
    fixture.effects.entered.notified().await;
    let mut saved = fixture.service.settings.load().await.unwrap();
    let original_prompt = saved.prompt_template.clone();
    saved.polling_interval_ms = 12345;
    fixture.service.settings.save(saved, None).await.unwrap();
    fixture.effects.release.notify_one();
    let error = applying.await.unwrap().unwrap_err();
    assert!(error.contains("Settings changed"));
    let saved = fixture.service.settings.load().await.unwrap();
    assert_eq!(saved.settings_revision, 2);
    assert_eq!(saved.polling_interval_ms, 12345);
    assert_eq!(saved.prompt_template, original_prompt);
    let batch = fixture
        .service
        .repo
        .list_retro_batches(&fixture.retro.id)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(batch.state, "failed");
}

#[tokio::test]
async fn disconnected_caller_does_not_abandon_reserved_workflow_application() {
    let fixture = Fixture::new().await;
    fixture.suggestion("prompt", "prompt", "accepted").await;
    fixture.effects.block_check.store(true, Ordering::SeqCst);
    let service = fixture.service.clone();
    let id = fixture.retro.id.clone();
    let runtime = fixture.runtime();
    let caller = tokio::spawn(async move { service.apply_workflow(id, runtime).await });
    fixture.effects.entered.notified().await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    fixture.effects.release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let batches = fixture
                .service
                .repo
                .list_retro_batches(&fixture.retro.id)
                .await
                .unwrap();
            if batches[0].state == "completed" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let saved = fixture.service.settings.load().await.unwrap();
    assert_eq!(saved.settings_revision, 2);
    assert!(saved
        .prompt_template
        .contains("Validate changes before pushing."));
    assert!(fixture
        .service
        .apply_workflow(fixture.retro.id.clone(), fixture.runtime())
        .await
        .unwrap_err()
        .contains("already exists"));
    assert_eq!(
        fixture
            .service
            .settings
            .load()
            .await
            .unwrap()
            .settings_revision,
        2
    );
}

#[tokio::test]
async fn concurrent_pr_requests_reserve_once_per_repository_and_delete_only_when_complete() {
    let fixture = Fixture::new().await;
    fixture.effects.block_pr.store(true, Ordering::SeqCst);
    fixture.suggestion("skill-one", "skill", "accepted").await;
    fixture
        .suggestion("workflow-two", "repo_workflow", "accepted")
        .await;
    let (first, second) = tokio::join!(
        fixture
            .service
            .start_prs(fixture.retro.id.clone(), fixture.runtime()),
        fixture
            .service
            .start_prs(fixture.retro.id.clone(), fixture.runtime())
    );
    first.unwrap();
    second.unwrap();
    fixture.effects.pr_entered.notified().await;
    assert!(fixture.service.has_in_progress_batches().await.unwrap());
    assert!(fixture
        .service
        .delete(fixture.retro.id.clone())
        .await
        .is_err());
    let reserved = fixture
        .service
        .review("skill-one".into(), "rejected".into())
        .await
        .unwrap();
    assert_eq!(reserved.decision, "accepted");
    fixture.effects.pr_release.notify_one();
    fixture.join_jobs().await;
    let calls = fixture.effects.jobs.lock().await;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "widgets");
    assert_eq!(calls[0].1.len(), 2);
    drop(calls);
    let batches = fixture
        .service
        .repo
        .list_retro_batches(&fixture.retro.id)
        .await
        .unwrap();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].state, "completed");
    assert!(fixture
        .service
        .detail(fixture.retro.id.clone())
        .await
        .unwrap()
        .is_some());
    fixture
        .service
        .delete(fixture.retro.id.clone())
        .await
        .unwrap();
    assert!(fixture
        .service
        .detail(fixture.retro.id.clone())
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn repository_source_change_marks_prompt_batch_stale_without_writing_settings() {
    let mut fixture = Fixture::new().await;
    let source = fixture.directory.path().join("source");
    std::fs::create_dir_all(&source).unwrap();
    for args in [
        &["init", "-b", "main"][..],
        &["config", "user.name", "Fixture"],
        &["config", "user.email", "fixture@example.test"],
    ] {
        let output = crate::retro::command_output("git", args, Some(&source), &BTreeMap::new())
            .await
            .unwrap();
        assert!(output.status.success());
    }
    std::fs::write(
        source.join(symphony_worker::WORKFLOW_FILE),
        "# Workflow\n\n## Instructions\n\n1. Use repository instructions.\n",
    )
    .unwrap();
    for args in [
        &["add", symphony_worker::WORKFLOW_FILE][..],
        &["commit", "-m", "fixture"],
    ] {
        assert!(
            crate::retro::command_output("git", args, Some(&source), &BTreeMap::new())
                .await
                .unwrap()
                .status
                .success()
        );
    }
    let mut settings = fixture.service.settings.load().await.unwrap();
    settings.repos[0].url = source.display().to_string();
    let saved = fixture.service.settings.save(settings, None).await.unwrap();
    fixture.suggestion("prompt", "prompt", "accepted").await;
    fixture.service.effects = Arc::new(NativeRetroEffects);
    let batch = fixture
        .service
        .apply_workflow(fixture.retro.id.clone(), fixture.runtime())
        .await
        .unwrap();
    assert_eq!(batch.state, "stale");
    assert!(batch.error.unwrap().contains("checked-in workflow"));
    assert_eq!(
        fixture
            .service
            .settings
            .load()
            .await
            .unwrap()
            .settings_revision,
        saved.settings_revision
    );
    assert_eq!(
        fixture
            .service
            .settings
            .load()
            .await
            .unwrap()
            .prompt_template,
        saved.prompt_template
    );
}

#[tokio::test]
async fn generation_without_credentials_does_not_create_a_retro() {
    let fixture = Fixture::new().await;
    let before = fixture.service.list().await.unwrap().len();
    let mut runtime = fixture.runtime();
    runtime.api_key = None;
    assert!(fixture
        .service
        .start(runtime)
        .await
        .unwrap_err()
        .contains("No Linear API key"));
    assert_eq!(fixture.service.list().await.unwrap().len(), before);
}
#[test]
fn retro_prs_require_the_saved_repo_name_and_url_to_match() {
    let mut settings = configured_settings();
    let stored = "git@github.com:acme/widgets.git";
    assert_eq!(
        current_retro_repo_url(&settings, "widgets", Some(stored)).as_deref(),
        Some(stored)
    );

    settings.repos[0].url = "git@github.com:acme/replacement.git".to_string();
    assert!(current_retro_repo_url(&settings, "widgets", Some(stored)).is_none());
    assert!(current_retro_repo_url(&settings, "removed", Some(stored)).is_none());
}

#[test]
fn prompt_revision_ignores_unrelated_workflow_settings() {
    let settings = configured_settings();
    let revision = prompt_revision(&settings);
    let original_workflow = workflow_from_settings(&settings, Some("lin_api_test"));
    let mut changed = settings;
    changed.active_states.push("Needs review".to_string());
    let changed_workflow = workflow_from_settings(&changed, Some("lin_api_test"));

    assert_ne!(original_workflow.source_hash, changed_workflow.source_hash);
    assert_eq!(prompt_revision(&changed), revision);
}
