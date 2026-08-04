use chrono::{Duration as ChronoDuration, Utc};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use symphony_storage::{now_iso, Repository, StorageError, WorkspaceCleanupRow};
use thiserror::Error;
use tokio::{
    process::Command,
    sync::{Mutex, Notify},
};
use tracing::{info, warn};
use uuid::Uuid;

const CLEANUP_DIR: &str = ".symphony-trash";
const CLEANUP_RETRY_CAP_MS: i64 = 300_000;

#[derive(Debug, Error)]
pub enum WorkspaceCleanupError {
    #[error("workspace cleanup storage error: {0}")]
    Storage(#[from] StorageError),
    #[error("workspace cleanup filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("workspace path has no parent: {0}")]
    MissingParent(String),
}

#[derive(Debug)]
struct CleanupInner {
    repo: Repository,
    notify: Notify,
    started: AtomicBool,
    quarantine_gate: Mutex<()>,
}

/// App-owned workspace garbage collector. The task is deliberately independent
/// of the orchestration stop token: stopping issue dispatch must not put a
/// half-deleted quarantined checkout back into service.
#[derive(Debug, Clone)]
pub struct WorkspaceCleanupManager {
    inner: Arc<CleanupInner>,
}

impl WorkspaceCleanupManager {
    pub fn new(repo: Repository) -> Self {
        Self {
            inner: Arc::new(CleanupInner {
                repo,
                notify: Notify::new(),
                started: AtomicBool::new(false),
                quarantine_gate: Mutex::new(()),
            }),
        }
    }

    /// Start the singleton collector for this app process. Repeated calls are
    /// harmless, including worker stop/start cycles.
    pub fn start(&self) {
        if self.inner.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            self.inner.started.store(false, Ordering::Release);
            warn!("workspace cleanup start requested outside a Tokio runtime");
            return;
        };
        let manager = self.clone();
        runtime.spawn(async move { manager.run().await });
    }

    /// Atomically move a workspace out of its dispatch path and persist the
    /// deletion before doing any recursive filesystem work.
    pub async fn quarantine(
        &self,
        repo_name: &str,
        issue_identifier: &str,
        source: &Path,
    ) -> Result<bool, WorkspaceCleanupError> {
        // Reconciliation must not inspect a `quarantining` row between its DB
        // insert and the matching filesystem rename.
        let _guard = self.inner.quarantine_gate.lock().await;
        match tokio::fs::symlink_metadata(source).await {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        }
        let parent = source
            .parent()
            .ok_or_else(|| WorkspaceCleanupError::MissingParent(source.display().to_string()))?;
        let quarantine_root = parent.join(CLEANUP_DIR);
        tokio::fs::create_dir_all(&quarantine_root).await?;

        let id = Uuid::new_v4().to_string();
        let destination =
            quarantine_root.join(format!("{}--{id}", crate::sanitize_key(issue_identifier)));
        let timestamp = now_iso();
        self.inner
            .repo
            .begin_workspace_cleanup(
                &id,
                repo_name,
                issue_identifier,
                &source.display().to_string(),
                &destination.display().to_string(),
                &timestamp,
            )
            .await?;

        if let Err(error) = tokio::fs::rename(source, &destination).await {
            // A row without a completed rename must never be retried blindly:
            // the issue may have reopened and reclaimed its original path.
            self.inner.repo.delete_workspace_cleanup(&id).await.ok();
            return Err(error.into());
        }

        info!(
            cleanup_id = %id,
            repo = repo_name,
            issue = issue_identifier,
            path = %destination.display(),
            "workspace quarantined for background cleanup"
        );
        // If this update fails, the durable `quarantining` row and renamed
        // destination are reconciled by the collector on its next pass.
        let queued = self.inner.repo.queue_workspace_cleanup(&id).await;
        self.inner.notify.notify_one();
        queued?;
        Ok(true)
    }

    async fn run(self) {
        if let Err(error) = self.inner.repo.recover_workspace_cleanup_queue().await {
            warn!(%error, "could not recover workspace cleanup queue");
        }
        loop {
            if let Err(error) = self.reconcile_quarantining().await {
                warn!(%error, "could not reconcile quarantined workspaces");
            }
            match self.inner.repo.due_workspace_cleanup(&now_iso()).await {
                Ok(Some(job)) => match self.inner.repo.claim_workspace_cleanup(&job.id).await {
                    Ok(true) => self.process(job).await,
                    Ok(false) => {}
                    Err(error) => {
                        warn!(cleanup_id = %job.id, %error, "could not claim workspace cleanup");
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                },
                Ok(None) => {
                    tokio::select! {
                        _ = self.inner.notify.notified() => {}
                        _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                    }
                }
                Err(error) => {
                    warn!(%error, "could not read workspace cleanup queue");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }

    async fn reconcile_quarantining(&self) -> Result<(), StorageError> {
        let _guard = self.inner.quarantine_gate.lock().await;
        for job in self.inner.repo.quarantining_workspace_cleanups().await? {
            match tokio::fs::symlink_metadata(&job.quarantine_path).await {
                Ok(_) => self.inner.repo.queue_workspace_cleanup(&job.id).await?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // No rename completed. Leave the source path untouched so
                    // the next tracker-backed terminal sweep can decide
                    // whether it is still safe to quarantine.
                    self.inner.repo.delete_workspace_cleanup(&job.id).await?;
                }
                Err(error) => warn!(
                    cleanup_id = %job.id,
                    path = %job.quarantine_path,
                    %error,
                    "could not inspect quarantining workspace; reconciliation deferred"
                ),
            }
        }
        Ok(())
    }

    async fn process(&self, job: WorkspaceCleanupRow) {
        let started = Instant::now();
        let path = PathBuf::from(&job.quarantine_path);
        let mut terminated = 0;
        let result = match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                // Never canonicalize or scan through a workspace symlink: its
                // target is outside Symphony's ownership boundary.
                tokio::fs::remove_file(&path).await
            }
            Ok(metadata) if metadata.is_dir() => {
                terminated = match terminate_workspace_processes(&path).await {
                    Ok(count) => count,
                    Err(error) => {
                        warn!(
                            cleanup_id = %job.id,
                            repo = %job.repo_name,
                            issue = %job.issue_identifier,
                            %error,
                            "could not inspect quarantined workspace processes; continuing cleanup"
                        );
                        0
                    }
                };
                tokio::fs::remove_dir_all(&path).await
            }
            Ok(_) => tokio::fs::remove_file(&path).await,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        };
        match result {
            Ok(()) => {
                self.persist_cleanup_deletion(&job.id).await;
                if let Some(parent) = path.parent() {
                    tokio::fs::remove_dir(parent).await.ok();
                }
                info!(
                    cleanup_id = %job.id,
                    repo = %job.repo_name,
                    issue = %job.issue_identifier,
                    attempt = job.attempts + 1,
                    terminated_processes = terminated,
                    duration_ms = started.elapsed().as_millis(),
                    "workspace background cleanup completed"
                );
            }
            Err(error) => {
                let attempt = job.attempts + 1;
                let delay_ms = cleanup_backoff_ms(attempt);
                let due = (Utc::now() + ChronoDuration::milliseconds(delay_ms))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                warn!(
                    cleanup_id = %job.id,
                    repo = %job.repo_name,
                    issue = %job.issue_identifier,
                    attempt,
                    delay_ms,
                    %error,
                    "workspace background cleanup failed; retry scheduled"
                );
                self.persist_cleanup_retry(&job.id, &due, &error.to_string())
                    .await;
            }
        }
    }

    async fn persist_cleanup_deletion(&self, id: &str) {
        loop {
            match self.inner.repo.delete_workspace_cleanup(id).await {
                Ok(()) => return,
                Err(error) => {
                    warn!(cleanup_id = id, %error, "workspace deleted but queue-row removal failed; retrying");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }

    async fn persist_cleanup_retry(&self, id: &str, due: &str, message: &str) {
        loop {
            match self
                .inner
                .repo
                .retry_workspace_cleanup(id, due, message)
                .await
            {
                Ok(()) => return,
                Err(error) => {
                    warn!(cleanup_id = id, %error, "could not persist cleanup retry; retrying state transition");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }
}

fn cleanup_backoff_ms(attempt: i64) -> i64 {
    let exponent = (attempt.saturating_sub(1)).clamp(0, 20) as u32;
    (1_000_i64.saturating_mul(1_i64 << exponent)).min(CLEANUP_RETRY_CAP_MS)
}

pub(crate) async fn terminate_workspace_processes(path: &Path) -> Result<usize, std::io::Error> {
    let initial = workspace_process_ids(path).await?;
    if initial.is_empty() {
        return Ok(0);
    }
    signal_pids(&initial, "TERM").await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let stubborn = workspace_process_ids(path).await.unwrap_or_default();
    signal_pids(&stubborn, "KILL").await;
    Ok(initial.len())
}

async fn signal_pids(pids: &BTreeSet<u32>, signal: &str) {
    for pid in pids {
        let _ = Command::new("/bin/kill")
            .arg(format!("-{signal}"))
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
}

#[cfg(target_os = "macos")]
async fn workspace_process_ids(path: &Path) -> Result<BTreeSet<u32>, std::io::Error> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-d", "cwd", "-Fpn"])
        .output()
        .await?;
    let root = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut current_pid = None;
    let mut is_cwd = false;
    let mut pids = BTreeSet::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(value) = line.strip_prefix('p') {
            current_pid = value.parse::<u32>().ok();
            is_cwd = false;
        } else if line == "fcwd" {
            is_cwd = true;
        } else if let Some(value) = line.strip_prefix('n') {
            if is_cwd && Path::new(value).starts_with(&root) {
                if let Some(pid) = current_pid.filter(|pid| *pid != std::process::id()) {
                    pids.insert(pid);
                }
            }
            is_cwd = false;
        }
    }
    Ok(pids)
}

#[cfg(target_os = "linux")]
async fn workspace_process_ids(path: &Path) -> Result<BTreeSet<u32>, std::io::Error> {
    let root = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut pids = BTreeSet::new();
    let mut entries = tokio::fs::read_dir("/proc").await?;
    while let Some(entry) = entries.next_entry().await? {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == std::process::id() {
            continue;
        }
        if tokio::fs::read_link(entry.path().join("cwd"))
            .await
            .is_ok_and(|cwd| cwd.starts_with(&root))
        {
            pids.insert(pid);
        }
    }
    Ok(pids)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
async fn workspace_process_ids(_path: &Path) -> Result<BTreeSet<u32>, std::io::Error> {
    Ok(BTreeSet::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_manager() -> (tempfile::TempDir, WorkspaceCleanupManager, Repository) {
        let temp = tempfile::tempdir().unwrap();
        let pool = symphony_storage::open_sqlite(temp.path().join("cleanup.sqlite"))
            .await
            .unwrap();
        let repo = Repository::new(pool, symphony_storage::EventBus::default());
        let manager = WorkspaceCleanupManager::new(repo.clone());
        (temp, manager, repo)
    }

    async fn wait_for_cleanup(repo: &Repository) {
        for _ in 0..500 {
            if repo.overview().await.unwrap().workspace_cleanup_count == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("workspace cleanup did not finish");
    }

    #[test]
    fn cleanup_backoff_is_bounded() {
        assert_eq!(cleanup_backoff_ms(1), 1_000);
        assert_eq!(cleanup_backoff_ms(2), 2_000);
        assert_eq!(cleanup_backoff_ms(100), CLEANUP_RETRY_CAP_MS);
    }

    #[tokio::test]
    async fn quarantine_releases_original_path_before_background_deletion() {
        let (temp, manager, repo) = test_manager().await;
        manager.start();
        let source = temp.path().join("widgets/SYM-1");
        tokio::fs::create_dir_all(source.join("nested"))
            .await
            .unwrap();
        tokio::fs::write(source.join("nested/old.txt"), "old")
            .await
            .unwrap();

        assert!(manager
            .quarantine("widgets", "SYM-1", &source)
            .await
            .unwrap());
        assert!(tokio::fs::metadata(&source).await.is_err());

        // A reopened issue can claim the canonical path while the old tree is
        // still being collected.
        tokio::fs::create_dir_all(&source).await.unwrap();
        tokio::fs::write(source.join("new.txt"), "new")
            .await
            .unwrap();
        wait_for_cleanup(&repo).await;
        assert_eq!(
            tokio::fs::read_to_string(source.join("new.txt"))
                .await
                .unwrap(),
            "new"
        );
    }

    #[tokio::test]
    async fn reconciliation_cannot_drop_in_flight_quarantines() {
        let (temp, manager, repo) = test_manager().await;
        manager.start();
        let mut tasks = Vec::new();
        for index in 0..24 {
            let source = temp.path().join(format!("widgets/SYM-{index}"));
            tokio::fs::create_dir_all(&source).await.unwrap();
            tokio::fs::write(source.join("marker"), index.to_string())
                .await
                .unwrap();
            let cleanup = manager.clone();
            tasks.push(tokio::spawn(async move {
                cleanup
                    .quarantine("widgets", &format!("SYM-{index}"), &source)
                    .await
                    .unwrap();
                assert!(tokio::fs::symlink_metadata(source).await.is_err());
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }

        wait_for_cleanup(&repo).await;
        let trash = temp.path().join("widgets/.symphony-trash");
        if let Ok(mut entries) = tokio::fs::read_dir(&trash).await {
            assert!(entries.next_entry().await.unwrap().is_none());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cleanup_removes_workspace_symlinks_without_touching_targets() {
        use std::os::unix::fs::symlink;

        let (temp, manager, repo) = test_manager().await;
        manager.start();
        let repo_root = temp.path().join("widgets");
        let target = temp.path().join("operator-owned");
        tokio::fs::create_dir_all(&repo_root).await.unwrap();
        tokio::fs::create_dir_all(&target).await.unwrap();
        tokio::fs::write(target.join("keep.txt"), "keep")
            .await
            .unwrap();
        let source = repo_root.join("SYM-LINK");
        symlink(&target, &source).unwrap();
        let mut target_process = Command::new("/bin/bash")
            .args(["-c", "while true; do sleep 1; done"])
            .current_dir(&target)
            .spawn()
            .unwrap();

        assert!(manager
            .quarantine("widgets", "SYM-LINK", &source)
            .await
            .unwrap());
        wait_for_cleanup(&repo).await;

        assert!(tokio::fs::symlink_metadata(&source).await.is_err());
        assert_eq!(
            tokio::fs::read_to_string(target.join("keep.txt"))
                .await
                .unwrap(),
            "keep"
        );
        assert!(target_process.try_wait().unwrap().is_none());
        target_process.kill().await.unwrap();
        target_process.wait().await.unwrap();

        let broken = repo_root.join("SYM-BROKEN");
        symlink(temp.path().join("missing-target"), &broken).unwrap();
        assert!(manager
            .quarantine("widgets", "SYM-BROKEN", &broken)
            .await
            .unwrap());
        wait_for_cleanup(&repo).await;
        assert!(tokio::fs::symlink_metadata(broken).await.is_err());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn process_cleanup_is_scoped_to_quarantined_working_directory() {
        let temp = tempfile::tempdir().unwrap();
        let quarantined = temp.path().join("quarantined");
        let control_dir = temp.path().join("control");
        tokio::fs::create_dir_all(&quarantined).await.unwrap();
        tokio::fs::create_dir_all(&control_dir).await.unwrap();
        let mut owned = Command::new("/bin/bash")
            .args(["-c", "trap '' TERM; while true; do sleep 1; done"])
            .current_dir(&quarantined)
            .spawn()
            .unwrap();
        let mut control = Command::new("/bin/bash")
            .args(["-c", "while true; do sleep 1; done"])
            .current_dir(&control_dir)
            .spawn()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert!(terminate_workspace_processes(&quarantined).await.unwrap() >= 1);
        tokio::time::timeout(Duration::from_secs(3), owned.wait())
            .await
            .expect("workspace process survived cleanup")
            .unwrap();
        assert!(control.try_wait().unwrap().is_none());
        control.kill().await.unwrap();
        control.wait().await.unwrap();
    }
}
