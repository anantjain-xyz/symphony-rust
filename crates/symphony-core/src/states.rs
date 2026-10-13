//! Closed states shared by persistence and presentation.
use crate::{AgentEventKind, RunStatus};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidState {
    pub kind: &'static str,
    pub value: String,
}
impl std::fmt::Display for InvalidState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid {}: {}", self.kind, self.value)
    }
}
impl std::error::Error for InvalidState {}

macro_rules! string_conversion {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        impl $name {
            pub fn as_str(&self) -> &'static str { match self { $(Self::$variant => $value),+ } }
        }
        impl std::str::FromStr for $name {
            type Err = InvalidState;
            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value { $($value => Ok(Self::$variant),)+ _ => Err(InvalidState { kind: stringify!($name), value: value.to_owned() }) }
            }
        }
        impl TryFrom<String> for $name {
            type Error = InvalidState;
            fn try_from(value: String) -> Result<Self, InvalidState> { value.parse() }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(self.as_str()) }
        }
    };
}
macro_rules! state {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
        pub enum $name { $(#[serde(rename = $value)] $variant),+ }
        string_conversion!($name { $($variant => $value),+ });
    };
}
string_conversion!(RunStatus { Pending => "pending", Running => "running", Success => "success", Failure => "failure", Timeout => "timeout", Cancelled => "cancelled" });
string_conversion!(AgentEventKind { Status => "status", ToolCall => "tool_call", Approval => "approval", TokenCount => "token_count", Error => "error", UserInput => "user_input", Humanized => "humanized", RateLimit => "rate_limit" });
state!(RetroState { Running => "running", Completed => "completed", Failed => "failed" });
state!(ProposalState { Ready => "ready", Unavailable => "unavailable" });
state!(SuggestionDecision { Pending => "pending", Accepted => "accepted", Rejected => "rejected" });
state!(SuggestionTarget { Prompt => "prompt", RepoWorkflow => "repo_workflow", Skill => "skill" });
state!(SuggestionConfidence { Low => "low", Medium => "medium", High => "high" });
state!(BatchState { Queued => "queued", Running => "running", Completed => "completed", Failed => "failed", Stale => "stale" });
state!(BatchKind { WorkflowUpdate => "workflow_update", RepoPr => "repo_pr" });
