use crate::settings::{normalize_linear_filters, parse_settings};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use symphony_contracts::AppSettings;

type ParentSync = fn(&Path) -> Result<(), String>;

enum AccessMode {
    Load,
    Commit,
}

pub trait Credentials: Send + Sync {
    fn read(&self) -> Result<Option<String>, String>;
    fn set(&self, value: Option<&str>) -> Result<(), String>;
}

pub struct KeyringCredentials;

impl Credentials for KeyringCredentials {
    fn read(&self) -> Result<Option<String>, String> {
        match crate::keyring_entry()
            .map_err(|error| error.to_string())?
            .get_password()
        {
            Ok(value) => Ok(Some(value)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn set(&self, value: Option<&str>) -> Result<(), String> {
        let entry = crate::keyring_entry().map_err(|error| error.to_string())?;
        match value {
            Some(value) => entry.set_password(value).map_err(|error| error.to_string()),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
                Err(error) => Err(error.to_string()),
            },
        }
    }
}

#[derive(Clone)]
pub struct SettingsStore {
    path: PathBuf,
    gate: Arc<Mutex<()>>,
    effects_gate: Arc<tokio::sync::Mutex<()>>,
    recovery_stop: Arc<AtomicBool>,
    credentials: Arc<dyn Credentials>,
    parent_sync: ParentSync,
}

/// Private runtime input captured under the same durable lock. Never serialize
/// or debug-print the credential; IPC receives only `AppSettings` metadata.
pub(crate) struct SettingsSnapshot {
    pub settings: AppSettings,
    pub credential: Option<String>,
}

impl SettingsStore {
    pub fn new(path: PathBuf, credentials: Arc<dyn Credentials>) -> Self {
        Self {
            path,
            gate: Arc::new(Mutex::new(())),
            effects_gate: Arc::new(tokio::sync::Mutex::new(())),
            recovery_stop: Arc::new(AtomicBool::new(false)),
            credentials,
            parent_sync: crate::settings_transaction::sync_parent,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_parent_sync(mut self, parent_sync: ParentSync) -> Self {
        self.parent_sync = parent_sync;
        self
    }

    /// Keep a local settings commit and its worker effects in the same order.
    /// Acquire inside an owned operation, before capturing settings for Start;
    /// Retro acquires only after slow source validation, immediately before CAS.
    pub async fn commit_effects(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.effects_gate.clone().lock_owned().await
    }

    /// Drain only inside an owned operation holding `commit_effects`, which
    /// must finish stopping the worker even if its IPC caller disconnects.
    pub fn take_recovery_stop(&self) -> bool {
        self.recovery_stop.swap(false, Ordering::AcqRel)
    }

    // The blocking task owns the lock: dropping an IPC future cannot release
    // ownership while its disk/keychain operation is still committing.
    async fn access<T: Send + 'static>(
        &self,
        mode: AccessMode,
        action: impl FnOnce(
                &Path,
                &dyn Credentials,
                Option<String>,
                &SettingsWriter<'_>,
            ) -> Result<T, String>
            + Send
            + 'static,
    ) -> Result<T, String> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = store
                .gate
                .lock()
                .map_err(|_| "Settings state is unavailable.")?;
            // Lock a stable sidecar, not the file replaced by rename. Every
            // settings owner, including another application process, uses it.
            let lock = std::fs::File::options()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(store.path.with_extension("json.lock"))
                .map_err(|error| error.to_string())?;
            lock.lock().map_err(|error| error.to_string())?;
            let recovery_error = match crate::settings_transaction::recover(
                &store.path,
                store.credentials.as_ref(),
            ) {
                Ok(crate::settings_transaction::RecoveryOutcome::Ready) => None,
                Ok(crate::settings_transaction::RecoveryOutcome::Recovered { .. })
                | Ok(crate::settings_transaction::RecoveryOutcome::Superseded) => {
                    // Record before releasing the blocking task's ownership.
                    // Cancellation of its async waiter cannot erase this effect.
                    store.recovery_stop.store(true, Ordering::Release);
                    None
                }
                Ok(crate::settings_transaction::RecoveryOutcome::Deferred) => Some(
                    "A Linear credential update is pending recovery. Unlock the OS credential store and retry before changing settings.".to_string(),
                ),
                Err(error) => Some(error),
            };
            if recovery_error.is_some() {
                store.recovery_stop.store(true, Ordering::Release);
            }
            if matches!(mode, AccessMode::Commit) {
                if let Some(error) = recovery_error {
                    return Err(error);
                }
            }
            let writer = SettingsWriter {
                recovery_stop: &store.recovery_stop,
                sync_parent: store.parent_sync,
            };
            let result = action(&store.path, store.credentials.as_ref(), recovery_error, &writer);
            if result.is_err() && crate::settings_transaction::has_pending(&store.path) {
                store.recovery_stop.store(true, Ordering::Release);
            }
            result
        })
        .await
        .map_err(|error| error.to_string())?
    }

    pub async fn load(&self) -> Result<AppSettings, String> {
        self.access(
            AccessMode::Load,
            |path, credentials, recovery_error, writer| {
                // An unresolved credential journal owns the existing file bytes;
                // even an automatic migration must wait until recovery can finish.
                let mut settings =
                    read_settings_with_migration(path, recovery_error.is_none(), writer)?;
                if let Some(error) = recovery_error {
                    settings.linear_api_key_set = false;
                    settings.linear_api_key_error = Some(error);
                } else {
                    credential_availability(&mut settings, credentials);
                }
                Ok(settings)
            },
        )
        .await
    }

    /// The caller owns `commit_effects` and drains recovery before using this
    /// snapshot. Settings and the injected credential are read under one lock.
    pub(crate) async fn runtime_snapshot(&self) -> Result<SettingsSnapshot, String> {
        self.access(
            AccessMode::Load,
            |path, credentials, recovery_error, writer| {
                if let Some(error) = recovery_error {
                    return Err(error);
                }
                let mut settings = read_settings_with_migration(path, true, writer)?;
                let credential = match credentials.read() {
                    Ok(credential) => {
                        settings.linear_api_key_set = credential.is_some();
                        settings.linear_api_key_error = None;
                        credential
                    }
                    Err(_) => {
                        settings.linear_api_key_set = false;
                        settings.linear_api_key_error = Some(
                            "The OS credential store is unavailable. Unlock it and retry.".into(),
                        );
                        None
                    }
                };
                Ok(SettingsSnapshot {
                    settings,
                    credential,
                })
            },
        )
        .await
    }

    pub async fn save(
        &self,
        mut settings: AppSettings,
        key: Option<String>,
    ) -> Result<AppSettings, String> {
        self.access(AccessMode::Commit, move |path, credentials, _, writer| {
            let current = read_settings(path, writer)?;
            if current.settings_revision != settings.settings_revision {
                return Err("Settings changed since this draft was loaded. Reload the latest settings before saving.".to_string());
            }
            normalize_linear_filters(&mut settings);
            // Availability metadata from a draft is not durable credential state.
            settings.linear_api_key_set = current.linear_api_key_set;
            settings.settings_revision = next_revision(current.settings_revision)?;
            let key = key.filter(|value| !value.trim().is_empty());
            commit_settings(path, settings, credentials, key.as_deref().map(Some), writer)
        }).await
    }

    pub async fn apply_prompt(
        &self,
        expected_revision: u64,
        expected_hash: String,
        prompt: String,
    ) -> Result<AppSettings, String> {
        self.access(AccessMode::Commit, move |path, credentials, _, writer| {
            let mut settings = read_settings(path, writer)?;
            let current_hash = format!("{:x}", Sha256::digest(settings.prompt_template.as_bytes()));
            if settings.settings_revision != expected_revision || current_hash != expected_hash {
                return Err("Settings changed while the workflow update was being prepared. Review the latest settings and retry.".to_string());
            }
            settings.prompt_template = prompt;
            settings.settings_revision = next_revision(settings.settings_revision)?;
            commit_settings(path, settings, credentials, None, writer)
        }).await
    }

    pub async fn remove_key(&self) -> Result<AppSettings, String> {
        self.access(AccessMode::Commit, move |path, credentials, _, writer| {
            let mut settings = read_settings(path, writer)?;
            settings.settings_revision = next_revision(settings.settings_revision)?;
            commit_settings(path, settings, credentials, Some(None), writer)
        })
        .await
    }
}

/// Own the complete mutation, including asynchronous post-commit actions.
/// Dropping an IPC caller's future only detaches its wait; this task continues.
pub async fn finish_operation<T: Send + 'static>(
    operation: impl std::future::Future<Output = Result<T, String>> + Send + 'static,
) -> Result<T, String> {
    tokio::spawn(operation)
        .await
        .map_err(|error| error.to_string())?
}

fn next_revision(revision: u64) -> Result<u64, String> {
    revision
        .checked_add(1)
        .filter(|next| *next <= 9_007_199_254_740_991)
        .ok_or_else(|| "Settings revision limit reached.".to_string())
}

fn commit_settings(
    path: &Path,
    mut settings: AppSettings,
    credentials: &dyn Credentials,
    key_change: Option<Option<&str>>,
    writer: &SettingsWriter<'_>,
) -> Result<AppSettings, String> {
    settings.linear_api_key_error = None;
    if key_change.is_none() {
        writer.write(
            path,
            &serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?,
        )?;
        // A locked credential store does not prevent a prompt or config edit.
        // Overlay availability only in the response, after preserving metadata
        // about the last durable key mutation in the settings file.
        credential_availability(&mut settings, credentials);
        return Ok(settings);
    }
    let previous_key = credentials.read()?;
    settings.linear_api_key_set = key_change.flatten().is_some();
    let result = crate::settings_transaction::commit(
        path,
        &settings,
        credentials,
        key_change.flatten(),
        previous_key.as_deref(),
    );
    if result.is_err() {
        // Even a final journal-cleanup sync failure can follow a durable key
        // change. Stop before returning an ambiguous credential mutation result.
        writer.recovery_stop.store(true, Ordering::Release);
    }
    result?;
    Ok(settings)
}

fn credential_availability(settings: &mut AppSettings, credentials: &dyn Credentials) {
    match credentials.read() {
        Ok(key) => {
            settings.linear_api_key_set = key.is_some();
            settings.linear_api_key_error = None;
        }
        Err(_) => {
            settings.linear_api_key_set = false;
            settings.linear_api_key_error = Some(
                "The OS credential store is unavailable. Unlock it and retry to access the saved Linear API key.".into(),
            );
        }
    }
}

fn read_settings(path: &Path, writer: &SettingsWriter<'_>) -> Result<AppSettings, String> {
    read_settings_with_migration(path, true, writer)
}

fn read_settings_with_migration(
    path: &Path,
    persist_migration: bool,
    writer: &SettingsWriter<'_>,
) -> Result<AppSettings, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AppSettings::default())
        }
        Err(error) => return Err(error.to_string()),
    };
    let (mut settings, migrated) = parse_settings(&raw)?;
    settings.linear_api_key_error = None;
    if migrated && persist_migration {
        writer.write(&path.with_extension("json.bak"), &raw)?;
        settings.settings_revision = next_revision(settings.settings_revision)?;
        writer.write(
            path,
            &serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?,
        )?;
    }
    Ok(settings)
}

fn prepare(path: &Path, body: &str) -> Result<tempfile::NamedTempFile, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Settings path has no parent.".to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    file.write_all(body.as_bytes())
        .map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    Ok(file)
}

/// A successful return includes directory durability. After replacement, an
/// error is ambiguous: the new file is visible but may not survive power loss.
struct SettingsWriter<'a> {
    recovery_stop: &'a AtomicBool,
    sync_parent: ParentSync,
}

impl SettingsWriter<'_> {
    fn write(&self, path: &Path, body: &str) -> Result<(), String> {
        let file = prepare(path, body)?
            .persist(path)
            .map_err(|error| error.error.to_string())?;
        let result = file
            .sync_all()
            .map_err(|error| error.to_string())
            .and_then(|()| (self.sync_parent)(path));
        if result.is_err() {
            // Record inside the blocking owner's task, before an async caller
            // can lose the obligation to stop a runtime using the old file.
            self.recovery_stop.store(true, Ordering::Release);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn read_settings(path: &Path) -> Result<AppSettings, String> {
        super::read_settings(
            path,
            &SettingsWriter {
                recovery_stop: &AtomicBool::new(false),
                sync_parent: crate::settings_transaction::sync_parent,
            },
        )
    }
    fn write_atomic(path: &Path, body: &str) -> Result<(), String> {
        SettingsWriter {
            recovery_stop: &AtomicBool::new(false),
            sync_parent: crate::settings_transaction::sync_parent,
        }
        .write(path, body)
    }
    #[derive(Default)]
    struct FakeCredentials {
        value: Mutex<Option<String>>,
        fail: Mutex<bool>,
    }
    impl Credentials for FakeCredentials {
        fn read(&self) -> Result<Option<String>, String> {
            Ok(self.value.lock().unwrap().clone())
        }
        fn set(&self, value: Option<&str>) -> Result<(), String> {
            if *self.fail.lock().unwrap() {
                return Err("keychain unavailable".to_string());
            }
            *self.value.lock().unwrap() = value.map(str::to_string);
            Ok(())
        }
    }
    fn store(path: PathBuf) -> SettingsStore {
        SettingsStore::new(path, Arc::new(FakeCredentials::default()))
    }

    #[tokio::test]
    async fn concurrent_save_and_retro_cannot_overwrite_settings() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path().join("settings.json"));
        let original = store.save(AppSettings::default(), None).await.unwrap();
        let hash = format!("{:x}", Sha256::digest(original.prompt_template.as_bytes()));
        let mut edit = original.clone();
        edit.polling_interval_ms = 12345;
        let (save, retro) = tokio::join!(
            store.save(edit, None),
            store.apply_prompt(
                original.settings_revision,
                hash,
                "Reviewed prompt".to_string()
            )
        );
        assert_ne!(save.is_ok(), retro.is_ok());
        let saved = store.load().await.unwrap();
        assert_eq!(saved.settings_revision, 2);
        if save.is_ok() {
            assert_eq!(saved.polling_interval_ms, 12345);
            assert_eq!(saved.prompt_template, original.prompt_template);
        } else {
            assert_eq!(saved.prompt_template, "Reviewed prompt");
            assert_eq!(saved.polling_interval_ms, original.polling_interval_ms);
        }
    }

    #[tokio::test]
    async fn stale_save_cannot_change_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path().join("settings.json"));
        store
            .save(AppSettings::default(), Some("first-key".to_string()))
            .await
            .unwrap();
        assert!(store
            .save(AppSettings::default(), Some("stale-key".to_string()))
            .await
            .is_err());
        assert_eq!(
            store.credentials.read().unwrap().as_deref(),
            Some("first-key")
        );
    }

    #[tokio::test]
    async fn keychain_failure_leaves_settings_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let credentials = Arc::new(FakeCredentials::default());
        let store = SettingsStore::new(path.clone(), credentials.clone());
        let mut settings = store.save(AppSettings::default(), None).await.unwrap();
        let previous = std::fs::read(&path).unwrap();
        settings.prompt_template = "new prompt".to_string();
        *credentials.fail.lock().unwrap() = true;
        assert!(store
            .save(settings, Some("new-key".to_string()))
            .await
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), previous);
    }

    #[tokio::test]
    async fn unavailable_keyring_does_not_block_settings_or_allow_partial_mutations() {
        struct UnavailableCredentials;
        impl Credentials for UnavailableCredentials {
            fn read(&self) -> Result<Option<String>, String> {
                Err("private-service-diagnostic".into())
            }
            fn set(&self, _value: Option<&str>) -> Result<(), String> {
                panic!("an unavailable credential service must not admit a write")
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let original = AppSettings {
            settings_revision: 7,
            prompt_template: "Readable saved prompt".into(),
            linear_api_key_set: true,
            ..Default::default()
        };
        write_atomic(&path, &serde_json::to_string(&original).unwrap()).unwrap();
        let previous = std::fs::read(&path).unwrap();
        let store = SettingsStore::new(path.clone(), Arc::new(UnavailableCredentials));
        let loaded = store.load().await.unwrap();
        assert_eq!(loaded.settings_revision, 7);
        assert_eq!(loaded.prompt_template, original.prompt_template);
        assert!(!loaded.linear_api_key_set);
        assert!(loaded
            .linear_api_key_error
            .as_deref()
            .unwrap()
            .contains("unavailable"));
        assert!(!serde_json::to_string(&loaded)
            .unwrap()
            .contains("private-service-diagnostic"));
        assert!(store
            .save(loaded.clone(), Some("replacement".into()))
            .await
            .is_err());
        assert!(store.remove_key().await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), previous);

        let mut draft = loaded;
        draft.polling_interval_ms = 12345;
        draft.linear_api_key_error = Some("client-supplied-diagnostic".into());
        let saved = store.save(draft, None).await.unwrap();
        assert_eq!(saved.settings_revision, 8);
        assert_eq!(saved.polling_interval_ms, 12345);
        assert!(!saved.linear_api_key_set);
        assert!(saved
            .linear_api_key_error
            .as_deref()
            .unwrap()
            .contains("unavailable"));
        let durable = read_settings(&path).unwrap();
        assert!(durable.linear_api_key_set);
        assert!(durable.linear_api_key_error.is_none());
        let hash = format!("{:x}", Sha256::digest(saved.prompt_template.as_bytes()));
        let applied = store
            .apply_prompt(8, hash, "Reviewed update".into())
            .await
            .unwrap();
        assert_eq!(applied.settings_revision, 9);
        assert_eq!(applied.prompt_template, "Reviewed update");
        assert!(!applied.linear_api_key_set);
        assert!(applied.linear_api_key_error.is_some());
        let durable = read_settings(&path).unwrap();
        assert!(durable.linear_api_key_set);
        assert!(durable.linear_api_key_error.is_none());
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("client-supplied-diagnostic"));
        assert!(!disk.contains("private-service-diagnostic"));
    }

    #[tokio::test]
    async fn ordinary_save_cannot_persist_client_credential_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = store(path.clone());
        let draft = AppSettings {
            linear_api_key_set: true,
            linear_api_key_error: Some("client-diagnostic".into()),
            ..Default::default()
        };
        let saved = store.save(draft, None).await.unwrap();
        assert!(!saved.linear_api_key_set);
        assert!(saved.linear_api_key_error.is_none());
        let durable = read_settings(&path).unwrap();
        assert!(!durable.linear_api_key_set);
        assert!(durable.linear_api_key_error.is_none());
    }

    #[tokio::test]
    async fn unresolved_recovery_keeps_settings_readable_without_migration_or_writes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut legacy = serde_json::to_value(AppSettings::default()).unwrap();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("codex_permission_mode");
        legacy["codex_approval_policy"] = serde_json::json!("never");
        let original = serde_json::to_string(&legacy).unwrap();
        std::fs::write(&path, &original).unwrap();
        std::fs::write(
            path.with_extension("json.transaction"),
            "interrupted journal",
        )
        .unwrap();
        let store = store(path.clone());
        let settings = store.load().await.unwrap();
        assert!(settings
            .linear_api_key_error
            .as_deref()
            .unwrap()
            .contains("Recovery"));
        assert!(!settings.linear_api_key_set);
        assert!(store.save(settings, None).await.is_err());
        assert!(store.remove_key().await.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert!(!path.with_extension("json.bak").exists());
        assert!(path.with_extension("json.transaction").exists());
    }

    #[tokio::test]
    async fn cancelled_save_retains_gate_through_effects_before_the_next_commit() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path().join("settings.json"));
        let effects = Arc::new(Mutex::new(Vec::new()));
        let (committed, committed_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = tokio::sync::oneshot::channel();
        let writer = store.clone();
        let recorded = effects.clone();
        let first = tokio::spawn(async move {
            finish_operation(async move {
                let _effects = writer.commit_effects().await;
                let saved = writer.save(AppSettings::default(), None).await?;
                committed.send(()).unwrap();
                release_rx.await.unwrap();
                recorded.lock().unwrap().push(saved.settings_revision);
                Ok(())
            })
            .await
        });
        committed_rx.await.unwrap();
        first.abort();
        let writer = store.clone();
        let recorded = effects.clone();
        let second = tokio::spawn(async move {
            finish_operation(async move {
                let _effects = writer.commit_effects().await;
                let settings = writer.load().await?;
                let saved = writer.save(settings, None).await?;
                recorded.lock().unwrap().push(saved.settings_revision);
                Ok(())
            })
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!second.is_finished());
        assert_eq!(store.load().await.unwrap().settings_revision, 1);
        release.send(()).unwrap();
        second.await.unwrap().unwrap();
        assert_eq!(*effects.lock().unwrap(), [1, 2]);
    }

    #[tokio::test]
    async fn captured_start_finishes_before_removal_commits_and_stops() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path().join("settings.json"));
        store
            .save(AppSettings::default(), Some("old-key".into()))
            .await
            .unwrap();
        let effects = Arc::new(Mutex::new(Vec::new()));
        let (captured, captured_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = tokio::sync::oneshot::channel();
        let reader = store.clone();
        let recorded = effects.clone();
        let start = tokio::spawn(async move {
            finish_operation(async move {
                let _effects = reader.commit_effects().await;
                let settings = reader.load().await?;
                assert!(settings.linear_api_key_set);
                captured.send(()).unwrap();
                release_rx.await.unwrap();
                recorded
                    .lock()
                    .unwrap()
                    .push(("start", settings.settings_revision));
                Ok(())
            })
            .await
        });
        captured_rx.await.unwrap();
        // Detaching Start must not let a captured old key escape the gate.
        start.abort();
        let writer = store.clone();
        let recorded = effects.clone();
        let removal = tokio::spawn(async move {
            finish_operation(async move {
                let _effects = writer.commit_effects().await;
                let settings = writer.remove_key().await?;
                recorded
                    .lock()
                    .unwrap()
                    .push(("stop", settings.settings_revision));
                Ok(())
            })
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!removal.is_finished());
        assert!(store.load().await.unwrap().linear_api_key_set);
        release.send(()).unwrap();
        removal.await.unwrap().unwrap();
        assert_eq!(*effects.lock().unwrap(), [("start", 1), ("stop", 2)]);
        assert!(!store.load().await.unwrap().linear_api_key_set);
    }

    #[tokio::test]
    async fn removal_stop_cannot_run_after_a_newer_save_effect() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path().join("settings.json"));
        store
            .save(AppSettings::default(), Some("old-key".into()))
            .await
            .unwrap();
        let effects = Arc::new(Mutex::new(Vec::new()));
        let (committed, committed_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = tokio::sync::oneshot::channel();
        let writer = store.clone();
        let recorded = effects.clone();
        let removal = tokio::spawn(async move {
            finish_operation(async move {
                let _effects = writer.commit_effects().await;
                let settings = writer.remove_key().await?;
                committed.send(()).unwrap();
                release_rx.await.unwrap();
                recorded
                    .lock()
                    .unwrap()
                    .push(("stop", settings.settings_revision));
                Ok(())
            })
            .await
        });
        committed_rx.await.unwrap();
        let writer = store.clone();
        let recorded = effects.clone();
        let save = tokio::spawn(async move {
            finish_operation(async move {
                let _effects = writer.commit_effects().await;
                let settings = writer.load().await?;
                let saved = writer.save(settings, Some("new-key".into())).await?;
                recorded
                    .lock()
                    .unwrap()
                    .push(("reconfigure", saved.settings_revision));
                Ok(())
            })
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!save.is_finished());
        assert_eq!(store.load().await.unwrap().settings_revision, 2);
        release.send(()).unwrap();
        removal.await.unwrap().unwrap();
        save.await.unwrap().unwrap();
        assert_eq!(*effects.lock().unwrap(), [("stop", 2), ("reconfigure", 3)]);
        assert!(store.load().await.unwrap().linear_api_key_set);
    }

    #[tokio::test]
    async fn retro_preparation_allows_save_then_rejects_stale_prompt_commit() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path().join("settings.json"));
        let original = store.save(AppSettings::default(), None).await.unwrap();
        let hash = format!("{:x}", Sha256::digest(original.prompt_template.as_bytes()));
        let (prepared, prepared_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = tokio::sync::oneshot::channel();
        let writer = store.clone();
        let retro = tokio::spawn(async move {
            finish_operation(async move {
                // Remote source validation runs before acquiring commit/effects ownership.
                prepared.send(()).unwrap();
                release_rx.await.unwrap();
                let _effects = writer.commit_effects().await;
                writer
                    .apply_prompt(original.settings_revision, hash, "Retro prompt".into())
                    .await
            })
            .await
        });
        prepared_rx.await.unwrap();
        let mut draft = store.load().await.unwrap();
        draft.prompt_template = "User prompt".into();
        let writer = store.clone();
        finish_operation(async move {
            let _effects = writer.commit_effects().await;
            writer.save(draft, None).await
        })
        .await
        .unwrap();
        release.send(()).unwrap();
        assert!(retro
            .await
            .unwrap()
            .unwrap_err()
            .starts_with("Settings changed"));
        let saved = store.load().await.unwrap();
        assert_eq!(saved.settings_revision, 2);
        assert_eq!(saved.prompt_template, "User prompt");
    }

    #[tokio::test]
    async fn concurrent_migration_reads_preserve_one_backup_and_revision() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut legacy = serde_json::to_value(AppSettings::default()).unwrap();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("codex_permission_mode");
        legacy["codex_approval_policy"] = serde_json::json!("never");
        let raw = serde_json::to_string(&legacy).unwrap();
        std::fs::write(&path, &raw).unwrap();
        let store = store(path.clone());
        let (first, second) = tokio::join!(store.load(), store.load());
        assert_eq!(first.unwrap().settings_revision, 1);
        assert_eq!(second.unwrap().settings_revision, 1);
        assert_eq!(
            std::fs::read_to_string(path.with_extension("json.bak")).unwrap(),
            raw
        );
        assert_eq!(store.load().await.unwrap().settings_revision, 1);
    }

    #[test]
    fn failed_replacement_restores_previous_credential() {
        let directory = tempfile::tempdir().unwrap();
        let credentials = FakeCredentials::default();
        credentials.set(Some("old-key")).unwrap();
        assert!(commit_settings(
            directory.path(),
            AppSettings::default(),
            &credentials,
            Some(Some("new-key")),
            &SettingsWriter {
                recovery_stop: &AtomicBool::new(false),
                sync_parent: crate::settings_transaction::sync_parent,
            },
        )
        .is_err());
        assert_eq!(credentials.read().unwrap().as_deref(), Some("old-key"));
    }

    #[tokio::test]
    async fn removing_credentials_invalidates_old_drafts() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path().join("settings.json"));
        let old = store
            .save(AppSettings::default(), Some("old-key".to_string()))
            .await
            .unwrap();
        let removed = store.remove_key().await.unwrap();
        assert_eq!(removed.settings_revision, 2);
        assert!(!removed.linear_api_key_set);
        assert!(store
            .save(old, Some("stale-key".to_string()))
            .await
            .is_err());
        assert_eq!(store.credentials.read().unwrap(), None);
    }

    #[tokio::test]
    async fn dropped_save_future_retains_commit_and_continuation_ownership() {
        struct BlockingCredentials {
            entered: tokio::sync::Notify,
            gate: (Mutex<bool>, std::sync::Condvar),
        }
        impl Credentials for BlockingCredentials {
            fn read(&self) -> Result<Option<String>, String> {
                Ok(None)
            }
            fn set(&self, _value: Option<&str>) -> Result<(), String> {
                self.entered.notify_one();
                let (mutex, wake) = &self.gate;
                let mut released = mutex.lock().unwrap();
                while !*released {
                    released = wake.wait(released).unwrap();
                }
                Ok(())
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let credentials = Arc::new(BlockingCredentials {
            entered: tokio::sync::Notify::new(),
            gate: (Mutex::new(false), std::sync::Condvar::new()),
        });
        let store = SettingsStore::new(directory.path().join("settings.json"), credentials.clone());
        let writer = store.clone();
        let continued = Arc::new(tokio::sync::Notify::new());
        let notify = continued.clone();
        let continuation = continued.notified();
        let first = tokio::spawn(async move {
            finish_operation(async move {
                let saved = writer
                    .save(
                        AppSettings::default(),
                        Some("lin_api_cancel_fixture".to_string()),
                    )
                    .await?;
                notify.notify_one();
                Ok(saved)
            })
            .await
        });
        credentials.entered.notified().await;
        first.abort();
        let writer = store.clone();
        let second = tokio::spawn(async move { writer.save(AppSettings::default(), None).await });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let completed_early = second.is_finished();
        *credentials.gate.0.lock().unwrap() = true;
        credentials.gate.1.notify_all();
        let second_result = second.await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), continuation)
            .await
            .expect("caller cancellation skipped the post-commit continuation");
        assert!(!completed_early);
        assert!(second_result.is_err());
        assert_eq!(store.load().await.unwrap().settings_revision, 1);
    }

    // Child entry point for the independent-process lock test. Environment is
    // scoped to child Commands, so parallel tests never mutate process env.
    #[tokio::test]
    async fn settings_writer_process_fixture() {
        let Some(path) = std::env::var_os("SYMPHONY_SETTINGS_TEST_PATH") else {
            return;
        };
        let output = PathBuf::from(std::env::var_os("SYMPHONY_SETTINGS_TEST_OUTPUT").unwrap());
        std::fs::write(output.with_extension("ready"), "ready").unwrap();
        let result = store(PathBuf::from(path))
            .save(AppSettings::default(), None)
            .await;
        let outcome = match result {
            Ok(_) => "saved",
            Err(error) => {
                assert!(error.starts_with("Settings changed since"), "{error}");
                "stale"
            }
        };
        std::fs::write(output, outcome).unwrap();
    }

    #[tokio::test]
    async fn independent_processes_cannot_commit_the_same_revision() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let lock = std::fs::File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path.with_extension("json.lock"))
            .unwrap();
        lock.lock().unwrap();
        let mut children = Vec::new();
        let outputs = [
            directory.path().join("one.out"),
            directory.path().join("two.out"),
        ];
        for output in &outputs {
            children.push(
                tokio::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "settings_store::tests::settings_writer_process_fixture",
                    ])
                    .env("SYMPHONY_SETTINGS_TEST_PATH", &path)
                    .env("SYMPHONY_SETTINGS_TEST_OUTPUT", output)
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .kill_on_drop(true)
                    .spawn()
                    .unwrap(),
            );
        }
        let ready = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !outputs
                .iter()
                .all(|output| output.with_extension("ready").exists())
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
        drop(lock);
        ready.expect("settings writer children never became ready");
        for child in children {
            let result =
                tokio::time::timeout(std::time::Duration::from_secs(10), child.wait_with_output())
                    .await
                    .unwrap()
                    .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        let mut outcomes = outputs
            .iter()
            .map(|output| std::fs::read_to_string(output).unwrap())
            .collect::<Vec<_>>();
        outcomes.sort();
        assert_eq!(outcomes, ["saved", "stale"]);
        assert_eq!(store(path).load().await.unwrap().settings_revision, 1);
    }

    #[test]
    fn abandoned_prepared_write_preserves_valid_prior_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        write_atomic(&path, "{\"old\":true}").unwrap();
        drop(prepare(&path, "{\"new\":true}").unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"old\":true}");
        write_atomic(&path, "{\"new\":true}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"new\":true}");
    }

    fn fail_parent_sync(path: &Path) -> Result<(), String> {
        assert!(
            path.is_file(),
            "replacement must be visible before parent sync"
        );
        Err("Synthetic parent-directory sync failure.".into())
    }

    #[tokio::test]
    async fn ordinary_save_and_prompt_sync_failure_report_error_after_replacement() {
        for prompt_update in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("settings.json");
            let original = AppSettings {
                settings_revision: 7,
                ..Default::default()
            };
            write_atomic(&path, &serde_json::to_string(&original).unwrap()).unwrap();
            let store = store(path.clone()).with_parent_sync(fail_parent_sync);
            let result = if prompt_update {
                let hash = format!("{:x}", Sha256::digest(original.prompt_template.as_bytes()));
                store
                    .apply_prompt(7, hash, "Replacement prompt".into())
                    .await
            } else {
                let mut draft = original;
                draft.prompt_template = "Replacement prompt".into();
                store.save(draft, None).await
            };
            assert!(result.unwrap_err().contains("parent-directory sync"));
            let visible = read_settings(&path).unwrap();
            assert_eq!(visible.settings_revision, 8);
            assert_eq!(visible.prompt_template, "Replacement prompt");
            assert!(store.take_recovery_stop());
            assert!(!crate::settings_transaction::has_pending(&path));
        }
    }

    #[tokio::test]
    async fn migration_backup_sync_failure_preserves_the_original_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut legacy = serde_json::to_value(AppSettings::default()).unwrap();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("codex_permission_mode");
        legacy["codex_approval_policy"] = serde_json::json!("never");
        let raw = serde_json::to_string(&legacy).unwrap();
        std::fs::write(&path, &raw).unwrap();
        let store = store(path.clone()).with_parent_sync(fail_parent_sync);
        assert!(store
            .load()
            .await
            .unwrap_err()
            .contains("parent-directory sync"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), raw);
        assert_eq!(
            std::fs::read_to_string(path.with_extension("json.bak")).unwrap(),
            raw
        );
        assert!(store.take_recovery_stop());
    }

    #[test]
    fn preparation_failure_does_not_schedule_a_post_commit_stop() {
        let directory = tempfile::tempdir().unwrap();
        let stop = AtomicBool::new(false);
        let writer = SettingsWriter {
            recovery_stop: &stop,
            sync_parent: fail_parent_sync,
        };
        assert!(writer
            .write(&directory.path().join("missing/settings.json"), "{}")
            .is_err());
        assert!(!stop.load(Ordering::Acquire));
    }
}
