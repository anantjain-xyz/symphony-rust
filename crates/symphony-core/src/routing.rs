use crate::{
    project::LinearProjectRef,
    types::{Issue, RepoConfig},
};

/// Resolve which configured repository an issue's runs should clone.
///
/// Precedence, first match wins:
/// 1. A matching repo label on the issue: either `repo:<name>` or a bare label
///    exactly matching a configured repo name. If the issue carries a
///    `repo:<name>` label but no such label names a configured repo, the issue
///    is unroutable — the user stated an intent we cannot honor, and silently
///    falling through to a team or project default could dispatch an agent at
///    the wrong codebase.
/// 2. The repo claiming the issue's Linear project in `project_ids`.
/// 3. The repo claiming the issue's team key (identifier prefix, e.g. the
///    `ENG` in `ENG-42`) in `team_prefixes`.
/// 4. The repo marked `is_default`.
pub fn route_issue<'a>(repos: &'a [RepoConfig], issue: &Issue) -> Option<&'a RepoConfig> {
    let prefixed_labels: Vec<&str> = issue
        .labels
        .iter()
        .filter_map(|label| label_repo_name(label))
        .collect();
    if !prefixed_labels.is_empty() {
        // Compare against the trimmed name — the same form validation accepts
        // and the Settings UI advertises as the label to use.
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
    let project_id = issue.project_id.as_deref().map(str::trim);
    let project_slug_id = issue.project_slug_id.as_deref().map(str::trim);
    if project_id.is_some_and(|id| !id.is_empty())
        || project_slug_id.is_some_and(|slug_id| !slug_id.is_empty())
    {
        if let Some(repo) = repos.iter().find(|repo| {
            repo.project_ids.iter().any(|raw| {
                LinearProjectRef::parse(raw)
                    .is_some_and(|project| project.matches_project(project_id, project_slug_id))
            })
        }) {
            return Some(repo);
        }
    }
    if let Some((team_key, _)) = issue.identifier.split_once('-') {
        if let Some(repo) = repos.iter().find(|repo| {
            repo.team_prefixes.iter().any(|prefix| {
                let prefix = prefix.trim().trim_end_matches('-');
                !prefix.is_empty() && prefix.eq_ignore_ascii_case(team_key)
            })
        }) {
            return Some(repo);
        }
    }
    default_repo(repos)
}

/// The repo non-routed work falls back to: the one marked default. Also the
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

    fn issue(identifier: &str, labels: &[&str], project_id: Option<&str>) -> Issue {
        Issue {
            id: "lin-1".to_string(),
            identifier: identifier.to_string(),
            title: "Test".to_string(),
            description: None,
            priority: 1,
            state: "todo".to_string(),
            branch: None,
            labels: labels.iter().map(ToString::to_string).collect(),
            blockers: vec![],
            pr_urls: vec![],
            project_id: project_id.map(ToString::to_string),
            project_slug_id: None,
        }
    }

    fn issue_with_project_slug(identifier: &str, project_slug_id: &str) -> Issue {
        Issue {
            project_slug_id: Some(project_slug_id.to_string()),
            ..issue(identifier, &[], None)
        }
    }

    #[test]
    fn label_beats_project_and_team_defaults() {
        let mut by_team = repo("backend");
        by_team.team_prefixes = vec!["ENG".to_string()];
        let mut by_project = repo("mobile");
        by_project.project_ids = vec!["proj-1".to_string()];
        let labeled = repo("web");
        let repos = vec![by_team, by_project, labeled];

        let routed = route_issue(&repos, &issue("ENG-42", &["repo:web"], Some("proj-1")));
        assert_eq!(routed.map(|r| r.name.as_str()), Some("web"));

        let routed = route_issue(&repos, &issue("ENG-42", &["web"], Some("proj-1")));
        assert_eq!(routed.map(|r| r.name.as_str()), Some("web"));
    }

    #[test]
    fn label_matching_is_case_insensitive_and_trims() {
        // The configured name carries accidental padding; the label still
        // matches because both sides are trimmed.
        let repos = vec![repo(" Web-App ")];
        for label in [
            "repo:web-app",
            "REPO:Web-App",
            "  repo: web-app  ",
            "web-app",
            "  Web-App  ",
        ] {
            let routed = route_issue(&repos, &issue("ENG-1", &[label], None));
            assert_eq!(
                routed.map(|r| r.name.as_str()),
                Some(" Web-App "),
                "label {label:?}"
            );
        }
    }

    #[test]
    fn unmatched_repo_label_is_unroutable_even_with_a_default() {
        let mut fallback = repo("backend");
        fallback.is_default = true;
        let repos = vec![fallback];
        assert!(route_issue(&repos, &issue("ENG-1", &["repo:gone"], None)).is_none());
        // Non-repo labels do not trigger the explicit-label path.
        assert!(route_issue(&repos, &issue("ENG-1", &["bug", "repository"], None)).is_some());
    }

    #[test]
    fn prefixed_repo_label_takes_precedence_over_bare_label() {
        let mut fallback = repo("backend");
        fallback.is_default = true;
        let repos = vec![repo("web"), fallback];

        assert!(route_issue(&repos, &issue("ENG-1", &["repo:gone", "web"], None)).is_none());
    }

    #[test]
    fn project_beats_team_default() {
        let mut by_team = repo("backend");
        by_team.team_prefixes = vec!["ENG".to_string()];
        let mut by_project = repo("mobile");
        by_project.project_ids = vec!["proj-1".to_string()];
        let repos = vec![by_team, by_project];

        let routed = route_issue(&repos, &issue("ENG-42", &[], Some("proj-1")));
        assert_eq!(routed.map(|r| r.name.as_str()), Some("mobile"));
        let routed = route_issue(&repos, &issue("ENG-42", &[], Some("proj-other")));
        assert_eq!(routed.map(|r| r.name.as_str()), Some("backend"));
    }

    #[test]
    fn project_url_slug_beats_team_default() {
        let mut by_team = repo("backend");
        by_team.team_prefixes = vec!["ENG".to_string()];
        let mut by_project = repo("mobile");
        by_project.project_ids = vec![
            "https://linear.app/optimism-llc/project/phase-1-pre-launch-fixes-00bdaf30dd39/overview"
                .to_string(),
        ];
        let repos = vec![by_team, by_project];

        let routed = route_issue(
            &repos,
            &issue_with_project_slug("ENG-42", "phase-1-pre-launch-fixes-00bdaf30dd39"),
        );
        assert_eq!(routed.map(|r| r.name.as_str()), Some("mobile"));
    }

    #[test]
    fn team_prefix_accepts_either_form_and_ignores_case() {
        let mut by_team = repo("backend");
        by_team.team_prefixes = vec!["eng-".to_string()];
        let repos = vec![by_team, repo("other")];
        let routed = route_issue(&repos, &issue("ENG-42", &[], None));
        assert_eq!(routed.map(|r| r.name.as_str()), Some("backend"));
        // A bare prefix never matches a longer team key.
        assert!(route_issue(&repos, &issue("ENGINE-42", &[], None)).is_none());
    }

    #[test]
    fn overlapping_team_and_project_rules_use_configured_order() {
        let mut first = repo("first");
        first.team_prefixes = vec!["ENG".to_string()];
        first.project_ids = vec!["proj-1".to_string()];
        let mut second = repo("second");
        second.team_prefixes = vec!["eng-".to_string()];
        second.project_ids = vec![" proj-1 ".to_string()];

        let mut repos = vec![first, second];
        assert_eq!(
            route_issue(&repos, &issue("OPS-1", &[], Some("proj-1")))
                .map(|repo| repo.name.as_str()),
            Some("first")
        );
        assert_eq!(
            route_issue(&repos, &issue("ENG-1", &[], None)).map(|repo| repo.name.as_str()),
            Some("first")
        );

        repos.reverse();
        assert_eq!(
            route_issue(&repos, &issue("OPS-1", &[], Some("proj-1")))
                .map(|repo| repo.name.as_str()),
            Some("second")
        );
        assert_eq!(
            route_issue(&repos, &issue("ENG-1", &[], None)).map(|repo| repo.name.as_str()),
            Some("second")
        );
    }

    #[test]
    fn falls_back_only_to_an_explicit_default() {
        let mut fallback = repo("backend");
        fallback.is_default = true;
        let repos = vec![repo("web"), fallback];
        let routed = route_issue(&repos, &issue("OPS-1", &[], None));
        assert_eq!(routed.map(|r| r.name.as_str()), Some("backend"));

        let only = vec![repo("web")];
        assert!(route_issue(&only, &issue("OPS-1", &[], None)).is_none());

        let two_no_default = vec![repo("web"), repo("backend")];
        assert!(route_issue(&two_no_default, &issue("OPS-1", &[], None)).is_none());
        assert!(route_issue(&[], &issue("OPS-1", &[], None)).is_none());
    }
}
