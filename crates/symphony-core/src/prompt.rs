use crate::types::{Issue, RepoConfig};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Placeholders supported in prompt templates, in `{{var}}` form (whitespace
/// inside the braces is ignored). The Settings UI mirrors this list in its
/// variable reference panel.
pub const PROMPT_VARIABLES: [&str; 10] = [
    "issue.id",
    "issue.identifier",
    "issue.title",
    "issue.description",
    "issue.state",
    "issue.branch",
    "issue.labels",
    "issue.blockers",
    "repo.name",
    "repo.url",
];

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct RetryContext {
    pub run_number: i64,
    pub error_class: Option<String>,
    pub error_message: Option<String>,
    pub recent_events: Vec<String>,
}

pub fn render_prompt(template: &str, issue: &Issue, repo: Option<&RepoConfig>) -> String {
    let labels = issue.labels.join(", ");
    let blockers = issue
        .blockers
        .iter()
        .map(|blocker| format!("- {blocker}"))
        .collect::<Vec<_>>()
        .join("\n");
    // Same order as PROMPT_VARIABLES, so the two cannot drift apart.
    let values: [&str; 10] = [
        &issue.id,
        &issue.identifier,
        &issue.title,
        issue.description.as_deref().unwrap_or(""),
        &issue.state,
        issue.branch.as_deref().unwrap_or(""),
        &labels,
        &blockers,
        repo.map(|repo| repo.name.as_str()).unwrap_or(""),
        repo.map(|repo| repo.url.as_str()).unwrap_or(""),
    ];
    let value_for = |name: &str| {
        PROMPT_VARIABLES
            .iter()
            .position(|variable| *variable == name)
            .map(|index| values[index])
    };

    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let Some(end) = rest[start + 2..].find("}}") else {
            break;
        };
        match value_for(rest[start + 2..start + 2 + end].trim()) {
            Some(value) => {
                out.push_str(&rest[..start]);
                out.push_str(value);
                rest = &rest[start + 2 + end + 2..];
            }
            None => {
                // Not a known variable (e.g. literal braces in prose) — keep
                // it verbatim and continue past the opening braces, since the
                // matching "}}" may belong to a later placeholder.
                out.push_str(&rest[..start + 2]);
                rest = &rest[start + 2..];
            }
        }
    }
    out.push_str(rest);
    out
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

    fn issue() -> Issue {
        Issue {
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
            project_id: None,
            project_slug_id: None,
        }
    }

    #[test]
    fn renders_basic_issue_fields() {
        let issue = Issue {
            description: Some("Details".to_string()),
            ..issue()
        };
        assert_eq!(
            render_prompt(
                "Work on {{issue.identifier}}: {{ issue.title }}",
                &issue,
                None
            ),
            "Work on SYM-1: Port it"
        );
    }

    #[test]
    fn renders_repo_fields_when_routed_and_empty_otherwise() {
        let repo = RepoConfig {
            name: "widgets".to_string(),
            url: "git@github.com:acme/widgets.git".to_string(),
            ..RepoConfig::default()
        };
        assert_eq!(
            render_prompt("{{repo.name}} at {{ repo.url }}", &issue(), Some(&repo)),
            "widgets at git@github.com:acme/widgets.git"
        );
        assert_eq!(
            render_prompt("[{{repo.name}}][{{repo.url}}]", &issue(), None),
            "[][]"
        );
    }

    #[test]
    fn renders_any_whitespace_inside_braces_and_keeps_unknown_tokens() {
        let issue = issue();
        assert_eq!(
            render_prompt("{{  issue.title  }} / {{ issue.identifier}}", &issue, None),
            "Port it / SYM-1"
        );
        // Unknown tokens and literal braces pass through; later placeholders
        // on the same line still render.
        assert_eq!(
            render_prompt("{{issue.nope}} {{\"k\": 1}} {{issue.state}}", &issue, None),
            "{{issue.nope}} {{\"k\": 1}} todo"
        );
    }

    #[test]
    fn renders_labels_and_blockers_as_lists() {
        let issue = Issue {
            labels: vec!["bug".to_string(), "ui".to_string()],
            blockers: vec!["SYM-2".to_string()],
            ..issue()
        };
        assert_eq!(
            render_prompt(
                "Labels: {{issue.labels}}\n{{ issue.blockers }}",
                &issue,
                None
            ),
            "Labels: bug, ui\n- SYM-2"
        );
    }

    #[test]
    fn renders_empty_labels_and_blockers_as_empty_strings() {
        assert_eq!(
            render_prompt("[{{issue.labels}}][{{issue.blockers}}]", &issue(), None),
            "[][]"
        );
    }
}
