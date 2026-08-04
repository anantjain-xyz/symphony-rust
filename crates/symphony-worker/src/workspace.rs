use std::path::{Path, PathBuf};
use symphony_core::Issue;
use thiserror::Error;

use crate::{WorkspaceCleanupError, WorkspaceCleanupManager};

pub const WORKSPACE_READY_SENTINEL: &str = ".symphony-workspace-ready";

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("workspace path escaped root: {0}")]
    EscapedRoot(String),
    #[error("workspace filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("workspace cleanup error: {0}")]
    Cleanup(#[from] WorkspaceCleanupError),
}

#[derive(Debug, Clone)]
pub struct Workspace {
    pub path: PathBuf,
    pub key: String,
    pub created_now: bool,
    pub needs_init: bool,
}

#[derive(Debug, Clone)]
pub struct WorkspaceManager {
    root: PathBuf,
    repo_name: Option<String>,
    cleanup: Option<WorkspaceCleanupManager>,
}

impl WorkspaceManager {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            repo_name: None,
            cleanup: None,
        }
    }

    pub fn with_cleanup(
        root: impl Into<PathBuf>,
        repo_name: impl Into<String>,
        cleanup: WorkspaceCleanupManager,
    ) -> Self {
        Self {
            root: root.into(),
            repo_name: Some(repo_name.into()),
            cleanup: Some(cleanup),
        }
    }

    pub async fn create_or_reuse(&self, issue: &Issue) -> Result<Workspace, WorkspaceError> {
        let key = sanitize_key(&issue.identifier);
        let path = self.assert_safe_path(&key)?;
        let mut created_now = false;
        match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                self.quarantine_or_remove(&key, &path).await?;
                tokio::fs::create_dir_all(&path).await?;
                created_now = true;
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tokio::fs::create_dir_all(&path).await?;
                created_now = true;
            }
            Err(error) => return Err(error.into()),
        }

        let sentinel = path.join(WORKSPACE_READY_SENTINEL);
        let mut needs_init = created_now;
        if !created_now && tokio::fs::metadata(&sentinel).await.is_err() {
            self.quarantine_or_remove(&key, &path).await?;
            tokio::fs::create_dir_all(&path).await?;
            needs_init = true;
        }

        Ok(Workspace {
            path,
            key,
            created_now,
            needs_init,
        })
    }

    pub async fn mark_ready(&self, issue: &Issue) -> Result<(), WorkspaceError> {
        let key = sanitize_key(&issue.identifier);
        let path = self.assert_safe_path(&key)?;
        tokio::fs::write(path.join(WORKSPACE_READY_SENTINEL), "").await?;
        Ok(())
    }

    pub async fn remove(&self, issue: &Issue) -> Result<(), WorkspaceError> {
        let key = sanitize_key(&issue.identifier);
        let path = self.assert_safe_path(&key)?;
        self.quarantine_or_remove(&key, &path).await?;
        Ok(())
    }

    async fn quarantine_or_remove(&self, key: &str, path: &Path) -> Result<(), WorkspaceError> {
        if let (Some(cleanup), Some(repo_name)) = (&self.cleanup, &self.repo_name) {
            cleanup.quarantine(repo_name, key, path).await?;
        } else {
            match tokio::fs::symlink_metadata(path).await {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    tokio::fs::remove_dir_all(path).await.ok();
                }
                Ok(_) => {
                    tokio::fs::remove_file(path).await.ok();
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    pub async fn remove_if_stale(&self, path: &Path) -> Result<bool, WorkspaceError> {
        let root = self
            .root
            .canonicalize()
            .unwrap_or_else(|_| self.root.clone());
        let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        if resolved == root || !resolved.starts_with(&root) {
            return Ok(false);
        }
        if tokio::fs::metadata(&resolved).await.is_err() {
            return Ok(false);
        }
        if tokio::fs::metadata(resolved.join(WORKSPACE_READY_SENTINEL))
            .await
            .is_ok()
        {
            return Ok(false);
        }
        tokio::fs::remove_dir_all(&resolved).await?;
        Ok(true)
    }

    pub fn path_for(&self, identifier: &str) -> Result<PathBuf, WorkspaceError> {
        self.assert_safe_path(&sanitize_key(identifier))
    }

    fn assert_safe_path(&self, key: &str) -> Result<PathBuf, WorkspaceError> {
        // Canonicalize the root *before* joining the key. `canonicalize` resolves
        // symlinks and (on case-insensitive volumes like macOS APFS) returns the
        // real on-disk casing — e.g. `.../workspaces/alligrator` comes back as
        // `.../workspaces/Alligrator`. Building `resolved` from the raw root and
        // then comparing against the canonical root made `starts_with` fail on
        // any such mismatch, raising a spurious EscapedRoot that aborts the
        // worker tick. Joining onto the canonical root keeps both sides
        // consistent, so the guard only fires on a genuine `..` escape.
        let root = self
            .root
            .canonicalize()
            .unwrap_or_else(|_| self.root.clone());
        let resolved = normalize(&root.join(key));
        if resolved != root && !resolved.starts_with(&root) {
            return Err(WorkspaceError::EscapedRoot(key.to_string()));
        }
        Ok(resolved)
    }
}

/// Resolve the directory per-issue workspaces (and the skills-install
/// workspace) live in: the workflow's `workspace.root` as a plain path,
/// falling back to `<app data dir>/workspaces` when the spec is empty.
pub fn resolve_workspace_root_dir(spec: &str, app_data_dir: &Path) -> PathBuf {
    if spec.trim().is_empty() {
        app_data_dir.join("workspaces")
    } else {
        PathBuf::from(spec.trim())
    }
}

pub fn sanitize_key(identifier: &str) -> String {
    if identifier.is_empty() || identifier == "." || identifier == ".." {
        return "_".to_string();
    }
    identifier
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(identifier: &str) -> Issue {
        Issue {
            id: format!("lin-{identifier}"),
            identifier: identifier.to_string(),
            title: "Test".to_string(),
            description: None,
            priority: 1,
            state: "todo".to_string(),
            branch: None,
            labels: vec![],
            blockers: vec![],
            pr_urls: vec![],
            project_id: None,
            project_slug_id: None,
        }
    }

    #[test]
    fn sanitizes_identifiers() {
        assert_eq!(sanitize_key("SYM-1"), "SYM-1");
        assert_eq!(sanitize_key("../bad"), "___bad");
        assert_eq!(sanitize_key(""), "_");
    }

    // A root reached through a symlink (and, on case-insensitive volumes, a
    // case-differing root) canonicalizes to a different string than the raw
    // path. The old assert_safe_path compared a raw-joined path against the
    // canonical root and raised a spurious EscapedRoot, which aborted the
    // worker tick and stalled all dispatch. path_for must succeed here.
    #[cfg(unix)]
    #[test]
    fn safe_path_resolves_through_symlinked_root() {
        use std::fs;
        let base = std::env::temp_dir().join("symphony-ws-symlink-test");
        let real = base.join("real-root");
        let link = base.join("linked-root");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let mgr = WorkspaceManager::new(&link);
        let path = mgr
            .path_for("SYM-1")
            .expect("a key under a symlinked root must be allowed");

        let canon_real = real.canonicalize().unwrap();
        assert!(
            path.starts_with(&canon_real),
            "{path:?} should resolve under {canon_real:?}"
        );
        let _ = fs::remove_dir_all(&base);
    }

    // The guard must still reject a key that climbs out of the root.
    #[cfg(unix)]
    #[test]
    fn safe_path_rejects_parent_escape() {
        let mgr = WorkspaceManager::new("/tmp");
        assert!(matches!(
            mgr.assert_safe_path("../../etc"),
            Err(WorkspaceError::EscapedRoot(_))
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn create_or_reuse_replaces_workspace_symlinks_without_following_targets() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspaces");
        let target = temp.path().join("operator-owned");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&target).await.unwrap();
        tokio::fs::write(target.join("keep"), "keep").await.unwrap();
        symlink(&target, root.join("SYM-1")).unwrap();
        symlink(temp.path().join("missing"), root.join("SYM-2")).unwrap();
        let manager = WorkspaceManager::new(&root);

        let live = manager.create_or_reuse(&issue("SYM-1")).await.unwrap();
        let broken = manager.create_or_reuse(&issue("SYM-2")).await.unwrap();

        assert!(live.created_now && live.needs_init);
        assert!(broken.created_now && broken.needs_init);
        assert!(tokio::fs::symlink_metadata(&live.path)
            .await
            .unwrap()
            .is_dir());
        assert!(tokio::fs::symlink_metadata(&broken.path)
            .await
            .unwrap()
            .is_dir());
        assert_eq!(
            tokio::fs::read_to_string(target.join("keep"))
                .await
                .unwrap(),
            "keep"
        );
    }
}
