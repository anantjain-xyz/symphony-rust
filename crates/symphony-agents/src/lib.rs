use async_trait::async_trait;
use chrono::TimeZone;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command as StdCommand,
    time::Duration,
};
use symphony_core::{
    AgentBackend, AgentEventKind, AgentOutcome, ClaudePermissionMode, CodexPermissionMode,
    CursorAgentMode, CursorSandboxMode, MappedAgentEvent, RateLimitPayload, SessionInfoPayload,
    ThreadSandbox, TokenCountPayload, ToolCallPayload, TurnSandboxPolicy,
};
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("agent spawn failed: {0}")]
    Spawn(std::io::Error),
    #[error("agent I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("agent timed out after {0}ms")]
    Timeout(u64),
    #[error("agent JSON parse failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("agent process exited without a result")]
    MissingResult,
}

#[derive(Debug, Clone)]
pub struct AgentRunRequest {
    pub backend: AgentBackend,
    pub command: String,
    pub cwd: PathBuf,
    pub prompt: String,
    pub codex_permission_mode: CodexPermissionMode,
    pub thread_sandbox: ThreadSandbox,
    pub turn_sandbox_policy: TurnSandboxPolicy,
    pub network_access: bool,
    pub turn_timeout_ms: u64,
    pub claude: ClaudeRunOptions,
    pub cursor: CursorRunOptions,
    pub opencode: OpencodeRunOptions,
    /// Extra environment variables for the agent process (e.g. LINEAR_API_KEY,
    /// which lives in the OS keychain and is absent from the inherited env).
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default)]
pub struct ClaudeRunOptions {
    pub permission_mode: ClaudePermissionMode,
    pub allowed_tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    pub add_dirs: Vec<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CursorRunOptions {
    pub mode: CursorAgentMode,
    pub force: bool,
    pub trust: bool,
    pub approve_mcps: bool,
    pub sandbox: CursorSandboxMode,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct OpencodeRunOptions {
    pub model: Option<String>,
    pub agent: Option<String>,
    pub skip_permissions: bool,
}

#[derive(Debug, Clone)]
pub struct AgentRunResult {
    pub thread_id: String,
    pub turn_id: String,
    pub outcome: AgentOutcome,
    pub error_class: Option<String>,
    pub error_message: Option<String>,
}

pub type AgentEventSender = mpsc::Sender<MappedAgentEvent>;

const GITHUB_TOKEN_ENV_VARS: &[&str] = &[
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
];

#[async_trait]
pub trait AgentDriver: Send + Sync {
    async fn run(
        &self,
        request: AgentRunRequest,
        events: AgentEventSender,
        cancel: CancellationToken,
    ) -> Result<AgentRunResult, AgentError>;
}

#[derive(Debug, Clone, Default)]
pub struct NativeAgentDriver;

#[async_trait]
impl AgentDriver for NativeAgentDriver {
    async fn run(
        &self,
        request: AgentRunRequest,
        events: AgentEventSender,
        cancel: CancellationToken,
    ) -> Result<AgentRunResult, AgentError> {
        match request.backend {
            AgentBackend::Codex => run_codex(request, events, cancel).await,
            AgentBackend::Claude => run_claude(request, events, cancel).await,
            AgentBackend::Cursor => run_cursor(request, events, cancel).await,
            AgentBackend::Opencode => run_opencode(request, events, cancel).await,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MockAgentDriver {
    pub result: AgentRunResult,
    pub events: Vec<MappedAgentEvent>,
}

#[async_trait]
impl AgentDriver for MockAgentDriver {
    async fn run(
        &self,
        _request: AgentRunRequest,
        events: AgentEventSender,
        cancel: CancellationToken,
    ) -> Result<AgentRunResult, AgentError> {
        for event in &self.events {
            if cancel.is_cancelled() {
                return Ok(AgentRunResult {
                    outcome: AgentOutcome::Cancelled,
                    ..self.result.clone()
                });
            }
            let _ = events.send(event.clone()).await;
        }
        Ok(self.result.clone())
    }
}

fn parse_strict_json_line(line: &str) -> Result<Value, AgentError> {
    Ok(serde_json::from_str(line)?)
}

#[derive(Debug, PartialEq)]
enum OpencodeStdoutLine {
    Event(Value),
    AgentFallback(String),
    Ignored,
}

fn parse_opencode_stdout_line(line: &str) -> OpencodeStdoutLine {
    match serde_json::from_str::<Value>(line) {
        Ok(value) => OpencodeStdoutLine::Event(value),
        Err(_) if is_opencode_agent_fallback(line) => {
            OpencodeStdoutLine::AgentFallback(line.to_string())
        }
        // opencode can print human-readable warnings to stdout even under
        // `--format json`; these are intentionally tolerated unless they
        // announce an unsafe fallback to a different configured agent.
        Err(_) => OpencodeStdoutLine::Ignored,
    }
}

async fn run_codex(
    request: AgentRunRequest,
    events: AgentEventSender,
    cancel: CancellationToken,
) -> Result<AgentRunResult, AgentError> {
    let thread_id = format!("th_{}", Uuid::new_v4());
    let turn_id = format!("tn_{}", Uuid::new_v4());
    let args = codex_args(&request);

    let mut child = spawn_shell_command(&request.command, &args, &request.cwd, &request.env)?;
    let pid = child.id();
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(request.prompt.as_bytes()).await?;
    }
    let stdout = child.stdout.take().ok_or(AgentError::MissingResult)?;
    let mut lines = BufReader::new(stdout).lines();
    let mut result: Option<AgentRunResult> = None;

    let run = async {
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            let value = parse_strict_json_line(&line)?;
            if let Some(done) = map_codex_event(&thread_id, &turn_id, value, &events).await? {
                result = Some(done);
            }
        }
        let status = child.wait().await?;
        Ok::<_, AgentError>((status, result))
    };

    let timeout = tokio::time::sleep(Duration::from_millis(request.turn_timeout_ms));
    tokio::pin!(timeout);
    let (status, parsed_result) = tokio::select! {
        outcome = run => outcome?,
        _ = &mut timeout => {
            kill_pid(pid).await;
            return Err(AgentError::Timeout(request.turn_timeout_ms));
        }
        _ = cancel.cancelled() => {
            kill_pid(pid).await;
            return Ok(AgentRunResult {
                thread_id,
                turn_id,
                outcome: AgentOutcome::Cancelled,
                error_class: Some("cancelled".to_string()),
                error_message: Some("run cancelled".to_string()),
            });
        }
    };

    Ok(parsed_result.unwrap_or_else(|| AgentRunResult {
        thread_id,
        turn_id,
        outcome: if status.success() {
            AgentOutcome::Success
        } else {
            AgentOutcome::Failure
        },
        error_class: (!status.success()).then(|| "nonzero_exit".to_string()),
        error_message: (!status.success()).then(|| format!("codex exit {status}")),
    }))
}

fn codex_args(request: &AgentRunRequest) -> Vec<String> {
    codex_args_with_git_metadata_dirs(request, git_metadata_dirs(&request.cwd))
}

fn codex_args_with_git_metadata_dirs(
    request: &AgentRunRequest,
    git_metadata_dirs: Vec<PathBuf>,
) -> Vec<String> {
    let sandbox = normalize_sandbox(&request.thread_sandbox, &request.turn_sandbox_policy);
    let mut args = vec![
        "exec".to_string(),
        "--json".to_string(),
        "--skip-git-repo-check".to_string(),
        "-C".to_string(),
        request.cwd.display().to_string(),
    ];
    if sandbox == "danger-full-access"
        || request.codex_permission_mode == CodexPermissionMode::FullAccess
    {
        args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
        return args;
    }

    match sandbox.as_str() {
        "workspace-write" => {
            args.push("-s".to_string());
            args.push("workspace-write".to_string());
            for dir in git_metadata_dirs {
                args.push("--add-dir".to_string());
                args.push(dir.display().to_string());
            }
            if request.network_access {
                args.push("-c".to_string());
                args.push("sandbox_workspace_write.network_access=true".to_string());
            }
        }
        _ => {
            args.push("-s".to_string());
            args.push("read-only".to_string());
        }
    }
    args.push("-c".to_string());
    args.push("approval_policy=on-request".to_string());
    args.push("-c".to_string());
    args.push("approvals_reviewer=auto_review".to_string());
    args
}

fn git_metadata_dirs(workspace: &Path) -> Vec<PathBuf> {
    let workspace_root = normalize_path(workspace.to_path_buf());
    match git_repo_root(&workspace_root) {
        Some(repo_root) if repo_root == workspace_root => {}
        Some(_) => return Vec::new(),
        None => {
            let dot_git = workspace_root.join(".git");
            return dot_git
                .is_dir()
                .then(|| normalize_path(dot_git))
                .into_iter()
                .collect();
        }
    }

    let mut dirs = Vec::new();
    for flag in ["--git-dir", "--git-common-dir"] {
        if let Some(path) = git_rev_parse_path(&workspace_root, flag) {
            push_unique_path(&mut dirs, normalize_path(path));
        }
    }
    dirs
}

fn git_repo_root(workspace: &Path) -> Option<PathBuf> {
    git_rev_parse_path(workspace, "--show-toplevel").map(normalize_path)
}

fn git_rev_parse_path(workspace: &Path, flag: &str) -> Option<PathBuf> {
    let output = StdCommand::new("git")
        .arg("-C")
        .arg(workspace)
        .arg("rev-parse")
        .arg(flag)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let path = PathBuf::from(raw);
    Some(if path.is_absolute() {
        path
    } else {
        workspace.join(path)
    })
}

fn normalize_path(path: PathBuf) -> PathBuf {
    std::fs::canonicalize(&path).unwrap_or(path)
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

async fn map_codex_event(
    thread_id: &str,
    turn_id: &str,
    ev: Value,
    events: &AgentEventSender,
) -> Result<Option<AgentRunResult>, AgentError> {
    match ev.get("type").and_then(Value::as_str).unwrap_or_default() {
        "thread.started" => {
            send_status(
                events,
                format!(
                    "Codex thread {}",
                    ev["thread_id"].as_str().unwrap_or(thread_id)
                ),
            )
            .await;
        }
        "turn.started" => send_status(events, "Turn started").await,
        "item.started" | "item.completed" => {
            if ev["item"]["type"].as_str() == Some("command_execution") {
                let summary = if ev["type"].as_str() == Some("item.completed") {
                    format!(
                        "exit {}",
                        ev["item"]["exit_code"]
                            .as_i64()
                            .map_or("?".to_string(), |v| v.to_string())
                    )
                } else {
                    ev["item"]["command"]
                        .as_str()
                        .map(|command| command.to_string())
                        .unwrap_or_else(|| "running".to_string())
                };
                let payload = serde_json::to_value(ToolCallPayload {
                    tool: "bash".to_string(),
                    args: Some(json!({ "command": ev["item"]["command"].clone() })),
                    call_id: ev["item"]["id"].as_str().map(ToOwned::to_owned),
                    result_summary: Some(summary.clone()),
                })?;
                send_mapped(
                    events,
                    MappedAgentEvent {
                        kind: AgentEventKind::ToolCall,
                        payload,
                        humanized: Some(format!("bash: {summary}")),
                        tokens: None,
                        rate_limit: None,
                        session_info: None,
                    },
                )
                .await;
            } else if ev["type"].as_str() == Some("item.completed") {
                if let Some(kind) = ev["item"]["type"].as_str() {
                    if kind == "agent_message" {
                        if let Some(summary) = codex_item_summary(&ev["item"]) {
                            send_status(events, truncate(&summary, 2000)).await;
                        } else {
                            send_status(events, format!("{kind} completed")).await;
                        }
                    } else {
                        send_status(events, format!("{kind} completed")).await;
                    }
                }
            }
        }
        "turn.completed" => {
            // Codex reports totals already: `cached_input_tokens` is a subset
            // of `input_tokens`, and `reasoning_output_tokens` (when present)
            // is a subset of `output_tokens`. Do not add either or we double
            // count — unlike Claude/Cursor/opencode, where cache buckets are
            // separate and must be folded into input.
            let usage = &ev["usage"];
            let input = usage["input_tokens"].as_i64().unwrap_or(0);
            let output = usage["output_tokens"].as_i64().unwrap_or(0);
            let tokens = TokenCountPayload {
                input_tokens: input,
                output_tokens: output,
                total_tokens: input + output,
            };
            send_token_count(events, tokens).await?;
            if let Some(limits) = ev.get("rate_limits").and_then(Value::as_object) {
                for (bucket, info) in limits {
                    let remaining = info
                        .get("remaining")
                        .or_else(|| info.get("remaining_tokens"))
                        .and_then(Value::as_i64);
                    let reset_at = info
                        .get("reset_at")
                        .or_else(|| info.get("reset"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                    let payload = RateLimitPayload {
                        source: format!("codex_{bucket}"),
                        remaining,
                        reset_at,
                    };
                    send_rate_limit(events, payload).await?;
                }
            }
            return Ok(Some(AgentRunResult {
                thread_id: thread_id.to_string(),
                turn_id: turn_id.to_string(),
                outcome: AgentOutcome::Success,
                error_class: None,
                error_message: None,
            }));
        }
        "turn.failed" => {
            // Codex usage/credit limits arrive as turn.failed with a human
            // message ("You've hit your usage limit... try again at ..."), not
            // as rate_limits on turn.completed. Detect them so the dashboard
            // and dispatch pause see the hit — matching Claude/Cursor/opencode.
            let message = ev["error"]["message"]
                .as_str()
                .unwrap_or("Codex turn failed");
            if let Some(limit) = detect_codex_rate_limit(message) {
                send_rate_limit(events, limit).await?;
                return Ok(Some(AgentRunResult {
                    thread_id: thread_id.to_string(),
                    turn_id: turn_id.to_string(),
                    outcome: AgentOutcome::Failure,
                    error_class: Some("rate_limited".to_string()),
                    error_message: Some(truncate(message, 1000)),
                }));
            }
            return Ok(Some(AgentRunResult {
                thread_id: thread_id.to_string(),
                turn_id: turn_id.to_string(),
                outcome: AgentOutcome::Failure,
                error_class: ev["error"]["type"]
                    .as_str()
                    .unwrap_or("turn_failed")
                    .to_string()
                    .into(),
                error_message: Some(message.to_string()),
            }));
        }
        "error" => {
            send_error(
                events,
                ev["class"].as_str().unwrap_or("codex_error"),
                ev["message"].as_str().unwrap_or("Codex error"),
            )
            .await?;
        }
        _ => {}
    }
    Ok(None)
}

fn codex_item_summary(item: &Value) -> Option<String> {
    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToOwned::to_owned)
    };

    if let Some(summary) = text(item.get("text")) {
        return Some(summary);
    }
    if let Some(summary) = text(item.get("summary")) {
        return Some(summary);
    }
    if let Some(summary) = text(item.get("message")) {
        return Some(summary);
    }
    if let Some(summary) = text(item.get("result")) {
        return Some(summary);
    }
    if let Some(summary) = text(item.get("content")) {
        return Some(summary);
    }

    let content = item.get("content")?.as_array()?;
    let mut lines = Vec::new();
    for block in content {
        if let Some(text) = block.get("text").and_then(Value::as_str).map(str::trim) {
            if !text.is_empty() {
                lines.push(text);
            }
        }
        if let Some(text) = block
            .get("content")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            lines.push(text);
        }
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

async fn run_claude(
    request: AgentRunRequest,
    events: AgentEventSender,
    cancel: CancellationToken,
) -> Result<AgentRunResult, AgentError> {
    let session_id = request
        .claude
        .session_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let args = claude_args(&request, &session_id);

    let mut child = spawn_shell_command(&request.command, &args, &request.cwd, &request.env)?;
    let pid = child.id();
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(request.prompt.as_bytes()).await?;
    }
    let stdout = child.stdout.take().ok_or(AgentError::MissingResult)?;
    let mut lines = BufReader::new(stdout).lines();
    let mut stream = ClaudeStreamState::new(
        session_id.clone(),
        &request.claude.permission_mode,
        request.cwd.clone(),
    );
    let mut result: Option<AgentRunResult> = None;

    let run = async {
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            let value = parse_strict_json_line(&line)?;
            if let Some(done) = stream.push(value, &events).await? {
                if stream.abort {
                    // Unusable session (e.g. dropped permission mode): stop
                    // the process now; stdout closes and the loop drains out.
                    kill_pid(pid).await;
                }
                result = Some(done);
            }
        }
        let status = child.wait().await?;
        Ok::<_, AgentError>((status, result))
    };

    let timeout = tokio::time::sleep(Duration::from_millis(request.turn_timeout_ms));
    tokio::pin!(timeout);
    let (status, parsed_result) = tokio::select! {
        outcome = run => outcome?,
        _ = &mut timeout => {
            kill_pid(pid).await;
            return Err(AgentError::Timeout(request.turn_timeout_ms));
        }
        _ = cancel.cancelled() => {
            kill_pid(pid).await;
            return Ok(AgentRunResult {
                thread_id: session_id.clone(),
                turn_id: session_id,
                outcome: AgentOutcome::Cancelled,
                error_class: Some("cancelled".to_string()),
                error_message: Some("run cancelled".to_string()),
            });
        }
    };

    Ok(parsed_result.unwrap_or_else(|| AgentRunResult {
        thread_id: session_id.clone(),
        turn_id: session_id,
        outcome: if status.success() {
            AgentOutcome::Success
        } else {
            AgentOutcome::Failure
        },
        error_class: (!status.success()).then(|| "nonzero_exit".to_string()),
        error_message: (!status.success()).then(|| format!("claude exit {status}")),
    }))
}

fn claude_args(request: &AgentRunRequest, session_id: &str) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--session-id".to_string(),
        session_id.to_string(),
    ];
    args.push("--permission-mode".to_string());
    args.push(permission_mode_arg(&request.claude.permission_mode).to_string());
    if !request.claude.allowed_tools.is_empty() {
        args.push("--allowedTools".to_string());
        args.push(request.claude.allowed_tools.join(","));
    }
    if !request.claude.disallowed_tools.is_empty() {
        args.push("--disallowedTools".to_string());
        args.push(request.claude.disallowed_tools.join(","));
    }
    args.push("--add-dir".to_string());
    args.push(request.cwd.join(".git").display().to_string());
    for dir in &request.claude.add_dirs {
        args.push("--add-dir".to_string());
        args.push(dir.clone());
    }
    args
}

struct ClaudeStreamState {
    session_id: String,
    pending_tools: HashMap<String, String>,
    completed: bool,
    last_assistant_text: String,
    session_info: SessionInfoPayload,
    expected_permission_mode: &'static str,
    /// Whether the requested mode should auto-approve edits inside the
    /// workspace (acceptEdits/auto/bypassPermissions). Denials there mean the
    /// session is not honoring the mode and the run cannot do its job.
    mode_auto_accepts_edits: bool,
    /// The init event confirmed the session runs in the requested mode. Write
    /// denials in a confirmed session are legitimate policy (repo ask/deny
    /// rules, protected build-tool files), not the dropped-mode bug.
    mode_confirmed: bool,
    cwd: PathBuf,
    /// Ask the driver to kill the process: the session is unusable.
    abort: bool,
    denied_workspace_writes: Vec<String>,
    /// A file-write tool completed at least once. A dropped mode denies every
    /// write in the session, so any success means denials were policy.
    any_write_succeeded: bool,
}

impl ClaudeStreamState {
    fn new(session_id: String, permission_mode: &ClaudePermissionMode, cwd: PathBuf) -> Self {
        Self {
            session_id,
            pending_tools: HashMap::new(),
            completed: false,
            last_assistant_text: String::new(),
            session_info: SessionInfoPayload::default(),
            expected_permission_mode: permission_mode_arg(permission_mode),
            mode_auto_accepts_edits: matches!(
                permission_mode,
                ClaudePermissionMode::AcceptEdits
                    | ClaudePermissionMode::Auto
                    | ClaudePermissionMode::BypassPermissions
            ),
            mode_confirmed: false,
            cwd,
            abort: false,
            denied_workspace_writes: Vec::new(),
            any_write_succeeded: false,
        }
    }

    async fn push(
        &mut self,
        ev: Value,
        events: &AgentEventSender,
    ) -> Result<Option<AgentRunResult>, AgentError> {
        if self.completed {
            return Ok(None);
        }
        match ev["type"].as_str().unwrap_or_default() {
            "system" => match ev["subtype"].as_str().unwrap_or_default() {
                "init" => {
                    let text = |key: &str| ev[key].as_str().map(ToOwned::to_owned);
                    self.session_info = SessionInfoPayload {
                        model: text("model"),
                        permission_mode: text("permissionMode"),
                        agent_version: text("claude_code_version"),
                        output_style: text("output_style"),
                        fast_mode: text("fast_mode_state"),
                        thinking_tokens: None,
                    };
                    let mut message = format!(
                        "Claude session {} started",
                        ev["session_id"].as_str().unwrap_or(&self.session_id)
                    );
                    if let Some(model) = &self.session_info.model {
                        message.push_str(&format!(" · {model}"));
                    }
                    if let Some(mode) = &self.session_info.permission_mode {
                        message.push_str(&format!(" · {mode}"));
                    }
                    send_mapped(
                        events,
                        MappedAgentEvent {
                            kind: AgentEventKind::Status,
                            payload: json!({ "message": message }),
                            humanized: Some(message),
                            tokens: None,
                            rate_limit: None,
                            session_info: Some(self.session_info.clone()),
                        },
                    )
                    .await;
                    // claude 2.1.x has a startup race that silently ignores
                    // --permission-mode; a headless session that comes up in the
                    // wrong mode can never write, so kill it and let the worker
                    // retry instead of burning a full doomed run.
                    if let Some(actual) = ev["permissionMode"].as_str() {
                        if actual != self.expected_permission_mode {
                            let message = format!(
                                "claude started in '{actual}' permission mode instead of the requested '{}'; aborting so the retry gets a working session",
                                self.expected_permission_mode
                            );
                            send_error(events, "permission_mode_dropped", &message).await?;
                            self.completed = true;
                            self.abort = true;
                            return Ok(Some(AgentRunResult {
                                thread_id: self.session_id.clone(),
                                turn_id: self.session_id.clone(),
                                outcome: AgentOutcome::Failure,
                                error_class: Some("permission_mode_dropped".to_string()),
                                error_message: Some(message),
                            }));
                        }
                        self.mode_confirmed = true;
                    }
                }
                "thinking_tokens" => {
                    let prior = self.session_info.thinking_tokens;
                    if let Some(estimate) = ev["estimated_tokens"].as_i64() {
                        self.session_info.thinking_tokens = Some(prior.unwrap_or(0).max(estimate));
                    }
                    // Persist each update as it happens: runs that time out,
                    // get cancelled, or die without a usage-bearing result
                    // event would otherwise lose the estimate. The null
                    // payload marks this as metadata-only so the worker skips
                    // the event log.
                    if self.session_info.thinking_tokens != prior {
                        send_mapped(
                            events,
                            MappedAgentEvent {
                                kind: AgentEventKind::Status,
                                payload: Value::Null,
                                humanized: None,
                                tokens: None,
                                rate_limit: None,
                                session_info: Some(self.session_info.clone()),
                            },
                        )
                        .await;
                    }
                }
                _ => {}
            },
            "assistant" => {
                for block in ev["message"]["content"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                {
                    match block["type"].as_str().unwrap_or_default() {
                        "text" => {
                            let text = block["text"].as_str().unwrap_or_default().trim();
                            if !text.is_empty() {
                                self.last_assistant_text = text.to_string();
                                send_status(events, truncate(text, 2000)).await;
                            }
                        }
                        "tool_use" => {
                            let id = block["id"].as_str().map(ToOwned::to_owned);
                            let name = block["name"].as_str().unwrap_or("tool").to_string();
                            if let Some(id) = &id {
                                self.pending_tools.insert(id.clone(), name.clone());
                            }
                            let payload = serde_json::to_value(ToolCallPayload {
                                tool: name.clone(),
                                args: block.get("input").cloned(),
                                call_id: id,
                                result_summary: None,
                            })?;
                            send_mapped(
                                events,
                                MappedAgentEvent {
                                    kind: AgentEventKind::ToolCall,
                                    payload,
                                    humanized: Some(format!("Calling {name}")),
                                    tokens: None,
                                    rate_limit: None,
                                    session_info: None,
                                },
                            )
                            .await;
                        }
                        _ => {}
                    }
                }
            }
            "user" => {
                for block in ev["message"]["content"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                {
                    if block["type"].as_str() != Some("tool_result") {
                        continue;
                    }
                    let id = block["tool_use_id"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                    let tool = self
                        .pending_tools
                        .remove(&id)
                        .unwrap_or_else(|| "tool".to_string());
                    if !block["is_error"].as_bool().unwrap_or(false)
                        && matches!(
                            tool.as_str(),
                            "Edit" | "Write" | "MultiEdit" | "NotebookEdit"
                        )
                    {
                        self.any_write_succeeded = true;
                    }
                    let raw = extract_tool_result(block.get("content").unwrap_or(&Value::Null));
                    let summary = truncate(
                        &format!(
                            "{}{}",
                            if block["is_error"].as_bool().unwrap_or(false) {
                                "error: "
                            } else {
                                ""
                            },
                            raw
                        ),
                        1000,
                    );
                    let payload = serde_json::to_value(ToolCallPayload {
                        tool,
                        args: None,
                        call_id: Some(id.clone()),
                        result_summary: Some(summary.clone()),
                    })?;
                    send_mapped(
                        events,
                        MappedAgentEvent {
                            kind: AgentEventKind::ToolCall,
                            payload,
                            humanized: Some(summary.clone()),
                            tokens: None,
                            rate_limit: None,
                            session_info: None,
                        },
                    )
                    .await;
                    if block["is_error"].as_bool().unwrap_or(false)
                        && raw.to_lowercase().contains("permission")
                    {
                        send_mapped(
                            events,
                            MappedAgentEvent {
                                kind: AgentEventKind::Approval,
                                payload: json!({ "reason": summary, "call_id": id }),
                                humanized: Some("Approval requested".to_string()),
                                tokens: None,
                                rate_limit: None,
                                session_info: None,
                            },
                        )
                        .await;
                        // Only armed while the session's mode is unverified
                        // (init didn't report one): a confirmed session that
                        // denies a write is enforcing legitimate policy.
                        if self.mode_auto_accepts_edits && !self.mode_confirmed {
                            if let Some(path) = denied_write_path(&raw) {
                                if std::path::Path::new(path).starts_with(&self.cwd) {
                                    self.denied_workspace_writes.push(path.to_string());
                                }
                            }
                        }
                    }
                }
            }
            "result" => {
                let usage = &ev["usage"];
                let input = usage["input_tokens"].as_i64().unwrap_or(0)
                    + usage["cache_creation_input_tokens"].as_i64().unwrap_or(0)
                    + usage["cache_read_input_tokens"].as_i64().unwrap_or(0);
                let output = usage["output_tokens"].as_i64().unwrap_or(0);
                if input > 0 || output > 0 {
                    let tokens = TokenCountPayload {
                        input_tokens: input,
                        output_tokens: output,
                        total_tokens: input + output,
                    };
                    send_mapped(
                        events,
                        MappedAgentEvent {
                            kind: AgentEventKind::TokenCount,
                            payload: serde_json::to_value(&tokens)?,
                            humanized: None,
                            tokens: Some(tokens),
                            rate_limit: None,
                            session_info: (!self.session_info.is_empty())
                                .then(|| self.session_info.clone()),
                        },
                    )
                    .await;
                }
                self.completed = true;
                // The CLI has no dedicated rate-limit event; a hit only shows
                // up as message text — the subscription limit arrives with
                // subtype "success" and exit 0 ("Claude AI usage limit
                // reached|<epoch>"), an API limit as "API Error: 429 ...".
                // Record the signal so the dashboard surfaces it and, when a
                // reset time is known, the worker pauses dispatch until then.
                let limit_hit = [
                    ev["result"].as_str().unwrap_or_default(),
                    ev["error"].as_str().unwrap_or_default(),
                    self.last_assistant_text.as_str(),
                ]
                .into_iter()
                .find_map(|text| detect_claude_rate_limit(text).map(|limit| (text, limit)));
                if let Some((text, limit)) = limit_hit {
                    send_rate_limit(events, limit).await?;
                    return Ok(Some(AgentRunResult {
                        thread_id: self.session_id.clone(),
                        turn_id: self.session_id.clone(),
                        outcome: AgentOutcome::Failure,
                        error_class: Some("rate_limited".to_string()),
                        error_message: Some(truncate(text, 1000)),
                    }));
                }
                if ev["subtype"].as_str() == Some("success") {
                    if let Some(class) = classify_api_error(&self.last_assistant_text) {
                        return Ok(Some(AgentRunResult {
                            thread_id: self.session_id.clone(),
                            turn_id: self.session_id.clone(),
                            outcome: AgentOutcome::Failure,
                            error_class: Some(class.to_string()),
                            error_message: Some(truncate(&self.last_assistant_text, 1000)),
                        }));
                    }
                    // claude exits 0 even when every workspace write was
                    // permission-denied; an unattended run that could not
                    // write has not done its job, so retry it. A session
                    // where any write completed was honoring the mode — its
                    // denials were policy, not the dropped-mode bug.
                    if !self.denied_workspace_writes.is_empty() && !self.any_write_succeeded {
                        let message = format!(
                            "{} workspace write(s) denied permission despite '{}' mode (first: {}); claude likely dropped the permission mode at startup",
                            self.denied_workspace_writes.len(),
                            self.expected_permission_mode,
                            self.denied_workspace_writes[0],
                        );
                        send_error(events, "write_permission_denied", &message).await?;
                        return Ok(Some(AgentRunResult {
                            thread_id: self.session_id.clone(),
                            turn_id: self.session_id.clone(),
                            outcome: AgentOutcome::Failure,
                            error_class: Some("write_permission_denied".to_string()),
                            error_message: Some(message),
                        }));
                    }
                    return Ok(Some(AgentRunResult {
                        thread_id: self.session_id.clone(),
                        turn_id: self.session_id.clone(),
                        outcome: AgentOutcome::Success,
                        error_class: None,
                        error_message: None,
                    }));
                }
                return Ok(Some(AgentRunResult {
                    thread_id: self.session_id.clone(),
                    turn_id: self.session_id.clone(),
                    outcome: AgentOutcome::Failure,
                    error_class: Some(ev["subtype"].as_str().unwrap_or("claude_error").to_string()),
                    error_message: Some(
                        ev["error"]
                            .as_str()
                            .or_else(|| ev["result"].as_str())
                            .unwrap_or("Claude run failed")
                            .to_string(),
                    ),
                }));
            }
            _ => {}
        }
        Ok(None)
    }
}

async fn run_cursor(
    request: AgentRunRequest,
    events: AgentEventSender,
    cancel: CancellationToken,
) -> Result<AgentRunResult, AgentError> {
    let session_id = format!("cs_{}", Uuid::new_v4());
    let args = cursor_args(&request);

    // Stream the prompt over stdin (cursor-agent reads it in print mode) rather
    // than as an argv entry: large issue prompts can exceed the OS command-line
    // limit, and argv is visible to other processes while the agent runs.
    let mut child = spawn_shell_command(&request.command, &args, &request.cwd, &request.env)?;
    let pid = child.id();
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(request.prompt.as_bytes()).await?;
    }
    let stdout = child.stdout.take().ok_or(AgentError::MissingResult)?;
    let mut lines = BufReader::new(stdout).lines();
    let mut stream = CursorStreamState::new(session_id.clone());
    let mut result: Option<AgentRunResult> = None;

    let run = async {
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            let value = parse_strict_json_line(&line)?;
            if let Some(done) = stream.push(value, &events).await? {
                // The `result` record is terminal, but cursor-agent can keep
                // the process alive afterwards waiting on a command-based MCP
                // subprocess. Stop reading here instead of blocking on EOF /
                // exit, which would otherwise strand the run until the turn
                // timeout and mark a completed run as a timeout.
                result = Some(done);
                break;
            }
        }
        Ok::<_, AgentError>(result)
    };

    let timeout = tokio::time::sleep(Duration::from_millis(request.turn_timeout_ms));
    tokio::pin!(timeout);
    let parsed_result = tokio::select! {
        outcome = run => outcome?,
        _ = &mut timeout => {
            kill_pid(pid).await;
            return Err(AgentError::Timeout(request.turn_timeout_ms));
        }
        _ = cancel.cancelled() => {
            kill_pid(pid).await;
            return Ok(AgentRunResult {
                thread_id: stream.session_id.clone(),
                turn_id: stream.session_id.clone(),
                outcome: AgentOutcome::Cancelled,
                error_class: Some("cancelled".to_string()),
                error_message: Some("run cancelled".to_string()),
            });
        }
    };

    let sid = stream.session_id.clone();
    if let Some(done) = parsed_result {
        // Terminate any process still lingering on an MCP subprocess.
        kill_pid(pid).await;
        return Ok(done);
    }

    // Stdout closed without a `result` record: fall back to the exit status.
    let status = child.wait().await?;
    Ok(AgentRunResult {
        thread_id: sid.clone(),
        turn_id: sid,
        outcome: if status.success() {
            AgentOutcome::Success
        } else {
            AgentOutcome::Failure
        },
        error_class: (!status.success()).then(|| "nonzero_exit".to_string()),
        error_message: (!status.success()).then(|| format!("cursor exit {status}")),
    })
}

fn cursor_args(request: &AgentRunRequest) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--workspace".to_string(),
        request.cwd.display().to_string(),
    ];
    if request.cursor.force {
        args.push("--force".to_string());
    }
    if request.cursor.trust {
        args.push("--trust".to_string());
    }
    if request.cursor.approve_mcps {
        args.push("--approve-mcps".to_string());
    }
    let mode = match request.cursor.mode {
        CursorAgentMode::Plan => Some("plan"),
        CursorAgentMode::Ask => Some("ask"),
        CursorAgentMode::Agent => None,
    };
    if let Some(mode) = mode {
        args.push("--mode".to_string());
        args.push(mode.to_string());
    }
    let sandbox = match request.cursor.sandbox {
        CursorSandboxMode::Enabled => "enabled",
        CursorSandboxMode::Disabled => "disabled",
    };
    args.push("--sandbox".to_string());
    args.push(sandbox.to_string());
    if let Some(model) = &request.cursor.model {
        let model = model.trim();
        if !model.is_empty() {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
    }
    args
}

struct CursorStreamState {
    session_id: String,
    completed: bool,
    last_assistant_text: String,
    session_info: SessionInfoPayload,
}

impl CursorStreamState {
    fn new(fallback_session_id: String) -> Self {
        Self {
            session_id: fallback_session_id,
            completed: false,
            last_assistant_text: String::new(),
            session_info: SessionInfoPayload::default(),
        }
    }

    async fn push(
        &mut self,
        ev: Value,
        events: &AgentEventSender,
    ) -> Result<Option<AgentRunResult>, AgentError> {
        if self.completed {
            return Ok(None);
        }
        match ev["type"].as_str().unwrap_or_default() {
            "system" if ev["subtype"].as_str() == Some("init") => {
                if let Some(sid) = ev["session_id"].as_str() {
                    self.session_id = sid.to_string();
                }
                let text = |key: &str| ev[key].as_str().map(ToOwned::to_owned);
                self.session_info = SessionInfoPayload {
                    model: text("model"),
                    permission_mode: text("permissionMode"),
                    ..Default::default()
                };
                let mut message = format!("Cursor session {} started", self.session_id);
                if let Some(model) = &self.session_info.model {
                    message.push_str(&format!(" · {model}"));
                }
                if let Some(mode) = &self.session_info.permission_mode {
                    message.push_str(&format!(" · {mode}"));
                }
                send_mapped(
                    events,
                    MappedAgentEvent {
                        kind: AgentEventKind::Status,
                        payload: json!({ "message": message }),
                        humanized: Some(message),
                        tokens: None,
                        rate_limit: None,
                        session_info: Some(self.session_info.clone()),
                    },
                )
                .await;
            }
            "assistant" => {
                for block in ev["message"]["content"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                {
                    if block["type"].as_str() != Some("text") {
                        continue;
                    }
                    let text = block["text"].as_str().unwrap_or_default().trim();
                    if text.is_empty() {
                        continue;
                    }
                    self.last_assistant_text = text.to_string();
                    send_status(events, truncate(text, 2000)).await;
                }
            }
            "tool_call" => {
                let call_id = ev["call_id"].as_str().map(ToOwned::to_owned);
                let subtype = ev["subtype"].as_str().unwrap_or_default();
                let (tool, args, summary) = cursor_tool_call_fields(&ev, subtype);
                let payload = serde_json::to_value(ToolCallPayload {
                    tool,
                    args,
                    call_id: call_id.clone(),
                    result_summary: summary.clone(),
                })?;
                send_mapped(
                    events,
                    MappedAgentEvent {
                        kind: AgentEventKind::ToolCall,
                        payload,
                        humanized: summary.or_else(|| {
                            Some(if subtype == "started" {
                                "Tool started".to_string()
                            } else {
                                "Tool completed".to_string()
                            })
                        }),
                        tokens: None,
                        rate_limit: None,
                        session_info: None,
                    },
                )
                .await;
            }
            "result" => {
                self.completed = true;
                // cursor-agent reports usage with camelCase keys. Cache read/
                // write are separate buckets (like Claude/opencode), so fold
                // them into input for a comparable per-run total.
                let usage = &ev["usage"];
                let input = usage["inputTokens"].as_i64().unwrap_or(0)
                    + usage["cacheReadTokens"].as_i64().unwrap_or(0)
                    + usage["cacheWriteTokens"].as_i64().unwrap_or(0);
                let output = usage["outputTokens"].as_i64().unwrap_or(0);
                if input > 0 || output > 0 {
                    send_token_count(
                        events,
                        TokenCountPayload {
                            input_tokens: input,
                            output_tokens: output,
                            total_tokens: input + output,
                        },
                    )
                    .await?;
                }
                let result_text = ev["result"].as_str().unwrap_or_default();
                let error_text = ev["error"].as_str().unwrap_or_default();
                let limit_hit = [result_text, error_text, self.last_assistant_text.as_str()]
                    .into_iter()
                    .find_map(|text| detect_cursor_rate_limit(text).map(|limit| (text, limit)));
                if let Some((text, limit)) = limit_hit {
                    send_rate_limit(events, limit).await?;
                    return Ok(Some(AgentRunResult {
                        thread_id: self.session_id.clone(),
                        turn_id: self.session_id.clone(),
                        outcome: AgentOutcome::Failure,
                        error_class: Some("rate_limited".to_string()),
                        error_message: Some(truncate(text, 1000)),
                    }));
                }
                if ev["subtype"].as_str() == Some("success")
                    && !ev["is_error"].as_bool().unwrap_or(false)
                {
                    return Ok(Some(AgentRunResult {
                        thread_id: self.session_id.clone(),
                        turn_id: self.session_id.clone(),
                        outcome: AgentOutcome::Success,
                        error_class: None,
                        error_message: None,
                    }));
                }
                return Ok(Some(AgentRunResult {
                    thread_id: self.session_id.clone(),
                    turn_id: self.session_id.clone(),
                    outcome: AgentOutcome::Failure,
                    error_class: Some(ev["subtype"].as_str().unwrap_or("cursor_error").to_string()),
                    error_message: Some(if !error_text.is_empty() {
                        error_text.to_string()
                    } else if !result_text.is_empty() {
                        result_text.to_string()
                    } else {
                        "Cursor run failed".to_string()
                    }),
                }));
            }
            _ => {}
        }
        Ok(None)
    }
}

fn cursor_tool_call_fields(ev: &Value, subtype: &str) -> (String, Option<Value>, Option<String>) {
    let tool_call = ev.get("tool_call").unwrap_or(ev);
    // Cursor wraps each call in a single `<name>ToolCall` object; locate that
    // entry once and derive the name, args, and summary from it. Fall back to
    // the OpenAI-style `function` shape when the wrapper key is absent.
    let variant = tool_call
        .as_object()
        .and_then(|obj| obj.iter().find(|(key, _)| key.ends_with("ToolCall")));

    let tool = match variant {
        Some((key, _)) => key.trim_end_matches("ToolCall").to_string(),
        None => tool_call["function"]["name"]
            .as_str()
            .unwrap_or("tool")
            .to_string(),
    };

    let args = match variant {
        Some((_, value)) => value.get("args").cloned(),
        None => tool_call
            .get("function")
            .and_then(|f| f.get("arguments"))
            .cloned()
            .or_else(|| Some(json!({ "tool": tool }))),
    };

    let summary = (subtype == "completed").then(|| match variant {
        Some((_, value)) => match value["args"]["path"].as_str() {
            Some(path) => format!("{tool}: {path}"),
            None => format!("{tool} completed"),
        },
        None => format!("{tool} completed"),
    });

    (tool, args, summary)
}

fn detect_cursor_rate_limit(text: &str) -> Option<RateLimitPayload> {
    let lower = text.trim().to_lowercase();
    // Anchor limit notices like Claude's detector: a successful final answer
    // can mention "rate limit" in prose without being a limit hit.
    let hit = lower.starts_with("api error: 429")
        || (lower.starts_with("api error:") && lower.contains("rate_limit"))
        || lower.starts_with("usage limit reached")
        || lower.starts_with("your usage limit reached")
        || lower.starts_with("you've reached your usage limit")
        || lower.starts_with("rate limit exceeded");
    hit.then(|| RateLimitPayload {
        source: "cursor".to_string(),
        remaining: None,
        reset_at: None,
    })
}

/// Rate-limit / usage-credit hit from a Codex `turn.failed` error message.
/// Anchored to the start of the text so a successful turn that merely
/// discusses usage limits is not reclassified as a hit.
fn detect_codex_rate_limit(text: &str) -> Option<RateLimitPayload> {
    let lower = text.trim().to_lowercase();
    let hit = lower.starts_with("you've hit your usage limit")
        || lower.starts_with("you have hit your usage limit")
        || lower.starts_with("you've reached your usage limit")
        || lower.starts_with("you have reached your usage limit")
        || lower.starts_with("usage limit reached")
        || lower.starts_with("rate limit exceeded");
    hit.then(|| RateLimitPayload {
        source: "codex".to_string(),
        remaining: None,
        reset_at: codex_limit_reset(text),
    })
}

/// Reset timestamp from Codex usage-limit copy:
/// "You've hit your usage limit. ... try again at Jul 25th, 2026 12:03 PM."
/// The wall time has no timezone; interpret it in the local zone (desktop
/// app) so the dispatch pause matches what the user was shown.
fn codex_limit_reset(text: &str) -> Option<String> {
    let naive = parse_codex_reset_naive(text)?;
    let local = chrono::Local
        .from_local_datetime(&naive)
        .single()
        .or_else(|| chrono::Local.from_local_datetime(&naive).earliest())?;
    Some(
        local
            .to_utc()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
}

fn parse_codex_reset_naive(text: &str) -> Option<chrono::NaiveDateTime> {
    let lower = text.to_lowercase();
    let marker = "try again at ";
    let start = lower.find(marker)? + marker.len();
    let raw = text[start..].trim().trim_end_matches('.').trim();
    let normalized = strip_day_ordinal(raw);
    chrono::NaiveDateTime::parse_from_str(&normalized, "%b %d, %Y %I:%M %p").ok()
}

/// "Jul 25th, 2026" → "Jul 25, 2026" so chrono can parse the day.
fn strip_day_ordinal(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            while i < chars.len() && chars[i].is_ascii_digit() {
                out.push(chars[i]);
                i += 1;
            }
            let ordinal: String = chars[i..]
                .iter()
                .take(2)
                .collect::<String>()
                .to_ascii_lowercase();
            if matches!(ordinal.as_str(), "st" | "nd" | "rd" | "th") {
                i += 2;
            }
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

async fn run_opencode(
    request: AgentRunRequest,
    events: AgentEventSender,
    cancel: CancellationToken,
) -> Result<AgentRunResult, AgentError> {
    let session_id = format!("oc_{}", Uuid::new_v4());
    // No `--print-logs`: it pushes verbose provider/plugin/MCP logs to stderr,
    // which would fill the OS pipe buffer and block the child (stalling stdout
    // JSON parsing until the turn timeout) unless we drained stderr in lockstep.
    // Leaving it off keeps stderr quiet; we still drain it below as a safety net.
    let args = opencode_args(&request);

    // Stream the prompt over stdin: opencode appends piped stdin to the
    // message, and large issue prompts can exceed the OS argv limit (which is
    // also visible to other processes while the agent runs).
    let mut child = spawn_shell_command(&request.command, &args, &request.cwd, &request.env)?;
    let pid = child.id();
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(request.prompt.as_bytes()).await?;
    }
    // Drain stderr to a sink so a chatty child can never block writing to a
    // full stderr pipe (which would stall stdout JSON parsing). The reader
    // stops on its own when the process exits and closes the pipe.
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        });
    }
    let stdout = child.stdout.take().ok_or(AgentError::MissingResult)?;
    let mut lines = BufReader::new(stdout).lines();
    let mut stream = OpencodeStreamState::new(session_id.clone());
    let mut result: Option<AgentRunResult> = None;

    let run = async {
        while let Some(line) = lines.next_line().await? {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match parse_opencode_stdout_line(line) {
                OpencodeStdoutLine::Event(value) => {
                    if let Some(done) = stream.push(value, &events).await? {
                        result = Some(done);
                    }
                }
                OpencodeStdoutLine::AgentFallback(message) => {
                    send_error(&events, "agent_not_found", &message).await?;
                    result = Some(opencode_agent_fallback_result(&stream, &message));
                    kill_pid(pid).await;
                    break;
                }
                OpencodeStdoutLine::Ignored => {}
            }
        }
        let status = child.wait().await?;
        Ok::<_, AgentError>((status, result))
    };

    let timeout = tokio::time::sleep(Duration::from_millis(request.turn_timeout_ms));
    tokio::pin!(timeout);
    let (status, parsed_result) = tokio::select! {
        outcome = run => outcome?,
        _ = &mut timeout => {
            kill_pid(pid).await;
            return Err(AgentError::Timeout(request.turn_timeout_ms));
        }
        _ = cancel.cancelled() => {
            kill_pid(pid).await;
            return Ok(AgentRunResult {
                thread_id: stream.session_id.clone(),
                turn_id: stream.session_id.clone(),
                outcome: AgentOutcome::Cancelled,
                error_class: Some("cancelled".to_string()),
                error_message: Some("run cancelled".to_string()),
            });
        }
    };

    // opencode has no terminal event in `--format json`; completion is the
    // process exiting. An `error` event flips the exit code to 1 and records
    // the failure on the stream, so a clean exit with no error is success.
    // Emit the run's summed token usage once, now that all steps have arrived.
    stream.finish(&events).await?;
    if let Some(done) = parsed_result {
        return Ok(done);
    }
    Ok(opencode_process_result(
        &stream,
        status.success(),
        (!status.success()).then(|| format!("opencode exit {status}")),
    ))
}

fn opencode_args(request: &AgentRunRequest) -> Vec<String> {
    let mut args = vec![
        "run".to_string(),
        "--dir".to_string(),
        request.cwd.display().to_string(),
        "--format".to_string(),
        "json".to_string(),
    ];
    if request.opencode.skip_permissions {
        // Non-interactive opencode auto-rejects every permission request
        // without this; an unattended run could never edit a file.
        args.push("--dangerously-skip-permissions".to_string());
    }
    if let Some(model) = &request.opencode.model {
        let model = model.trim();
        if !model.is_empty() {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
    }
    if let Some(agent) = &request.opencode.agent {
        let agent = agent.trim();
        if !agent.is_empty() {
            args.push("--agent".to_string());
            args.push(agent.to_string());
        }
    }
    args
}

struct OpencodeStreamState {
    session_id: String,
    last_assistant_text: String,
    failure: Option<AgentRunResult>,
    /// opencode emits a `step_finish` per agent step, each carrying that step's
    /// token usage. The storage layer treats one token event as one run, so we
    /// sum the steps here and emit a single total when the run finishes instead
    /// of inflating run_count and overwriting the live total per step.
    input_tokens: i64,
    output_tokens: i64,
}

impl OpencodeStreamState {
    fn new(session_id: String) -> Self {
        Self {
            session_id,
            last_assistant_text: String::new(),
            failure: None,
            input_tokens: 0,
            output_tokens: 0,
        }
    }

    /// Emit the accumulated run total once, after stdout drains. A no-op when
    /// no `step_finish` reported usage (e.g. an immediate error).
    async fn finish(&self, events: &AgentEventSender) -> Result<(), AgentError> {
        if self.input_tokens > 0 || self.output_tokens > 0 {
            send_token_count(
                events,
                TokenCountPayload {
                    input_tokens: self.input_tokens,
                    output_tokens: self.output_tokens,
                    total_tokens: self.input_tokens + self.output_tokens,
                },
            )
            .await?;
        }
        Ok(())
    }

    async fn push(
        &mut self,
        ev: Value,
        events: &AgentEventSender,
    ) -> Result<Option<AgentRunResult>, AgentError> {
        if let Some(sid) = ev["sessionID"].as_str() {
            self.session_id = sid.to_string();
        }
        match ev["type"].as_str().unwrap_or_default() {
            "text" => {
                let text = ev["part"]["text"].as_str().unwrap_or_default().trim();
                if !text.is_empty() {
                    self.last_assistant_text = text.to_string();
                    send_status(events, truncate(text, 2000)).await;
                }
            }
            "reasoning" => {
                let text = ev["part"]["text"].as_str().unwrap_or_default().trim();
                if !text.is_empty() {
                    send_status(events, truncate(text, 2000)).await;
                }
            }
            "tool_use" => {
                let part = &ev["part"];
                let tool = part["tool"].as_str().unwrap_or("tool").to_string();
                let call_id = part["callID"].as_str().map(ToOwned::to_owned);
                let state = &part["state"];
                let status = state["status"].as_str().unwrap_or_default();
                let summary = if status == "error" {
                    let err = state["error"].as_str().unwrap_or("failed");
                    format!("error: {}", truncate(err, 900))
                } else {
                    match state["title"].as_str() {
                        Some(title) if !title.is_empty() => title.to_string(),
                        _ => format!("{tool} completed"),
                    }
                };
                let payload = serde_json::to_value(ToolCallPayload {
                    tool: tool.clone(),
                    args: state.get("input").cloned(),
                    call_id,
                    result_summary: Some(summary.clone()),
                })?;
                send_mapped(
                    events,
                    MappedAgentEvent {
                        kind: AgentEventKind::ToolCall,
                        payload,
                        humanized: Some(summary),
                        tokens: None,
                        rate_limit: None,
                        session_info: None,
                    },
                )
                .await;
            }
            "step_finish" => {
                let tokens = &ev["part"]["tokens"];
                let input = tokens["input"].as_i64().unwrap_or(0)
                    + tokens["cache"]["read"].as_i64().unwrap_or(0)
                    + tokens["cache"]["write"].as_i64().unwrap_or(0);
                let output = tokens["output"].as_i64().unwrap_or(0)
                    + tokens["reasoning"].as_i64().unwrap_or(0);
                self.input_tokens += input;
                self.output_tokens += output;
            }
            "error" => {
                let data = &ev["error"]["data"];
                let name = ev["error"]["name"].as_str().unwrap_or("opencode_error");
                let message = data["message"]
                    .as_str()
                    .or_else(|| ev["error"]["message"].as_str())
                    .unwrap_or("opencode error");
                if let Some(limit) = detect_opencode_rate_limit(data, message) {
                    send_rate_limit(events, limit).await?;
                    self.failure = Some(AgentRunResult {
                        thread_id: self.session_id.clone(),
                        turn_id: self.session_id.clone(),
                        outcome: AgentOutcome::Failure,
                        error_class: Some("rate_limited".to_string()),
                        error_message: Some(truncate(message, 1000)),
                    });
                } else {
                    send_error(events, name, message).await?;
                    self.failure = Some(AgentRunResult {
                        thread_id: self.session_id.clone(),
                        turn_id: self.session_id.clone(),
                        outcome: AgentOutcome::Failure,
                        error_class: Some(name.to_string()),
                        error_message: Some(truncate(message, 1000)),
                    });
                }
            }
            _ => {}
        }
        // Errors arrive mid-stream, but the process keeps running until it
        // exits; surface the recorded failure once stdout drains by handing it
        // to the caller as the terminal result.
        Ok(self.failure.clone())
    }
}

fn opencode_process_result(
    stream: &OpencodeStreamState,
    process_succeeded: bool,
    exit_error: Option<String>,
) -> AgentRunResult {
    if let Some(failure) = &stream.failure {
        return failure.clone();
    }
    let sid = stream.session_id.clone();
    AgentRunResult {
        thread_id: sid.clone(),
        turn_id: sid,
        outcome: if process_succeeded {
            AgentOutcome::Success
        } else {
            AgentOutcome::Failure
        },
        error_class: (!process_succeeded).then(|| "nonzero_exit".to_string()),
        error_message: (!process_succeeded)
            .then(|| exit_error.unwrap_or_else(|| "opencode exited unsuccessfully".to_string())),
    }
}

fn opencode_agent_fallback_result(stream: &OpencodeStreamState, message: &str) -> AgentRunResult {
    AgentRunResult {
        thread_id: stream.session_id.clone(),
        turn_id: stream.session_id.clone(),
        outcome: AgentOutcome::Failure,
        error_class: Some("agent_not_found".to_string()),
        error_message: Some(truncate(message, 1000)),
    }
}

/// True when a non-JSON stdout line is opencode's agent-fallback diagnostic
/// ("agent \"x\" not found. Falling back to ..."). With skip-permissions on, a
/// misconfigured restricted agent would otherwise silently run as the writable
/// default agent, so the driver must surface this as a failure rather than skip
/// it like benign output.
fn is_opencode_agent_fallback(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("not found") && lower.contains("falling back")
}

/// A rate-limit hit reported on opencode's `error` event: a 429 status code or
/// a provider message that leads with a usage-limit notice. Anchored to the
/// start of the message like the Claude/Cursor detectors so prose that merely
/// mentions rate limits is not misread as a hit.
fn detect_opencode_rate_limit(data: &Value, message: &str) -> Option<RateLimitPayload> {
    let lower = message.trim().to_lowercase();
    let hit = data["statusCode"].as_i64() == Some(429)
        || lower.starts_with("api error: 429")
        || lower.starts_with("rate limit exceeded")
        || lower.starts_with("usage limit reached")
        || lower.starts_with("you've reached your usage limit");
    hit.then(|| RateLimitPayload {
        source: "opencode".to_string(),
        remaining: None,
        reset_at: None,
    })
}

fn spawn_shell_command(
    command: &str,
    args: &[String],
    cwd: &PathBuf,
    envs: &[(String, String)],
) -> Result<tokio::process::Child, AgentError> {
    let full = if args.is_empty() {
        command.to_string()
    } else {
        format!(
            "{} {}",
            command,
            args.iter()
                .map(|arg| shell_quote(arg))
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-lc")
        .arg(full)
        .current_dir(cwd)
        // Tokio does not kill a child when its future is dropped. Without this,
        // a caller that abandons the run future (e.g. dispatch_run returning
        // early on a transient DB error) would leave the agent CLI alive,
        // still mutating the workspace, while a retry is scheduled against the
        // same checkout. kill_on_drop SIGKILLs it on drop; the cancel/timeout
        // paths still SIGTERM first for a graceful stop.
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if request_env_has_github_token(envs) {
        for key in GITHUB_TOKEN_ENV_VARS {
            cmd.env_remove(key);
        }
    }
    for (key, value) in envs {
        cmd.env(key, value);
    }
    // Put the agent in its own process group (the /bin/sh leader becomes the
    // group leader). The agent CLI spawns its own tree -- MCP servers, language
    // servers, bash subshells -- and on cancel/timeout we kill the whole group
    // by negative PID. Without this, killing only the shell reparents the agent
    // tree to init, leaving an orphaned run that keeps mutating the workspace.
    #[cfg(unix)]
    cmd.process_group(0);
    cmd.spawn().map_err(AgentError::Spawn)
}

fn request_env_has_github_token(envs: &[(String, String)]) -> bool {
    envs.iter().any(|(key, value)| {
        GITHUB_TOKEN_ENV_VARS.contains(&key.as_str()) && !value.trim().is_empty()
    })
}

#[cfg(unix)]
async fn kill_pid(pid: Option<u32>) {
    let Some(pid) = pid else {
        return;
    };
    // The pid is the /bin/sh leader of the agent's process group (see
    // spawn_shell_command). A negative target signals the whole group, so the
    // agent CLI and every process it spawned receive the signal -- not just the
    // shell, whose children would otherwise be reparented to init and survive.
    let group = format!("-{pid}");
    let _ = Command::new("/bin/kill")
        .arg("-TERM")
        .arg(&group)
        .status()
        .await;
    // Give the group a moment to exit gracefully, then force-kill survivors
    // (e.g. an agent wedged in a tool call that ignores SIGTERM).
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = Command::new("/bin/kill")
        .arg("-KILL")
        .arg(&group)
        .status()
        .await;
}

#[cfg(not(unix))]
async fn kill_pid(pid: Option<u32>) {
    let Some(pid) = pid else {
        return;
    };
    let _ = Command::new("/bin/kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status()
        .await;
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn normalize_sandbox(thread: &ThreadSandbox, turn: &TurnSandboxPolicy) -> String {
    match turn {
        TurnSandboxPolicy::DangerFullAccess => "danger-full-access",
        TurnSandboxPolicy::WorkspaceWrite => "workspace-write",
        TurnSandboxPolicy::ReadOnly => "read-only",
        TurnSandboxPolicy::Inherit => match thread {
            ThreadSandbox::None | ThreadSandbox::ReadOnly => "read-only",
            ThreadSandbox::WorkspaceWrite => "workspace-write",
        },
    }
    .to_string()
}

fn permission_mode_arg(mode: &ClaudePermissionMode) -> &'static str {
    match mode {
        ClaudePermissionMode::Default => "default",
        ClaudePermissionMode::AcceptEdits => "acceptEdits",
        ClaudePermissionMode::Auto => "auto",
        ClaudePermissionMode::BypassPermissions => "bypassPermissions",
        ClaudePermissionMode::DontAsk => "dontAsk",
        ClaudePermissionMode::Plan => "plan",
    }
}

async fn send_status(events: &AgentEventSender, message: impl Into<String>) {
    let message = message.into();
    send_mapped(
        events,
        MappedAgentEvent {
            kind: AgentEventKind::Status,
            payload: json!({ "message": message }),
            humanized: Some(message),
            tokens: None,
            rate_limit: None,
            session_info: None,
        },
    )
    .await;
}

async fn send_error(
    events: &AgentEventSender,
    class: &str,
    message: &str,
) -> Result<(), AgentError> {
    send_mapped(
        events,
        MappedAgentEvent {
            kind: AgentEventKind::Error,
            payload: json!({ "class": class, "message": message, "recoverable": true }),
            humanized: Some(format!("Error ({class}): {message}")),
            tokens: None,
            rate_limit: None,
            session_info: None,
        },
    )
    .await;
    Ok(())
}

async fn send_token_count(
    events: &AgentEventSender,
    tokens: TokenCountPayload,
) -> Result<(), AgentError> {
    send_mapped(
        events,
        MappedAgentEvent {
            kind: AgentEventKind::TokenCount,
            payload: serde_json::to_value(&tokens)?,
            humanized: None,
            tokens: Some(tokens),
            rate_limit: None,
            session_info: None,
        },
    )
    .await;
    Ok(())
}

async fn send_rate_limit(
    events: &AgentEventSender,
    payload: RateLimitPayload,
) -> Result<(), AgentError> {
    send_mapped(
        events,
        MappedAgentEvent {
            kind: AgentEventKind::RateLimit,
            payload: serde_json::to_value(&payload)?,
            humanized: None,
            tokens: None,
            rate_limit: Some(payload),
            session_info: None,
        },
    )
    .await;
    Ok(())
}

async fn send_mapped(events: &AgentEventSender, event: MappedAgentEvent) {
    let _ = events.send(event).await;
}

fn extract_tool_result(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(ToOwned::to_owned)
                    .or_else(|| {
                        item.get("text")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                    })
                    .unwrap_or_else(|| item.to_string())
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => content.to_string(),
    }
}

fn truncate(value: &str, max: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        value.to_string()
    }
}

/// Path from a headless write-permission denial: "Claude requested
/// permissions to write to <path>, but you haven't granted it yet."
fn denied_write_path(raw: &str) -> Option<&str> {
    let rest = raw.split("requested permissions to write to ").nth(1)?;
    let path = rest
        .split(", but you haven't granted it yet")
        .next()?
        .trim();
    (!path.is_empty()).then_some(path)
}

/// Rate-limit hit in Claude's result, error, or assistant text. The CLI
/// emits limit notices as standalone messages, so every match is anchored to
/// the start of the text: a successful run whose final answer merely
/// discusses rate limits (docs, code touching this very feature) must not be
/// reclassified as a hit.
fn detect_claude_rate_limit(text: &str) -> Option<RateLimitPayload> {
    let lower = text.trim().to_lowercase();
    let hit = lower.starts_with("api error: 429")
        || (lower.starts_with("api error:") && lower.contains("rate_limit_error"))
        || lower.starts_with("claude ai usage limit reached")
        || lower.starts_with("claude usage limit reached")
        || lower.starts_with("you've reached your usage limit")
        || lower.starts_with("weekly limit reached")
        || hour_window_limit_notice(&lower);
    hit.then(|| RateLimitPayload {
        source: "claude".to_string(),
        remaining: None,
        reset_at: claude_limit_reset(text),
    })
}

/// The session-window notice leads with the window length:
/// "5-hour limit reached ∙ resets 3am".
fn hour_window_limit_notice(lower: &str) -> bool {
    lower
        .split_once("-hour limit reached")
        .is_some_and(|(window, _)| !window.is_empty() && window.chars().all(|c| c.is_ascii_digit()))
}

/// Reset timestamp from the usage-limit message's trailing epoch
/// ("Claude AI usage limit reached|1750000000"). Newer wordings only give a
/// fuzzy local time ("resets 3am"), which has no timezone to parse, so they
/// yield no reset and the worker falls back to normal retry backoff.
fn claude_limit_reset(text: &str) -> Option<String> {
    let epoch: i64 = text.rsplit('|').next()?.trim().parse().ok()?;
    let reset = chrono::DateTime::from_timestamp(epoch, 0)?;
    Some(reset.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn classify_api_error(text: &str) -> Option<&'static str> {
    if !text.starts_with("API Error:") {
        return None;
    }
    if text.contains("Overloaded") || text.starts_with("API Error: 5") {
        Some("api_overloaded")
    } else if text.contains("Output blocked by content filtering policy") {
        Some("content_filter")
    } else {
        Some("api_error")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn request_env_detects_github_tokens() {
        assert!(request_env_has_github_token(&[(
            "GITHUB_TOKEN".to_string(),
            "repo-scoped-session".to_string(),
        )]));
        assert!(!request_env_has_github_token(&[(
            "GITHUB_TOKEN".to_string(),
            " ".to_string(),
        )]));
        assert!(!request_env_has_github_token(&[(
            "OPENAI_API_KEY".to_string(),
            "sk-test".to_string(),
        )]));
    }

    fn codex_test_request(
        cwd: PathBuf,
        permission_mode: CodexPermissionMode,
        thread_sandbox: ThreadSandbox,
        turn_sandbox_policy: TurnSandboxPolicy,
        network_access: bool,
    ) -> AgentRunRequest {
        AgentRunRequest {
            backend: AgentBackend::Codex,
            command: "codex".to_string(),
            cwd,
            prompt: String::new(),
            codex_permission_mode: permission_mode,
            thread_sandbox,
            turn_sandbox_policy,
            network_access,
            turn_timeout_ms: 1_000,
            claude: ClaudeRunOptions::default(),
            cursor: CursorRunOptions::default(),
            opencode: OpencodeRunOptions::default(),
            env: Vec::new(),
        }
    }

    fn native_fixture_request(backend: AgentBackend) -> AgentRunRequest {
        AgentRunRequest {
            command: backend.as_source_str().to_string(),
            backend,
            cwd: PathBuf::from("/fixture/workspace"),
            prompt: "sanitized fixture prompt".to_string(),
            codex_permission_mode: CodexPermissionMode::ApproveForMe,
            thread_sandbox: ThreadSandbox::WorkspaceWrite,
            turn_sandbox_policy: TurnSandboxPolicy::Inherit,
            network_access: true,
            turn_timeout_ms: 1_000,
            claude: ClaudeRunOptions::default(),
            cursor: CursorRunOptions::default(),
            opencode: OpencodeRunOptions::default(),
            env: Vec::new(),
        }
    }

    fn strict_fixture_values(raw: &str) -> Result<Vec<Value>, AgentError> {
        raw.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(parse_strict_json_line)
            .collect()
    }

    fn drain_fixture_events(mut rx: mpsc::Receiver<MappedAgentEvent>) -> Vec<MappedAgentEvent> {
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        events
    }

    struct NativeFixtureObservation {
        backend: &'static str,
        result: AgentRunResult,
        events: Vec<MappedAgentEvent>,
    }

    #[test]
    fn native_backend_fixture_contracts_construct_commands_without_clis() {
        let codex = codex_args_with_git_metadata_dirs(
            &native_fixture_request(AgentBackend::Codex),
            vec![PathBuf::from("/fixture/git-metadata")],
        );
        assert_eq!(
            codex,
            [
                "exec",
                "--json",
                "--skip-git-repo-check",
                "-C",
                "/fixture/workspace",
                "-s",
                "workspace-write",
                "--add-dir",
                "/fixture/git-metadata",
                "-c",
                "sandbox_workspace_write.network_access=true",
                "-c",
                "approval_policy=on-request",
                "-c",
                "approvals_reviewer=auto_review",
            ]
            .map(str::to_string)
        );

        let mut claude_request = native_fixture_request(AgentBackend::Claude);
        claude_request.claude.allowed_tools = vec!["Read".to_string(), "Edit".to_string()];
        claude_request.claude.disallowed_tools = vec!["WebSearch".to_string()];
        claude_request.claude.add_dirs = vec!["/fixture/shared".to_string()];
        assert_eq!(
            claude_args(&claude_request, "fixture-claude-session"),
            [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--session-id",
                "fixture-claude-session",
                "--permission-mode",
                "acceptEdits",
                "--allowedTools",
                "Read,Edit",
                "--disallowedTools",
                "WebSearch",
                "--add-dir",
                "/fixture/workspace/.git",
                "--add-dir",
                "/fixture/shared",
            ]
            .map(str::to_string)
        );

        let mut cursor_request = native_fixture_request(AgentBackend::Cursor);
        cursor_request.cursor.mode = CursorAgentMode::Plan;
        cursor_request.cursor.force = true;
        cursor_request.cursor.trust = true;
        cursor_request.cursor.approve_mcps = true;
        cursor_request.cursor.sandbox = CursorSandboxMode::Disabled;
        cursor_request.cursor.model = Some(" fixture-cursor-model ".to_string());
        assert_eq!(
            cursor_args(&cursor_request),
            [
                "-p",
                "--output-format",
                "stream-json",
                "--workspace",
                "/fixture/workspace",
                "--force",
                "--trust",
                "--approve-mcps",
                "--mode",
                "plan",
                "--sandbox",
                "disabled",
                "--model",
                "fixture-cursor-model",
            ]
            .map(str::to_string)
        );

        let mut opencode_request = native_fixture_request(AgentBackend::Opencode);
        opencode_request.opencode.skip_permissions = true;
        opencode_request.opencode.model = Some(" fixture/model ".to_string());
        opencode_request.opencode.agent = Some(" fixture-reviewer ".to_string());
        assert_eq!(
            opencode_args(&opencode_request),
            [
                "run",
                "--dir",
                "/fixture/workspace",
                "--format",
                "json",
                "--dangerously-skip-permissions",
                "--model",
                "fixture/model",
                "--agent",
                "fixture-reviewer",
            ]
            .map(str::to_string)
        );
    }

    #[tokio::test]
    async fn native_backend_fixture_contracts_normalize_success_equivalently() {
        const CODEX: &str = include_str!("../tests/fixtures/native/codex/success.jsonl");
        const CLAUDE: &str = include_str!("../tests/fixtures/native/claude/success.jsonl");
        const CURSOR: &str = include_str!("../tests/fixtures/native/cursor/success.jsonl");
        const OPENCODE: &str = include_str!("../tests/fixtures/native/opencode/success.jsonl");

        let mut observations = Vec::new();

        let (tx, rx) = mpsc::channel(64);
        let mut result = None;
        for value in strict_fixture_values(CODEX).unwrap() {
            result = map_codex_event("fixture-codex-thread", "fixture-codex-turn", value, &tx)
                .await
                .unwrap()
                .or(result);
        }
        drop(tx);
        observations.push(NativeFixtureObservation {
            backend: "codex",
            result: result.expect("codex fixture terminal result"),
            events: drain_fixture_events(rx),
        });

        let (tx, rx) = mpsc::channel(64);
        let mut stream = ClaudeStreamState::new(
            "fixture-claude-session".to_string(),
            &ClaudePermissionMode::AcceptEdits,
            PathBuf::from("/fixture/workspace"),
        );
        let mut result = None;
        for value in strict_fixture_values(CLAUDE).unwrap() {
            result = stream.push(value, &tx).await.unwrap().or(result);
        }
        drop(tx);
        observations.push(NativeFixtureObservation {
            backend: "claude",
            result: result.expect("claude fixture terminal result"),
            events: drain_fixture_events(rx),
        });

        let (tx, rx) = mpsc::channel(64);
        let mut stream = CursorStreamState::new("fixture-cursor-session".to_string());
        let mut result = None;
        for value in strict_fixture_values(CURSOR).unwrap() {
            result = stream.push(value, &tx).await.unwrap().or(result);
        }
        drop(tx);
        observations.push(NativeFixtureObservation {
            backend: "cursor",
            result: result.expect("cursor fixture terminal result"),
            events: drain_fixture_events(rx),
        });

        let (tx, rx) = mpsc::channel(64);
        let mut stream = OpencodeStreamState::new("fixture-opencode-session".to_string());
        for line in OPENCODE
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            let OpencodeStdoutLine::Event(value) = parse_opencode_stdout_line(line) else {
                panic!("opencode success fixture must contain only JSON events");
            };
            stream.push(value, &tx).await.unwrap();
        }
        stream.finish(&tx).await.unwrap();
        let result = opencode_process_result(&stream, true, None);
        drop(tx);
        observations.push(NativeFixtureObservation {
            backend: "opencode",
            result,
            events: drain_fixture_events(rx),
        });

        for observation in &observations {
            assert_eq!(
                observation.result.outcome,
                AgentOutcome::Success,
                "{} outcome",
                observation.backend
            );
            assert_eq!(observation.result.error_class, None);
            assert!(
                observation
                    .events
                    .iter()
                    .any(|event| event.kind == AgentEventKind::Status),
                "{} status",
                observation.backend
            );
            assert!(
                observation
                    .events
                    .iter()
                    .any(|event| event.kind == AgentEventKind::ToolCall),
                "{} tool call",
                observation.backend
            );
            let token_events = observation
                .events
                .iter()
                .filter(|event| event.kind == AgentEventKind::TokenCount)
                .collect::<Vec<_>>();
            assert_eq!(
                token_events.len(),
                1,
                "{} token event count",
                observation.backend
            );
            assert_eq!(
                token_events[0].tokens,
                Some(TokenCountPayload {
                    input_tokens: 7,
                    output_tokens: 3,
                    total_tokens: 10,
                }),
                "{} normalized token totals",
                observation.backend
            );
        }

        for observation in &observations {
            let carries_session_info = observation
                .events
                .iter()
                .any(|event| event.session_info.is_some());
            assert_eq!(
                carries_session_info,
                matches!(observation.backend, "claude" | "cursor"),
                "{} intentional session metadata difference",
                observation.backend
            );
            let tool_event = observation
                .events
                .iter()
                .find(|event| event.kind == AgentEventKind::ToolCall)
                .expect("fixture tool event");
            let tool: ToolCallPayload = serde_json::from_value(tool_event.payload.clone()).unwrap();
            let expected_tool = match observation.backend {
                "codex" => "bash",
                "claude" => "Read",
                "cursor" => "read",
                "opencode" => "edit",
                _ => unreachable!(),
            };
            assert_eq!(tool.tool, expected_tool);
        }
    }

    #[tokio::test]
    async fn native_backend_fixture_contracts_classify_sanitized_failures() {
        const CODEX: &str = include_str!("../tests/fixtures/native/codex/failure.jsonl");
        const CLAUDE: &str = include_str!("../tests/fixtures/native/claude/failure.jsonl");
        const CURSOR: &str = include_str!("../tests/fixtures/native/cursor/failure.jsonl");
        const OPENCODE: &str = include_str!("../tests/fixtures/native/opencode/failure.jsonl");

        let (tx, _rx) = mpsc::channel(16);
        let codex = map_codex_event(
            "fixture-codex-thread",
            "fixture-codex-turn",
            strict_fixture_values(CODEX).unwrap().remove(0),
            &tx,
        )
        .await
        .unwrap()
        .expect("codex failure");

        let mut claude_stream = ClaudeStreamState::new(
            "fixture-claude-session".to_string(),
            &ClaudePermissionMode::AcceptEdits,
            PathBuf::from("/fixture/workspace"),
        );
        let claude = claude_stream
            .push(strict_fixture_values(CLAUDE).unwrap().remove(0), &tx)
            .await
            .unwrap()
            .expect("claude failure");

        let mut cursor_stream = CursorStreamState::new("fixture-cursor-session".to_string());
        let cursor = cursor_stream
            .push(strict_fixture_values(CURSOR).unwrap().remove(0), &tx)
            .await
            .unwrap()
            .expect("cursor failure");

        let mut opencode_stream = OpencodeStreamState::new("fixture-opencode-session".to_string());
        let opencode = opencode_stream
            .push(strict_fixture_values(OPENCODE).unwrap().remove(0), &tx)
            .await
            .unwrap()
            .expect("opencode failure");

        for (backend, result, expected_class) in [
            ("codex", codex, "fixture_failure"),
            ("claude", claude, "error_during_execution"),
            ("cursor", cursor, "error"),
            ("opencode", opencode, "FixtureProviderError"),
        ] {
            assert_eq!(result.outcome, AgentOutcome::Failure, "{backend} outcome");
            assert_eq!(
                result.error_class.as_deref(),
                Some(expected_class),
                "{backend} class"
            );
            assert_eq!(
                result.error_message.as_deref(),
                Some("sanitized fixture backend failure"),
                "{backend} message"
            );
        }
    }

    #[test]
    fn native_backend_fixture_contracts_fail_closed_or_tolerate_partial_streams() {
        for (backend, raw) in [
            (
                "codex",
                include_str!("../tests/fixtures/native/codex/malformed.jsonl"),
            ),
            (
                "claude",
                include_str!("../tests/fixtures/native/claude/malformed.jsonl"),
            ),
            (
                "cursor",
                include_str!("../tests/fixtures/native/cursor/malformed.jsonl"),
            ),
        ] {
            let error = parse_strict_json_line(raw.trim()).unwrap_err();
            assert!(
                matches!(error, AgentError::Json(_)),
                "{backend} must reject malformed JSON"
            );
        }

        let partial = include_str!("../tests/fixtures/native/opencode/partial.txt").trim();
        assert_eq!(
            parse_opencode_stdout_line(partial),
            OpencodeStdoutLine::Ignored,
            "opencode intentionally tolerates non-JSON partial output"
        );

        let fallback = include_str!("../tests/fixtures/native/opencode/fallback.txt").trim();
        let OpencodeStdoutLine::AgentFallback(message) = parse_opencode_stdout_line(fallback)
        else {
            panic!("opencode fallback must not be ignored");
        };
        let stream = OpencodeStreamState::new("fixture-opencode-session".to_string());
        let result = opencode_agent_fallback_result(&stream, &message);
        assert_eq!(result.outcome, AgentOutcome::Failure);
        assert_eq!(result.error_class.as_deref(), Some("agent_not_found"));
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let output = StdCommand::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {} failed\nstdout:\n{}\nstderr:\n{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_path_stdout(cwd: &Path, args: &[&str]) -> PathBuf {
        let output = StdCommand::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {} failed\nstdout:\n{}\nstderr:\n{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let path = PathBuf::from(raw);
        if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        }
    }

    #[test]
    fn codex_workspace_write_args_allow_git_metadata_writes() {
        let cwd = PathBuf::from("/tmp/symphony/OP-272");
        let git_dir = PathBuf::from("/tmp/symphony/.git/worktrees/OP-272");
        let common_dir = PathBuf::from("/tmp/symphony/.git");
        let args = codex_args_with_git_metadata_dirs(
            &codex_test_request(
                cwd,
                CodexPermissionMode::ApproveForMe,
                ThreadSandbox::WorkspaceWrite,
                TurnSandboxPolicy::Inherit,
                true,
            ),
            vec![git_dir.clone(), common_dir.clone()],
        );
        let git_dir = git_dir.display().to_string();
        let common_dir = common_dir.display().to_string();

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-s" && pair[1] == "workspace-write"));
        assert!(!args.iter().any(|arg| arg == "--full-auto"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--add-dir" && pair[1] == git_dir));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--add-dir" && pair[1] == common_dir));
        assert!(args.windows(2).any(
            |pair| pair[0] == "-c" && pair[1] == "sandbox_workspace_write.network_access=true"
        ));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-c" && pair[1] == "approval_policy=on-request"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-c" && pair[1] == "approvals_reviewer=auto_review"));
    }

    #[test]
    fn codex_read_only_args_do_not_allow_git_metadata_writes() {
        let cwd = PathBuf::from("/tmp/symphony/OP-272");
        let git_dir = PathBuf::from("/tmp/symphony/.git/worktrees/OP-272");
        let args = codex_args_with_git_metadata_dirs(
            &codex_test_request(
                cwd,
                CodexPermissionMode::ApproveForMe,
                ThreadSandbox::WorkspaceWrite,
                TurnSandboxPolicy::ReadOnly,
                true,
            ),
            vec![git_dir.clone()],
        );
        let git_dir = git_dir.display().to_string();

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-s" && pair[1] == "read-only"));
        assert!(!args
            .windows(2)
            .any(|pair| pair[0] == "--add-dir" && pair[1] == git_dir));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-c" && pair[1] == "approvals_reviewer=auto_review"));
    }

    #[test]
    fn codex_danger_full_access_args_do_not_need_git_add_dir() {
        let cwd = PathBuf::from("/tmp/symphony/OP-272");
        let git_dir = PathBuf::from("/tmp/symphony/.git/worktrees/OP-272");
        let args = codex_args_with_git_metadata_dirs(
            &codex_test_request(
                cwd,
                CodexPermissionMode::ApproveForMe,
                ThreadSandbox::WorkspaceWrite,
                TurnSandboxPolicy::DangerFullAccess,
                true,
            ),
            vec![git_dir.clone()],
        );
        let git_dir = git_dir.display().to_string();

        assert!(args
            .iter()
            .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox"));
        assert!(!args
            .windows(2)
            .any(|pair| pair[0] == "--add-dir" && pair[1] == git_dir));
    }

    #[test]
    fn codex_full_access_permission_mode_bypasses_the_sandbox() {
        let args = codex_args_with_git_metadata_dirs(
            &codex_test_request(
                PathBuf::from("/tmp/symphony/OP-272"),
                CodexPermissionMode::FullAccess,
                ThreadSandbox::WorkspaceWrite,
                TurnSandboxPolicy::Inherit,
                true,
            ),
            vec![PathBuf::from("/tmp/symphony/.git/worktrees/OP-272")],
        );

        assert!(args
            .iter()
            .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox"));
        assert!(!args.iter().any(|arg| arg == "--add-dir"));
        assert!(!args.iter().any(|arg| arg == "approval_policy=on-request"));
    }

    #[test]
    fn git_metadata_dirs_resolves_linked_worktree_dirs() {
        let root = std::env::temp_dir().join(format!("symphony-agents-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        let worktree = root.join("worktree");
        std::fs::create_dir_all(&repo).expect("create temp repo");

        run_git(&repo, &["init"]);
        std::fs::write(repo.join("README.md"), "hello\n").expect("write readme");
        run_git(&repo, &["add", "README.md"]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Symphony Test",
                "-c",
                "user.email=symphony@example.com",
                "commit",
                "-m",
                "initial",
            ],
        );
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "--detach",
                worktree.to_str().unwrap(),
                "HEAD",
            ],
        );

        let dirs = git_metadata_dirs(&worktree);
        let git_dir = normalize_path(git_path_stdout(&worktree, &["rev-parse", "--git-dir"]));
        let common_dir = normalize_path(git_path_stdout(
            &worktree,
            &["rev-parse", "--git-common-dir"],
        ));

        assert!(dirs.contains(&git_dir), "missing git dir: {dirs:?}");
        assert!(dirs.contains(&common_dir), "missing common dir: {dirs:?}");
        assert_ne!(git_dir, worktree.join(".git"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn git_metadata_dirs_does_not_walk_above_workspace() {
        let root = std::env::temp_dir().join(format!("symphony-agents-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        let child_workspace = repo.join("child-workspace");
        std::fs::create_dir_all(&child_workspace).expect("create child workspace");

        run_git(&repo, &["init"]);

        let dirs = git_metadata_dirs(&child_workspace);

        assert!(
            dirs.is_empty(),
            "child workspace should not inherit parent repo metadata dirs: {dirs:?}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn captures_session_info_from_init_and_result() {
        let (tx, mut rx) = mpsc::channel(16);
        let mut stream = ClaudeStreamState::new(
            "sess-1".to_string(),
            &ClaudePermissionMode::AcceptEdits,
            PathBuf::from("/tmp/ws"),
        );
        stream
            .push(
                json!({
                    "type": "system",
                    "subtype": "init",
                    "session_id": "sess-1",
                    "model": "claude-opus-4-8",
                    "permissionMode": "acceptEdits",
                    "claude_code_version": "2.1.172",
                    "output_style": "default",
                    "fast_mode_state": "off"
                }),
                &tx,
            )
            .await
            .unwrap();
        let started = rx.recv().await.unwrap();
        let info = started.session_info.expect("init carries session info");
        assert_eq!(info.model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(info.permission_mode.as_deref(), Some("acceptEdits"));
        assert_eq!(info.agent_version.as_deref(), Some("2.1.172"));
        assert_eq!(info.thinking_tokens, None);

        stream
            .push(
                json!({ "type": "system", "subtype": "thinking_tokens", "estimated_tokens": 42 }),
                &tx,
            )
            .await
            .unwrap();
        // Thinking updates emit a metadata-only event right away, so the
        // estimate survives runs that never reach a usage-bearing result.
        let thinking = rx.recv().await.unwrap();
        assert!(thinking.payload.is_null());
        assert_eq!(
            thinking.session_info.and_then(|info| info.thinking_tokens),
            Some(42)
        );
        let result = stream
            .push(
                json!({
                    "type": "result",
                    "subtype": "success",
                    "usage": { "input_tokens": 10, "output_tokens": 5 }
                }),
                &tx,
            )
            .await
            .unwrap()
            .expect("result event finishes the run");
        assert!(matches!(result.outcome, AgentOutcome::Success));
        let tokens_event = rx.recv().await.unwrap();
        assert_eq!(
            tokens_event
                .session_info
                .and_then(|info| info.thinking_tokens),
            Some(42)
        );
    }

    #[test]
    fn classifies_claude_api_errors() {
        assert_eq!(
            classify_api_error("API Error: 529 Overloaded"),
            Some("api_overloaded")
        );
        assert_eq!(classify_api_error("hello"), None);
    }

    #[test]
    fn truncates_on_char_boundaries() {
        let value = format!("{}étail", "a".repeat(999));

        assert_eq!(truncate(&value, 1000), format!("{}é...", "a".repeat(999)));
        assert_eq!(truncate("shorté", 1000), "shorté");
    }

    #[tokio::test]
    async fn codex_command_execution_started_uses_the_actual_command() {
        let (tx, mut rx) = mpsc::channel(16);
        let event = json!({
            "type": "item.started",
            "item": {
                "type": "command_execution",
                "id": "cmd-1",
                "command": "/bin/zsh -lc 'gh auth token'"
            }
        });

        assert!(map_codex_event("th-1", "tn-1", event, &tx)
            .await
            .unwrap()
            .is_none());
        let mapped = rx.recv().await.unwrap();
        assert!(matches!(mapped.kind, AgentEventKind::ToolCall));
        assert_eq!(
            mapped.humanized.as_deref(),
            Some("bash: /bin/zsh -lc 'gh auth token'")
        );
    }

    #[tokio::test]
    async fn codex_completed_agent_message_uses_the_message_text() {
        let (tx, mut rx) = mpsc::channel(16);
        let event = json!({
            "type": "item.completed",
            "item": {
                "type": "agent_message",
                "text": "Let's verify the images render correctly."
            }
        });

        assert!(map_codex_event("th-1", "tn-1", event, &tx)
            .await
            .unwrap()
            .is_none());
        let mapped = rx.recv().await.unwrap();
        assert!(matches!(mapped.kind, AgentEventKind::Status));
        assert_eq!(
            mapped.humanized.as_deref(),
            Some("Let's verify the images render correctly.")
        );
    }

    #[tokio::test]
    async fn codex_completed_user_message_uses_generic_label() {
        let (tx, mut rx) = mpsc::channel(16);
        let event = json!({
            "type": "item.completed",
            "item": {
                "type": "user_message",
                "text": "Prompt text that should not be persisted."
            }
        });

        assert!(map_codex_event("th-1", "tn-1", event, &tx)
            .await
            .unwrap()
            .is_none());
        let mapped = rx.recv().await.unwrap();
        assert!(matches!(mapped.kind, AgentEventKind::Status));
        assert_eq!(mapped.humanized.as_deref(), Some("user_message completed"));
    }

    #[tokio::test]
    async fn codex_completed_item_summary_is_truncated() {
        let (tx, mut rx) = mpsc::channel(16);
        let event = json!({
            "type": "item.completed",
            "item": {
                "type": "agent_message",
                "text": format!("{}tail", "a".repeat(2000))
            }
        });

        assert!(map_codex_event("th-1", "tn-1", event, &tx)
            .await
            .unwrap()
            .is_none());
        let mapped = rx.recv().await.unwrap();
        assert!(matches!(mapped.kind, AgentEventKind::Status));
        let expected = format!("{}...", "a".repeat(2000));
        assert_eq!(mapped.humanized.as_deref(), Some(expected.as_str()));
    }

    #[tokio::test]
    async fn codex_turn_completed_uses_total_tokens_without_double_counting_cache() {
        let (tx, mut rx) = mpsc::channel(16);
        let done = map_codex_event(
            "th-1",
            "tn-1",
            json!({
                "type": "turn.completed",
                "usage": {
                    "input_tokens": 24763,
                    "cached_input_tokens": 24448,
                    "output_tokens": 122,
                    "reasoning_output_tokens": 40
                }
            }),
            &tx,
        )
        .await
        .unwrap()
        .expect("turn.completed finishes run");
        assert!(matches!(done.outcome, AgentOutcome::Success));
        let tokens = rx.recv().await.expect("token count event");
        assert!(matches!(tokens.kind, AgentEventKind::TokenCount));
        // cached_input_tokens / reasoning_output_tokens are subsets — do not
        // add them (Claude/Cursor/opencode cache buckets are additive).
        assert_eq!(tokens.tokens.as_ref().map(|t| t.input_tokens), Some(24763));
        assert_eq!(tokens.tokens.as_ref().map(|t| t.output_tokens), Some(122));
        assert_eq!(tokens.tokens.as_ref().map(|t| t.total_tokens), Some(24885));
    }

    #[test]
    fn detects_claude_rate_limit_hits() {
        let legacy = detect_claude_rate_limit("Claude AI usage limit reached|1750000000")
            .expect("legacy usage-limit message");
        assert_eq!(legacy.source, "claude");
        assert_eq!(legacy.reset_at.as_deref(), Some("2025-06-15T15:06:40.000Z"));

        let api = detect_claude_rate_limit(
            r#"API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}"#,
        )
        .expect("429 error");
        assert_eq!(api.reset_at, None);

        let worded = detect_claude_rate_limit("5-hour limit reached ∙ resets 3am")
            .expect("wordy usage-limit message");
        assert_eq!(worded.reset_at, None);

        assert!(detect_claude_rate_limit("All tests passing").is_none());
        // A successful run that merely talks about limits is not a hit.
        assert!(detect_claude_rate_limit(
            "I improved how the usage limit reached message is detected"
        )
        .is_none());
        assert!(detect_claude_rate_limit(
            "The mapper now classifies rate_limit_error responses as retryable"
        )
        .is_none());
        assert!(detect_claude_rate_limit("After the 5-hour limit reached us we paused").is_none());
    }

    #[tokio::test]
    async fn records_rate_limit_hit_from_result_error_field() {
        let (tx, mut rx) = mpsc::channel(16);
        let mut stream = ClaudeStreamState::new(
            "sess-rl-err".to_string(),
            &ClaudePermissionMode::AcceptEdits,
            PathBuf::from("/tmp/ws"),
        );
        let result = stream
            .push(
                json!({
                    "type": "result",
                    "subtype": "error_during_execution",
                    "error": "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
                    "usage": {}
                }),
                &tx,
            )
            .await
            .unwrap()
            .expect("result event finishes the run");
        assert!(matches!(result.outcome, AgentOutcome::Failure));
        assert_eq!(result.error_class.as_deref(), Some("rate_limited"));
        let event = rx.recv().await.unwrap();
        assert_eq!(event.rate_limit.expect("payload").source, "claude");
    }

    #[tokio::test]
    async fn records_rate_limit_hit_from_result_text() {
        let (tx, mut rx) = mpsc::channel(16);
        let mut stream = ClaudeStreamState::new(
            "sess-rl".to_string(),
            &ClaudePermissionMode::AcceptEdits,
            PathBuf::from("/tmp/ws"),
        );
        let result = stream
            .push(
                json!({
                    "type": "result",
                    "subtype": "success",
                    "result": "Claude AI usage limit reached|1750000000",
                    "usage": {}
                }),
                &tx,
            )
            .await
            .unwrap()
            .expect("result event finishes the run");
        assert!(matches!(result.outcome, AgentOutcome::Failure));
        assert_eq!(result.error_class.as_deref(), Some("rate_limited"));

        let event = rx.recv().await.unwrap();
        assert!(matches!(event.kind, AgentEventKind::RateLimit));
        let limit = event.rate_limit.expect("rate-limit payload");
        assert_eq!(limit.source, "claude");
        assert_eq!(limit.reset_at.as_deref(), Some("2025-06-15T15:06:40.000Z"));
    }

    #[test]
    fn parses_denied_write_paths() {
        assert_eq!(
            denied_write_path(
                "Claude requested permissions to write to /ws/src/lib/site-config.ts, but you haven't granted it yet."
            ),
            Some("/ws/src/lib/site-config.ts")
        );
        assert_eq!(
            denied_write_path(
                "Claude requested permissions to use mcp__linear-server__save_comment, but you haven't granted it yet."
            ),
            None
        );
        assert_eq!(denied_write_path("Permission denied"), None);
    }

    fn claude_stream(mode: ClaudePermissionMode) -> (ClaudeStreamState, AgentEventSender) {
        let (tx, mut rx) = mpsc::channel(64);
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        (
            ClaudeStreamState::new("sess".to_string(), &mode, PathBuf::from("/ws")),
            tx,
        )
    }

    fn init_event(mode: &str) -> Value {
        json!({ "type": "system", "subtype": "init", "session_id": "sess", "permissionMode": mode })
    }

    /// Init from a CLI that doesn't report the effective permission mode, so
    /// the session stays unverified and the write-denial net stays armed.
    fn init_event_without_mode() -> Value {
        json!({ "type": "system", "subtype": "init", "session_id": "sess" })
    }

    fn denied_write_events(path: &str) -> [Value; 2] {
        [
            json!({ "type": "assistant", "message": { "content": [
                { "type": "tool_use", "id": "t1", "name": "Edit", "input": {} }
            ] } }),
            json!({ "type": "user", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t1", "is_error": true,
                  "content": format!("Claude requested permissions to write to {path}, but you haven't granted it yet.") }
            ] } }),
        ]
    }

    fn success_result_event() -> Value {
        json!({ "type": "result", "subtype": "success", "usage": {} })
    }

    #[tokio::test]
    async fn fails_fast_when_claude_drops_the_permission_mode() {
        let (mut stream, tx) = claude_stream(ClaudePermissionMode::Auto);
        let done = stream.push(init_event("default"), &tx).await.unwrap();
        let result = done.expect("init mode mismatch should end the run");
        assert!(matches!(result.outcome, AgentOutcome::Failure));
        assert_eq!(
            result.error_class.as_deref(),
            Some("permission_mode_dropped")
        );
        assert!(stream.abort);
    }

    #[tokio::test]
    async fn accepts_matching_or_absent_init_permission_mode() {
        let (mut stream, tx) = claude_stream(ClaudePermissionMode::Auto);
        assert!(stream
            .push(init_event("auto"), &tx)
            .await
            .unwrap()
            .is_none());
        let no_mode = json!({ "type": "system", "subtype": "init", "session_id": "sess" });
        assert!(stream.push(no_mode, &tx).await.unwrap().is_none());
        assert!(!stream.abort);
    }

    #[tokio::test]
    async fn denied_workspace_write_fails_an_unverified_run() {
        let (mut stream, tx) = claude_stream(ClaudePermissionMode::Auto);
        stream.push(init_event_without_mode(), &tx).await.unwrap();
        for ev in denied_write_events("/ws/src/lib/site-config.ts") {
            stream.push(ev, &tx).await.unwrap();
        }
        let done = stream.push(success_result_event(), &tx).await.unwrap();
        let result = done.expect("result event should end the run");
        assert!(matches!(result.outcome, AgentOutcome::Failure));
        assert_eq!(
            result.error_class.as_deref(),
            Some("write_permission_denied")
        );
        assert!(result
            .error_message
            .unwrap()
            .contains("/ws/src/lib/site-config.ts"));
    }

    #[tokio::test]
    async fn denials_alongside_successful_writes_are_policy() {
        // Even when init doesn't report the mode, a session that completed
        // any write was honoring it; the denial was an ask/deny rule or a
        // protected file, not the dropped-mode bug.
        let (mut stream, tx) = claude_stream(ClaudePermissionMode::Auto);
        stream.push(init_event_without_mode(), &tx).await.unwrap();
        for ev in denied_write_events("/ws/.npmrc") {
            stream.push(ev, &tx).await.unwrap();
        }
        let successful_write = [
            json!({ "type": "assistant", "message": { "content": [
                { "type": "tool_use", "id": "t2", "name": "Write", "input": {} }
            ] } }),
            json!({ "type": "user", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t2", "is_error": false,
                  "content": "File created successfully at: /ws/src/app.ts" }
            ] } }),
        ];
        for ev in successful_write {
            stream.push(ev, &tx).await.unwrap();
        }
        let done = stream.push(success_result_event(), &tx).await.unwrap();
        assert!(matches!(done.unwrap().outcome, AgentOutcome::Success));
    }

    #[tokio::test]
    async fn confirmed_mode_treats_denials_as_policy() {
        // Repo ask/deny rules and protected build-tool files legitimately
        // deny workspace writes even when the session mode is correct.
        let (mut stream, tx) = claude_stream(ClaudePermissionMode::Auto);
        stream.push(init_event("auto"), &tx).await.unwrap();
        for ev in denied_write_events("/ws/.npmrc") {
            stream.push(ev, &tx).await.unwrap();
        }
        let done = stream.push(success_result_event(), &tx).await.unwrap();
        assert!(matches!(done.unwrap().outcome, AgentOutcome::Success));
    }

    #[tokio::test]
    async fn denials_outside_the_workspace_do_not_fail_the_run() {
        let (mut stream, tx) = claude_stream(ClaudePermissionMode::Auto);
        stream.push(init_event_without_mode(), &tx).await.unwrap();
        for ev in denied_write_events("/etc/hosts") {
            stream.push(ev, &tx).await.unwrap();
        }
        let done = stream.push(success_result_event(), &tx).await.unwrap();
        assert!(matches!(done.unwrap().outcome, AgentOutcome::Success));
    }

    #[tokio::test]
    async fn tool_use_denials_do_not_fail_the_run() {
        let (mut stream, tx) = claude_stream(ClaudePermissionMode::Auto);
        stream.push(init_event_without_mode(), &tx).await.unwrap();
        let events = [
            json!({ "type": "assistant", "message": { "content": [
                { "type": "tool_use", "id": "t1", "name": "mcp__linear-server__save_comment", "input": {} }
            ] } }),
            json!({ "type": "user", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t1", "is_error": true,
                  "content": "Claude requested permissions to use mcp__linear-server__save_comment, but you haven't granted it yet." }
            ] } }),
        ];
        for ev in events {
            stream.push(ev, &tx).await.unwrap();
        }
        let done = stream.push(success_result_event(), &tx).await.unwrap();
        assert!(matches!(done.unwrap().outcome, AgentOutcome::Success));
    }

    #[tokio::test]
    async fn default_mode_write_denials_are_expected() {
        let (mut stream, tx) = claude_stream(ClaudePermissionMode::Default);
        stream.push(init_event_without_mode(), &tx).await.unwrap();
        for ev in denied_write_events("/ws/src/lib/site-config.ts") {
            stream.push(ev, &tx).await.unwrap();
        }
        let done = stream.push(success_result_event(), &tx).await.unwrap();
        assert!(matches!(done.unwrap().outcome, AgentOutcome::Success));
    }

    fn cursor_stream() -> (
        CursorStreamState,
        mpsc::Sender<MappedAgentEvent>,
        mpsc::Receiver<MappedAgentEvent>,
    ) {
        let (tx, rx) = mpsc::channel(64);
        (CursorStreamState::new("sess-cursor".to_string()), tx, rx)
    }

    #[tokio::test]
    async fn cursor_init_maps_session_info() {
        let (mut stream, tx, mut rx) = cursor_stream();
        assert!(stream
            .push(
                json!({
                    "type": "system",
                    "subtype": "init",
                    "session_id": "abc-123",
                    "model": "Composer 2.5",
                    "permissionMode": "default"
                }),
                &tx,
            )
            .await
            .unwrap()
            .is_none());
        let event = rx.recv().await.expect("init status event");
        let info = event.session_info.expect("session info");
        assert_eq!(info.model.as_deref(), Some("Composer 2.5"));
        assert_eq!(info.permission_mode.as_deref(), Some("default"));
    }

    #[tokio::test]
    async fn cursor_tool_call_started_and_completed() {
        let (mut stream, tx, mut rx) = cursor_stream();
        stream
            .push(
                json!({
                    "type": "tool_call",
                    "subtype": "started",
                    "call_id": "c1",
                    "tool_call": { "readToolCall": { "args": { "path": "README.md" } } }
                }),
                &tx,
            )
            .await
            .unwrap();
        let started = rx.recv().await.expect("tool started");
        assert!(matches!(started.kind, AgentEventKind::ToolCall));
        stream
            .push(
                json!({
                    "type": "tool_call",
                    "subtype": "completed",
                    "call_id": "c1",
                    "tool_call": { "readToolCall": {
                        "args": { "path": "README.md" },
                        "result": { "success": { "content": "hello" } }
                    } }
                }),
                &tx,
            )
            .await
            .unwrap();
        let completed = rx.recv().await.expect("tool completed");
        assert!(matches!(completed.kind, AgentEventKind::ToolCall));
    }

    #[tokio::test]
    async fn cursor_success_result_emits_token_count() {
        let (mut stream, tx, mut rx) = cursor_stream();
        let done = stream
            .push(
                json!({
                    "type": "result",
                    "subtype": "success",
                    "is_error": false,
                    "result": "All done",
                    "usage": {
                        "inputTokens": 120,
                        "outputTokens": 45,
                        "cacheReadTokens": 800,
                        "cacheWriteTokens": 40
                    }
                }),
                &tx,
            )
            .await
            .unwrap()
            .expect("result finishes run");
        assert!(matches!(done.outcome, AgentOutcome::Success));
        let tokens = rx.recv().await.expect("token count event");
        assert!(matches!(tokens.kind, AgentEventKind::TokenCount));
        assert_eq!(tokens.tokens.as_ref().map(|t| t.input_tokens), Some(960));
        assert_eq!(tokens.tokens.as_ref().map(|t| t.output_tokens), Some(45));
        assert_eq!(tokens.tokens.as_ref().map(|t| t.total_tokens), Some(1005));
    }

    #[tokio::test]
    async fn cursor_success_result_ends_run() {
        let (mut stream, tx, _rx) = cursor_stream();
        let done = stream
            .push(
                json!({
                    "type": "result",
                    "subtype": "success",
                    "is_error": false,
                    "result": "All done"
                }),
                &tx,
            )
            .await
            .unwrap()
            .expect("result finishes run");
        assert!(matches!(done.outcome, AgentOutcome::Success));
    }

    #[test]
    fn detects_cursor_rate_limit_hits() {
        assert!(detect_cursor_rate_limit("API Error: 429 too many requests").is_some());
        assert!(detect_cursor_rate_limit("Your usage limit reached for today").is_some());
        assert!(detect_cursor_rate_limit("All tests passing").is_none());
        assert!(
            detect_cursor_rate_limit("Updated the rate limit docs and tests; all passing.")
                .is_none()
        );
    }

    #[test]
    fn detects_codex_rate_limit_hits() {
        let hit = detect_codex_rate_limit(
            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 25th, 2026 12:03 PM.",
        )
        .expect("usage-limit message");
        assert_eq!(hit.source, "codex");
        assert!(hit.reset_at.is_some(), "parsed try-again timestamp");

        let naive = parse_codex_reset_naive(
            "You've hit your usage limit. try again at Jul 25th, 2026 12:03 PM.",
        )
        .expect("naive reset");
        assert_eq!(
            naive,
            chrono::NaiveDate::from_ymd_opt(2026, 7, 25)
                .unwrap()
                .and_hms_opt(12, 3, 0)
                .unwrap()
        );

        assert!(detect_codex_rate_limit("You've reached your usage limit.").is_some());
        assert!(detect_codex_rate_limit("Rate limit exceeded for this model").is_some());
        assert!(detect_codex_rate_limit("All tests passing").is_none());
        assert!(detect_codex_rate_limit(
            "I documented how you've hit your usage limit messages are detected"
        )
        .is_none());
        assert_eq!(
            detect_codex_rate_limit("You've hit your usage limit.")
                .expect("hit without reset")
                .reset_at,
            None
        );
    }

    #[tokio::test]
    async fn records_codex_rate_limit_hit_from_turn_failed() {
        let (tx, mut rx) = mpsc::channel(16);
        let result = map_codex_event(
            "th-1",
            "tn-1",
            json!({
                "type": "turn.failed",
                "error": {
                    "type": "usage_limit_exceeded",
                    "message": "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 25th, 2026 12:03 PM."
                }
            }),
            &tx,
        )
        .await
        .unwrap()
        .expect("turn.failed finishes the run");
        assert!(matches!(result.outcome, AgentOutcome::Failure));
        assert_eq!(result.error_class.as_deref(), Some("rate_limited"));

        let event = rx.recv().await.unwrap();
        assert!(matches!(event.kind, AgentEventKind::RateLimit));
        let limit = event.rate_limit.expect("rate-limit payload");
        assert_eq!(limit.source, "codex");
        assert!(limit.reset_at.is_some());
    }

    #[tokio::test]
    async fn codex_turn_failed_without_usage_limit_stays_generic() {
        let (tx, mut rx) = mpsc::channel(16);
        let result = map_codex_event(
            "th-1",
            "tn-1",
            json!({
                "type": "turn.failed",
                "error": {
                    "type": "turn_failed",
                    "message": "model overloaded"
                }
            }),
            &tx,
        )
        .await
        .unwrap()
        .expect("turn.failed finishes the run");
        assert!(matches!(result.outcome, AgentOutcome::Failure));
        assert_eq!(result.error_class.as_deref(), Some("turn_failed"));
        assert!(rx.try_recv().is_err(), "no rate-limit event");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_pid_terminates_whole_process_group() {
        if std::env::var_os("GITHUB_ACTIONS").is_some() {
            eprintln!(
                "skipping process-group signal test on GitHub Actions; Ubuntu hosted runners wedge this integration test"
            );
            return;
        }

        // A shell leader that ignores TERM and backgrounds a stubborn child
        // that also ignores TERM -- modelling a wedged agent whose subprocess
        // tree would otherwise be reparented to init when only the leader is
        // signalled. kill_pid must take down the whole group.
        let script = r#"trap "" TERM
(trap "" TERM; while true; do /bin/sleep 0.05; done) &
echo started
wait"#;
        let mut child = spawn_shell_command(script, &[], &std::env::temp_dir(), &[])
            .expect("spawn stubborn group");
        let pid = child.id().expect("leader pid");

        // Wait until the group is fully up before signalling it.
        let stdout = child.stdout.take().expect("stdout");
        let mut lines = BufReader::new(stdout).lines();
        lines.next_line().await.expect("read marker");

        kill_pid(Some(pid)).await;
        // Reap the leader so the group is fully torn down before we assert.
        tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .expect("process group leader should exit after kill_pid")
            .expect("wait for process group leader");

        // A negative pid targets the whole group; with it gone, kill -0 fails.
        let alive = Command::new("/bin/kill")
            .arg("-0")
            .arg(format!("-{pid}"))
            .status()
            .await
            .expect("kill -0")
            .success();
        assert!(!alive, "process group {pid} should be dead after kill_pid");
    }

    fn opencode_stream() -> (
        OpencodeStreamState,
        mpsc::Sender<MappedAgentEvent>,
        mpsc::Receiver<MappedAgentEvent>,
    ) {
        let (tx, rx) = mpsc::channel(64);
        (OpencodeStreamState::new("oc-sess".to_string()), tx, rx)
    }

    #[tokio::test]
    async fn opencode_text_event_emits_status() {
        let (mut stream, tx, mut rx) = opencode_stream();
        assert!(stream
            .push(
                json!({
                    "type": "text",
                    "sessionID": "sess-real",
                    "part": { "type": "text", "text": "Implementing the fix" }
                }),
                &tx,
            )
            .await
            .unwrap()
            .is_none());
        assert_eq!(stream.session_id, "sess-real");
        let event = rx.recv().await.expect("status event");
        assert!(matches!(event.kind, AgentEventKind::Status));
    }

    #[tokio::test]
    async fn opencode_tool_use_maps_to_tool_call() {
        let (mut stream, tx, mut rx) = opencode_stream();
        stream
            .push(
                json!({
                    "type": "tool_use",
                    "sessionID": "oc-sess",
                    "part": {
                        "type": "tool",
                        "tool": "edit",
                        "callID": "call_1",
                        "state": {
                            "status": "completed",
                            "input": { "filePath": "src/bar.rs" },
                            "title": "Edit src/bar.rs"
                        }
                    }
                }),
                &tx,
            )
            .await
            .unwrap();
        let event = rx.recv().await.expect("tool call event");
        assert!(matches!(event.kind, AgentEventKind::ToolCall));
        assert_eq!(event.humanized.as_deref(), Some("Edit src/bar.rs"));
    }

    #[tokio::test]
    async fn opencode_step_finish_sums_token_buckets() {
        let (mut stream, tx, mut rx) = opencode_stream();
        let step = |reasoning: i64| {
            json!({
                "type": "step_finish",
                "sessionID": "oc-sess",
                "part": {
                    "type": "step-finish",
                    "tokens": {
                        "input": 1200,
                        "output": 332,
                        "reasoning": reasoning,
                        "cache": { "read": 800, "write": 400 }
                    }
                }
            })
        };
        stream.push(step(8), &tx).await.unwrap();
        stream.push(step(2), &tx).await.unwrap();
        assert!(rx.try_recv().is_err(), "no token event before finish()");

        stream.finish(&tx).await.unwrap();
        let event = rx.recv().await.expect("token count event");
        assert!(matches!(event.kind, AgentEventKind::TokenCount));
        let tokens = event.tokens.expect("token payload");
        assert_eq!(tokens.input_tokens, 4800);
        assert_eq!(tokens.output_tokens, 674);
        assert_eq!(tokens.total_tokens, 5474);
        assert!(rx.try_recv().is_err(), "exactly one token event per run");
    }

    #[tokio::test]
    async fn opencode_finish_without_usage_emits_nothing() {
        let (stream, tx, mut rx) = opencode_stream();
        stream.finish(&tx).await.unwrap();
        assert!(rx.try_recv().is_err(), "no token event without any steps");
    }

    #[tokio::test]
    async fn opencode_error_event_fails_the_run() {
        let (mut stream, tx, mut rx) = opencode_stream();
        let done = stream
            .push(
                json!({
                    "type": "error",
                    "sessionID": "oc-sess",
                    "error": {
                        "name": "ProviderAuthError",
                        "data": { "message": "missing API key", "statusCode": 401 }
                    }
                }),
                &tx,
            )
            .await
            .unwrap()
            .expect("error event ends the run");
        assert!(matches!(done.outcome, AgentOutcome::Failure));
        assert_eq!(done.error_class.as_deref(), Some("ProviderAuthError"));
        let event = rx.recv().await.expect("error event");
        assert!(matches!(event.kind, AgentEventKind::Error));
    }

    #[tokio::test]
    async fn opencode_rate_limit_error_is_classified() {
        let (mut stream, tx, mut rx) = opencode_stream();
        let done = stream
            .push(
                json!({
                    "type": "error",
                    "sessionID": "oc-sess",
                    "error": {
                        "name": "APIError",
                        "data": { "message": "Rate limit exceeded", "statusCode": 429 }
                    }
                }),
                &tx,
            )
            .await
            .unwrap()
            .expect("rate-limit error ends the run");
        assert!(matches!(done.outcome, AgentOutcome::Failure));
        assert_eq!(done.error_class.as_deref(), Some("rate_limited"));
        let event = rx.recv().await.expect("rate-limit event");
        assert_eq!(event.rate_limit.expect("payload").source, "opencode");
    }

    #[test]
    fn detects_opencode_rate_limit_hits() {
        assert!(
            detect_opencode_rate_limit(&json!({ "statusCode": 429 }), "Too many requests")
                .is_some()
        );
        assert!(
            detect_opencode_rate_limit(&json!({}), "Rate limit exceeded for this model").is_some()
        );
        assert!(detect_opencode_rate_limit(&json!({}), "All tests passing").is_none());
        assert!(detect_opencode_rate_limit(
            &json!({ "statusCode": 200 }),
            "I updated how the rate limit exceeded path is handled"
        )
        .is_none());
    }

    #[test]
    fn detects_opencode_agent_fallback() {
        assert!(is_opencode_agent_fallback(
            r#"agent "reviewer" not found. Falling back to default agent"#
        ));
        assert!(is_opencode_agent_fallback(
            "Agent NOT FOUND, falling back to build"
        ));
        assert!(!is_opencode_agent_fallback("All tests passing"));
        assert!(!is_opencode_agent_fallback(
            "the file was not found in the repo"
        ));
    }
}
