use crate::settings::{normalize_linear_filters, parse_settings};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use symphony_contracts::AppSettings;

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
    credentials: Arc<dyn Credentials>,
}

impl SettingsStore {
    pub fn new(path: PathBuf, credentials: Arc<dyn Credentials>) -> Self {
        Self {
            path,
            gate: Arc::new(Mutex::new(())),
            credentials,
        }
    }

    // The blocking task owns the lock: dropping an IPC future cannot release
    // ownership while its disk/keychain operation is still committing.
    async fn access<T: Send + 'static>(
        &self,
        action: impl FnOnce(&Path, &dyn Credentials) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = store
                .gate
                .lock()
                .map_err(|_| "Settings state is unavailable.")?;
            action(&store.path, store.credentials.as_ref())
        })
        .await
        .map_err(|error| error.to_string())?
    }

    pub async fn load(&self) -> Result<AppSettings, String> {
        self.access(|path, credentials| {
            let mut settings = read_settings(path)?;
            settings.linear_api_key_set = credentials.read()?.is_some();
            Ok(settings)
        })
        .await
    }

    pub async fn save(
        &self,
        mut settings: AppSettings,
        key: Option<String>,
    ) -> Result<AppSettings, String> {
        self.access(move |path, credentials| {
            let current = read_settings(path)?;
            if current.settings_revision != settings.settings_revision {
                return Err("Settings changed since this draft was loaded. Reload the latest settings before saving.".to_string());
            }
            normalize_linear_filters(&mut settings);
            settings.settings_revision = next_revision(current.settings_revision)?;
            let key = key.filter(|value| !value.trim().is_empty());
            commit_settings(path, settings, credentials, key.as_deref().map(Some))
        }).await
    }

    pub async fn apply_prompt(
        &self,
        expected_revision: u64,
        expected_hash: String,
        prompt: String,
    ) -> Result<AppSettings, String> {
        self.access(move |path, credentials| {
            let mut settings = read_settings(path)?;
            let current_hash = format!("{:x}", Sha256::digest(settings.prompt_template.as_bytes()));
            if settings.settings_revision != expected_revision || current_hash != expected_hash {
                return Err("Settings changed while the workflow update was being prepared. Review the latest settings and retry.".to_string());
            }
            settings.prompt_template = prompt;
            settings.settings_revision = next_revision(settings.settings_revision)?;
            commit_settings(path, settings, credentials, None)
        }).await
    }

    pub async fn remove_key(&self) -> Result<AppSettings, String> {
        self.access(|path, credentials| {
            let mut settings = read_settings(path)?;
            settings.settings_revision = next_revision(settings.settings_revision)?;
            commit_settings(path, settings, credentials, Some(None))
        })
        .await
    }
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
) -> Result<AppSettings, String> {
    let previous_key = credentials.read()?;
    settings.linear_api_key_set = key_change.unwrap_or(previous_key.as_deref()).is_some();
    let prepared = prepare(
        path,
        &serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?,
    )?;
    if let Some(value) = key_change {
        credentials.set(value)?;
    }
    if let Err(error) = prepared.persist(path) {
        let mut message = format!("Could not save settings: {}", error.error);
        if key_change.is_some() {
            if let Err(rollback) = credentials.set(previous_key.as_deref()) {
                message.push_str(&format!(" Credential restoration also failed: {rollback}. Check the Linear credential before restarting work."));
            }
        }
        return Err(message);
    }
    Ok(settings)
}

fn read_settings(path: &Path) -> Result<AppSettings, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AppSettings::default())
        }
        Err(error) => return Err(error.to_string()),
    };
    let (mut settings, migrated) = parse_settings(&raw)?;
    if migrated {
        write_atomic(&path.with_extension("json.bak"), &raw)?;
        settings.settings_revision = next_revision(settings.settings_revision)?;
        write_atomic(
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

fn write_atomic(path: &Path, body: &str) -> Result<(), String> {
    prepare(path, body)?
        .persist(path)
        .map_err(|error| error.error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
            Some(Some("new-key"))
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
    async fn dropped_save_future_retains_commit_ownership() {
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
        let first = tokio::spawn(async move {
            writer
                .save(AppSettings::default(), Some("key".to_string()))
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
        assert!(!completed_early);
        assert!(second_result.is_err());
        assert_eq!(store.load().await.unwrap().settings_revision, 1);
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
}
