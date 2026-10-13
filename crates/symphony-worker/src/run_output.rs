//! The persistence boundary for provider/hook output. Keep all dynamic event,
//! session and terminal strings behind this adapter before storage emits UI
//! invalidations or makes them available to future retry prompts. Operational
//! quota metadata is canonicalized separately, never rewritten by redaction.
use crate::output::{OutputSanitizer, ID_LIMIT};
use chrono::{DateTime, SecondsFormat, Utc};
use sha2::{Digest, Sha256};
use symphony_core::{AgentEventKind, MappedAgentEvent, RateLimitPayload, TokenCountPayload};
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
        if let MappedAgentEvent::Visible { kind, payload, .. } = &event {
            self.repo
                .append_event(run_id, kind.clone(), payload)
                .await?;
        }
        let metadata = event.metadata();
        if let Some(info) = &metadata.session_info {
            self.repo.set_run_session_info(run_id, info).await?;
        }
        if let Some(tokens) = &metadata.tokens {
            self.repo
                .upsert_live_session(
                    run_id,
                    &symphony_core::AgentSessionId::new(format!("pending-{run_id}")),
                    &symphony_core::AgentThreadId::new(""),
                    &symphony_core::AgentTurnId::new(""),
                    tokens,
                )
                .await?;
            self.repo.record_token_usage(provider, tokens).await?;
        }
        if let Some(rate_limit) = metadata
            .rate_limit
            .as_ref()
            .and_then(|limit| canonical_rate_limit(provider, limit))
        {
            self.repo.upsert_rate_limit(&rate_limit).await?;
        }
        if let MappedAgentEvent::Visible {
            humanized: Some(summary),
            ..
        } = &event
        {
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
                &symphony_core::AgentSessionId::new(format!("{thread_id}-{turn_id}")),
                &symphony_core::AgentThreadId::new(&thread_id),
                &symphony_core::AgentTurnId::new(&turn_id),
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

/// Provider keys and reset timestamps affect scheduling, so neither may depend
/// on configured credential values. Unknown Codex buckets retain distinct,
/// stable identities without persisting arbitrary provider-controlled labels.
fn canonical_rate_limit(provider: &str, limit: &RateLimitPayload) -> Option<RateLimitPayload> {
    if !matches!(provider, "codex" | "claude" | "cursor" | "opencode") {
        return None;
    }
    let source = if limit.source == provider
        || (provider == "codex"
            && matches!(limit.source.as_str(), "codex_primary" | "codex_secondary"))
    {
        limit.source.clone()
    } else if provider == "codex" && limit.source.starts_with("codex_") {
        format!("codex_bucket_{:x}", Sha256::digest(limit.source.as_bytes()))
    } else {
        return None;
    };
    let reset_at = limit
        .reset_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| {
            value
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        });
    Some(RateLimitPayload {
        source,
        remaining: limit.remaining,
        // An invalid reset carries no known expiry, just like an absent reset.
        reset_at,
    })
}
