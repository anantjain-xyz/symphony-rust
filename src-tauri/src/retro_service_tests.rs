use super::*;
use crate::settings_store::Credentials;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use symphony_core::RepoConfig;
use tokio::sync::Notify;

struct FakeCredentials(
    std::sync::Mutex<Option<String>>,
    AtomicBool,
    std::sync::Mutex<std::collections::VecDeque<bool>>,
);
impl Credentials for FakeCredentials {
    fn read(&self) -> Result<Option<String>, String> {
        let unavailable = self
            .2
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| self.1.load(Ordering::SeqCst));
        if unavailable {
            Err("Synthetic keyring unavailable".into())
        } else {
            Ok(self.0.lock().unwrap().clone())
        }
    }
    fn set(&self, value: Option<&str>) -> Result<(), String> {
        *self.0.lock().unwrap() = value.map(str::to_owned);
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
    environments: Mutex<Vec<BTreeMap<String, String>>>,
    admitted_batch_counts: Mutex<Vec<usize>>,
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
        env: BTreeMap<String, String>,
    ) {
        self.environments.lock().await.push(env);
        self.admitted_batch_counts.lock().await.push(
            repository
                .list_retro_batches(&batch.retro_id)
                .await
                .unwrap()
                .len(),
        );
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
                BatchState::Completed,
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
    credentials: Arc<FakeCredentials>,
    retro: RetroRow,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(directory.path().join("test.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let credentials = Arc::new(FakeCredentials(
            std::sync::Mutex::new(Some("synthetic-test-key".into())),
            AtomicBool::new(false),
            std::sync::Mutex::default(),
        ));
        let settings =
            SettingsStore::new(directory.path().join("settings.json"), credentials.clone());
        settings.save(configured_settings(), None).await.unwrap();
        let worker = WorkerManager::new(repo.clone());
        let mut service = RetroService::new(repo.clone(), settings, worker);
        let effects = Arc::new(FakeEffects::default());
        service.effects = effects.clone();
        let retro = repo
            .create_retro("2000-01-01T00:00:00Z", "2000-01-02T00:00:00Z")
            .await
            .unwrap();
        let report = RetroReport {
            id: retro.id.clone(),
            since_at: retro.since_at.clone(),
            until_at: retro.until_at.clone(),
            generated_at: now_iso(),
            run_count: 0,
            issue_count: 0,
            workpad_count: 0,
            repos: vec![],
        };
        repo.finish_retro(&retro.id, &serde_json::to_string(&report).unwrap(), 0, 0)
            .await
            .unwrap();
        Self {
            directory,
            service,
            effects,
            credentials,
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
            target_type: target.parse().unwrap(),
            target_id: id.into(),
            target_path: "WORKFLOW.md".into(),
            title: "Validate changes".into(),
            body: "Run checks".into(),
            rationale: "Repeated failure".into(),
            confidence: symphony_core::SuggestionConfidence::High,
            guidance: "Validate changes before pushing.".into(),
            before_content: Some(settings.prompt_template.clone()),
            after_content: Some(integrate_retro_guidance(
                &settings.prompt_template,
                &["Validate changes before pushing.".into()],
            )),
            unified_diff: None,
            base_ref: Some("reviewed-ref".into()),
            base_hash: Some(prompt_revision(&settings)),
            proposal_status: ProposalState::Ready,
            proposal_error: None,
            decision: decision.parse().unwrap(),
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
    assert_eq!(
        fixture
            .service
            .review(pending.id, SuggestionDecision::Rejected)
            .await
            .unwrap()
            .decision,
        SuggestionDecision::Rejected
    );
    let batch = fixture
        .service
        .apply_workflow(fixture.retro.id.clone(), fixture.runtime())
        .await
        .unwrap();
    assert_eq!(batch.state, BatchState::Completed);
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
    assert_eq!(batch.state, BatchState::Failed);
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
            if batches[0].state == BatchState::Completed {
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
        .review("skill-one".into(), SuggestionDecision::Rejected)
        .await
        .unwrap();
    assert_eq!(reserved.decision, SuggestionDecision::Accepted);
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
    assert_eq!(batches[0].state, BatchState::Completed);
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
    assert_eq!(batch.state, BatchState::Stale);
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
    let runtime = fixture.runtime();
    *fixture.credentials.0.lock().unwrap() = None;
    assert!(fixture
        .service
        .start(runtime)
        .await
        .unwrap_err()
        .contains("No Linear API key"));
    assert_eq!(fixture.service.list().await.unwrap().len(), before);
}

#[tokio::test]
async fn shared_runtime_validation_rejects_unrunnable_prompt_application_before_save() {
    let fixture = Fixture::new().await;
    fixture.suggestion("prompt", "prompt", "accepted").await;
    let mut settings = fixture.service.settings.load().await.unwrap();
    settings.polling_interval_ms = 0;
    let before = fixture.service.settings.save(settings, None).await.unwrap();
    let error = fixture
        .service
        .apply_workflow(fixture.retro.id.clone(), fixture.runtime())
        .await
        .unwrap_err();
    assert!(error.contains("Polling interval must be positive"));
    let after = fixture.service.settings.load().await.unwrap();
    assert_eq!(after.settings_revision, before.settings_revision);
    assert_eq!(after.prompt_template, before.prompt_template);
    let batches = fixture
        .service
        .repo
        .list_retro_batches(&fixture.retro.id)
        .await
        .unwrap();
    assert_eq!(batches[0].state, BatchState::Failed);
}

#[tokio::test]
async fn detail_reports_corrupt_stored_report_instead_of_hiding_it() {
    let fixture = Fixture::new().await;
    fixture
        .service
        .repo
        .finish_retro(&fixture.retro.id, "{}", 0, 0)
        .await
        .unwrap();
    let error = fixture
        .service
        .detail(fixture.retro.id.clone())
        .await
        .err()
        .unwrap();
    assert!(error.contains("invalid stored retro report"));
}

#[tokio::test]
async fn pr_admission_uses_settings_committed_while_waiting_for_the_effects_gate() {
    for replace_url in [false, true] {
        let fixture = Fixture::new().await;
        fixture.suggestion("skill", "skill", "accepted").await;
        let gate = fixture.service.settings.commit_effects().await;
        let service = fixture.service.clone();
        let retro_id = fixture.retro.id.clone();
        let runtime = fixture.runtime();
        let mut request = tokio::spawn(async move { service.start_prs(retro_id, runtime).await });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut request)
                .await
                .is_err(),
            "PR admission waits for the in-flight settings operation"
        );
        let mut changed = fixture.service.settings.load().await.unwrap();
        changed
            .session_env
            .insert("CURRENT_CONFIG".into(), "new-value".into());
        if replace_url {
            changed.repos[0].url = "git@github.com:acme/replacement.git".into();
        }
        fixture.service.settings.save(changed, None).await.unwrap();
        drop(gate);
        let batches = request.await.unwrap().unwrap();
        fixture.join_jobs().await;
        if replace_url {
            assert_eq!(batches[0].state, BatchState::Stale);
            assert!(fixture.effects.jobs.lock().await.is_empty());
        } else {
            assert_eq!(fixture.effects.jobs.lock().await.len(), 1);
            assert_eq!(
                fixture.effects.environments.lock().await[0]["CURRENT_CONFIG"],
                "new-value"
            );
        }
    }
}

#[tokio::test]
async fn all_repository_batches_are_durable_before_the_first_job_starts() {
    let fixture = Fixture::new().await;
    let mut settings = fixture.service.settings.load().await.unwrap();
    settings.repos.push(RepoConfig {
        name: "gadgets".into(),
        url: "git@github.com:acme/gadgets.git".into(),
        ..Default::default()
    });
    fixture.service.settings.save(settings, None).await.unwrap();
    let mut second = fixture
        .suggestion("widgets-skill", "skill", "accepted")
        .await;
    second.id = "gadgets-skill".into();
    second.repo_name = "gadgets".into();
    second.repo_url = Some("git@github.com:acme/gadgets.git".into());
    fixture
        .service
        .repo
        .insert_retro_suggestions(&[second])
        .await
        .unwrap();
    let batches = fixture
        .service
        .start_prs(fixture.retro.id.clone(), fixture.runtime())
        .await
        .unwrap();
    assert_eq!(batches.len(), 2);
    fixture.join_jobs().await;
    assert_eq!(
        *fixture.effects.admitted_batch_counts.lock().await,
        vec![2, 2]
    );
    let again = fixture
        .service
        .start_prs(fixture.retro.id.clone(), fixture.runtime())
        .await
        .unwrap();
    assert_eq!(again.len(), 2);
    fixture.join_jobs().await;
    assert_eq!(fixture.effects.jobs.lock().await.len(), 2);
}

#[tokio::test]
async fn colliding_saved_repository_drafts_cannot_reserve_or_launch_prs() {
    let fixture = Fixture::new().await;
    fixture.suggestion("skill", "skill", "accepted").await;
    let mut settings = fixture.service.settings.load().await.unwrap();
    for name in ["team/app", "team_app"] {
        settings.repos.push(RepoConfig {
            name: name.into(),
            url: format!("git@github.com:acme/{name}.git"),
            ..Default::default()
        });
    }
    fixture.service.settings.save(settings, None).await.unwrap();
    let error = fixture
        .service
        .start_prs(fixture.retro.id.clone(), fixture.runtime())
        .await
        .unwrap_err();
    assert!(error.contains("collide"));
    assert!(fixture.effects.jobs.lock().await.is_empty());
    assert!(fixture
        .service
        .repo
        .list_retro_batches(&fixture.retro.id)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn disconnected_delete_finishes_forgetting_the_deleted_status() {
    let fixture = Fixture::new().await;
    let status = RetroStatus {
        state: crate::retro::RetroRunState::Completed,
        retro_id: Some(fixture.retro.id.clone()),
        message: None,
        report: fixture
            .service
            .detail(fixture.retro.id.clone())
            .await
            .unwrap()
            .unwrap()
            .report,
        error: None,
    };
    let status_guard = fixture
        .service
        .generation
        .hold_status_for_test(status)
        .await;
    let service = fixture.service.clone();
    let id = fixture.retro.id.clone();
    let caller = tokio::spawn(async move { service.delete(id).await });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while fixture
            .service
            .repo
            .get_retro(&fixture.retro.id)
            .await
            .unwrap()
            .is_some()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(status_guard.as_ref().unwrap().retro_id.is_some());
    drop(status_guard);
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while fixture.service.status().await.unwrap().retro_id.is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        fixture.service.status().await.unwrap().state,
        crate::retro::RetroRunState::Idle
    );
}

#[tokio::test]
async fn admitted_credential_replaces_or_removes_stale_command_values() {
    let fixture = Fixture::new().await;
    for credential in [Some("fresh-snapshot-canary"), None] {
        *fixture.credentials.0.lock().unwrap() = credential.map(str::to_owned);
        let mut runtime = fixture.runtime();
        runtime.api_key = Some("obsolete-captured-canary".into());
        runtime
            .env
            .insert("LINEAR_API_KEY".into(), "obsolete-captured-canary".into());
        let _effects = fixture.service.settings.commit_effects().await;
        let snapshot = fixture.service.runtime_snapshot().await.unwrap();
        let runtime = runtime.with_credential(snapshot.credential);
        let config = runtime.worker_config(&snapshot.settings).unwrap();
        assert_eq!(runtime.api_key.as_deref(), credential);
        assert_eq!(
            runtime.env.get("LINEAR_API_KEY").map(String::as_str),
            credential
        );
        assert_eq!(
            config.runtime.workflow().front_matter.tracker.api_key,
            credential.unwrap_or_default()
        );
    }
}

#[tokio::test]
async fn unavailable_linear_keyring_blocks_generation_but_not_git_or_prompt_changes() {
    let fixture = Fixture::new().await;
    fixture.suggestion("skill", "skill", "accepted").await;
    fixture.suggestion("prompt", "prompt", "accepted").await;
    fixture.credentials.1.store(true, Ordering::SeqCst);
    assert!(fixture
        .service
        .start(fixture.runtime())
        .await
        .unwrap_err()
        .contains("unavailable"));
    let batches = fixture
        .service
        .start_prs(fixture.retro.id.clone(), fixture.runtime())
        .await
        .unwrap();
    assert_eq!(batches.len(), 1);
    fixture.join_jobs().await;
    assert_eq!(fixture.effects.jobs.lock().await.len(), 1);
    let batch = fixture
        .service
        .apply_workflow(fixture.retro.id.clone(), fixture.runtime())
        .await
        .unwrap();
    assert_eq!(batch.state, BatchState::Completed);
    let settings = fixture.service.settings.load().await.unwrap();
    assert_eq!(settings.settings_revision, 2);
    assert!(settings
        .prompt_template
        .contains("Validate changes before pushing."));
    assert!(settings.linear_api_key_error.is_some());
    let _effects = fixture.service.settings.commit_effects().await;
    let snapshot = fixture.service.runtime_snapshot().await.unwrap();
    let mut captured = fixture.runtime();
    captured
        .env
        .insert("LINEAR_API_KEY".into(), "stale-command-key".into());
    let refreshed = captured.with_credential(snapshot.credential);
    assert!(refreshed.api_key.is_none());
    assert!(!refreshed.env.contains_key("LINEAR_API_KEY"));
}

#[tokio::test]
async fn keyring_unlock_during_commit_does_not_reconfigure_with_an_uncaptured_key() {
    let fixture = Fixture::new().await;
    fixture.suggestion("prompt", "prompt", "accepted").await;
    let settings = fixture.service.settings.load().await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (connected, observed) = tokio::sync::oneshot::channel();
    let tracker = tokio::spawn(async move {
        let (_socket, _) = listener.accept().await.unwrap();
        connected.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    let mut workflow = workflow_from_settings(&settings, Some("synthetic-test-key"));
    workflow.front_matter.tracker.endpoint = format!("http://{address}/graphql");
    fixture
        .service
        .worker
        .start(WorkerStartConfig {
            runtime: RunnableConfig::new(
                settings.settings_revision,
                workflow,
                settings.repos,
                settings.session_env,
            )
            .unwrap(),
            env: BTreeMap::new(),
            app_data_dir: fixture.directory.path().into(),
            skills: vec![],
        })
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), observed)
        .await
        .unwrap()
        .unwrap();
    // Both admitted snapshots cannot read the key. The response-only metadata
    // read after the prompt commit succeeds because the keyring was unlocked.
    *fixture.credentials.2.lock().unwrap() = [true, true, false].into();
    let batch = fixture
        .service
        .apply_workflow(fixture.retro.id.clone(), fixture.runtime())
        .await
        .unwrap();
    assert_eq!(batch.state, BatchState::Completed);
    assert!(fixture.credentials.2.lock().unwrap().is_empty());
    let status = fixture.service.worker.status().await;
    assert_eq!(status.state, symphony_worker::WorkerState::Running);
    let diagnostic = status
        .last_error
        .expect("skipped runtime update stays observable");
    assert!(diagnostic.contains("credential access prevented worker update"));
    assert!(diagnostic.contains("Restart worker"));
    assert_eq!(
        fixture.service.worker.status().await.last_error.as_deref(),
        Some(diagnostic.as_str())
    );
    fixture.service.worker.stop().await;
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while fixture.service.worker.status().await.state != symphony_worker::WorkerState::Stopped {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tracker.abort();
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
