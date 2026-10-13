//! Exercise the production settings continuations with a real worker whose
//! tracker preflight is held at a local socket. No OS credentials are read.
use super::*;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use tokio::{sync::oneshot, task::JoinHandle, time::Duration};

const OLD_KEY: &str = "lin_api_settings_effects_old_canary";

type ReadBarrier = (oneshot::Sender<()>, mpsc::Receiver<()>);

struct FixtureCredentials {
    key: Mutex<Option<String>>,
    unavailable: AtomicBool,
    reads: AtomicUsize,
    unavailable_at_read: AtomicUsize,
    fail_removal_after_mutation: AtomicBool,
    read_barrier: Mutex<Option<ReadBarrier>>,
}

impl FixtureCredentials {
    fn new() -> Self {
        Self {
            key: Mutex::new(Some(OLD_KEY.into())),
            unavailable: AtomicBool::new(false),
            reads: AtomicUsize::new(0),
            unavailable_at_read: AtomicUsize::new(usize::MAX),
            fail_removal_after_mutation: AtomicBool::new(false),
            read_barrier: Mutex::new(None),
        }
    }

    fn block_next_read(&self) -> (oneshot::Receiver<()>, mpsc::Sender<()>) {
        let (entered, observed) = oneshot::channel();
        let (release, wait) = mpsc::channel();
        *self.read_barrier.lock().unwrap() = Some((entered, wait));
        (observed, release)
    }
}

impl settings_store::Credentials for FixtureCredentials {
    fn read(&self) -> Result<Option<String>, String> {
        let barrier = self.read_barrier.lock().unwrap().take();
        if let Some((entered, release)) = barrier {
            let _ = entered.send(());
            release
                .recv_timeout(Duration::from_secs(10))
                .map_err(|_| "Synthetic credential barrier was not released.")?;
        }
        let read = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
        if self.unavailable.load(Ordering::SeqCst)
            || read >= self.unavailable_at_read.load(Ordering::SeqCst)
        {
            Err("Synthetic credential store is locked.".into())
        } else {
            Ok(self.key.lock().unwrap().clone())
        }
    }

    fn set(&self, value: Option<&str>) -> Result<(), String> {
        if self.unavailable.load(Ordering::SeqCst) {
            return Err("Synthetic credential store is locked.".into());
        }
        *self.key.lock().unwrap() = value.map(str::to_owned);
        if value.is_none() && self.fail_removal_after_mutation.load(Ordering::SeqCst) {
            self.unavailable.store(true, Ordering::SeqCst);
            return Err("Synthetic removal changed the key before failing.".into());
        }
        Ok(())
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    state: AppState,
    credentials: Arc<FixtureCredentials>,
    settings_path: PathBuf,
    settings: AppSettings,
    tracker: JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.tracker.abort();
    }
}

impl Fixture {
    async fn running() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("test.sqlite");
        let repo = Repository::new(
            open_sqlite(&database_path).await.unwrap(),
            EventBus::default(),
        );
        let credentials = Arc::new(FixtureCredentials::new());
        let settings_path = directory.path().join("settings.json");
        let settings = AppSettings {
            settings_revision: 10,
            linear_api_key_set: true,
            ..Default::default()
        };
        std::fs::write(
            &settings_path,
            serde_json::to_vec_pretty(&settings).unwrap(),
        )
        .unwrap();
        let state = AppState {
            worker: WorkerManager::new(repo.clone()),
            repo,
            skills_installer: SkillsInstaller::new(),
            workflow_transfer: WorkflowTransferManager::new(),
            retro: RetroManager::new(),
            app_data_dir: directory.path().into(),
            settings_store: settings_store::SettingsStore::new(
                settings_path.clone(),
                credentials.clone(),
            ),
            database_path,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (connected, observed) = oneshot::channel();
        let tracker = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            let _ = connected.send(());
            std::future::pending::<()>().await;
        });
        let mut workflow = workflow_from_settings(&settings, Some(OLD_KEY));
        workflow.front_matter.tracker.endpoint = format!("http://{address}/graphql");
        state
            .worker
            .start(WorkerStartConfig {
                workflow,
                repos: vec![],
                skills: vec![],
                env: BTreeMap::new(),
                session_env: BTreeMap::new(),
                app_data_dir: directory.path().into(),
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), observed)
            .await
            .expect("worker reached local tracker preflight")
            .unwrap();
        assert_eq!(
            state.worker.status().await.state,
            symphony_worker::WorkerState::Running
        );
        Self {
            _directory: directory,
            state,
            credentials,
            settings_path,
            settings,
            tracker,
        }
    }

    fn interrupt_removal(&self) {
        let mut removed = self.settings.clone();
        removed.settings_revision += 1;
        removed.linear_api_key_set = false;
        settings_transaction::stage_interrupted_credential_change(
            &self.settings_path,
            &removed,
            self.credentials.as_ref(),
            None,
            Some(OLD_KEY),
        )
        .expect_err("interrupt after credential mutation");
        assert!(settings_transaction::has_pending(&self.settings_path));
    }

    async fn assert_stopped(&self) {
        assert_ne!(
            self.state.worker.status().await.state,
            symphony_worker::WorkerState::Running
        );
        tokio::time::timeout(Duration::from_secs(3), async {
            while self.state.worker.status().await.state != symphony_worker::WorkerState::Stopped {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("worker supervisor finishes stopping");
        assert!(!self.state.settings_store.take_recovery_stop());
    }
}

#[tokio::test]
async fn recovered_removal_load_stops_worker_even_when_the_caller_disconnects() {
    for cancel_caller in [false, true] {
        let fixture = Fixture::running().await;
        fixture.interrupt_removal();
        let (entered, release) = fixture.credentials.block_next_read();
        let state = fixture.state.clone();
        let load = tokio::spawn(async move { load_settings_from_disk(&state).await });
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .unwrap()
            .unwrap();
        if cancel_caller {
            load.abort();
            assert!(load.await.unwrap_err().is_cancelled());
            release.send(()).unwrap();
        } else {
            release.send(()).unwrap();
            let loaded = load.await.unwrap().unwrap();
            assert_eq!(loaded.settings_revision, 11);
            assert!(!loaded.linear_api_key_set);
        }
        // Acquiring the production gate waits for the owned load's worker stop,
        // even when its original caller no longer waits for the result.
        let _effects = fixture.state.settings_store.commit_effects().await;
        fixture.assert_stopped().await;
        let settings = fixture.state.settings_store.load().await.unwrap();
        assert_eq!(settings.settings_revision, 11);
        assert!(!settings.linear_api_key_set);
        assert!(settings.linear_api_key_error.is_none());
        assert!(!settings_transaction::has_pending(&fixture.settings_path));
    }
}

#[tokio::test]
async fn recovery_stops_worker_even_when_the_following_save_is_stale() {
    let fixture = Fixture::running().await;
    fixture.interrupt_removal();
    let error = save_settings_owned(
        fixture.state.clone(),
        SaveSettingsRequest {
            settings: fixture.settings.clone(),
            linear_api_key: None,
        },
    )
    .await
    .unwrap_err();
    assert!(error.contains("Settings changed"));
    fixture.assert_stopped().await;
    assert!(!settings_transaction::has_pending(&fixture.settings_path));
    let saved: AppSettings =
        serde_json::from_slice(&std::fs::read(&fixture.settings_path).unwrap()).unwrap();
    assert_eq!(saved.settings_revision, 11);
    assert!(!saved.linear_api_key_set);
}

#[tokio::test]
async fn failed_removal_with_locked_rollback_stops_before_returning_the_error() {
    let fixture = Fixture::running().await;
    fixture
        .credentials
        .fail_removal_after_mutation
        .store(true, Ordering::SeqCst);
    let error = remove_linear_api_key_owned(fixture.state.clone())
        .await
        .unwrap_err();
    assert!(error.contains("recovery"));
    fixture.assert_stopped().await;
    assert!(settings_transaction::has_pending(&fixture.settings_path));
    assert!(fixture.credentials.key.lock().unwrap().is_none());
    let before = std::fs::read(&fixture.settings_path).unwrap();
    for _ in 0..2 {
        let loaded = load_settings_from_disk(&fixture.state).await.unwrap();
        assert_eq!(loaded.settings_revision, 10);
        assert!(!loaded.linear_api_key_set);
        assert!(loaded.linear_api_key_error.is_some());
        fixture.assert_stopped().await;
        assert!(settings_transaction::has_pending(&fixture.settings_path));
        assert_eq!(std::fs::read(&fixture.settings_path).unwrap(), before);
    }
}

#[tokio::test]
async fn superseded_credential_journal_still_stops_the_worker() {
    let fixture = Fixture::running().await;
    fixture.interrupt_removal();
    let mut newer = fixture.settings.clone();
    newer.settings_revision = 12;
    newer.prompt_template = "A newer writer's prompt must survive recovery.".into();
    let durable = serde_json::to_vec_pretty(&newer).unwrap();
    std::fs::write(&fixture.settings_path, &durable).unwrap();
    // Availability is unknown, so only the superseded journal can require stop.
    fixture
        .credentials
        .unavailable
        .store(true, Ordering::SeqCst);

    let loaded = load_settings_from_disk(&fixture.state).await.unwrap();
    assert_eq!(loaded.settings_revision, 12);
    assert_eq!(loaded.prompt_template, newer.prompt_template);
    assert!(loaded.linear_api_key_error.is_some());
    fixture.assert_stopped().await;
    assert!(!settings_transaction::has_pending(&fixture.settings_path));
    assert_eq!(std::fs::read(&fixture.settings_path).unwrap(), durable);
}

#[tokio::test]
async fn operational_snapshot_recovers_removal_before_admitting_a_saved_key() {
    let fixture = Fixture::running().await;
    fixture.interrupt_removal();

    let snapshot = load_runtime_settings(&fixture.state).await.unwrap();
    assert_eq!(snapshot.settings.settings_revision, 11);
    assert!(snapshot.credential.is_none());
    fixture.assert_stopped().await;
    assert!(request_linear_api_key(&fixture.state, None)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn unresolved_journal_blocks_operational_saved_keys_but_settings_stay_readable() {
    let fixture = Fixture::running().await;
    let marker = fixture.settings_path.with_extension("json.transaction");
    std::fs::write(&marker, b"malformed pending transaction").unwrap();
    assert!(settings_transaction::has_pending(&fixture.settings_path));

    // This is the shared admission path for board reads/moves and Retro start.
    let error = load_runtime_settings(&fixture.state)
        .await
        .err()
        .expect("operational snapshot must reject unresolved recovery");
    assert!(error.contains("unreadable"));
    fixture.assert_stopped().await;
    // Viewer and connection checks must reject the same saved-key fallback.
    assert!(request_linear_api_key(&fixture.state, None).await.is_err());
    assert!(request_linear_api_key(&fixture.state, Some("  ".into()))
        .await
        .is_err());
    // A deliberately supplied draft credential is independent of saved state.
    assert_eq!(
        request_linear_api_key(&fixture.state, Some("lin_api_unsaved_fixture".into()))
            .await
            .unwrap()
            .as_deref(),
        Some("lin_api_unsaved_fixture")
    );
    let loaded = load_settings_from_disk(&fixture.state).await.unwrap();
    assert_eq!(loaded.settings_revision, fixture.settings.settings_revision);
    assert_eq!(loaded.prompt_template, fixture.settings.prompt_template);
    assert!(!loaded.linear_api_key_set);
    assert!(loaded.linear_api_key_error.unwrap().contains("unreadable"));
    assert_eq!(
        std::fs::read(marker).unwrap(),
        b"malformed pending transaction"
    );
    assert_eq!(
        fixture.credentials.key.lock().unwrap().as_deref(),
        Some(OLD_KEY)
    );
}

#[tokio::test]
async fn unavailable_saved_credential_blocks_operational_use_without_stopping_live_worker() {
    let fixture = Fixture::running().await;
    fixture
        .credentials
        .unavailable
        .store(true, Ordering::SeqCst);
    let error = load_runtime_settings(&fixture.state)
        .await
        .err()
        .expect("unknown credential availability must block saved-key operations");
    assert!(error.contains("unavailable"));
    assert_eq!(
        fixture.state.worker.status().await.state,
        symphony_worker::WorkerState::Running
    );
    let loaded = load_settings_from_disk(&fixture.state).await.unwrap();
    assert!(loaded.linear_api_key_error.is_some());
    fixture.state.worker.stop().await;
    fixture.assert_stopped().await;
}

#[tokio::test]
async fn cancelled_operational_read_still_drains_credential_recovery() {
    let fixture = Fixture::running().await;
    fixture.interrupt_removal();
    let (entered, release) = fixture.credentials.block_next_read();
    let state = fixture.state.clone();
    let access = tokio::spawn(async move { load_runtime_settings(&state).await });
    tokio::time::timeout(Duration::from_secs(5), entered)
        .await
        .unwrap()
        .unwrap();
    access.abort();
    assert!(access.await.err().unwrap().is_cancelled());
    release.send(()).unwrap();
    let _effects = fixture.state.settings_store.commit_effects().await;
    fixture.assert_stopped().await;
    assert!(!settings_transaction::has_pending(&fixture.settings_path));
}

#[tokio::test]
async fn save_receipt_reports_unavailable_runtime_admission_without_losing_its_commit() {
    let fixture = Fixture::running().await;
    // The commit's availability read succeeds; the fresh runtime admission fails.
    fixture
        .credentials
        .unavailable_at_read
        .store(2, Ordering::SeqCst);
    let mut draft = fixture.settings.clone();
    draft.prompt_template = "Keep this exact committed prompt.".into();
    draft.repos = vec![symphony_core::RepoConfig {
        name: "widgets".into(),
        url: "https://example.invalid/widgets.git".into(),
        install_cmd: None,
        is_default: true,
        skills_marked_installed: false,
    }];
    assert!(live_reconfigure_allowed(&draft));
    let saved = save_settings_owned(
        fixture.state.clone(),
        SaveSettingsRequest {
            settings: draft.clone(),
            linear_api_key: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(saved.settings_revision, 11);
    assert_eq!(saved.prompt_template, draft.prompt_template);
    assert_eq!(saved.repos[0].url, draft.repos[0].url);
    assert!(!saved.linear_api_key_set);
    assert!(saved
        .linear_api_key_error
        .as_deref()
        .unwrap()
        .contains("unavailable"));
    assert_eq!(fixture.credentials.reads.load(Ordering::SeqCst), 2);
    assert_eq!(
        fixture.state.worker.status().await.state,
        symphony_worker::WorkerState::Running
    );
    let durable: AppSettings =
        serde_json::from_slice(&std::fs::read(&fixture.settings_path).unwrap()).unwrap();
    assert_eq!(durable.settings_revision, 11);
    assert_eq!(durable.prompt_template, draft.prompt_template);
    assert!(durable.linear_api_key_set);
    assert!(durable.linear_api_key_error.is_none());
    let expected_error = "Settings saved, but credential access prevented worker update. Restart worker after unlocking credential store.";
    assert_eq!(
        fixture.state.worker.status().await.last_error.as_deref(),
        Some(expected_error)
    );
    fixture
        .credentials
        .unavailable_at_read
        .store(usize::MAX, Ordering::SeqCst);
    let reloaded = load_settings_from_disk(&fixture.state).await.unwrap();
    assert!(reloaded.linear_api_key_error.is_none());
    assert!(reloaded.linear_api_key_set);
    // A new webview reads these separately after the credential store unlocks.
    // Reloading settings must not imply that the active worker adopted them.
    let status_after_reload = fixture.state.worker.status().await;
    assert_eq!(
        status_after_reload.state,
        symphony_worker::WorkerState::Running
    );
    assert_eq!(
        status_after_reload.last_error.as_deref(),
        Some(expected_error)
    );
    fixture.state.worker.stop().await;
    fixture.assert_stopped().await;
}

fn fail_settings_directory_sync(path: &std::path::Path) -> Result<(), String> {
    if path
        .extension()
        .is_some_and(|extension| extension == "json")
    {
        assert!(path.is_file());
        Err("Synthetic settings parent-directory sync failure.".into())
    } else {
        settings_transaction::sync_parent(path)
    }
}

#[tokio::test]
async fn ordinary_save_stops_stale_runtime_after_post_rename_sync_error() {
    let mut fixture = Fixture::running().await;
    fixture.state.settings_store = fixture
        .state
        .settings_store
        .clone()
        .with_parent_sync(fail_settings_directory_sync);
    let mut draft = fixture.settings.clone();
    draft.prompt_template = "Visible replacement whose directory sync failed.".into();
    let error = save_settings_owned(
        fixture.state.clone(),
        SaveSettingsRequest {
            settings: draft.clone(),
            linear_api_key: None,
        },
    )
    .await
    .unwrap_err();
    assert!(error.contains("parent-directory sync"));
    fixture.assert_stopped().await;
    let visible: AppSettings =
        serde_json::from_slice(&std::fs::read(&fixture.settings_path).unwrap()).unwrap();
    assert_eq!(visible.settings_revision, 11);
    assert_eq!(visible.prompt_template, draft.prompt_template);
    assert_eq!(
        fixture.credentials.key.lock().unwrap().as_deref(),
        Some(OLD_KEY)
    );
    assert!(!settings_transaction::has_pending(&fixture.settings_path));
}

#[tokio::test]
async fn migration_load_stops_stale_runtime_after_post_rename_sync_error() {
    let mut fixture = Fixture::running().await;
    fixture.state.settings_store = fixture
        .state
        .settings_store
        .clone()
        .with_parent_sync(fail_settings_directory_sync);
    let mut legacy = serde_json::to_value(&fixture.settings).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("codex_permission_mode");
    legacy["codex_approval_policy"] = serde_json::json!("never");
    let raw = serde_json::to_string(&legacy).unwrap();
    std::fs::write(&fixture.settings_path, &raw).unwrap();
    let error = load_settings_from_disk(&fixture.state).await.unwrap_err();
    assert!(error.contains("parent-directory sync"));
    fixture.assert_stopped().await;
    let visible = std::fs::read_to_string(&fixture.settings_path).unwrap();
    let (migrated, needs_migration) = settings::parse_settings(&visible).unwrap();
    assert!(!needs_migration);
    assert_eq!(migrated.settings_revision, 11);
    assert_eq!(
        std::fs::read_to_string(fixture.settings_path.with_extension("json.bak")).unwrap(),
        raw
    );
    assert_eq!(
        fixture.credentials.key.lock().unwrap().as_deref(),
        Some(OLD_KEY)
    );
}

#[tokio::test]
async fn committed_retro_prompt_finishes_failed_batch_when_runtime_refresh_fails() {
    for disconnect_caller in [false, true] {
        let fixture = Fixture::running().await;
        let retro = fixture
            .state
            .repo
            .create_retro("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z")
            .await
            .unwrap();
        fixture
            .state
            .repo
            .finish_retro(&retro.id, "{}", 0, 0)
            .await
            .unwrap();
        let suggestion = RetroSuggestionRow {
            id: Uuid::new_v4().to_string(),
            retro_id: retro.id.clone(),
            repo_name: "widgets".into(),
            repo_url: Some("https://example.invalid/widgets.git".into()),
            finding_index: 0,
            target_type: "prompt".into(),
            target_id: "default-prompt".into(),
            target_path: "Settings → Prompt template".into(),
            title: "Clarify completion".into(),
            body: "Preserve the reviewed prompt update.".into(),
            rationale: "Test reviewed workflow continuation.".into(),
            confidence: "high".into(),
            guidance: "Verify before reporting completion.".into(),
            before_content: None,
            after_content: None,
            unified_diff: None,
            base_ref: Some("saved-prompt".into()),
            base_hash: Some(prompt_revision(&fixture.settings)),
            proposal_status: "ready".into(),
            proposal_error: None,
            decision: "accepted".into(),
            decided_at: Some(now_iso()),
            created_at: now_iso(),
        };
        fixture
            .state
            .repo
            .insert_retro_suggestions(std::slice::from_ref(&suggestion))
            .await
            .unwrap();
        let batch = RetroBatchRow {
            id: Uuid::new_v4().to_string(),
            retro_id: retro.id.clone(),
            kind: "workflow_update".into(),
            repo_name: None,
            repo_url: None,
            base_ref: suggestion.base_ref.clone(),
            state: "running".into(),
            progress: Some("Applying reviewed prompt.".into()),
            error: None,
            pr_url: None,
            created_at: now_iso(),
            completed_at: None,
        };
        assert_eq!(
            fixture
                .state
                .repo
                .reserve_retro_batch(&batch, std::slice::from_ref(&suggestion.id))
                .await
                .unwrap(),
            RetroBatchReservation::Created
        );
        assert!(fixture
            .state
            .repo
            .has_in_progress_retro_batches()
            .await
            .unwrap());
        assert!(!fixture.state.repo.delete_retro(&retro.id).await.unwrap());

        let (committed, observed) = oneshot::channel();
        let (release, continue_refresh) = oneshot::channel();
        let state = fixture.state.clone();
        let settings = fixture.settings.clone();
        let operation_batch = batch.clone();
        let caller = tokio::spawn(settings_store::finish_operation(async move {
            let _effects = state.settings_store.commit_effects().await;
            state
                .settings_store
                .apply_prompt(
                    settings.settings_revision,
                    prompt_revision(&settings),
                    "Durably saved reviewed prompt.".into(),
                )
                .await?;
            finish_settings_recovery(&state).await;
            committed.send(()).unwrap();
            continue_refresh.await.unwrap();
            finish_retro_workflow_after_prompt_save(&state, &operation_batch).await
        }));
        observed.await.unwrap();
        let durable = std::fs::read(&fixture.settings_path).unwrap();
        let saved: AppSettings = serde_json::from_slice(&durable).unwrap();
        assert_eq!(saved.settings_revision, 11);
        assert_eq!(saved.prompt_template, "Durably saved reviewed prompt.");
        // A malformed pending recovery record makes the real runtime snapshot
        // fail after the successful commit, without any source Git or Linear IO.
        let marker = fixture.settings_path.with_extension("json.transaction");
        std::fs::write(&marker, b"malformed pending transaction").unwrap();
        if disconnect_caller {
            caller.abort();
            assert!(caller.await.unwrap_err().is_cancelled());
            release.send(()).unwrap();
            let _finished = fixture.state.settings_store.commit_effects().await;
        } else {
            release.send(()).unwrap();
            let error = caller.await.unwrap().unwrap_err();
            assert!(error.contains("Workflow prompt saved; runtime refresh failed."));
            assert!(error.contains("unreadable"));
        }

        fixture.assert_stopped().await;
        let batches = fixture
            .state
            .repo
            .list_retro_batches(&retro.id)
            .await
            .unwrap();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].id, batch.id);
        assert_eq!(batches[0].state, "failed");
        assert_eq!(
            batches[0].progress.as_deref(),
            Some("Workflow prompt saved; runtime refresh failed.")
        );
        assert!(batches[0].error.as_deref().unwrap().contains("unreadable"));
        assert!(batches[0].completed_at.is_some());
        assert!(!fixture
            .state
            .repo
            .has_in_progress_retro_batches()
            .await
            .unwrap());
        assert_eq!(std::fs::read(&fixture.settings_path).unwrap(), durable);
        assert!(marker.is_file());
        assert!(fixture.state.repo.delete_retro(&retro.id).await.unwrap());
    }
}
