use std::{
    collections::BTreeMap,
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};
use symphony_core::{HookName, Issue};
use tokio::{io::AsyncReadExt, process::Command, task::JoinHandle};
use tokio_util::sync::CancellationToken;

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
            pr_urls: vec![],
            project_id: None,
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
(trap "" TERM; while true; do echo child-still-running >&2; /bin/sleep 0.01; done) &
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
}
