use async_trait::async_trait;
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, time::Duration};
use symphony_core::{
    AgentBackend, AgentEventKind, AgentOutcome, ClaudePermissionMode, MappedAgentEvent,
    RateLimitPayload, SessionInfoPayload, ThreadSandbox, TokenCountPayload, ToolCallPayload,
    TurnSandboxPolicy,
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
    let mut stream = ClaudeStreamState::new(session_id.clone());
    let mut result: Option<AgentRunResult> = None;

    let run = async {
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(&line)?;
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
}

impl ClaudeStreamState {
    fn new(session_id: String) -> Self {
        Self {
            session_id,
            pending_tools: HashMap::new(),
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
                }
                "thinking_tokens" => {
                    if let Some(estimate) = ev["estimated_tokens"].as_i64() {
                        let prior = self.session_info.thinking_tokens.unwrap_or(0);
                        self.session_info.thinking_tokens = Some(prior.max(estimate));
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
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (key, value) in envs {
        cmd.env(key, value);
    }
    cmd.spawn().map_err(AgentError::Spawn)
}

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
    if value.len() <= max {
        value.to_string()
    } else {
        format!("{}...", &value[..max])
    }
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
        let mut stream = ClaudeStreamState::new("sess-1".to_string());
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
}
