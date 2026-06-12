use crate::types::{ParsedWorkflow, WorkflowFrontMatter};
use sha2::{Digest, Sha256};

/// Build a workflow from already-structured config plus a prompt template.
/// The source hash identifies this exact configuration in the `workflows`
/// audit table; serde_json over fixed-order structs is deterministic.
pub fn build_parsed_workflow(
    front_matter: WorkflowFrontMatter,
    prompt_template: String,
) -> ParsedWorkflow {
    let front_matter_json =
        serde_json::to_string(&front_matter).expect("workflow front matter serializes");
    let source_hash = hash(&format!("{front_matter_json}\n{prompt_template}"));
    ParsedWorkflow {
        front_matter,
        prompt_template,
        source_hash,
    }
}

/// Return the body of a legacy WORKFLOW.md (everything after the YAML front
/// matter), or `None` if the input has no front matter delimiters. Used only
/// to migrate pre-structured-settings `workflow_source` blobs.
pub fn strip_front_matter(raw: &str) -> Option<&str> {
    let trimmed = raw.strip_prefix("---\n")?;
    let end = trimmed.find("\n---")?;
    let rest = &trimmed[end + "\n---".len()..];
    Some(rest.strip_prefix('\n').unwrap_or(rest))
}

fn hash(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TrackerConfig;

    fn front_matter() -> WorkflowFrontMatter {
        WorkflowFrontMatter {
            tracker: TrackerConfig {
                api_key: "secret".to_string(),
                active_states: vec!["Todo".to_string()],
                terminal_states: vec!["Done".to_string()],
                ..TrackerConfig::default()
            },
            ..WorkflowFrontMatter::default()
        }
    }

    #[test]
    fn hash_is_stable_for_identical_config_and_changes_with_it() {
        let a = build_parsed_workflow(front_matter(), "Hello {{issue.identifier}}".to_string());
        let b = build_parsed_workflow(front_matter(), "Hello {{issue.identifier}}".to_string());
        assert_eq!(a.source_hash, b.source_hash);

        let other_prompt = build_parsed_workflow(front_matter(), "Different".to_string());
        assert_ne!(a.source_hash, other_prompt.source_hash);

        let mut fm = front_matter();
        fm.agent.max_concurrent_agents = 1;
        let other_config = build_parsed_workflow(fm, "Hello {{issue.identifier}}".to_string());
        assert_ne!(a.source_hash, other_config.source_hash);
    }

    #[test]
    fn strips_front_matter_to_prompt_body() {
        let raw = "---\ntracker:\n  api_key: x\n---\nHello {{issue.identifier}}\n";
        assert_eq!(
            strip_front_matter(raw),
            Some("Hello {{issue.identifier}}\n")
        );
        assert_eq!(strip_front_matter("no front matter"), None);
    }
}
