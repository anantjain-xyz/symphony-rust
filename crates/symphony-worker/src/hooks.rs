use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};
use symphony_core::{HookName, Issue};
use tokio::{io::AsyncReadExt, process::Command, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct HookResult {
    pub exit_code: i32,
    pub duration_ms: i64,
    pub stderr_tail: Option<String>,
    pub timed_out: bool,
}

pub struct HookInvocation<'a> {
    pub hook: HookName,
    pub script: &'a str,
    pub issue: &'a Issue,
    pub workspace_path: &'a Path,
    pub run_number: i64,
    pub timeout_ms: u64,
    pub env: &'a BTreeMap<String, String>,
    pub cancel: &'a CancellationToken,
}

pub async fn run_hook(invocation: HookInvocation<'_>) -> HookResult {
    let HookInvocation {
        hook,
        script,
        issue,
        workspace_path,
        run_number,
        timeout_ms,
        env,
        cancel,
    } = invocation;
    let start = Instant::now();
    if cancel.is_cancelled() {
        return cancelled_result(start);
    }
    let mut child_env = filter_env(env);
    let hook_invocation_id = Uuid::new_v4().to_string();
    child_env.insert(
        "SYMPHONY_HOOK_INVOCATION_ID".to_string(),
        hook_invocation_id.clone(),
    );
    child_env.insert("SYMPHONY_HOOK".to_string(), hook.as_env_value().to_string());
    child_env.insert("ISSUE_ID".to_string(), issue.id.clone());
    child_env.insert("ISSUE_IDENTIFIER".to_string(), issue.identifier.clone());
    child_env.insert("ISSUE_TITLE".to_string(), issue.title.clone());
    child_env.insert("ISSUE_STATE".to_string(), issue.state.clone());
    child_env.insert(
        "ISSUE_BRANCH".to_string(),
        issue.branch.clone().unwrap_or_default(),
    );
    child_env.insert("RUN_NUMBER".to_string(), run_number.to_string());
    child_env.insert(
        "WORKSPACE_PATH".to_string(),
        workspace_path.display().to_string(),
    );

    let mut cmd = Command::new("/bin/bash");
    cmd.arg("-lc")
        .arg(script)
        .current_dir(workspace_path)
        .kill_on_drop(true)
        .env_clear()
        .envs(child_env)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            return HookResult {
                exit_code: -1,
                duration_ms: start.elapsed().as_millis() as i64,
                stderr_tail: Some(err.to_string()),
                timed_out: false,
            };
        }
    };
    let process_group_id = child.id();
    let stderr = child.stderr.take().map(|mut stderr| {
        tokio::spawn(async move {
            let mut bytes = Vec::new();
            let _ = stderr.read_to_end(&mut bytes).await;
            bytes
        })
    });
    let timeout = tokio::time::sleep(Duration::from_millis(timeout_ms));
    tokio::pin!(timeout);

    let outcome = tokio::select! {
        status = child.wait() => HookExit::Finished(status),
        _ = &mut timeout => {
            terminate_hook(&mut child).await;
            HookExit::TimedOut
        }
        _ = cancel.cancelled() => {
            terminate_hook(&mut child).await;
            HookExit::Cancelled
        }
    };
    if let Some(process_group_id) = process_group_id {
        cleanup_hook_process_group(process_group_id).await;
    }
    // Some package-manager daemons create a new session and escape the hook's
    // process group. The per-invocation environment marker proves ownership
    // without treating unrelated user processes in the workspace as children.
    cleanup_hook_invocation_processes(&hook_invocation_id).await;
    let stderr = collect_stderr(stderr).await;

    match outcome {
        HookExit::Finished(Ok(status)) => HookResult {
            exit_code: status.code().unwrap_or(-1),
            duration_ms: start.elapsed().as_millis() as i64,
            stderr_tail: tail(&String::from_utf8_lossy(&stderr), 4096),
            timed_out: false,
        },
        HookExit::Finished(Err(err)) => HookResult {
            exit_code: -1,
            duration_ms: start.elapsed().as_millis() as i64,
            stderr_tail: Some(err.to_string()),
            timed_out: false,
        },
        HookExit::TimedOut => HookResult {
            exit_code: -1,
            duration_ms: start.elapsed().as_millis() as i64,
            stderr_tail: Some("hook timed out".to_string()),
            timed_out: true,
        },
        HookExit::Cancelled => cancelled_result(start),
    }
}

fn cancelled_result(start: Instant) -> HookResult {
    HookResult {
        exit_code: -1,
        duration_ms: start.elapsed().as_millis() as i64,
        stderr_tail: Some("hook cancelled".to_string()),
        timed_out: false,
    }
}

enum HookExit {
    Finished(std::io::Result<std::process::ExitStatus>),
    TimedOut,
    Cancelled,
}

async fn terminate_hook(child: &mut tokio::process::Child) {
    terminate_hook_process(child, "TERM").await;
    if tokio::time::timeout(Duration::from_millis(500), child.wait())
        .await
        .is_err()
    {
        terminate_hook_process(child, "KILL").await;
        if tokio::time::timeout(Duration::from_millis(500), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }
}

/// A hook shell can leave background descendants behind (package-manager
/// daemons and watch processes are common examples). The shell was launched as
/// its own process group, so clean that group after every outcome while
/// preserving the hook's original result.
#[cfg(unix)]
async fn cleanup_hook_process_group(process_group_id: u32) {
    if !signal_hook_process_group(process_group_id, "TERM").await {
        return;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    signal_hook_process_group(process_group_id, "KILL").await;
}

#[cfg(not(unix))]
async fn cleanup_hook_process_group(_process_group_id: u32) {}

#[cfg(unix)]
async fn signal_hook_process_group(process_group_id: u32, signal: &str) -> bool {
    Command::new("/bin/kill")
        .arg(format!("-{signal}"))
        .arg(format!("-{process_group_id}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok_and(|status| status.success())
}

#[cfg(unix)]
async fn cleanup_hook_invocation_processes(invocation_id: &str) {
    let Ok(initial) = hook_invocation_process_ids(invocation_id).await else {
        return;
    };
    signal_hook_pids(&initial, "TERM").await;
    if initial.is_empty() {
        return;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    if let Ok(stubborn) = hook_invocation_process_ids(invocation_id).await {
        signal_hook_pids(&stubborn, "KILL").await;
    }
}

#[cfg(not(unix))]
async fn cleanup_hook_invocation_processes(_invocation_id: &str) {}

#[cfg(unix)]
async fn signal_hook_pids(pids: &BTreeSet<u32>, signal: &str) {
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

#[cfg(target_os = "linux")]
async fn hook_invocation_process_ids(invocation_id: &str) -> Result<BTreeSet<u32>, std::io::Error> {
    let marker = format!("SYMPHONY_HOOK_INVOCATION_ID={invocation_id}");
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
        let Ok(environment) = tokio::fs::read(entry.path().join("environ")).await else {
            continue;
        };
        if environment
            .split(|byte| *byte == 0)
            .any(|entry| entry == marker.as_bytes())
        {
            pids.insert(pid);
        }
    }
    Ok(pids)
}

#[cfg(target_os = "macos")]
async fn hook_invocation_process_ids(invocation_id: &str) -> Result<BTreeSet<u32>, std::io::Error> {
    let marker = format!("SYMPHONY_HOOK_INVOCATION_ID={invocation_id}");
    let output = Command::new("/bin/ps")
        .args(["eww", "-axo", "pid=,command="])
        .output()
        .await?;
    let mut pids = BTreeSet::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.trim_start().splitn(2, char::is_whitespace);
        let Some(pid) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        let Some(command_and_env) = fields.next() else {
            continue;
        };
        if pid != std::process::id()
            && command_and_env
                .split_whitespace()
                .any(|field| field == marker)
        {
            pids.insert(pid);
        }
    }
    Ok(pids)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
async fn hook_invocation_process_ids(
    _invocation_id: &str,
) -> Result<BTreeSet<u32>, std::io::Error> {
    Ok(BTreeSet::new())
}

#[cfg(unix)]
async fn terminate_hook_process(child: &mut tokio::process::Child, signal: &str) {
    if let Some(pid) = child.id() {
        let _ = Command::new("/bin/kill")
            .arg(format!("-{signal}"))
            .arg(format!("-{pid}"))
            .status()
            .await;
    }
}

#[cfg(not(unix))]
async fn terminate_hook_process(child: &mut tokio::process::Child, _signal: &str) {
    let _ = child.start_kill();
}

async fn collect_stderr(handle: Option<JoinHandle<Vec<u8>>>) -> Vec<u8> {
    let Some(mut handle) = handle else {
        return Vec::new();
    };
    tokio::select! {
        result = &mut handle => result.unwrap_or_default(),
        _ = tokio::time::sleep(Duration::from_millis(500)) => {
            handle.abort();
            Vec::new()
        }
    }
}

fn filter_env(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    env.iter()
        .filter(|(key, _)| {
            !matches!(
                key.as_str(),
                "DATABASE_URL" | "TEST_DATABASE_URL" | "LINEAR_API_KEY"
            )
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn tail(value: &str, max: usize) -> Option<String> {
    if value.is_empty() {
        None
    } else if value.len() <= max {
        Some(value.to_string())
    } else {
        Some(value[value.len() - max..].to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue() -> Issue {
        Issue {
            id: "lin-1".to_string(),
            identifier: "SYM-1".to_string(),
            title: "Test".to_string(),
            description: None,
            priority: 1,
            state: "todo".to_string(),
            branch: None,
            labels: vec![],
            blockers: vec![],
            completed_at: None,
            project_id: None,
            project_slug_id: None,
        }
    }

    async fn wait_for_path(path: &Path) {
        for _ in 0..500 {
            if tokio::fs::metadata(path).await.is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {}", path.display());
    }

    #[cfg(unix)]
    async fn wait_for_process_exit(pid: &str) -> bool {
        for _ in 0..200 {
            #[cfg(target_os = "linux")]
            {
                let stat = tokio::fs::read_to_string(format!("/proc/{pid}/stat")).await;
                match stat {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
                    Ok(stat)
                        if stat.rsplit_once(") ").is_some_and(|(_, rest)| {
                            rest.split_whitespace().next() == Some("Z")
                        }) =>
                    {
                        return true
                    }
                    _ => {}
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                let status = Command::new("/bin/kill")
                    .args(["-0", pid])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .await;
                if !status.is_ok_and(|status| status.success()) {
                    return true;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }

    #[tokio::test]
    async fn run_hook_returns_promptly_when_cancelled() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().to_path_buf();
        let hook_issue = issue();
        let env = BTreeMap::new();
        let stop = CancellationToken::new();
        let hook_stop = stop.clone();
        let mut handle = tokio::spawn(async move {
            run_hook(HookInvocation {
                hook: HookName::AfterCreate,
                script: r#"printf started > "$WORKSPACE_PATH/hook-started"
while true; do /bin/sleep 0.01; done
"#,
                issue: &hook_issue,
                workspace_path: &workspace,
                run_number: 1,
                timeout_ms: 60_000,
                env: &env,
                cancel: &hook_stop,
            })
            .await
        });

        wait_for_path(&temp.path().join("hook-started")).await;
        stop.cancel();
        let result = tokio::time::timeout(Duration::from_secs(2), &mut handle)
            .await
            .expect("hook should finish promptly after cancellation")
            .unwrap();

        assert_eq!(result.exit_code, -1);
        assert!(!result.timed_out);
        assert_eq!(result.stderr_tail.as_deref(), Some("hook cancelled"));
    }

    #[tokio::test]
    async fn run_hook_does_not_spawn_when_already_cancelled() {
        let temp = tempfile::tempdir().unwrap();
        let hook_issue = issue();
        let env = BTreeMap::new();
        let stop = CancellationToken::new();
        stop.cancel();

        let result = run_hook(HookInvocation {
            hook: HookName::AfterCreate,
            script: r#"printf touched > "$WORKSPACE_PATH/side-effect""#,
            issue: &hook_issue,
            workspace_path: temp.path(),
            run_number: 1,
            timeout_ms: 60_000,
            env: &env,
            cancel: &stop,
        })
        .await;

        assert_eq!(result.stderr_tail.as_deref(), Some("hook cancelled"));
        assert!(tokio::fs::metadata(temp.path().join("side-effect"))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn run_hook_kills_stubborn_process_group() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().to_path_buf();
        let hook_issue = issue();
        let env = BTreeMap::new();
        let stop = CancellationToken::new();
        let hook_stop = stop.clone();
        let mut handle = tokio::spawn(async move {
            run_hook(HookInvocation {
                hook: HookName::AfterCreate,
                script: r#"trap "" TERM
if command -v setsid >/dev/null 2>&1; then
  setsid /bin/bash -c 'trap "" TERM; while true; do echo child-still-running >&2; /bin/sleep 0.01; done' &
else
  (trap "" TERM; while true; do echo child-still-running >&2; /bin/sleep 0.01; done) &
fi
printf started > "$WORKSPACE_PATH/stubborn-started"
wait
"#,
                issue: &hook_issue,
                workspace_path: &workspace,
                run_number: 1,
                timeout_ms: 60_000,
                env: &env,
                cancel: &hook_stop,
            })
            .await
        });

        wait_for_path(&temp.path().join("stubborn-started")).await;
        stop.cancel();
        let result = tokio::time::timeout(Duration::from_secs(3), &mut handle)
            .await
            .expect("stubborn hook should finish after SIGKILL fallback")
            .unwrap();

        assert_eq!(result.exit_code, -1);
        assert!(!result.timed_out);
        assert_eq!(result.stderr_tail.as_deref(), Some("hook cancelled"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_hook_cleans_up_background_descendants() {
        let temp = tempfile::tempdir().unwrap();
        let hook_issue = issue();
        let env = BTreeMap::new();
        let stop = CancellationToken::new();
        let mut unrelated = Command::new("/bin/bash")
            .args(["-c", "while true; do /bin/sleep 1; done"])
            .current_dir(temp.path())
            .spawn()
            .unwrap();

        let result = run_hook(HookInvocation {
            hook: HookName::AfterCreate,
            script: r#"if command -v setsid >/dev/null 2>&1; then
  setsid /bin/bash -c 'trap "" TERM; while true; do /bin/sleep 1; done' &
else
  /bin/bash -c 'trap "" TERM; while true; do /bin/sleep 1; done' &
fi
printf '%s' "$!" > "$WORKSPACE_PATH/background-pid"
"#,
            issue: &hook_issue,
            workspace_path: temp.path(),
            run_number: 1,
            timeout_ms: 10_000,
            env: &env,
            cancel: &stop,
        })
        .await;

        assert_eq!(result.exit_code, 0);
        let pid = tokio::fs::read_to_string(temp.path().join("background-pid"))
            .await
            .unwrap();
        assert!(
            wait_for_process_exit(pid.trim()).await,
            "successful hook leaked child {pid}"
        );
        assert!(
            unrelated.try_wait().unwrap().is_none(),
            "hook cleanup terminated an unrelated workspace process"
        );
        unrelated.kill().await.unwrap();
        unrelated.wait().await.unwrap();
    }
}
