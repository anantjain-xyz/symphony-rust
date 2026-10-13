//! Pure scheduling policy. The caller gathers facts and executes the returned
//! plan through the single workspace-claim/run-reservation boundary.
use symphony_core::{route_issue, Issue, RepoConfig};

#[derive(Debug, Clone, Copy)]
pub(crate) enum DispatchMode {
    Active,
    Retry { run_number: i64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SkipReason {
    Missing,
    Inactive,
    Blocked,
    RetryQueued,
    Suppressed,
    AlreadyRunning,
    NoRepository,
    AtCapacity,
    RateLimited,
    NoResumeState,
}

impl SkipReason {
    pub(crate) fn clears_retry(self) -> bool {
        matches!(
            self,
            Self::Missing | Self::Inactive | Self::NoRepository | Self::NoResumeState
        )
    }

    pub(crate) fn pauses_dispatch(self) -> bool {
        matches!(self, Self::AtCapacity | Self::RateLimited)
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Admission {
    pub active_runs: i64,
    pub max_concurrent: usize,
    pub rate_limited: bool,
}

impl Admission {
    pub(crate) fn skip(self) -> Option<SkipReason> {
        if self.rate_limited {
            Some(SkipReason::RateLimited)
        } else if self.active_runs < 0 || self.active_runs as u64 >= self.max_concurrent as u64 {
            Some(SkipReason::AtCapacity)
        } else {
            None
        }
    }
}

pub(crate) struct EligibilityFacts<'a> {
    pub issue: Option<&'a Issue>,
    pub repos: &'a [RepoConfig],
    pub active_states: &'a [String],
    pub mode: DispatchMode,
    pub has_active_run: bool,
    pub retry_queued: bool,
    pub suppression_matches: bool,
    pub admission: Admission,
}

#[derive(Debug)]
pub(crate) struct DispatchPlan<'a> {
    pub issue: &'a Issue,
    pub repository: &'a RepoConfig,
    pub run_number: Option<i64>,
}

#[derive(Debug)]
pub(crate) enum EligibilityDecision<'a> {
    Skip(SkipReason),
    Dispatch(DispatchPlan<'a>),
}

pub(crate) fn decide(facts: EligibilityFacts<'_>) -> EligibilityDecision<'_> {
    use EligibilityDecision::{Dispatch, Skip};
    let Some(issue) = facts.issue else {
        return Skip(SkipReason::Missing);
    };
    if !facts
        .active_states
        .iter()
        .any(|state| state.eq_ignore_ascii_case(&issue.state))
    {
        return Skip(SkipReason::Inactive);
    }
    if !issue.blockers.is_empty() {
        return Skip(SkipReason::Blocked);
    }
    if matches!(facts.mode, DispatchMode::Active) {
        if facts.retry_queued {
            return Skip(SkipReason::RetryQueued);
        }
        if facts.suppression_matches {
            return Skip(SkipReason::Suppressed);
        }
    }
    if facts.has_active_run {
        return Skip(SkipReason::AlreadyRunning);
    }
    if let Some(reason) = facts.admission.skip() {
        return Skip(reason);
    }
    let Some(repository) = route_issue(facts.repos, issue) else {
        return Skip(SkipReason::NoRepository);
    };
    Dispatch(DispatchPlan {
        issue,
        repository,
        run_number: match facts.mode {
            DispatchMode::Active => None,
            DispatchMode::Retry { run_number } => Some(run_number),
        },
    })
}

/// An explicit retry reverses the user-stop transition before eligibility is
/// evaluated; blocked issues retain that retry until the blocker clears.
pub(crate) fn retry_resume_state<'a>(
    issue: &Issue,
    explicitly_requested: bool,
    stopped_state: &str,
    active_states: &'a [String],
) -> Result<Option<&'a str>, SkipReason> {
    if !explicitly_requested || !issue.state.eq_ignore_ascii_case(stopped_state) {
        return Ok(None);
    }
    active_states
        .iter()
        .find(|state| !state.eq_ignore_ascii_case(stopped_state))
        .or_else(|| active_states.first())
        .map(|state| Some(state.as_str()))
        .ok_or(SkipReason::NoResumeState)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue() -> Issue {
        Issue {
            id: "one".into(),
            identifier: "SYM-1".into(),
            title: "task".into(),
            description: None,
            priority: 1,
            state: "todo".into(),
            branch: None,
            labels: vec![],
            blockers: vec![],
            completed_at: None,
            canceled_at: None,
            project_id: None,
            project_slug_id: None,
        }
    }

    #[test]
    fn decisions_explain_skips_and_preserve_retry_ownership() {
        let issue = issue();
        let repos = [RepoConfig {
            name: "default".into(),
            is_default: true,
            ..RepoConfig::default()
        }];
        let active_states = ["Todo".into()];
        let base = || EligibilityFacts {
            issue: Some(&issue),
            repos: &repos,
            active_states: &active_states,
            mode: DispatchMode::Active,
            has_active_run: false,
            retry_queued: false,
            suppression_matches: false,
            admission: Admission {
                active_runs: 0,
                max_concurrent: 2,
                rate_limited: false,
            },
        };
        for (expected, facts) in [
            (
                SkipReason::Missing,
                EligibilityFacts {
                    issue: None,
                    ..base()
                },
            ),
            (
                SkipReason::Inactive,
                EligibilityFacts {
                    active_states: &[],
                    ..base()
                },
            ),
            (
                SkipReason::RetryQueued,
                EligibilityFacts {
                    retry_queued: true,
                    ..base()
                },
            ),
            (
                SkipReason::Suppressed,
                EligibilityFacts {
                    suppression_matches: true,
                    ..base()
                },
            ),
            (
                SkipReason::AlreadyRunning,
                EligibilityFacts {
                    has_active_run: true,
                    ..base()
                },
            ),
            (
                SkipReason::NoRepository,
                EligibilityFacts {
                    repos: &[],
                    ..base()
                },
            ),
            (
                SkipReason::AtCapacity,
                EligibilityFacts {
                    admission: Admission {
                        active_runs: 2,
                        ..base().admission
                    },
                    ..base()
                },
            ),
            (
                SkipReason::RateLimited,
                EligibilityFacts {
                    admission: Admission {
                        rate_limited: true,
                        ..base().admission
                    },
                    ..base()
                },
            ),
        ] {
            assert!(
                matches!(decide(facts), EligibilityDecision::Skip(actual) if actual == expected),
                "{expected:?}"
            );
        }
        let EligibilityDecision::Dispatch(plan) = decide(EligibilityFacts {
            mode: DispatchMode::Retry { run_number: 7 },
            retry_queued: true,
            suppression_matches: true,
            ..base()
        }) else {
            panic!("explicit retry should own dispatch");
        };
        assert_eq!(plan.run_number, Some(7));
        assert_eq!(plan.repository.name, "default");
        for reason in [
            SkipReason::Blocked,
            SkipReason::AlreadyRunning,
            SkipReason::AtCapacity,
            SkipReason::RateLimited,
        ] {
            assert!(!reason.clears_retry());
        }
        for reason in [
            SkipReason::Missing,
            SkipReason::Inactive,
            SkipReason::NoRepository,
            SkipReason::NoResumeState,
        ] {
            assert!(reason.clears_retry());
        }
    }

    #[test]
    fn blocked_retry_waits_and_resume_selects_an_actionable_state() {
        let mut issue = issue();
        issue.state = "in review".into();
        issue.blockers.push("blocker".into());
        let states = ["In Review".into(), "Todo".into()];
        assert_eq!(
            retry_resume_state(&issue, true, "In Review", &states),
            Ok(Some("Todo"))
        );
        assert_eq!(
            retry_resume_state(&issue, false, "In Review", &states),
            Ok(None)
        );
        assert_eq!(
            retry_resume_state(&issue, true, "In Review", &[]),
            Err(SkipReason::NoResumeState)
        );
        assert!(matches!(
            decide(EligibilityFacts {
                issue: Some(&issue),
                repos: &[],
                active_states: &states,
                mode: DispatchMode::Retry { run_number: 2 },
                has_active_run: false,
                retry_queued: true,
                suppression_matches: false,
                admission: Admission {
                    active_runs: 0,
                    max_concurrent: 1,
                    rate_limited: false
                }
            }),
            EligibilityDecision::Skip(SkipReason::Blocked)
        ));
    }
}
