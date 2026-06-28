use async_trait::async_trait;
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, time::Duration};
use symphony_core::{
    AgentBackend, AgentEventKind, AgentOutcome, ClaudePermissionMode, CursorAgentMode,
    CursorSandboxMode, MappedAgentEvent, RateLimitPayload, SessionInfoPayload, ThreadSandbox,
    TokenCountPayload, ToolCallPayload, TurnSandboxPolicy,
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

async fn run_codex(
    request: AgentRunRequest,
    events: AgentEventSender,
    cancel: CancellationToken,
) -> Result<AgentRunResult, AgentError> {
    let thread_id = format!("th_{}", Uuid::new_v4());
    let turn_id = format!("tn_{}", Uuid::new_v4());
    let sandbox = normalize_sandbox(&request.thread_sandbox, &request.turn_sandbox_policy);
    let mut args = vec![
        "exec".to_string(),
        "--json".to_string(),
        "--skip-git-repo-check".to_string(),
        "-C".to_string(),
        request.cwd.display().to_string(),
    ];
    match sandbox.as_str() {
        "danger-full-access" => args.push("--dangerously-bypass-approvals-and-sandbox".to_string()),
        "workspace-write" => {
            args.push("--full-auto".to_string());
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
            let value: Value = serde_json::from_str(&line)?;
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
                    "running".to_string()
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
                    send_status(events, format!("{kind} completed")).await;
                }
            }
        }
        "turn.completed" => {
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
            return Ok(Some(AgentRunResult {
                thread_id: thread_id.to_string(),
                turn_id: turn_id.to_string(),
                outcome: AgentOutcome::Failure,
                error_class: ev["error"]["type"]
                    .as_str()
                    .unwrap_or("turn_failed")
                    .to_string()
                    .into(),
                error_message: ev["error"]["message"]
                    .as_str()
                    .unwrap_or("Codex turn failed")
                    .to_string()
                    .into(),
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
    let mut args = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--session-id".to_string(),
        session_id.clone(),
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
            let value: Value = serde_json::from_str(&line)?;
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
            let value: Value = serde_json::from_str(&line)?;
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
                // cursor-agent reports usage with camelCase keys.
                let usage = &ev["usage"];
                let input = usage["inputTokens"].as_i64().unwrap_or(0);
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
            // opencode can print human-readable warnings to stdout even under
            // `--format json` (e.g. a permission auto-reject, or a fallback
            // when the configured agent is missing). Skip anything that is not
            // a JSON event instead of failing the whole run on it.
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if let Some(done) = stream.push(value, &events).await? {
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
    let sid = stream.session_id.clone();
    Ok(AgentRunResult {
        thread_id: sid.clone(),
        turn_id: sid,
        outcome: if status.success() {
            AgentOutcome::Success
        } else {
            AgentOutcome::Failure
        },
        error_class: (!status.success()).then(|| "nonzero_exit".to_string()),
        error_message: (!status.success()).then(|| format!("opencode exit {status}")),
    })
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
                    "usage": { "inputTokens": 120, "outputTokens": 45 }
                }),
                &tx,
            )
            .await
            .unwrap()
            .expect("result finishes run");
        assert!(matches!(done.outcome, AgentOutcome::Success));
        let tokens = rx.recv().await.expect("token count event");
        assert!(matches!(tokens.kind, AgentEventKind::TokenCount));
        assert_eq!(tokens.tokens.as_ref().map(|t| t.input_tokens), Some(120));
        assert_eq!(tokens.tokens.as_ref().map(|t| t.output_tokens), Some(45));
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
}
