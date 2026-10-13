//! Recoverable credential/settings commits. Call only while holding the stable
//! settings sidecar lock. The journal contains salted credential fingerprints,
//! never credential values; recovery reads the OS store to choose an outcome.
use crate::settings_store::Credentials;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
};
use symphony_contracts::AppSettings;
use uuid::Uuid;

const JOURNAL_VERSION: u32 = 1;
const PENDING: &str = "A Linear credential update needs recovery before settings can be changed. Unlock the OS credential store and retry.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryOutcome {
    Ready,
    Recovered { settings_revision: u64 },
    Superseded,
    Deferred,
}

/// Unknown marker availability is conservatively pending: a worker may still
/// hold credentials from before an incomplete settings transaction.
pub(crate) fn has_pending(path: &Path) -> bool {
    journal_path(path).try_exists().unwrap_or(true)
}

#[derive(Serialize, Deserialize)]
struct Journal {
    version: u32,
    base_revision: u64,
    base_file_digest: Option<String>,
    salt: String,
    old_credential_digest: String,
    new_credential_digest: String,
    settings: AppSettings,
}

#[derive(Clone, Copy)]
enum CommitPoint {
    JournalDurable,
    CredentialChanged,
    SettingsDurable,
}

/// Commit one explicit credential replacement/removal and its next settings
/// revision. `old_key` was read by the caller under the same settings lock.
/// A returned error may leave a journal; all later accesses must recover first.
pub(crate) fn commit(
    path: &Path,
    settings: &AppSettings,
    credentials: &dyn Credentials,
    replacement: Option<&str>,
    old_key: Option<&str>,
) -> Result<(), String> {
    commit_with_hooks(
        path,
        settings,
        credentials,
        replacement,
        old_key,
        |_| Ok(()),
        |path, body| write_atomic(path, body, true),
    )
}

/// Stage the durable state left by process loss after the OS credential changed.
/// Callers use the production journal format to test their recovery effects.
#[cfg(test)]
pub(crate) fn stage_interrupted_credential_change(
    path: &Path,
    settings: &AppSettings,
    credentials: &dyn Credentials,
    replacement: Option<&str>,
    old_key: Option<&str>,
) -> Result<(), String> {
    commit_with_hooks(
        path,
        settings,
        credentials,
        replacement,
        old_key,
        |point| match point {
            CommitPoint::CredentialChanged => {
                Err("Simulated process loss after credential change.".into())
            }
            _ => Ok(()),
        },
        |path, body| write_atomic(path, body, true),
    )
}

fn commit_with_hooks(
    path: &Path,
    settings: &AppSettings,
    credentials: &dyn Credentials,
    replacement: Option<&str>,
    old_key: Option<&str>,
    mut at_point: impl FnMut(CommitPoint) -> Result<(), String>,
    mut write_settings: impl FnMut(&Path, &[u8]) -> Result<(), String>,
) -> Result<(), String> {
    let marker = journal_path(path);
    if marker.try_exists().map_err(|error| error.to_string())? {
        return Err(PENDING.into());
    }
    let base = read_file(path)?;
    let base_revision = file_revision(base.as_deref())?;
    if base_revision.checked_add(1) != Some(settings.settings_revision) {
        return Err("Settings changed before the credential update could begin.".into());
    }
    if settings.linear_api_key_set != replacement.is_some() {
        return Err("Credential metadata does not match the requested update.".into());
    }
    // The dedicated credential never belongs in the settings payload either.
    // Refuse an accidental duplicate instead of copying it into the journal.
    let settings_value = serde_json::to_value(settings).map_err(|error| error.to_string())?;
    if [old_key, replacement]
        .into_iter()
        .flatten()
        .filter(|key| !key.is_empty())
        .any(|key| contains_value(&settings_value, key))
    {
        return Err("Settings must not contain the Linear credential value.".into());
    }
    let salt = Uuid::new_v4().to_string();
    let journal = Journal {
        version: JOURNAL_VERSION,
        base_revision,
        base_file_digest: base.as_deref().map(file_digest),
        old_credential_digest: credential_digest(&salt, old_key),
        new_credential_digest: credential_digest(&salt, replacement),
        salt,
        settings: settings.clone(),
    };
    let body = serde_json::to_vec(&journal).map_err(|error| error.to_string())?;
    write_atomic(&marker, &body, false)?;
    at_point(CommitPoint::JournalDurable)?;
    if credentials.set(replacement).is_err() {
        return Err(rollback_if_unchanged(
            path,
            &journal,
            credentials,
            old_key,
            "Could not update the Linear credential.",
        ));
    }
    at_point(CommitPoint::CredentialChanged)?;
    let intended = settings_body(&journal.settings)?;
    if write_settings(path, &intended).is_err() {
        return Err(rollback_if_unchanged(
            path,
            &journal,
            credentials,
            old_key,
            "Could not save settings after updating the Linear credential.",
        ));
    }
    at_point(CommitPoint::SettingsDurable)?;
    clear_journal(path)
}

/// Resolve a prior interrupted commit. No marker means no credential access.
/// `Recovered` identifies the credential revision whose runtime effects must
/// finish, including when the new settings file was already installed.
/// `Superseded` still requires a conservative runtime stop: the old credential
/// may already have changed even though a newer file won the commit race.
/// `Deferred` leaves all durable state untouched while the OS store is locked.
/// Unexpected file/key combinations return an error and retain the evidence.
pub(crate) fn recover(
    path: &Path,
    credentials: &dyn Credentials,
) -> Result<RecoveryOutcome, String> {
    let Some(body) = read_file(&journal_path(path))? else {
        return Ok(RecoveryOutcome::Ready);
    };
    let journal: Journal = serde_json::from_slice(&body)
        .map_err(|_| "The pending settings transaction is unreadable. Recovery is required.")?;
    validate_journal(&journal)?;
    let current = read_file(path)?;
    let current_revision = file_revision(current.as_deref())?;
    if current_revision > journal.settings.settings_revision {
        // A later writer already superseded the transaction. Never restore its
        // old file or credentials, even if the stale marker survived deletion.
        sync_current(path)?;
        clear_journal(path)?;
        return Ok(RecoveryOutcome::Superseded);
    }
    let intended = settings_body(&journal.settings)?;
    let is_committed = current.as_deref() == Some(intended.as_slice());
    let is_base = current_revision == journal.base_revision
        && current.as_deref().map(file_digest) == journal.base_file_digest;
    if !is_committed && !is_base {
        return Err("Settings changed outside the pending credential transaction. Recovery will not overwrite them.".into());
    }
    let key = match credentials.read() {
        Ok(key) => key,
        Err(_) => return Ok(RecoveryOutcome::Deferred),
    };
    let actual = credential_digest(&journal.salt, key.as_deref());
    if actual == journal.new_credential_digest {
        if is_committed {
            sync_current(path)?;
        } else {
            write_atomic(path, &intended, true)?;
        }
        clear_journal(path)?;
        return Ok(RecoveryOutcome::Recovered {
            settings_revision: journal.settings.settings_revision,
        });
    }
    if actual == journal.old_credential_digest && is_base {
        sync_current(path)?;
        clear_journal(path)?;
        return Ok(RecoveryOutcome::Ready);
    }
    Err("The Linear credential does not match the pending settings transaction. Recovery is required before further changes.".into())
}

fn rollback_if_unchanged(
    path: &Path,
    journal: &Journal,
    credentials: &dyn Credentials,
    old_key: Option<&str>,
    message: &str,
) -> String {
    // Rename may already have succeeded even when its subsequent directory sync
    // failed. Never restore an old key underneath a possibly committed new file.
    let unchanged = read_file(path)
        .ok()
        .is_some_and(|current| current.as_deref().map(file_digest) == journal.base_file_digest);
    if unchanged {
        let _ = credentials.set(old_key);
        let restored = credentials.read().ok().is_some_and(|current| {
            credential_digest(&journal.salt, current.as_deref()) == journal.old_credential_digest
        });
        if restored
            && sync_current(path)
                .and_then(|()| clear_journal(path))
                .is_ok()
        {
            return format!("{message} The previous credential and settings were restored.");
        }
    }
    format!("{message} {PENDING}")
}

fn validate_journal(journal: &Journal) -> Result<(), String> {
    let valid_digest =
        |digest: &str| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit());
    if journal.version != JOURNAL_VERSION
        || journal.base_revision.checked_add(1) != Some(journal.settings.settings_revision)
        || Uuid::parse_str(&journal.salt).is_err()
        || !valid_digest(&journal.old_credential_digest)
        || !valid_digest(&journal.new_credential_digest)
        || journal
            .base_file_digest
            .as_deref()
            .is_some_and(|digest| !valid_digest(digest))
    {
        return Err("The pending settings transaction is invalid. Recovery is required.".into());
    }
    Ok(())
}

fn contains_value(value: &serde_json::Value, secret: &str) -> bool {
    match value {
        serde_json::Value::String(value) => value.contains(secret),
        serde_json::Value::Array(values) => {
            values.iter().any(|value| contains_value(value, secret))
        }
        serde_json::Value::Object(values) => values
            .iter()
            .any(|(key, value)| key.contains(secret) || contains_value(value, secret)),
        _ => false,
    }
}

fn credential_digest(salt: &str, value: Option<&str>) -> String {
    let mut digest = Sha256::new();
    digest.update(b"symphony-settings-credential-v1\0");
    digest.update(salt.as_bytes());
    match value {
        Some(value) => {
            digest.update([1]);
            digest.update((value.len() as u64).to_le_bytes());
            digest.update(value.as_bytes());
        }
        None => digest.update([0]),
    }
    format!("{:x}", digest.finalize())
}

fn file_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn file_revision(bytes: Option<&[u8]>) -> Result<u64, String> {
    let Some(bytes) = bytes else { return Ok(0) };
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| "Settings are unreadable; the pending transaction cannot be resolved.")?;
    match value.get("settings_revision") {
        None => Ok(0),
        Some(value) => value
            .as_u64()
            .ok_or_else(|| "Settings revision is invalid.".into()),
    }
}

fn settings_body(settings: &AppSettings) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())
}

fn read_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(body) => Ok(Some(body)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn journal_path(path: &Path) -> PathBuf {
    path.with_extension("json.transaction")
}

fn write_atomic(path: &Path, body: &[u8], replace: bool) -> Result<(), String> {
    let parent = path.parent().ok_or("Settings path has no parent.")?;
    let mut prepared =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    prepared
        .write_all(body)
        .map_err(|error| error.to_string())?;
    prepared
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    let file = if replace {
        prepared.persist(path)
    } else {
        prepared.persist_noclobber(path)
    }
    .map_err(|error| error.error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    sync_parent(path)
}

fn sync_current(path: &Path) -> Result<(), String> {
    let mut options = File::options();
    options.read(true);
    // Windows sync_all calls FlushFileBuffers, which requires GENERIC_WRITE.
    // Do not require write permission for the POSIX fsync path.
    #[cfg(windows)]
    options.write(true);
    match options.open(path) {
        Ok(file) => file.sync_all().map_err(|error| error.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    sync_parent(path)
}

pub(crate) fn sync_parent(path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("Settings path has no parent.")?;
    let mut options = File::options();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // BACKUP_SEMANTICS admits directory handles; FlushFileBuffers also
        // requires GENERIC_WRITE on the handle used by sync_all.
        options.write(true);
        options.custom_flags(0x02000000); // FILE_FLAG_BACKUP_SEMANTICS opens a directory.
    }
    options
        .open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

fn clear_journal(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(journal_path(path)) {
        Ok(()) => sync_parent(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
#[path = "settings_transaction_tests.rs"]
mod tests;
