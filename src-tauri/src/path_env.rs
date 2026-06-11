//! Login-shell PATH resolution for GUI launches.
//!
//! When the packaged app is launched from Finder or the Dock, launchd hands it
//! a minimal environment (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`), so hooks and
//! agent processes can't find user-installed tools (pnpm, codex, claude, ...).
//! Ask the user's shell for its PATH — interactive + login, so rc-managed
//! entries like `PNPM_HOME` are included — and overlay it onto this process
//! before the worker snapshots the environment.

#[cfg(unix)]
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[cfg(unix)]
const MARKER_START: &str = "__SYMPHONY_PATH_START__";
#[cfg(unix)]
const MARKER_END: &str = "__SYMPHONY_PATH_END__";
#[cfg(unix)]
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

/// Overlay the login-shell PATH onto this process and return the merged PATH.
/// Call before spawning threads that read the environment.
#[cfg(unix)]
pub fn fix() -> Result<String, String> {
    let shell_path = resolve_login_shell_path()?;
    let current = std::env::var("PATH").unwrap_or_default();
    let merged = merge_paths(&shell_path, &current);
    std::env::set_var("PATH", &merged);
    Ok(merged)
}

#[cfg(not(unix))]
pub fn fix() -> Result<String, String> {
    Err("login-shell PATH resolution is unix-only".to_string())
}

#[cfg(unix)]
fn resolve_login_shell_path() -> Result<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let script = format!("printf '%s%s%s' '{MARKER_START}' \"$PATH\" '{MARKER_END}'");
    let mut child = Command::new(&shell)
        .args(["-i", "-l", "-c", &script])
        // Keeps oh-my-zsh from blocking the shell on its update prompt.
        .env("DISABLE_AUTO_UPDATE", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("failed to spawn {shell}: {err}"))?;

    // A pathological rc file can hang (prompts, tmux, ...) — don't let it
    // block app launch.
    let deadline = Instant::now() + SHELL_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                child.kill().ok();
                child.wait().ok();
                return Err(format!("{shell} did not exit within {SHELL_TIMEOUT:?}"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(err) => return Err(format!("failed to wait for {shell}: {err}")),
        }
    };
    // PATH is far below the pipe buffer size, so reading after exit is safe.
    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        pipe.read_to_string(&mut stdout).ok();
    }

    match extract_marked(&stdout) {
        Some(path) if !path.is_empty() => Ok(path.to_string()),
        _ if !status.success() => Err(format!("{shell} exited with {status}")),
        Some(_) => Err(format!("{shell} reported an empty PATH")),
        None => Err(format!("no PATH markers in {shell} output")),
    }
}

/// Shell rc files may print arbitrary text; only trust what sits between our
/// markers.
#[cfg(unix)]
fn extract_marked(output: &str) -> Option<&str> {
    let start = output.find(MARKER_START)? + MARKER_START.len();
    let end = output[start..].find(MARKER_END)? + start;
    Some(&output[start..end])
}

/// Shell entries first (the user's preferred order), then whatever the current
/// environment had that the shell didn't mention.
#[cfg(unix)]
fn merge_paths(shell: &str, current: &str) -> String {
    let mut entries: Vec<&str> = Vec::new();
    for entry in shell.split(':').chain(current.split(':')) {
        if !entry.is_empty() && !entries.contains(&entry) {
            entries.push(entry);
        }
    }
    entries.join(":")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn merges_shell_path_first_and_dedupes() {
        assert_eq!(
            merge_paths("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin"),
            "/opt/homebrew/bin:/usr/bin:/bin"
        );
        assert_eq!(merge_paths("", "/usr/bin"), "/usr/bin");
        assert_eq!(merge_paths("/a::/b", ""), "/a:/b");
    }

    #[test]
    fn extracts_path_between_markers_ignoring_rc_noise() {
        let output = format!("rc banner\n{MARKER_START}/a:/b{MARKER_END}\nmore noise");
        assert_eq!(extract_marked(&output), Some("/a:/b"));
        assert_eq!(extract_marked("no markers"), None);
        assert_eq!(extract_marked(MARKER_START), None);
    }

    #[test]
    fn resolves_a_non_empty_path_from_the_login_shell() {
        let path = resolve_login_shell_path().expect("login shell should report PATH");
        assert!(path.split(':').any(|entry| !entry.is_empty()));
    }
}
