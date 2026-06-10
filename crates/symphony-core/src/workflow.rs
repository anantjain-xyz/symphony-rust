use crate::types::{ParsedWorkflow, WorkflowFrontMatter};
use regex::Regex;
use serde_yaml::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkflowError {
    #[error("workflow must start with YAML front matter delimited by ---")]
    MissingFrontMatter,
    #[error("workflow front matter is not valid YAML: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("workflow front matter is missing required tracker configuration")]
    MissingTracker,
}

pub fn parse_workflow_source(
    raw: &str,
    env: &BTreeMap<String, String>,
) -> Result<ParsedWorkflow, WorkflowError> {
    let (front_matter_raw, prompt_template) = split_front_matter(raw)?;
    let source_hash = hash(raw);
    let mut value: Value = serde_yaml::from_str(front_matter_raw)?;
    let hooks = extract_hooks(&value);
    interpolate_value(&mut value, env);
    restore_hooks(&mut value, hooks);
    drop_empty_optional_tracker_strings(&mut value);
    let front_matter: WorkflowFrontMatter = serde_yaml::from_value(value)?;
    if front_matter.tracker.kind != "linear" || front_matter.tracker.active_states.is_empty() {
        return Err(WorkflowError::MissingTracker);
    }
    Ok(ParsedWorkflow {
        front_matter,
        prompt_template: prompt_template.to_string(),
        source_hash,
    })
}

pub fn resolve_workspace_root(root: &str, env: &BTreeMap<String, String>) -> String {
    expand_string(root, env)
}

fn split_front_matter(raw: &str) -> Result<(&str, &str), WorkflowError> {
    let trimmed = raw
        .strip_prefix("---\n")
        .ok_or(WorkflowError::MissingFrontMatter)?;
    let end = trimmed
        .find("\n---")
        .ok_or(WorkflowError::MissingFrontMatter)?;
    let fm = &trimmed[..end];
    let rest = &trimmed[end + "\n---".len()..];
    let rest = rest.strip_prefix('\n').unwrap_or(rest);
    Ok((fm, rest))
}

fn extract_hooks(value: &Value) -> Option<Value> {
    value
        .as_mapping()
        .and_then(|m| m.get(Value::String("hooks".to_string())).cloned())
}

fn restore_hooks(value: &mut Value, hooks: Option<Value>) {
    let Some(hooks) = hooks else {
        return;
    };
    if let Some(map) = value.as_mapping_mut() {
        map.insert(Value::String("hooks".to_string()), hooks);
    }
}

fn drop_empty_optional_tracker_strings(value: &mut Value) {
    let Some(map) = value.as_mapping_mut() else {
        return;
    };
    let Some(tracker) = map
        .get_mut(Value::String("tracker".to_string()))
        .and_then(Value::as_mapping_mut)
    else {
        return;
    };
    for key in [
        "workspace",
        "project_slug",
        "project_url",
        "identifier_prefix",
        "project_id",
    ] {
        let yaml_key = Value::String(key.to_string());
        let should_remove = tracker
            .get(&yaml_key)
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(str::is_empty);
        if should_remove {
            tracker.remove(&yaml_key);
        }
    }
}

fn interpolate_value(value: &mut Value, env: &BTreeMap<String, String>) {
    match value {
        Value::String(s) => *s = expand_string(s, env),
        Value::Sequence(items) => {
            for item in items {
                interpolate_value(item, env);
            }
        }
        Value::Mapping(map) => {
            for (_key, value) in map {
                interpolate_value(value, env);
            }
        }
        _ => {}
    }
}

fn expand_string(input: &str, env: &BTreeMap<String, String>) -> String {
    // Supports ${VAR} and shell-style ${VAR:-default}. Like the shell, the
    // default applies when the variable is unset *or* empty.
    let re = Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")
        .expect("valid interpolation regex");
    re.replace_all(input, |caps: &regex::Captures<'_>| {
        let value = env.get(&caps[1]).cloned().unwrap_or_default();
        if value.is_empty() {
            caps.get(2)
                .map(|default| default.as_str().to_string())
                .unwrap_or_default()
        } else {
            value
        }
    })
    .to_string()
}

fn hash(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolates_non_hook_strings_and_restores_hooks() {
        let raw = r#"---
tracker:
  kind: linear
  api_key: ${LINEAR_API_KEY}
  active_states: [Todo]
  terminal_states: [Done]
workspace:
  root: ${TMPDIR}/symphony-workspaces
hooks:
  after_create: echo "$REPO_URL ${LINEAR_API_KEY}"
---
Hello {{issue.identifier}}
"#;
        let env = BTreeMap::from([
            ("LINEAR_API_KEY".to_string(), "secret".to_string()),
            ("TMPDIR".to_string(), "/tmp".to_string()),
        ]);
        let parsed = parse_workflow_source(raw, &env).unwrap();
        assert_eq!(parsed.front_matter.tracker.api_key, "secret");
        assert_eq!(
            parsed.front_matter.workspace.root,
            "/tmp/symphony-workspaces"
        );
        assert_eq!(
            parsed.front_matter.hooks.after_create.as_deref(),
            Some("echo \"$REPO_URL ${LINEAR_API_KEY}\"")
        );
    }

    #[test]
    fn expands_shell_style_defaults_for_unset_and_empty_vars() {
        let env = BTreeMap::from([
            ("SET".to_string(), "value".to_string()),
            ("EMPTY".to_string(), String::new()),
        ]);
        assert_eq!(expand_string("${SET:-fallback}", &env), "value");
        assert_eq!(expand_string("${EMPTY:-fallback}", &env), "fallback");
        assert_eq!(expand_string("${UNSET:-fallback}", &env), "fallback");
        assert_eq!(expand_string("${UNSET:-}", &env), "");
        assert_eq!(expand_string("${UNSET}", &env), "");
        // Defaults may contain anything but a closing brace, e.g. paths.
        assert_eq!(
            expand_string("${UNSET:-npm ci --prefer-offline}", &env),
            "npm ci --prefer-offline"
        );
    }
}
