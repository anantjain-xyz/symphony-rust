use crate::types::Issue;
use serde::{Deserialize, Serialize};
use specta::Type;

/// Placeholders supported in prompt templates, in `{{var}}` (or `{{ var }}`)
/// form. The Settings UI mirrors this list in its variable reference panel.
pub const PROMPT_VARIABLES: [&str; 8] = [
    "issue.id",
    "issue.identifier",
    "issue.title",
    "issue.description",
    "issue.state",
    "issue.branch",
    "issue.labels",
    "issue.blockers",
];

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct RetryContext {
    pub run_number: i64,
    pub error_class: Option<String>,
    pub error_message: Option<String>,
    pub recent_events: Vec<String>,
}

pub fn render_prompt(template: &str, issue: &Issue) -> String {
    let labels = issue.labels.join(", ");
    let blockers = issue
        .blockers
        .iter()
        .map(|blocker| format!("- {blocker}"))
        .collect::<Vec<_>>()
        .join("\n");
    template
        .replace("{{issue.id}}", &issue.id)
        .replace("{{ issue.id }}", &issue.id)
        .replace("{{issue.identifier}}", &issue.identifier)
        .replace("{{ issue.identifier }}", &issue.identifier)
        .replace("{{issue.title}}", &issue.title)
        .replace("{{ issue.title }}", &issue.title)
        .replace(
            "{{issue.description}}",
            issue.description.as_deref().unwrap_or(""),
        )
        .replace(
            "{{ issue.description }}",
            issue.description.as_deref().unwrap_or(""),
        )
        .replace("{{issue.state}}", &issue.state)
        .replace("{{ issue.state }}", &issue.state)
        .replace("{{issue.branch}}", issue.branch.as_deref().unwrap_or(""))
        .replace("{{ issue.branch }}", issue.branch.as_deref().unwrap_or(""))
        .replace("{{issue.labels}}", &labels)
        .replace("{{ issue.labels }}", &labels)
        .replace("{{issue.blockers}}", &blockers)
        .replace("{{ issue.blockers }}", &blockers)
}

pub fn append_retry_context(prompt: &str, ctx: &RetryContext) -> String {
    let mut out = String::from(prompt);
    out.push_str("\n\n## Retry context\n");
    out.push_str(&format!("Prior failed run: #{}\n", ctx.run_number));
    if let Some(class) = &ctx.error_class {
        out.push_str(&format!("Error class: {class}\n"));
    }
    if let Some(message) = &ctx.error_message {
        out.push_str(&format!("Error message: {message}\n"));
    }
    if !ctx.recent_events.is_empty() {
        out.push_str("\nRecent events:\n");
        for event in &ctx.recent_events {
            out.push_str("- ");
            out.push_str(event);
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_basic_issue_fields() {
        let issue = Issue {
            id: "lin-1".to_string(),
            identifier: "SYM-1".to_string(),
            title: "Port it".to_string(),
            description: Some("Details".to_string()),
            priority: 1,
            state: "todo".to_string(),
            branch: None,
            labels: vec![],
            blockers: vec![],
            pr_urls: vec![],
        };
        assert_eq!(
            render_prompt("Work on {{issue.identifier}}: {{ issue.title }}", &issue),
            "Work on SYM-1: Port it"
        );
    }

    #[test]
    fn renders_labels_and_blockers_as_lists() {
        let issue = Issue {
            id: "lin-1".to_string(),
            identifier: "SYM-1".to_string(),
            title: "Port it".to_string(),
            description: None,
            priority: 1,
            state: "todo".to_string(),
            branch: None,
            labels: vec!["bug".to_string(), "ui".to_string()],
            blockers: vec!["SYM-2".to_string()],
            pr_urls: vec![],
        };
        assert_eq!(
            render_prompt("Labels: {{issue.labels}}\n{{ issue.blockers }}", &issue),
            "Labels: bug, ui\n- SYM-2"
        );
    }

    #[test]
    fn renders_empty_labels_and_blockers_as_empty_strings() {
        let issue = Issue {
            id: "lin-1".to_string(),
            identifier: "SYM-1".to_string(),
            title: "Port it".to_string(),
            description: None,
            priority: 1,
            state: "todo".to_string(),
            branch: None,
            labels: vec![],
            blockers: vec![],
            pr_urls: vec![],
        };
        assert_eq!(
            render_prompt("[{{issue.labels}}][{{issue.blockers}}]", &issue),
            "[][]"
        );
    }
}
