use std::path::{Path, PathBuf};
use symphony_core::Issue;
use thiserror::Error;

pub const WORKSPACE_READY_SENTINEL: &str = ".symphony-workspace-ready";

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("workspace path escaped root: {0}")]
    EscapedRoot(String),
    #[error("workspace filesystem error: {0}")]
    Io(#[from] std::io::Error),
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
}

impl WorkspaceManager {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub async fn create_or_reuse(&self, issue: &Issue) -> Result<Workspace, WorkspaceError> {
        let key = sanitize_key(&issue.identifier);
        let path = self.assert_safe_path(&key)?;
        let mut created_now = false;
        if tokio::fs::metadata(&path).await.is_err() {
            tokio::fs::create_dir_all(&path).await?;
            created_now = true;
        }

        let sentinel = path.join(WORKSPACE_READY_SENTINEL);
        let mut needs_init = created_now;
        if !created_now && tokio::fs::metadata(&sentinel).await.is_err() {
            tokio::fs::remove_dir_all(&path).await.ok();
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
        tokio::fs::remove_dir_all(path).await.ok();
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
}
