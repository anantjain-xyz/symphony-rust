//! One owner for an agent's pipes, deadline, and process group.
use crate::{AgentError, AgentEventSender, AgentRunRequest, AgentRunResult};
use async_trait::async_trait;
use std::{future::Future, process::ExitStatus, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStderr, ChildStdout},
};
use tokio_util::sync::CancellationToken;

const MAX_STDOUT_RECORD_BYTES: usize = 8 * 1024 * 1024;
const STDERR_TAIL_BYTES: usize = 8 * 1024;
#[cfg(unix)]
const TERMINATION_GRACE: Duration = Duration::from_millis(500);

#[derive(Clone, Copy)]
pub(crate) enum StreamControl {
    Continue,
    Stop,
}

#[allow(
    clippy::double_must_use,
    reason = "async_trait generates must_use on a boxed future"
)]
#[async_trait]
pub(crate) trait Protocol: Send {
    async fn push_line(
        &mut self,
        line: &str,
        events: &AgentEventSender,
    ) -> Result<StreamControl, AgentError>;

    async fn finish(
        &mut self,
        status: Option<ExitStatus>,
        stderr_tail: &str,
        events: &AgentEventSender,
    ) -> Result<AgentRunResult, AgentError>;

    fn cancelled(&self) -> AgentRunResult;
}

pub(crate) async fn run(
    request: &AgentRunRequest,
    args: &[String],
    protocol: &mut impl Protocol,
    events: &AgentEventSender,
    cancel: &CancellationToken,
) -> Result<AgentRunResult, AgentError> {
    if cancel.is_cancelled() {
        return Ok(protocol.cancelled());
    }
    let mut process = ProcessGroup::new(crate::spawn_shell_command(
        &request.command,
        args,
        &request.cwd,
        &request.env,
    )?);
    enum Outcome {
        Finished(Result<PumpOutput, AgentError>),
        Cancelled,
    }
    let deadline = tokio::time::Instant::now() + Duration::from_millis(request.turn_timeout_ms);
    let outcome = tokio::select! {
        biased;
        _ = cancel.cancelled() => Outcome::Cancelled,
        _ = tokio::time::sleep_until(deadline) => {
            Outcome::Finished(Err(AgentError::Timeout(request.turn_timeout_ms)))
        }
        result = pump(&mut process.child, protocol, request, events) => Outcome::Finished(result),
    };
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    // Cleanup has its own fixed grace period and cannot be abandoned when the
    // execution deadline expires. Signal immediately after reaping a normal
    // exit, before any potentially blocked provider finalization/event sends.
    let cleanup = process.terminate().await;
    let mut output = match outcome {
        Outcome::Finished(Err(error)) => return Err(error),
        Outcome::Cancelled => {
            cleanup?;
            return Ok(protocol.cancelled());
        }
        Outcome::Finished(Ok(output)) => {
            cleanup?;
            output
        }
    };
    // Preserve the remaining execution budget across mandatory cleanup. Once
    // the group has exited, collect the last diagnostic bytes before finish.
    let finish = async {
        drain_stderr(&mut output.stderr, &mut output.tail).await?;
        protocol
            .finish(output.status, &output.tail.diagnostic(), events)
            .await
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        _ = tokio::time::sleep(remaining) => Some(Err(AgentError::Timeout(request.turn_timeout_ms))),
        result = finish => Some(result),
    };
    result.unwrap_or_else(|| Ok(protocol.cancelled()))
}

struct PumpOutput {
    status: Option<ExitStatus>,
    stderr: ChildStderr,
    tail: StderrCapture,
}

async fn pump(
    child: &mut Child,
    protocol: &mut impl Protocol,
    request: &AgentRunRequest,
    events: &AgentEventSender,
) -> Result<PumpOutput, AgentError> {
    let mut stdin = child.stdin.take().ok_or(AgentError::MissingResult)?;
    let stdout = child.stdout.take().ok_or(AgentError::MissingResult)?;
    let mut stderr = child.stderr.take().ok_or(AgentError::MissingResult)?;
    let mut tail = StderrCapture::default();
    let status = {
        let input = async {
            stdin.write_all(request.prompt.as_bytes()).await?;
            drop(stdin);
            Ok::<_, std::io::Error>(())
        };
        let output = async {
            let mut lines = ProtocolLines::new(stdout);
            while let Some(line) = lines.next_line().await? {
                if line.trim().is_empty() {
                    continue;
                }
                if matches!(
                    protocol.push_line(&line, events).await?,
                    StreamControl::Stop
                ) {
                    return Ok(None);
                }
            }
            // EOF alone does not imply process exit. This await remains under
            // the same deadline/cancellation scope as all other I/O.
            Ok::<_, AgentError>(Some(child.wait().await?))
        };
        let errors = drain_stderr(&mut stderr, &mut tail);
        pump_concurrently(input, output, errors).await?
    };
    Ok(PumpOutput {
        status,
        stderr,
        tail,
    })
}

async fn pump_concurrently<T>(
    input: impl Future<Output = std::io::Result<()>>,
    output: impl Future<Output = Result<T, AgentError>>,
    errors: impl Future<Output = std::io::Result<()>>,
) -> Result<T, AgentError> {
    tokio::pin!(input, output, errors);
    let mut input_done = false;
    let mut errors_done = false;
    loop {
        tokio::select! {
            result = &mut input, if !input_done => {
                result?;
                input_done = true;
            }
            result = &mut errors, if !errors_done => {
                result?;
                errors_done = true;
            }
            result = &mut output => return result,
        }
    }
}

async fn drain_stderr(
    mut stderr: impl AsyncRead + Unpin,
    tail: &mut StderrCapture,
) -> std::io::Result<()> {
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stderr.read(&mut buffer).await?;
        if read == 0 {
            return Ok(());
        }
        tail.push(&buffer[..read]);
    }
}

#[derive(Default)]
struct StderrCapture {
    bytes: Vec<u8>,
    omitted: bool,
}

impl StderrCapture {
    fn push(&mut self, bytes: &[u8]) {
        if self.omitted {
            return;
        }
        if self.bytes.len() + bytes.len() > STDERR_TAIL_BYTES {
            // Truncating before the worker's redaction boundary could retain
            // only part of a credential, making exact-value redaction fail.
            // Keep complete diagnostics or omit them, while draining every byte.
            self.bytes.clear();
            self.omitted = true;
        } else {
            self.bytes.extend_from_slice(bytes);
        }
    }

    fn diagnostic(&self) -> std::borrow::Cow<'_, str> {
        if self.omitted {
            "[stderr omitted: diagnostic limit exceeded]".into()
        } else {
            String::from_utf8_lossy(&self.bytes)
        }
    }
}

struct ProtocolLines {
    reader: BufReader<ChildStdout>,
}

impl ProtocolLines {
    fn new(stdout: ChildStdout) -> Self {
        Self {
            reader: BufReader::new(stdout),
        }
    }

    async fn next_line(&mut self) -> Result<Option<String>, AgentError> {
        let mut line = Vec::new();
        loop {
            let chunk = self.reader.fill_buf().await?;
            if chunk.is_empty() {
                if line.is_empty() {
                    return Ok(None);
                }
                break;
            }
            let end = chunk.iter().position(|byte| *byte == b'\n');
            let length = end.map_or(chunk.len(), |index| index + 1);
            if line.len() + length > MAX_STDOUT_RECORD_BYTES {
                return Err(AgentError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("agent stdout record exceeds {MAX_STDOUT_RECORD_BYTES} bytes"),
                )));
            }
            line.extend_from_slice(&chunk[..length]);
            self.reader.consume(length);
            if end.is_some() {
                break;
            }
        }
        String::from_utf8(line).map(Some).map_err(|error| {
            AgentError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, error))
        })
    }
}

struct ProcessGroup {
    child: Child,
    pid: Option<u32>,
}

impl ProcessGroup {
    fn new(child: Child) -> Self {
        Self {
            pid: child.id(),
            child,
        }
    }

    async fn terminate(&mut self) -> Result<(), AgentError> {
        // Reap an already-exited leader before signaling. On macOS a group
        // containing only its zombie leader can report EPERM rather than
        // ESRCH, despite having no process left that can receive the signal.
        self.child.try_wait()?;
        #[cfg(unix)]
        if self.pid.is_some() && self.signal(libc::SIGTERM).await? {
            tokio::time::sleep(TERMINATION_GRACE).await;
            self.child.try_wait()?;
            self.signal(libc::SIGKILL).await?;
        }
        #[cfg(not(unix))]
        self.child.start_kill()?;
        self.child.wait().await?;
        self.pid = None;
        Ok(())
    }

    #[cfg(unix)]
    async fn signal(&mut self, signal: libc::c_int) -> std::io::Result<bool> {
        let Some(pid) = self.pid else {
            return Ok(false);
        };
        match signal_group(pid, signal) {
            Err(error) if error.raw_os_error() == Some(libc::EPERM) => {
                // On macOS a group whose last member is exiting may report
                // EPERM before that child becomes waitable. Allow it to finish
                // exiting, reap it, and retry. A genuinely unsignalable live
                // group still fails within the bounded cleanup grace.
                match tokio::time::timeout(TERMINATION_GRACE, self.child.wait()).await {
                    Ok(Ok(_)) => signal_group(pid, signal),
                    Ok(Err(error)) => Err(error),
                    Err(_) => Err(error),
                }
            }
            result => result,
        }
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // Synchronous signaling is essential: an abandoned future cannot await
        // cleanup and the runtime may itself be shutting down. Tokio's Child
        // retains kill-on-drop/reaping responsibility for the direct child.
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            let _ = signal_group(pid, libc::SIGKILL);
        }
    }
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) -> std::io::Result<bool> {
    let pid = libc::pid_t::try_from(pid).map_err(std::io::Error::other)?;
    // SAFETY: kill takes only integers. This pid was obtained from the child
    // launched with process_group(0), so the negative value targets its group.
    if unsafe { libc::kill(-pid, signal) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(false)
    } else {
        Err(error)
    }
}
