//! Exercise the public driver with real shell processes, without provider CLIs.
use super::*;
use std::time::Duration;
use tokio::task::JoinHandle;

const BACKENDS: [AgentBackend; 4] = [
    AgentBackend::Codex,
    AgentBackend::Claude,
    AgentBackend::Cursor,
    AgentBackend::Opencode,
];

struct Fixture {
    directory: PathBuf,
}

impl Fixture {
    fn new(script: &str) -> Self {
        let directory = std::env::temp_dir().join(format!("symphony-process-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        // exec in the configured command keeps this shell's PID equal to the
        // process-group leader, so test cleanup never signals unrelated work.
        std::fs::write(
            directory.join("agent.sh"),
            format!("echo $$ > leader.pid\n{script}\n"),
        )
        .unwrap();
        Self { directory }
    }

    fn request(&self, backend: AgentBackend) -> AgentRunRequest {
        AgentRunRequest {
            backend,
            command: format!(
                "exec /bin/sh {}",
                shell_quote(&self.directory.join("agent.sh").display().to_string())
            ),
            cwd: self.directory.clone(),
            prompt: "fixture prompt".into(),
            codex_permission_mode: Default::default(),
            thread_sandbox: Default::default(),
            turn_sandbox_policy: Default::default(),
            network_access: false,
            turn_timeout_ms: 5_000,
            claude: Default::default(),
            cursor: Default::default(),
            opencode: Default::default(),
            env: vec![],
        }
    }

    async fn wait_for_file(&self, name: &str) -> String {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(self.directory.join(name)) {
                    if !text.trim().is_empty() {
                        return text;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "fake process never produced {name}: {}",
                self.directory.display()
            )
        })
    }

    async fn assert_stopped(&self, name: &str) {
        let pid: libc::pid_t = self.wait_for_file(name).await.trim().parse().unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                // SAFETY: signal zero only checks the known fixture PID.
                if unsafe { libc::kill(pid, 0) } != 0
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    break;
                }
                // Container PID 1 may not reap orphaned grandchildren. A zombie
                // cannot execute or mutate a workspace and is also stopped.
                #[cfg(target_os = "linux")]
                if std::fs::read_to_string(format!("/proc/{pid}/stat"))
                    .ok()
                    .and_then(|s| {
                        s.rsplit_once(')')
                            .map(|(_, state)| state.trim_start().starts_with('Z'))
                    })
                    .unwrap_or(false)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fixture process survived driver completion/drop");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(pid) = std::fs::read_to_string(self.directory.join("leader.pid")) {
            if let Ok(pid) = pid.trim().parse::<libc::pid_t>() {
                // SAFETY: fixtures exec the script as their own group leader.
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                }
            }
        }
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

struct Running(JoinHandle<Result<AgentRunResult, AgentError>>);

impl Running {
    fn start(
        request: AgentRunRequest,
        events: AgentEventSender,
        cancel: CancellationToken,
    ) -> Self {
        Self(tokio::spawn(async move {
            NativeAgentDriver.run(request, events, cancel).await
        }))
    }

    async fn result(&mut self) -> Result<AgentRunResult, AgentError> {
        tokio::time::timeout(Duration::from_secs(3), &mut self.0)
            .await
            .expect("driver exceeded cleanup deadline")
            .expect("driver panicked")
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn success_record(backend: &AgentBackend) -> &'static str {
    match backend {
        AgentBackend::Codex => {
            r#"{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}"#
        }
        AgentBackend::Claude | AgentBackend::Cursor => {
            r#"{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":1,"output_tokens":1,"inputTokens":1,"outputTokens":1}}"#
        }
        AgentBackend::Opencode => r#"{"type":"text","part":{"text":"done"}}"#,
    }
}

#[tokio::test]
async fn every_provider_drains_stderr_while_pumping_large_stdin() {
    for backend in BACKENDS {
        let script = format!(
            "dd if=/dev/zero bs=65536 count=32 >&2 2>/dev/null\ncat >/dev/null\nprintf '%s\\n' {}",
            shell_quote(success_record(&backend)),
        );
        let fixture = Fixture::new(&script);
        let mut request = fixture.request(backend);
        request.prompt = "x".repeat(2 * 1024 * 1024);
        let (tx, _rx) = mpsc::channel(64);
        let mut running = Running::start(request, tx, CancellationToken::new());
        assert!(matches!(
            running.result().await.unwrap().outcome,
            AgentOutcome::Success
        ));
        fixture.assert_stopped("leader.pid").await;
    }
}

#[tokio::test]
async fn every_provider_cancels_a_blocked_stdin_write() {
    for backend in BACKENDS {
        let fixture = Fixture::new("sleep 30");
        let mut request = fixture.request(backend);
        request.prompt = "x".repeat(2 * 1024 * 1024);
        let cancel = CancellationToken::new();
        let (tx, _rx) = mpsc::channel(64);
        let mut running = Running::start(request, tx, cancel.clone());
        fixture.wait_for_file("leader.pid").await;
        cancel.cancel();
        assert!(matches!(
            running.result().await.unwrap().outcome,
            AgentOutcome::Cancelled
        ));
        fixture.assert_stopped("leader.pid").await;
    }
}

#[tokio::test]
async fn every_provider_times_out_a_blocked_stdin_write() {
    for backend in BACKENDS {
        let fixture = Fixture::new("sleep 30");
        let mut request = fixture.request(backend);
        request.prompt = "x".repeat(2 * 1024 * 1024);
        request.turn_timeout_ms = 150;
        let (tx, _rx) = mpsc::channel(64);
        let mut running = Running::start(request, tx, CancellationToken::new());
        assert!(matches!(
            running.result().await,
            Err(AgentError::Timeout(150))
        ));
        fixture.assert_stopped("leader.pid").await;
    }
}

#[tokio::test]
async fn every_provider_keeps_eof_exit_wait_cancellable_and_bounded() {
    for backend in BACKENDS {
        for timeout in [false, true] {
            let fixture = Fixture::new("cat >/dev/null\nexec 1>&-\necho ready > ready\nsleep 30");
            let mut request = fixture.request(backend.clone());
            request.turn_timeout_ms = if timeout { 150 } else { 5_000 };
            let cancel = CancellationToken::new();
            let (tx, _rx) = mpsc::channel(64);
            let mut running = Running::start(request, tx, cancel.clone());
            fixture.wait_for_file("ready").await;
            if !timeout {
                cancel.cancel();
            }
            let result = running.result().await;
            if timeout {
                assert!(matches!(result, Err(AgentError::Timeout(150))));
            } else {
                assert!(matches!(result.unwrap().outcome, AgentOutcome::Cancelled));
            }
            fixture.assert_stopped("leader.pid").await;
        }
    }
}

const DESCENDANT: &str = "(trap '' TERM; echo ready > descendant.ready; while :; do sleep 1; done) &\necho $! > descendant.pid\nwhile [ ! -s descendant.ready ]; do sleep 0.01; done";

#[tokio::test]
async fn protocol_errors_stop_and_reap_the_process_group() {
    for backend in [
        AgentBackend::Codex,
        AgentBackend::Claude,
        AgentBackend::Cursor,
    ] {
        let fixture = Fixture::new(&format!(
            "trap '' TERM\ncat >/dev/null\n{DESCENDANT}\nprintf 'malformed JSON\\n'\nsleep 30"
        ));
        let (tx, _rx) = mpsc::channel(64);
        let mut running = Running::start(fixture.request(backend), tx, CancellationToken::new());
        assert!(matches!(running.result().await, Err(AgentError::Json(_))));
        fixture.assert_stopped("leader.pid").await;
        fixture.assert_stopped("descendant.pid").await;
    }
}

#[tokio::test]
async fn dropping_every_provider_stops_descendants_even_during_event_backpressure() {
    for backend in BACKENDS {
        let fixture = Fixture::new(&format!(
            "cat >/dev/null\n{DESCENDANT}\nprintf '%s\\n' {}\necho ready > emitted\nsleep 30",
            shell_quote(success_record(&backend))
        ));
        let (tx, _rx) = mpsc::channel(1);
        // Fill the channel first so provider event delivery cannot finish.
        tx.send(MappedAgentEvent::Visible {
            kind: AgentEventKind::Status,
            payload: json!({}),
            humanized: None,
            metadata: AgentEventMetadata::default(),
        })
        .await
        .unwrap();
        let mut running = Running::start(fixture.request(backend), tx, CancellationToken::new());
        fixture.wait_for_file("emitted").await;
        tokio::time::sleep(Duration::from_millis(25)).await;
        running.0.abort();
        assert!(tokio::time::timeout(Duration::from_secs(3), &mut running.0)
            .await
            .unwrap()
            .unwrap_err()
            .is_cancelled());
        fixture.assert_stopped("leader.pid").await;
        fixture.assert_stopped("descendant.pid").await;
    }
}

#[tokio::test]
async fn every_provider_cancels_during_event_backpressure() {
    for backend in BACKENDS {
        let fixture = Fixture::new(&format!(
            "cat >/dev/null\nprintf '%s\\n' {}\necho ready > emitted\nsleep 30",
            shell_quote(success_record(&backend))
        ));
        let (tx, _rx) = mpsc::channel(1);
        tx.send(MappedAgentEvent::Visible {
            kind: AgentEventKind::Status,
            payload: json!({}),
            humanized: None,
            metadata: AgentEventMetadata::default(),
        })
        .await
        .unwrap();
        let cancel = CancellationToken::new();
        let mut running = Running::start(fixture.request(backend), tx, cancel.clone());
        fixture.wait_for_file("emitted").await;
        tokio::time::sleep(Duration::from_millis(25)).await;
        cancel.cancel();
        assert!(matches!(
            running.result().await.unwrap().outcome,
            AgentOutcome::Cancelled
        ));
        fixture.assert_stopped("leader.pid").await;
    }
}

#[tokio::test]
async fn every_provider_rejects_unbounded_stdout_records() {
    for backend in BACKENDS {
        let fixture = Fixture::new(
            "cat >/dev/null\ndd if=/dev/zero bs=1048576 count=9 2>/dev/null\nsleep 30",
        );
        let (tx, _rx) = mpsc::channel(64);
        let mut running = Running::start(fixture.request(backend), tx, CancellationToken::new());
        let error = running.result().await.unwrap_err();
        assert!(
            error.to_string().contains("stdout record exceeds"),
            "{error}"
        );
        fixture.assert_stopped("leader.pid").await;
    }
}

#[tokio::test]
async fn cursor_terminal_result_stops_a_lingering_process() {
    let fixture = Fixture::new(&format!(
        "cat >/dev/null\n{DESCENDANT}\nprintf '%s\\n' {}\nsleep 30",
        shell_quote(success_record(&AgentBackend::Cursor))
    ));
    let (tx, _rx) = mpsc::channel(64);
    let mut running = Running::start(
        fixture.request(AgentBackend::Cursor),
        tx,
        CancellationToken::new(),
    );
    assert!(matches!(
        running.result().await.unwrap().outcome,
        AgentOutcome::Success
    ));
    fixture.assert_stopped("leader.pid").await;
    fixture.assert_stopped("descendant.pid").await;
}

#[tokio::test]
async fn nonzero_exit_omits_overflowed_stderr_without_retaining_credential_fragments() {
    for backend in BACKENDS {
        let fixture = Fixture::new("cat >/dev/null\nprintf 'credential-prefix-' >&2\ndd if=/dev/zero bs=65536 count=32 >&2 2>/dev/null\nprintf 'credential-suffix\\n' >&2\nexit 7");
        let (tx, _rx) = mpsc::channel(64);
        let mut running = Running::start(fixture.request(backend), tx, CancellationToken::new());
        let result = running.result().await.unwrap();
        assert!(matches!(result.outcome, AgentOutcome::Failure));
        assert_eq!(result.error_class.as_deref(), Some("nonzero_exit"));
        let message = result.error_message.unwrap();
        assert!(message.ends_with("[stderr omitted: diagnostic limit exceeded]"));
        assert!(!message.contains("credential"));
        assert!(message.len() < 8 * 1024 + 100);
        fixture.assert_stopped("leader.pid").await;
    }
}

#[tokio::test]
async fn nonzero_exit_preserves_complete_bounded_stderr_for_every_provider() {
    for backend in BACKENDS {
        let fixture = Fixture::new("cat >/dev/null\nprintf 'diagnostic é final\\n' >&2\nexit 7");
        let mut request = fixture.request(backend);
        request.prompt = "prompt-canary-secret".into();
        request.env = vec![("CUSTOM".into(), "env-canary-secret".into())];
        let debug = format!("{request:?}");
        assert!(!debug.contains("canary"));
        let (tx, _rx) = mpsc::channel(64);
        let mut running = Running::start(request, tx, CancellationToken::new());
        let result = running.result().await.unwrap();
        assert!(matches!(result.outcome, AgentOutcome::Failure));
        assert!(result
            .error_message
            .unwrap()
            .ends_with("diagnostic é final"));
        fixture.assert_stopped("leader.pid").await;
    }
}

#[tokio::test]
async fn opencode_final_usage_delivery_keeps_the_execution_deadline() {
    let fixture = Fixture::new("cat >/dev/null\nprintf '%s\\n' '{\"type\":\"step_finish\",\"part\":{\"tokens\":{\"input\":1,\"output\":1}}}'");
    let (tx, _rx) = mpsc::channel(1);
    tx.send(MappedAgentEvent::Visible {
        kind: AgentEventKind::Status,
        payload: json!({}),
        humanized: None,
        metadata: AgentEventMetadata::default(),
    })
    .await
    .unwrap();
    let mut request = fixture.request(AgentBackend::Opencode);
    request.turn_timeout_ms = 150;
    let mut running = Running::start(request, tx, CancellationToken::new());
    assert!(matches!(
        running.result().await,
        Err(AgentError::Timeout(150))
    ));
    fixture.assert_stopped("leader.pid").await;
}

#[tokio::test]
async fn provider_requested_abort_preserves_the_reported_failure() {
    for (backend, record, class) in [
        (
            AgentBackend::Claude,
            r#"{"type":"system","subtype":"init","permissionMode":"default"}"#,
            "permission_mode_dropped",
        ),
        (
            AgentBackend::Opencode,
            "agent unknown not found. Falling back to default",
            "agent_not_found",
        ),
    ] {
        let fixture = Fixture::new(&format!(
            "cat >/dev/null\n{DESCENDANT}\nprintf '%s\\n' {}\nsleep 30",
            shell_quote(record)
        ));
        let (tx, _rx) = mpsc::channel(64);
        let mut running = Running::start(fixture.request(backend), tx, CancellationToken::new());
        let result = running.result().await.unwrap();
        assert!(matches!(result.outcome, AgentOutcome::Failure));
        assert_eq!(result.error_class.as_deref(), Some(class));
        fixture.assert_stopped("leader.pid").await;
        fixture.assert_stopped("descendant.pid").await;
    }
}
