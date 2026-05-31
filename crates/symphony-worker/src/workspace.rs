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
        let resolved = self.root.join(key);
        let root = self
            .root
            .canonicalize()
            .unwrap_or_else(|_| self.root.clone());
        let normalized = normalize(&resolved);
        if normalized != root && !normalized.starts_with(&root) {
            return Err(WorkspaceError::EscapedRoot(key.to_string()));
        }
        Ok(resolved)
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
}
