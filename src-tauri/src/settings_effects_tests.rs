//! Exercise the production settings continuations with a real worker whose
//! tracker preflight is held at a local socket. No OS credentials are read.
use super::*;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};
use tokio::{sync::oneshot, task::JoinHandle, time::Duration};

const OLD_KEY: &str = "lin_api_settings_effects_old_canary";

type ReadBarrier = (oneshot::Sender<()>, mpsc::Receiver<()>);

struct FixtureCredentials {
    key: Mutex<Option<String>>,
    unavailable: AtomicBool,
    read_availability: Mutex<VecDeque<bool>>,
    fail_removal_after_mutation: AtomicBool,
    read_barrier: Mutex<Option<ReadBarrier>>,
}

impl FixtureCredentials {
    fn new() -> Self {
        Self {
            key: Mutex::new(Some(OLD_KEY.into())),
            unavailable: AtomicBool::new(false),
            read_availability: Mutex::new(VecDeque::new()),
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
        let unavailable = self
            .read_availability
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| self.unavailable.load(Ordering::SeqCst));
        if unavailable {
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
            repos: vec![symphony_core::RepoConfig {
                name: "fixture".into(),
                url: "https://example.test/fixture.git".into(),
                ..Default::default()
            }],
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
                runtime: symphony_core::RunnableConfig::new(
                    settings.settings_revision,
                    workflow,
                    settings.repos.clone(),
                    BTreeMap::new(),
                )
                .unwrap(),
                skills: vec![],
                env: BTreeMap::new(),
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
async fn save_preserves_running_worker_when_admitted_credential_becomes_unavailable() {
    let fixture = Fixture::running().await;
    // The Save response knows a key exists, but runtime admission cannot read it.
    // This is an unavailable credential, never proof that it was removed.
    *fixture.credentials.read_availability.lock().unwrap() = VecDeque::from([false, true]);
    let mut draft = fixture.settings.clone();
    draft.polling_interval_ms += 1;
    let saved = save_settings_owned(
        fixture.state.clone(),
        SaveSettingsRequest {
            settings: draft,
            linear_api_key: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(saved.settings_revision, 11);
    assert!(saved.linear_api_key_set);
    assert!(saved.linear_api_key_error.is_none());
    assert!(fixture
        .credentials
        .read_availability
        .lock()
        .unwrap()
        .is_empty());
    let durable: AppSettings =
        serde_json::from_slice(&std::fs::read(&fixture.settings_path).unwrap()).unwrap();
    assert_eq!(durable.settings_revision, 11);
    assert_eq!(durable.polling_interval_ms, saved.polling_interval_ms);
    assert_eq!(
        fixture.credentials.key.lock().unwrap().as_deref(),
        Some(OLD_KEY)
    );
    assert_eq!(
        fixture.state.worker.status().await.state,
        symphony_worker::WorkerState::Running
    );
    fixture.state.worker.stop().await;
    fixture.assert_stopped().await;
}

#[tokio::test]
async fn start_distinguishes_unavailable_credentials_from_confirmed_removal() {
    for unavailable in [true, false] {
        let fixture = Fixture::running().await;
        fixture
            .credentials
            .unavailable
            .store(unavailable, Ordering::SeqCst);
        if !unavailable {
            *fixture.credentials.key.lock().unwrap() = None;
        }
        let error = start_worker_owned(fixture.state.clone()).await.unwrap_err();
        assert!(error.contains(if unavailable {
            "unavailable"
        } else {
            "No Linear API key"
        }));
        if unavailable {
            assert_eq!(
                fixture.state.worker.status().await.state,
                symphony_worker::WorkerState::Running
            );
            fixture.state.worker.stop().await;
        }
        fixture.assert_stopped().await;
    }
}

#[tokio::test]
async fn worker_config_uses_the_admitted_credential_for_tracker_and_environment() {
    let fixture = Fixture::running().await;
    fixture
        .credentials
        .unavailable
        .store(true, Ordering::SeqCst);
    let config =
        worker_start_config(&fixture.state, &fixture.settings, "admitted-key-canary").unwrap();
    assert_eq!(
        config.runtime.workflow().front_matter.tracker.api_key,
        "admitted-key-canary"
    );
    assert_eq!(config.env["LINEAR_API_KEY"], "admitted-key-canary");
    fixture.state.worker.stop().await;
    fixture.assert_stopped().await;
}
