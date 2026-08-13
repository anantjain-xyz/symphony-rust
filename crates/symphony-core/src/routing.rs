use crate::types::{Issue, RepoConfig};

/// Resolve which configured repository an issue's runs should clone.
///
/// Precedence, first match wins:
/// 1. A matching repo label on the issue: either `repo:<name>` or a bare label
///    exactly matching a configured repo name. If the issue carries a
///    `repo:<name>` label but no such label names a configured repo, the issue
///    is unroutable — the user stated an intent we cannot honor, and silently
///    falling through to the default could dispatch an agent at the wrong
///    codebase.
/// 2. The repo marked `is_default`.
///
/// Linear team and project settings filter which issues Symphony watches; they
/// never select a repository.
pub fn route_issue<'a>(repos: &'a [RepoConfig], issue: &Issue) -> Option<&'a RepoConfig> {
    let prefixed_labels: Vec<&str> = issue
        .labels
        .iter()
        .filter_map(|label| label_repo_name(label))
        .collect();
    if !prefixed_labels.is_empty() {
        return prefixed_labels
            .iter()
            .find_map(|name| repo_named(repos, name));
    }
    if let Some(repo) = issue
        .labels
        .iter()
        .find_map(|label| repo_named(repos, label))
    {
        return Some(repo);
    }
    default_repo(repos)
}

/// The repo non-labeled work falls back to: the one marked default. Also the
/// target for repo-scoped actions taken outside any issue context (e.g. the
/// skills install).
pub fn default_repo(repos: &[RepoConfig]) -> Option<&RepoConfig> {
    repos.iter().find(|repo| repo.is_default)
}

/// The repo name carried by a `repo:<name>` label, if this is one.
fn label_repo_name(label: &str) -> Option<&str> {
    let trimmed = label.trim();
    let prefix = trimmed.get(..5)?;
    if !prefix.eq_ignore_ascii_case("repo:") {
        return None;
    }
    Some(trimmed[5..].trim()).filter(|name| !name.is_empty())
}

fn repo_named<'a>(repos: &'a [RepoConfig], name: &str) -> Option<&'a RepoConfig> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    repos
        .iter()
        .find(|repo| repo.name.trim().eq_ignore_ascii_case(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(name: &str) -> RepoConfig {
        RepoConfig {
            name: name.to_string(),
            url: format!("git@github.com:acme/{name}.git"),
            ..RepoConfig::default()
        }
    }

    fn issue(labels: &[&str]) -> Issue {
        Issue {
            id: "lin-1".to_string(),
            identifier: "ENG-42".to_string(),
            title: "Test".to_string(),
            description: None,
            priority: 1,
            state: "todo".to_string(),
            branch: None,
            labels: labels.iter().map(ToString::to_string).collect(),
            blockers: vec![],
            completed_at: None,
            canceled_at: None,
            project_id: Some("proj-1".to_string()),
            project_slug_id: None,
        }
    }

    #[test]
    fn routes_prefixed_or_bare_repo_labels() {
        let repos = vec![repo("backend"), repo("web")];
        for label in ["repo:web", "REPO:Web", "  repo: web  ", "web", " Web "] {
            let routed = route_issue(&repos, &issue(&[label]));
            assert_eq!(routed.map(|r| r.name.as_str()), Some("web"), "{label:?}");
        }
    }

    #[test]
    fn unmatched_repo_label_is_unroutable_even_with_a_default() {
        let mut fallback = repo("backend");
        fallback.is_default = true;
        let repos = vec![fallback];
        assert!(route_issue(&repos, &issue(&["repo:gone"])).is_none());
        assert!(route_issue(&repos, &issue(&["bug", "repository"])).is_some());
    }

    #[test]
    fn prefixed_repo_label_takes_precedence_over_bare_label() {
        let mut fallback = repo("backend");
        fallback.is_default = true;
        let repos = vec![repo("web"), fallback];
        assert!(route_issue(&repos, &issue(&["repo:gone", "web"])).is_none());
    }

    #[test]
    fn falls_back_only_to_an_explicit_default() {
        let mut fallback = repo("backend");
        fallback.is_default = true;
        let repos = vec![repo("web"), fallback];
        assert_eq!(
            route_issue(&repos, &issue(&[])).map(|r| r.name.as_str()),
            Some("backend")
        );
        assert!(route_issue(&[repo("web")], &issue(&[])).is_none());
        assert!(route_issue(&[repo("web"), repo("backend")], &issue(&[])).is_none());
        assert!(route_issue(&[], &issue(&[])).is_none());
    }

    #[test]
    fn project_and_team_metadata_do_not_route() {
        let repos = vec![repo("web"), repo("backend")];
        // The fixture belongs to ENG/proj-1, but routing ignores both fields.
        assert!(route_issue(&repos, &issue(&[])).is_none());
    }
}
