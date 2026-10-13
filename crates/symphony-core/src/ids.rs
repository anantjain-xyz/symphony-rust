//! Provider identifiers are opaque, but their roles are not interchangeable.
use serde::{Deserialize, Serialize};

macro_rules! identifier {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);
        impl $name {
            pub fn new(value: impl AsRef<str>) -> Self {
                Self(value.as_ref().to_owned())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}
identifier!(AgentSessionId);
identifier!(AgentThreadId);
identifier!(AgentTurnId);

/// A thread ID cannot accidentally occupy the adjacent turn ID argument.
/// ```compile_fail
/// use symphony_core::{AgentThreadId, AgentTurnId};
/// fn turn(_: &AgentTurnId) {}
/// turn(&AgentThreadId::new("opaque-provider-id"));
/// ```
const _: () = ();
