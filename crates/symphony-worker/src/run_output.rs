//! The persistence boundary for provider/hook output. Keep all dynamic event,
//! session and terminal strings behind this adapter before storage emits UI
//! invalidations or makes them available to future retry prompts.
use crate::output::{OutputSanitizer, ID_LIMIT};
use symphony_core::{AgentEventKind, MappedAgentEvent, TokenCountPayload};
use symphony_storage::{Repository, RunCompletion, StorageError};

pub(crate) struct RunOutput<'a> {
    repo: &'a Repository,
    sanitizer: &'a OutputSanitizer,
}

impl<'a> RunOutput<'a> {
    pub(crate) fn new(repo: &'a Repository, sanitizer: &'a OutputSanitizer) -> Self {
        Self { repo, sanitizer }
    }

    pub(crate) async fn event(
        &self,
        run_id: &str,
        provider: &str,
        event: &MappedAgentEvent,
    ) -> Result<(), StorageError> {
        let event = self.sanitizer.event(event);
        if !event.payload.is_null() {
            self.repo
                .append_event(run_id, event.kind, &event.payload)
                .await?;
        }
        if let Some(info) = &event.session_info {
            self.repo.set_run_session_info(run_id, info).await?;
        }
        if let Some(tokens) = &event.tokens {
            self.repo
                .upsert_live_session(run_id, &format!("pending-{run_id}"), "", "", tokens)
                .await?;
            self.repo.record_token_usage(provider, tokens).await?;
        }
        if let Some(rate_limit) = &event.rate_limit {
            self.repo.upsert_rate_limit(rate_limit).await?;
        }
        if let Some(summary) = &event.humanized {
            self.repo
                .append_event(
                    run_id,
                    AgentEventKind::Humanized,
                    &serde_json::json!({"summary": summary}),
                )
                .await?;
        }
        Ok(())
    }

    pub(crate) async fn status(&self, run_id: &str, message: &str) -> Result<(), StorageError> {
        self.repo
            .append_event(
                run_id,
                AgentEventKind::Status,
                &self
                    .sanitizer
                    .json(&serde_json::json!({"message": message})),
            )
            .await
            .map(|_| ())
    }

    pub(crate) async fn identity(
        &self,
        run_id: &str,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<(), StorageError> {
        let thread_id = self.sanitizer.text(thread_id, ID_LIMIT);
        let turn_id = self.sanitizer.text(turn_id, ID_LIMIT);
        self.repo
            .upsert_live_session(
                run_id,
                &format!("{thread_id}-{turn_id}"),
                &thread_id,
                &turn_id,
                &TokenCountPayload {
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0,
                },
            )
            .await
    }

    pub(crate) async fn failure(
        &self,
        run_id: &str,
        due: &str,
        class: &str,
        message: &str,
    ) -> Result<bool, StorageError> {
        let class = self.sanitizer.text(class, ID_LIMIT);
        let message = self.sanitizer.error(message);
        self.repo
            .complete_run(
                run_id,
                RunCompletion::Failure {
                    error_class: &class,
                    error_message: &message,
                    retry_due_at: due,
                },
            )
            .await
    }

    pub(crate) async fn cancelled(
        &self,
        run_id: &str,
        class: Option<&str>,
        message: Option<&str>,
    ) -> Result<bool, StorageError> {
        let class = class.map(|s| self.sanitizer.text(s, ID_LIMIT));
        let message = message.map(|s| self.sanitizer.error(s));
        self.repo
            .complete_run(
                run_id,
                RunCompletion::Cancelled {
                    error_class: class.as_deref(),
                    error_message: message.as_deref(),
                    suppression: None,
                },
            )
            .await
    }
}
