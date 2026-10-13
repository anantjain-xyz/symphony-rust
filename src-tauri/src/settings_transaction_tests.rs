use super::*;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};

const OLD: &str = "lin_api_synthetic_old_credential_canary";
const NEW: &str = "lin_api_synthetic_new_credential_canary";

struct FakeCredentials {
    value: Mutex<Option<String>>,
    unavailable: AtomicBool,
    reads: AtomicUsize,
    sets: AtomicUsize,
    // Return errors on these calls, optionally after actually changing the key.
    failures: Mutex<Vec<(usize, bool)>>,
}
impl FakeCredentials {
    fn new(key: Option<&str>) -> Self {
        Self {
            value: Mutex::new(key.map(str::to_owned)),
            unavailable: AtomicBool::new(false),
            reads: AtomicUsize::new(0),
            sets: AtomicUsize::new(0),
            failures: Mutex::new(vec![]),
        }
    }
    fn current(&self) -> Option<String> {
        self.value.lock().unwrap().clone()
    }
}
impl Credentials for FakeCredentials {
    fn read(&self) -> Result<Option<String>, String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.unavailable.load(Ordering::SeqCst) {
            Err("synthetic keyring unavailable".into())
        } else {
            Ok(self.current())
        }
    }
    fn set(&self, key: Option<&str>) -> Result<(), String> {
        let call = self.sets.fetch_add(1, Ordering::SeqCst) + 1;
        let failure = self
            .failures
            .lock()
            .unwrap()
            .iter()
            .find(|(at, _)| *at == call)
            .copied();
        if failure.is_none_or(|(_, mutate)| mutate) {
            *self.value.lock().unwrap() = key.map(str::to_owned);
        }
        match failure {
            Some(_) => Err("synthetic credential write failure".into()),
            None => Ok(()),
        }
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    path: PathBuf,
    credentials: FakeCredentials,
    before: AppSettings,
    after: AppSettings,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let before = AppSettings {
            settings_revision: 10,
            linear_api_key_set: true,
            polling_interval_ms: 1000,
            ..Default::default()
        };
        write_atomic(&path, &settings_body(&before).unwrap(), true).unwrap();
        let mut after = before.clone();
        after.settings_revision += 1;
        after.polling_interval_ms = 2000;
        Self {
            _directory: directory,
            path,
            credentials: FakeCredentials::new(Some(OLD)),
            before,
            after,
        }
    }
    fn interrupt(&self, point: CommitPoint, replacement: Option<&str>) {
        let mut after = self.after.clone();
        after.linear_api_key_set = replacement.is_some();
        let error = commit_with_hooks(
            &self.path,
            &after,
            &self.credentials,
            replacement,
            Some(OLD),
            |at| {
                if std::mem::discriminant(&point) == std::mem::discriminant(&at) {
                    Err("simulated process loss".into())
                } else {
                    Ok(())
                }
            },
            |path, body| write_atomic(path, body, true),
        )
        .unwrap_err();
        assert_eq!(error, "simulated process loss");
        assert!(journal_path(&self.path).exists());
        assert!(has_pending(&self.path));
        let raw = std::fs::read_to_string(journal_path(&self.path)).unwrap();
        assert!(!raw.contains(OLD));
        assert!(!raw.contains(NEW));
    }
    fn settings(&self) -> AppSettings {
        serde_json::from_slice(&std::fs::read(&self.path).unwrap()).unwrap()
    }
    fn recover_twice(&self, first: RecoveryOutcome) {
        assert_eq!(recover(&self.path, &self.credentials).unwrap(), first);
        let reads = self.credentials.reads.load(Ordering::SeqCst);
        assert_eq!(
            recover(&self.path, &self.credentials).unwrap(),
            RecoveryOutcome::Ready
        );
        assert_eq!(self.credentials.reads.load(Ordering::SeqCst), reads);
        assert!(!journal_path(&self.path).exists());
        assert!(!has_pending(&self.path));
    }
}

#[test]
fn interruption_before_key_change_retains_the_old_revision() {
    let fixture = Fixture::new();
    fixture.interrupt(CommitPoint::JournalDurable, Some(NEW));
    assert_eq!(fixture.credentials.sets.load(Ordering::SeqCst), 0);
    fixture.recover_twice(RecoveryOutcome::Ready);
    assert_eq!(
        fixture.settings().settings_revision,
        fixture.before.settings_revision
    );
    assert_eq!(fixture.settings().polling_interval_ms, 1000);
    assert_eq!(fixture.credentials.current().as_deref(), Some(OLD));
}

#[test]
fn interruption_after_key_change_finishes_the_matching_new_revision() {
    let fixture = Fixture::new();
    fixture.interrupt(CommitPoint::CredentialChanged, Some(NEW));
    assert_eq!(
        fixture.settings().settings_revision,
        fixture.before.settings_revision
    );
    fixture.recover_twice(RecoveryOutcome::Recovered {
        settings_revision: 11,
    });
    assert_eq!(
        fixture.settings().settings_revision,
        fixture.after.settings_revision
    );
    assert_eq!(fixture.settings().polling_interval_ms, 2000);
    assert_eq!(fixture.credentials.current().as_deref(), Some(NEW));
}

#[test]
fn interruption_after_file_commit_only_finishes_cleanup() {
    let fixture = Fixture::new();
    fixture.interrupt(CommitPoint::SettingsDurable, Some(NEW));
    let before = std::fs::read(&fixture.path).unwrap();
    fixture.recover_twice(RecoveryOutcome::Recovered {
        settings_revision: 11,
    });
    assert_eq!(std::fs::read(&fixture.path).unwrap(), before);
    assert_eq!(fixture.credentials.sets.load(Ordering::SeqCst), 1);
}

#[test]
fn recovery_reports_the_new_revision_even_when_replacing_with_the_same_key() {
    let fixture = Fixture::new();
    fixture.interrupt(CommitPoint::CredentialChanged, Some(OLD));
    fixture.recover_twice(RecoveryOutcome::Recovered {
        settings_revision: fixture.after.settings_revision,
    });
    assert_eq!(fixture.settings().settings_revision, 11);
    assert_eq!(fixture.credentials.current().as_deref(), Some(OLD));
}

#[test]
fn interrupted_removal_recovers_as_an_absent_credential() {
    for point in [CommitPoint::CredentialChanged, CommitPoint::SettingsDurable] {
        let fixture = Fixture::new();
        fixture.interrupt(point, None);
        fixture.recover_twice(RecoveryOutcome::Recovered {
            settings_revision: 11,
        });
        assert_eq!(fixture.settings().settings_revision, 11);
        assert!(!fixture.settings().linear_api_key_set);
        assert!(fixture.credentials.current().is_none());
    }
}

#[test]
fn unavailable_keyring_defers_without_changing_any_durable_state() {
    let fixture = Fixture::new();
    fixture.interrupt(CommitPoint::CredentialChanged, Some(NEW));
    let marker = std::fs::read(journal_path(&fixture.path)).unwrap();
    let settings = std::fs::read(&fixture.path).unwrap();
    fixture
        .credentials
        .unavailable
        .store(true, Ordering::SeqCst);
    for _ in 0..2 {
        assert_eq!(
            recover(&fixture.path, &fixture.credentials).unwrap(),
            RecoveryOutcome::Deferred
        );
        assert_eq!(std::fs::read(journal_path(&fixture.path)).unwrap(), marker);
        assert_eq!(std::fs::read(&fixture.path).unwrap(), settings);
        assert!(commit(
            &fixture.path,
            &fixture.after,
            &fixture.credentials,
            Some(NEW),
            Some(OLD)
        )
        .is_err());
    }
    fixture
        .credentials
        .unavailable
        .store(false, Ordering::SeqCst);
    fixture.recover_twice(RecoveryOutcome::Recovered {
        settings_revision: 11,
    });
    assert_eq!(fixture.settings().settings_revision, 11);
}

#[test]
fn no_journal_does_not_read_or_require_the_keyring() {
    let fixture = Fixture::new();
    fixture
        .credentials
        .unavailable
        .store(true, Ordering::SeqCst);
    fixture.recover_twice(RecoveryOutcome::Ready);
    assert_eq!(fixture.credentials.reads.load(Ordering::SeqCst), 0);
}

#[test]
fn a_newer_file_supersedes_an_old_marker_without_touching_credentials() {
    let fixture = Fixture::new();
    fixture.interrupt(CommitPoint::CredentialChanged, Some(NEW));
    let mut newer = fixture.after.clone();
    newer.settings_revision += 1;
    newer.polling_interval_ms = 3000;
    write_atomic(&fixture.path, &settings_body(&newer).unwrap(), true).unwrap();
    fixture
        .credentials
        .unavailable
        .store(true, Ordering::SeqCst);
    fixture.recover_twice(RecoveryOutcome::Ready);
    assert_eq!(fixture.settings().settings_revision, 12);
    assert_eq!(fixture.settings().polling_interval_ms, 3000);
    assert_eq!(fixture.credentials.reads.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.credentials.sets.load(Ordering::SeqCst), 1);
}

#[test]
fn mismatched_file_or_credential_is_preserved_and_blocks_recovery() {
    for change_file in [false, true] {
        let fixture = Fixture::new();
        fixture.interrupt(CommitPoint::CredentialChanged, Some(NEW));
        if change_file {
            let mut edited = fixture.before.clone();
            edited.polling_interval_ms = 123;
            write_atomic(&fixture.path, &settings_body(&edited).unwrap(), true).unwrap();
        } else {
            *fixture.credentials.value.lock().unwrap() = Some("unrelated-key".into());
        }
        let before = std::fs::read(&fixture.path).unwrap();
        let key = fixture.credentials.current();
        assert!(recover(&fixture.path, &fixture.credentials).is_err());
        assert_eq!(std::fs::read(&fixture.path).unwrap(), before);
        assert_eq!(fixture.credentials.current(), key);
        assert!(journal_path(&fixture.path).exists());
    }
}

#[test]
fn a_returned_set_error_restores_old_state_even_if_the_set_mutated_first() {
    for mutated in [false, true] {
        let fixture = Fixture::new();
        *fixture.credentials.failures.lock().unwrap() = vec![(1, mutated)];
        let error = commit(
            &fixture.path,
            &fixture.after,
            &fixture.credentials,
            Some(NEW),
            Some(OLD),
        )
        .unwrap_err();
        assert!(error.contains("restored"));
        assert_eq!(fixture.credentials.current().as_deref(), Some(OLD));
        assert_eq!(fixture.settings().settings_revision, 10);
        assert!(!journal_path(&fixture.path).exists());
    }
}

#[test]
fn returned_file_error_rolls_back_only_before_the_new_file_is_installed() {
    for installed in [false, true] {
        let fixture = Fixture::new();
        let error = commit_with_hooks(
            &fixture.path,
            &fixture.after,
            &fixture.credentials,
            Some(NEW),
            Some(OLD),
            |_| Ok(()),
            |path, body| {
                if installed {
                    std::fs::write(path, body).unwrap();
                }
                Err("simulated persist/directory sync error".into())
            },
        )
        .unwrap_err();
        if installed {
            assert!(error.contains("recovery"));
            assert_eq!(fixture.credentials.current().as_deref(), Some(NEW));
            assert_eq!(fixture.credentials.sets.load(Ordering::SeqCst), 1);
            fixture.recover_twice(RecoveryOutcome::Recovered {
                settings_revision: 11,
            });
            assert_eq!(fixture.settings().settings_revision, 11);
        } else {
            assert!(error.contains("restored"));
            assert_eq!(fixture.credentials.current().as_deref(), Some(OLD));
            assert_eq!(fixture.settings().settings_revision, 10);
            assert!(!journal_path(&fixture.path).exists());
        }
    }
}

#[test]
fn failed_rollback_keeps_a_marker_so_restart_can_complete_the_new_state() {
    let fixture = Fixture::new();
    *fixture.credentials.failures.lock().unwrap() = vec![(1, true), (2, false)];
    let error = commit(
        &fixture.path,
        &fixture.after,
        &fixture.credentials,
        Some(NEW),
        Some(OLD),
    )
    .unwrap_err();
    assert!(error.contains("recovery"));
    assert_eq!(fixture.credentials.current().as_deref(), Some(NEW));
    assert_eq!(fixture.settings().settings_revision, 10);
    fixture.recover_twice(RecoveryOutcome::Recovered {
        settings_revision: 11,
    });
    assert_eq!(fixture.settings().settings_revision, 11);
}

#[test]
fn fingerprints_are_salted_and_distinguish_removal_from_an_empty_key() {
    let first = Fixture::new();
    let second = Fixture::new();
    first.interrupt(CommitPoint::JournalDurable, Some(NEW));
    second.interrupt(CommitPoint::JournalDurable, Some(NEW));
    let first: Journal =
        serde_json::from_slice(&std::fs::read(journal_path(&first.path)).unwrap()).unwrap();
    let second: Journal =
        serde_json::from_slice(&std::fs::read(journal_path(&second.path)).unwrap()).unwrap();
    assert_ne!(first.salt, second.salt);
    assert_ne!(first.old_credential_digest, second.old_credential_digest);
    assert_ne!(first.new_credential_digest, second.new_credential_digest);
    assert_ne!(
        credential_digest(&first.salt, None),
        credential_digest(&first.salt, Some(""))
    );
}

#[test]
fn accidental_credential_copies_in_settings_are_not_written_to_a_journal() {
    let mut fixture = Fixture::new();
    fixture
        .after
        .session_env
        .insert("CUSTOM".into(), NEW.into());
    assert!(commit(
        &fixture.path,
        &fixture.after,
        &fixture.credentials,
        Some(NEW),
        Some(OLD)
    )
    .is_err());
    assert!(!journal_path(&fixture.path).exists());
    assert_eq!(fixture.credentials.sets.load(Ordering::SeqCst), 0);
}

#[test]
fn malformed_marker_remains_available_for_diagnosis() {
    let fixture = Fixture::new();
    std::fs::write(journal_path(&fixture.path), "{invalid").unwrap();
    assert!(recover(&fixture.path, &fixture.credentials).is_err());
    assert_eq!(
        std::fs::read_to_string(journal_path(&fixture.path)).unwrap(),
        "{invalid"
    );
}
