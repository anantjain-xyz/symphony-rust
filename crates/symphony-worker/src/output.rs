//! Redaction and size limits for untrusted output. Credentials never leave this
//! module through Debug, and matching happens before truncation.
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};
use symphony_core::{AgentEventKind, MappedAgentEvent, RetryContext};

pub(crate) const ERROR_LIMIT: usize = 8 * 1024;
pub(crate) const ID_LIMIT: usize = 256;
pub(crate) const SUMMARY_LIMIT: usize = 4 * 1024;
pub(crate) const JSON_LIMIT: usize = 64 * 1024;
const REDACTED: &str = "[REDACTED]";
const TRUNCATED: &str = "[truncated]";

#[derive(Clone, Default)]
pub(crate) struct OutputSanitizer {
    secrets: Arc<Vec<String>>,
}

impl std::fmt::Debug for OutputSanitizer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutputSanitizer")
            .field("credential_count", &self.secrets.len())
            .finish()
    }
}

impl OutputSanitizer {
    pub(crate) fn new(
        tracker_key: &str,
        env: &BTreeMap<String, String>,
        session_env: &BTreeMap<String, String>,
    ) -> Self {
        let mut secrets = std::iter::once(tracker_key)
            .chain(
                env.iter()
                    .filter(|(key, _)| sensitive_key(key))
                    .map(|(_, v)| v.as_str()),
            )
            // Explicit session variables may use arbitrary names.
            .chain(session_env.values().map(String::as_str))
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        // Some providers embed serialized JSON inside string fields.
        let escaped = secrets
            .iter()
            .map(|secret| {
                let json = serde_json::to_string(secret).expect("string serialization");
                json[1..json.len() - 1].to_string()
            })
            .collect::<Vec<_>>();
        secrets.extend(escaped);
        secrets.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        secrets.dedup();
        Self {
            secrets: Arc::new(secrets),
        }
    }

    pub(crate) fn include(&mut self, other: &Self) {
        let secrets = Arc::make_mut(&mut self.secrets);
        secrets.extend(other.secrets.iter().cloned());
        secrets.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        secrets.dedup();
    }

    pub(crate) fn text(&self, input: &str, limit: usize) -> String {
        // Agent adapters can truncate before this boundary. Their explicit
        // ellipsis must not preserve a known credential's leading fragment.
        let fragment = input.strip_suffix("...").and_then(|prefix| {
            self.secrets
                .iter()
                .flat_map(|secret| {
                    secret
                        .char_indices()
                        .skip(1)
                        .map(move |(end, _)| &secret[..end])
                })
                .filter(|candidate| prefix.ends_with(candidate))
                .map(str::len)
                .max()
                .map(|len| (prefix.len() - len, len))
        });
        let mut output = String::new();
        let mut remaining = input;
        while !remaining.is_empty() {
            let found = self
                .secrets
                .iter()
                .filter_map(|secret| remaining.find(secret).map(|at| (at, secret.len())))
                .chain(fragment.and_then(|(at, len)| {
                    let consumed = input.len() - remaining.len();
                    at.checked_sub(consumed).map(|at| (at, len))
                }))
                .min_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.cmp(&a.1)));
            let (plain, rest) = match found {
                Some((at, len)) => (&remaining[..at], Some(&remaining[at + len..])),
                None => (remaining, None),
            };
            if !append_bounded(&mut output, plain, limit) {
                return mark_truncated(output, limit);
            }
            match rest {
                Some(rest) => {
                    if !append_bounded(&mut output, REDACTED, limit) {
                        return mark_truncated(output, limit);
                    }
                    remaining = rest;
                }
                None => return output,
            }
        }
        output
    }

    pub(crate) fn error(&self, value: &str) -> String {
        self.text(value, ERROR_LIMIT)
    }

    pub(crate) fn json(&self, value: &Value) -> Value {
        let mut nodes = 256;
        let value = self.json_inner(value, 0, &mut nodes);
        let encoded = value.to_string();
        if encoded.len() <= JSON_LIMIT {
            value
        } else {
            // A JSON string can expand to six bytes per input byte when escaped.
            serde_json::json!({ "truncated": true, "preview": self.text(&encoded, (JSON_LIMIT - 128) / 6) })
        }
    }

    fn json_inner(&self, value: &Value, depth: usize, nodes: &mut usize) -> Value {
        if depth >= 16 || *nodes == 0 {
            return Value::String(TRUNCATED.into());
        }
        *nodes -= 1;
        match value {
            Value::String(value) => Value::String(self.text(value, ERROR_LIMIT)),
            Value::Array(values) => {
                let mut output = Vec::new();
                for value in values {
                    if *nodes == 0 {
                        output.push(Value::String(TRUNCATED.into()));
                        break;
                    }
                    output.push(self.json_inner(value, depth + 1, nodes));
                }
                Value::Array(output)
            }
            Value::Object(values) => {
                let mut output = serde_json::Map::new();
                for (key, value) in values {
                    if *nodes == 0 {
                        output.insert("_truncated".into(), Value::Bool(true));
                        break;
                    }
                    let clean_value = if sensitive_key(key) {
                        *nodes -= 1;
                        Value::String(REDACTED.into())
                    } else {
                        self.json_inner(value, depth + 1, nodes)
                    };
                    output.insert(self.text(key, ID_LIMIT), clean_value);
                }
                Value::Object(output)
            }
            _ => value.clone(),
        }
    }

    pub(crate) fn event(&self, event: &MappedAgentEvent) -> MappedAgentEvent {
        let mut metadata = event.metadata().clone();
        if let Some(info) = &mut metadata.session_info {
            for value in [
                &mut info.model,
                &mut info.permission_mode,
                &mut info.agent_version,
                &mut info.output_style,
                &mut info.fast_mode,
            ] {
                *value = value.as_ref().map(|s| self.text(s, ID_LIMIT));
            }
        }
        // Quota keys and timestamps control dispatch. Redacting an overlapping
        // session value (for example `codex` or `2026`) would change that policy.
        // RunOutput validates those operational fields separately; only their
        // visible payload representation passes through text redaction.
        match event {
            MappedAgentEvent::Visible {
                kind,
                payload,
                humanized,
                ..
            } => MappedAgentEvent::Visible {
                kind: kind.clone(),
                payload: self.json(payload),
                humanized: humanized
                    .as_ref()
                    .map(|value| self.text(value, SUMMARY_LIMIT)),
                metadata,
            },
            MappedAgentEvent::Metadata { .. } => MappedAgentEvent::Metadata { metadata },
        }
    }

    pub(crate) fn historical_event(&self, kind: &AgentEventKind, payload: &Value) -> String {
        // Storage has decoded JSON already. Redact decoded strings before
        // serialization so escaped credentials cannot evade the boundary.
        let payload = self.json(payload).to_string();
        format!("{}: {}", kind.as_str(), self.text(&payload, 2048))
    }

    pub(crate) fn retry_prompt(&self, prompt: &str, context: &RetryContext) -> String {
        let safe = RetryContext {
            run_number: context.run_number,
            error_class: context.error_class.as_ref().map(|s| self.text(s, ID_LIMIT)),
            error_message: context.error_message.as_ref().map(|s| self.error(s)),
            recent_events: context
                .recent_events
                .iter()
                .take(10)
                .map(|s| self.text(s, 2304))
                .collect(),
        };
        let suffix = symphony_core::append_retry_context("", &safe);
        format!("{prompt}{}", self.text(&suffix, 32 * 1024))
    }
}

/// Bounded hook stderr capture which redacts before discarding a prefix. The
/// carry buffer is at most one read chunk plus the largest configured secret.
pub(crate) struct RedactedTail {
    sanitizer: OutputSanitizer,
    pending: Vec<u8>,
    retained: std::collections::VecDeque<u8>,
    limit: usize,
    longest: usize,
}

impl RedactedTail {
    pub(crate) fn new(sanitizer: OutputSanitizer, limit: usize) -> Self {
        let longest = sanitizer.secrets.iter().map(String::len).max().unwrap_or(1);
        Self {
            sanitizer,
            pending: Vec::new(),
            retained: std::collections::VecDeque::new(),
            limit,
            longest,
        }
    }

    pub(crate) fn push(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        self.drain(false);
    }

    fn drain(&mut self, final_chunk: bool) {
        let end = if final_chunk {
            self.pending.len()
        } else {
            self.pending.len().saturating_sub(self.longest - 1)
        };
        let mut consumed = 0;
        while consumed < end {
            let found = self
                .sanitizer
                .secrets
                .iter()
                .filter_map(|secret| {
                    self.pending[consumed..]
                        .windows(secret.len())
                        .position(|window| window == secret.as_bytes())
                        .map(|at| (consumed + at, secret.len()))
                })
                .filter(|(at, _)| *at < end)
                .min_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.cmp(&a.1)));
            let plain_end = found.map_or(end, |(at, _)| at);
            self.retained.extend(&self.pending[consumed..plain_end]);
            consumed = if let Some((at, len)) = found {
                self.retained.extend(REDACTED.as_bytes());
                at + len
            } else {
                end
            };
            let excess = self.retained.len().saturating_sub(self.limit);
            self.retained.drain(..excess);
        }
        self.pending.drain(..consumed);
    }

    pub(crate) fn finish(mut self) -> String {
        self.drain(true);
        let bytes = self.retained.into_iter().collect::<Vec<_>>();
        let value = String::from_utf8_lossy(&bytes);
        let mut start = value.len().saturating_sub(self.limit);
        while !value.is_char_boundary(start) {
            start += 1;
        }
        value[start..].to_string()
    }
}

fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace('-', "_");
    matches!(
        key.as_str(),
        "api_key"
            | "apikey"
            | "authorization"
            | "password"
            | "passwd"
            | "secret"
            | "token"
            | "credential"
            | "credentials"
            | "private_key"
            | "accesstoken"
            | "refreshtoken"
            | "clientsecret"
            | "privatekey"
            | "database_url"
            | "connection_string"
    ) || [
        "_api_key",
        "_key",
        "_key_id",
        "_apikey",
        "_token",
        "_secret",
        "_password",
        "_passwd",
        "_private_key",
        "_credentials",
        "_credential",
    ]
    .iter()
    .any(|suffix| key.ends_with(suffix))
        || ["_token_", "_secret_", "_password_"]
            .iter()
            .any(|part| key.contains(part))
}

fn append_bounded(output: &mut String, value: &str, limit: usize) -> bool {
    let available = limit.saturating_sub(output.len());
    if value.len() <= available {
        output.push_str(value);
        true
    } else {
        let mut end = available;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        output.push_str(&value[..end]);
        false
    }
}

fn mark_truncated(mut output: String, limit: usize) -> String {
    let mut end = output.len().min(limit.saturating_sub(TRUNCATED.len()));
    while !output.is_char_boundary(end) {
        end -= 1;
    }
    output.truncate(end);
    append_bounded(&mut output, TRUNCATED, limit);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_before_utf8_truncation_and_does_not_rewrite_replacement() {
        let sanitizer = OutputSanitizer::new(
            "canary-secret",
            &BTreeMap::new(),
            &BTreeMap::from([("CUSTOM".into(), "REDACTED".into())]),
        );
        let text = sanitizer.text(
            &format!("{}canary-secret{}", "界".repeat(10), "界".repeat(100)),
            48,
        );
        assert!(text.len() <= 48);
        assert!(!text.contains("canary"));
        assert_eq!(sanitizer.text("canary-secret", 100), REDACTED);
        assert!(!format!("{sanitizer:?}").contains("canary"));
    }

    #[test]
    fn nested_json_redacts_credentials_but_preserves_token_counts_and_bounds_size() {
        let sanitizer = OutputSanitizer::new("synthetic-key", &BTreeMap::new(), &BTreeMap::new());
        let safe = sanitizer.json(&serde_json::json!({
            "nested": [{"authorization": "unknown-credential", "text": "synthetic-key"}],
            "input_tokens": 123, "large": vec!["界".repeat(10_000); 300]
        }));
        let serialized = safe.to_string();
        assert!(serialized.len() <= JSON_LIMIT);
        assert!(!serialized.contains("synthetic-key"));
        assert!(!serialized.contains("unknown-credential"));
        let counts = sanitizer.json(&serde_json::json!({"input_tokens": 123}));
        assert_eq!(counts["input_tokens"], 123);
    }

    #[test]
    fn streaming_tail_redacts_across_chunks_before_dropping_large_prefixes() {
        let secret = format!("synthetic-canary-{}", "秘密".repeat(2000));
        let sanitizer = OutputSanitizer::new(&secret, &BTreeMap::new(), &BTreeMap::new());
        let input = format!(
            "{}{}{}{}done",
            "界".repeat(4000),
            secret,
            secret,
            "界".repeat(20)
        );
        for chunk_size in [1, 7, 4096, 16000] {
            let mut tail = RedactedTail::new(sanitizer.clone(), 4096);
            for chunk in input.as_bytes().chunks(chunk_size) {
                tail.push(chunk);
            }
            let output = tail.finish();
            assert!(!output.contains("秘密"));
            assert!(!output.contains("canary"));
            assert!(output.contains("[REDACTED]"));
            assert!(output.ends_with("done"));
            assert!(output.len() <= 4096);
        }
    }

    #[test]
    fn removes_credential_prefixes_cut_off_by_provider_adapter_truncation() {
        let sanitizer = OutputSanitizer::new(
            "canary-credential-value",
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        for prefix in ["c", "canary-", "canary-credential-val"] {
            assert_eq!(
                sanitizer.error(&format!("error: {prefix}...")),
                "error: [REDACTED]..."
            );
        }
        assert_eq!(sanitizer.error("unrelated failure"), "unrelated failure");
    }

    #[test]
    fn decoded_json_and_retry_context_remove_escaped_credentials() {
        let secret = "synthetic\"\ncredential";
        let sanitizer = OutputSanitizer::new(secret, &BTreeMap::new(), &BTreeMap::new());
        let payload = serde_json::json!({"output": secret});
        let context = RetryContext {
            run_number: 1,
            error_class: Some(secret.into()),
            error_message: Some(secret.into()),
            recent_events: vec![sanitizer.historical_event(&AgentEventKind::ToolCall, &payload)],
        };
        let prompt = sanitizer.retry_prompt("base", &context);
        assert!(prompt.starts_with("base"));
        assert!(!prompt.contains("synthetic"));
        assert!(prompt.contains(REDACTED));
    }
}
