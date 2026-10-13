//! Typed, validated fields that affect terminal outcomes and token accounting.
//! Unknown record kinds and provider-specific extra fields remain opaque.
use serde::{de::DeserializeOwned, Deserialize, Deserializer};
use serde_json::Value;
use symphony_core::TokenCountPayload;

use crate::AgentError;

pub(crate) fn decode<T: DeserializeOwned>(
    backend: &'static str,
    event: &'static str,
    value: &Value,
) -> Result<T, AgentError> {
    serde_json::from_value(value.clone()).map_err(|error| AgentError::Protocol {
        backend,
        event,
        message: error.to_string(),
    })
}

// Serde structs also accept sequence representations; provider objects must
// stay objects so an empty array cannot masquerade as empty/default usage.
fn object<'de, D: Deserializer<'de>, T: DeserializeOwned>(deserializer: D) -> Result<T, D::Error> {
    let value = Value::deserialize(deserializer)?;
    if !value.is_object() {
        return Err(serde::de::Error::custom("expected an object"));
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}
fn optional_object<'de, D: Deserializer<'de>, T: DeserializeOwned>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    let value = Option::<Value>::deserialize(deserializer)?;
    value
        .map(|value| {
            if !value.is_object() {
                return Err(serde::de::Error::custom("expected an object"));
            }
            serde_json::from_value(value).map_err(serde::de::Error::custom)
        })
        .transpose()
}

fn nonnegative<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    let count = i64::deserialize(deserializer)?;
    if count < 0 {
        return Err(serde::de::Error::custom("token count must be nonnegative"));
    }
    Ok(count)
}

pub(crate) fn token_sum(
    backend: &'static str,
    event: &'static str,
    counts: &[i64],
) -> Result<i64, AgentError> {
    counts.iter().try_fold(0_i64, |total, count| {
        total
            .checked_add(*count)
            .ok_or_else(|| AgentError::Protocol {
                backend,
                event,
                message: "token total exceeds supported range".to_string(),
            })
    })
}

pub(crate) fn tokens(
    backend: &'static str,
    event: &'static str,
    input: &[i64],
    output: &[i64],
) -> Result<TokenCountPayload, AgentError> {
    let input_tokens = token_sum(backend, event, input)?;
    let output_tokens = token_sum(backend, event, output)?;
    let total_tokens = token_sum(backend, event, &[input_tokens, output_tokens])?;
    Ok(TokenCountPayload {
        input_tokens,
        output_tokens,
        total_tokens,
    })
}

// Missing usage and buckets are valid in older CLIs. A present value must have
// the expected shape; null, strings, negative counts, and overflow are errors.
#[derive(Default, Deserialize)]
pub(crate) struct SnakeUsage {
    #[serde(default, deserialize_with = "nonnegative")]
    pub input_tokens: i64,
    #[serde(default, deserialize_with = "nonnegative")]
    pub output_tokens: i64,
    #[serde(default, deserialize_with = "nonnegative")]
    pub cache_creation_input_tokens: i64,
    #[serde(default, deserialize_with = "nonnegative")]
    pub cache_read_input_tokens: i64,
}

#[derive(Default, Deserialize)]
pub(crate) struct CodexUsage {
    #[serde(default, deserialize_with = "nonnegative")]
    pub input_tokens: i64,
    #[serde(default, deserialize_with = "nonnegative")]
    pub output_tokens: i64,
}

#[derive(Deserialize)]
pub(crate) struct CodexCompleted {
    #[serde(default, deserialize_with = "object")]
    pub usage: CodexUsage,
}

#[derive(Deserialize)]
pub(crate) struct CodexFailed {
    #[serde(deserialize_with = "object")]
    pub error: CodexError,
}
#[derive(Deserialize)]
pub(crate) struct CodexError {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub message: Option<String>,
}

#[derive(Deserialize)]
#[serde(bound(deserialize = "U: Default + DeserializeOwned"))]
pub(crate) struct ResultRecord<U: Default + DeserializeOwned> {
    pub subtype: ResultSubtype,
    #[serde(default)]
    pub is_error: bool,
    pub result: Option<String>,
    pub error: Option<String>,
    #[serde(default, deserialize_with = "object")]
    pub usage: U,
}

// Only the documented success tag authorizes success. Preserve every other
// nonempty provider code for diagnostics without promoting future tags to success.
pub(crate) enum ResultSubtype {
    Success,
    FailureCode(String),
}

impl ResultSubtype {
    pub fn is_success(&self) -> bool {
        matches!(self, Self::Success)
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Success => "success",
            Self::FailureCode(code) => code,
        }
    }
}

impl<'de> Deserialize<'de> for ResultSubtype {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.trim().is_empty() {
            return Err(serde::de::Error::custom("result subtype must not be empty"));
        }
        Ok(if value == "success" {
            Self::Success
        } else {
            Self::FailureCode(value)
        })
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CursorUsage {
    #[serde(default, deserialize_with = "nonnegative")]
    pub input_tokens: i64,
    #[serde(default, deserialize_with = "nonnegative")]
    pub output_tokens: i64,
    #[serde(default, deserialize_with = "nonnegative")]
    pub cache_read_tokens: i64,
    #[serde(default, deserialize_with = "nonnegative")]
    pub cache_write_tokens: i64,
}

#[derive(Deserialize)]
pub(crate) struct OpencodeStep {
    #[serde(deserialize_with = "object")]
    pub part: OpencodeStepPart,
}
#[derive(Deserialize)]
pub(crate) struct OpencodeStepPart {
    #[serde(default, deserialize_with = "object")]
    pub tokens: OpencodeTokens,
}
#[derive(Default, Deserialize)]
pub(crate) struct OpencodeTokens {
    #[serde(default, deserialize_with = "nonnegative")]
    pub input: i64,
    #[serde(default, deserialize_with = "nonnegative")]
    pub output: i64,
    #[serde(default, deserialize_with = "nonnegative")]
    pub reasoning: i64,
    #[serde(default, deserialize_with = "object")]
    pub cache: OpencodeCache,
}
#[derive(Default, Deserialize)]
pub(crate) struct OpencodeCache {
    #[serde(default, deserialize_with = "nonnegative")]
    pub read: i64,
    #[serde(default, deserialize_with = "nonnegative")]
    pub write: i64,
}

#[derive(Deserialize)]
pub(crate) struct OpencodeErrorRecord {
    #[serde(deserialize_with = "object")]
    pub error: OpencodeError,
}
#[derive(Deserialize)]
pub(crate) struct OpencodeError {
    pub name: Option<String>,
    pub message: Option<String>,
    #[serde(default, deserialize_with = "optional_object")]
    pub data: Option<OpencodeErrorData>,
}
#[derive(Deserialize)]
pub(crate) struct OpencodeErrorData {
    pub message: Option<String>,
    #[serde(rename = "statusCode")]
    pub status_code: Option<u16>,
}
