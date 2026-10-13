//! Persistence-to-desktop projections. JSON and closed states are decoded by storage.
use symphony_contracts::*;
use symphony_storage as db;

pub fn issue_summary(row: db::IssueRow) -> IssueSummary {
    IssueSummary {
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        description: row.description,
        priority: row.priority,
        state: row.state,
        branch: row.branch,
        labels: row.labels,
        blockers: row.blockers,
        last_seen_at: row.last_seen_at,
    }
}

pub fn run_summary(row: db::RunWithIssueRow) -> RunSummary {
    RunSummary {
        id: row.id,
        issue_id: row.issue_id,
        run_number: row.run_number,
        workspace_path: row.workspace_path,
        status: row.status,
        started_at: row.started_at,
        ended_at: row.ended_at,
        error_class: row.error_class,
        error_message: row.error_message,
        session_info: row.session_info,
        repo_name: row.repo_name,
        created_at: row.created_at,
        issue_identifier: row.issue_identifier,
        issue_title: row.issue_title,
        issue_state: row.issue_state,
    }
}

pub fn retry_summary(row: db::RetryWithIssueRow) -> RetrySummary {
    RetrySummary {
        issue_id: row.issue_id,
        run_number: row.run_number,
        due_at: row.due_at,
        error_class: row.error_class,
        error_message: row.error_message,
        created_at: row.created_at,
        issue_identifier: row.issue_identifier,
        issue_title: row.issue_title,
    }
}

pub fn live_session(row: db::LiveSessionRow) -> LiveSession {
    LiveSession {
        run_id: row.run_id,
        session_id: row.session_id,
        thread_id: row.thread_id,
        turn_id: row.turn_id,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        total_tokens: row.total_tokens,
        last_event_at: row.last_event_at,
        started_at: row.started_at,
    }
}

pub fn rate_limit_state(row: db::RateLimitStateRow) -> RateLimitState {
    RateLimitState {
        source: row.source,
        remaining: row.remaining,
        reset_at: row.reset_at,
        updated_at: row.updated_at,
    }
}

pub fn token_usage(row: db::TokenUsageRow) -> TokenUsage {
    TokenUsage {
        source: row.source,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        total_tokens: row.total_tokens,
        run_count: row.run_count,
        updated_at: row.updated_at,
    }
}

pub fn dashboard_overview(row: db::Overview) -> DashboardOverview {
    DashboardOverview {
        active_runs: row.active_runs.into_iter().map(run_summary).collect(),
        retry_queue: row.retry_queue.into_iter().map(retry_summary).collect(),
        retry_count: row.retry_count,
        recent_failures: row.recent_failures.into_iter().map(run_summary).collect(),
        workspace_cleanup_count: row.workspace_cleanup_count,
        live_sessions: row.live_sessions.into_iter().map(live_session).collect(),
        rate_limits: row.rate_limits.into_iter().map(rate_limit_state).collect(),
        token_usage: row.token_usage.into_iter().map(token_usage).collect(),
    }
}

pub fn retro_summary(row: db::RetroRow) -> RetroSummary {
    RetroSummary {
        id: row.id,
        since_at: row.since_at,
        until_at: row.until_at,
        status: row.status,
        run_count: row.run_count,
        issue_count: row.issue_count,
        error_message: row.error_message,
        created_at: row.created_at,
        completed_at: row.completed_at,
    }
}

pub fn retro_suggestion_review(row: db::RetroSuggestionRow) -> RetroSuggestionReview {
    RetroSuggestionReview {
        id: row.id,
        retro_id: row.retro_id,
        repo_name: row.repo_name,
        repo_url: row.repo_url,
        finding_index: row.finding_index,
        target_type: row.target_type,
        target_id: row.target_id,
        target_path: row.target_path,
        title: row.title,
        body: row.body,
        rationale: row.rationale,
        confidence: row.confidence,
        guidance: row.guidance,
        before_content: row.before_content,
        after_content: row.after_content,
        unified_diff: row.unified_diff,
        base_ref: row.base_ref,
        base_hash: row.base_hash,
        proposal_status: row.proposal_status,
        proposal_error: row.proposal_error,
        decision: row.decision,
        decided_at: row.decided_at,
        created_at: row.created_at,
    }
}

pub fn retro_change_batch(row: db::RetroBatchRow) -> RetroChangeBatch {
    RetroChangeBatch {
        id: row.id,
        retro_id: row.retro_id,
        kind: row.kind,
        repo_name: row.repo_name,
        repo_url: row.repo_url,
        base_ref: row.base_ref,
        state: row.state,
        progress: row.progress,
        error: row.error,
        pr_url: row.pr_url,
        created_at: row.created_at,
        completed_at: row.completed_at,
    }
}

pub fn agent_event(row: db::AgentEventRow) -> AgentEvent {
    AgentEvent {
        id: row.id,
        run_id: row.run_id,
        kind: row.kind,
        payload: row.payload,
        created_at: row.created_at,
    }
}

pub fn storage_notification(event: db::StorageEvent) -> StorageNotification {
    match event {
        db::StorageEvent::DbChanged { table, op } => StorageNotification::DbChanged { table, op },
        db::StorageEvent::AgentEvent { event } => StorageNotification::AgentEvent {
            event: agent_event(event),
        },
        db::StorageEvent::RateLimitChanged { source } => {
            StorageNotification::RateLimitChanged { source }
        }
        db::StorageEvent::WorkflowReady => StorageNotification::WorkflowReady,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use symphony_core::{RunStatus, SessionInfoPayload};

    #[test]
    fn issue_projection_serializes_literal_arrays_and_omits_storage_snapshot() {
        let summary = issue_summary(db::IssueRow {
            id: "issue-id".into(),
            identifier: "ENG-1".into(),
            title: "Issue".into(),
            description: None,
            priority: 1,
            state: "Todo".into(),
            branch: None,
            labels: vec!["repo:app".into()],
            blockers: vec!["ENG-2".into()],
            raw: "internal snapshot".into(),
            last_seen_at: "now".into(),
        });
        let value = serde_json::to_value(summary).unwrap();
        assert_eq!(value["labels"], serde_json::json!(["repo:app"]));
        assert_eq!(value["blockers"], serde_json::json!(["ENG-2"]));
        assert!(value.get("raw").is_none());
    }

    #[test]
    fn run_projection_serializes_closed_state_and_session_object() {
        let summary = run_summary(db::RunWithIssueRow {
            id: "run-id".into(),
            issue_id: "issue-id".into(),
            run_number: 1,
            workspace_path: "/tmp/workspace".into(),
            status: RunStatus::Success,
            started_at: None,
            ended_at: None,
            error_class: None,
            error_message: None,
            session_info: Some(SessionInfoPayload {
                model: Some("test-model".into()),
                ..Default::default()
            }),
            repo_name: Some("app".into()),
            created_at: "now".into(),
            issue_identifier: "ENG-1".into(),
            issue_title: "Issue".into(),
            issue_state: "Done".into(),
        });
        let value = serde_json::to_value(summary).unwrap();
        assert_eq!(value["status"], "success");
        assert_eq!(value["session_info"]["model"], "test-model");
        let mut invalid = value;
        invalid["status"] = serde_json::json!("anything");
        assert!(serde_json::from_value::<RunSummary>(invalid).is_err());
    }
}
