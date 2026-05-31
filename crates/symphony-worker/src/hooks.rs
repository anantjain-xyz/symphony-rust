use std::{collections::BTreeMap, path::Path, time::Instant};
use symphony_core::{HookName, Issue};
use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct HookResult {
    pub exit_code: i32,
    pub duration_ms: i64,
    pub stderr_tail: Option<String>,
    pub timed_out: bool,
}

pub async fn run_hook(
    hook: HookName,
    script: &str,
    issue: &Issue,
    workspace_path: &Path,
    run_number: i64,
    timeout_ms: u64,
    env: &BTreeMap<String, String>,
) -> HookResult {
    let start = Instant::now();
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
        .env_clear()
        .envs(child_env)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let output =
        tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), cmd.output()).await;
    match output {
        Ok(Ok(output)) => HookResult {
            exit_code: output.status.code().unwrap_or(-1),
            duration_ms: start.elapsed().as_millis() as i64,
            stderr_tail: tail(&String::from_utf8_lossy(&output.stderr), 4096),
            timed_out: false,
        },
        Ok(Err(err)) => HookResult {
            exit_code: -1,
            duration_ms: start.elapsed().as_millis() as i64,
            stderr_tail: Some(err.to_string()),
            timed_out: false,
        },
        Err(_) => HookResult {
            exit_code: -1,
            duration_ms: start.elapsed().as_millis() as i64,
            stderr_tail: Some("hook timed out".to_string()),
            timed_out: true,
        },
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
