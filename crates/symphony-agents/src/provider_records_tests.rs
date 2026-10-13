use super::*;

async fn map_record(
    backend: AgentBackend,
    value: Value,
    events: &AgentEventSender,
) -> Result<Option<AgentRunResult>, AgentError> {
    match backend {
        AgentBackend::Codex => map_codex_event("thread", "turn", value, events).await,
        AgentBackend::Claude => {
            ClaudeStreamState::new(
                "session".into(),
                &ClaudePermissionMode::default(),
                "/tmp".into(),
            )
            .push(value, events)
            .await
        }
        AgentBackend::Cursor => {
            CursorStreamState::new("session".into())
                .push(value, events)
                .await
        }
        AgentBackend::Opencode => {
            OpencodeStreamState::new("session".into())
                .push(value, events)
                .await
        }
    }
}

#[tokio::test]
async fn malformed_known_terminal_records_fail_before_publishing() {
    let cases = [
        (
            AgentBackend::Codex,
            json!({"type":"turn.completed","usage":"unknown"}),
        ),
        (
            AgentBackend::Codex,
            json!({"type":"turn.completed","usage":null}),
        ),
        (
            AgentBackend::Codex,
            json!({"type":"turn.completed","usage":{"input_tokens":"3"}}),
        ),
        (
            AgentBackend::Codex,
            json!({"type":"turn.completed","usage":{"output_tokens":-1}}),
        ),
        (
            AgentBackend::Codex,
            json!({"type":"turn.completed","usage":{"input_tokens":i64::MAX,"output_tokens":1}}),
        ),
        (AgentBackend::Codex, json!({"type":"turn.failed"})),
        (
            AgentBackend::Codex,
            json!({"type":"turn.failed","error":{"message":17}}),
        ),
        (AgentBackend::Claude, json!({"type":"result","usage":{}})),
        (AgentBackend::Claude, json!({"type":"result","subtype":""})),
        (
            AgentBackend::Claude,
            json!({"type":"result","subtype":"success","usage":[]}),
        ),
        (
            AgentBackend::Claude,
            json!({"type":"result","subtype":"success","usage":{"cache_read_input_tokens":-1}}),
        ),
        (
            AgentBackend::Claude,
            json!({"type":"result","subtype":"success","result":{}}),
        ),
        (
            AgentBackend::Claude,
            json!({"type":"result","subtype":"success","is_error":"false"}),
        ),
        (
            AgentBackend::Cursor,
            json!({"type":"result","is_error":false}),
        ),
        (
            AgentBackend::Cursor,
            json!({"type":"result","subtype":"success","is_error":"false"}),
        ),
        (
            AgentBackend::Cursor,
            json!({"type":"result","subtype":"success","usage":{"inputTokens":0.5}}),
        ),
        (
            AgentBackend::Cursor,
            json!({"type":"result","subtype":"success","usage":{"inputTokens":i64::MAX,"cacheReadTokens":1}}),
        ),
        (
            AgentBackend::Opencode,
            json!({"type":"error","error":"broken"}),
        ),
        (
            AgentBackend::Opencode,
            json!({"type":"error","error":{"data":{"statusCode":"429"}}}),
        ),
        (
            AgentBackend::Opencode,
            json!({"type":"step_finish","part":null}),
        ),
        (
            AgentBackend::Opencode,
            json!({"type":"step_finish","part":{"tokens":{"input":-1}}}),
        ),
        (
            AgentBackend::Opencode,
            json!({"type":"step_finish","part":{"tokens":{"cache":[]}}}),
        ),
    ];
    for (backend, value) in cases {
        let name = backend.as_source_str();
        let (tx, mut rx) = mpsc::channel(16);
        let error = map_record(backend, value.clone(), &tx)
            .await
            .expect_err(&format!("malformed known record: {value}"));
        assert!(
            matches!(error, AgentError::Protocol { backend, .. } if backend == name),
            "{name}: {value}: {error}"
        );
        assert!(
            rx.try_recv().is_err(),
            "malformed record published an event: {value}"
        );
    }
}

#[tokio::test]
async fn older_terminal_records_may_omit_usage_and_cursor_error_flag() {
    for (backend, value) in [
        (AgentBackend::Codex, json!({"type":"turn.completed"})),
        (
            AgentBackend::Claude,
            json!({"type":"result","subtype":"success"}),
        ),
        (
            AgentBackend::Cursor,
            json!({"type":"result","subtype":"success"}),
        ),
    ] {
        let (tx, _rx) = mpsc::channel(16);
        let done = map_record(backend, value, &tx).await.unwrap().unwrap();
        assert_eq!(done.outcome, AgentOutcome::Success);
    }
    let (tx, _rx) = mpsc::channel(16);
    let done = map_record(
        AgentBackend::Codex,
        json!({"type":"turn.failed","error":{}}),
        &tx,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(done.outcome, AgentOutcome::Failure);
    assert_eq!(done.error_class.as_deref(), Some("turn_failed"));
    assert!(map_record(
        AgentBackend::Opencode,
        json!({"type":"step_finish","part":{}}),
        &tx
    )
    .await
    .unwrap()
    .is_none());
}

#[tokio::test]
async fn unknown_records_and_extra_fields_do_not_become_protocol_errors() {
    for backend in [
        AgentBackend::Codex,
        AgentBackend::Claude,
        AgentBackend::Cursor,
        AgentBackend::Opencode,
    ] {
        let (tx, mut rx) = mpsc::channel(16);
        assert!(map_record(
            backend,
            json!({"type":"provider.future_event","usage":"opaque","payload":[1,{"future":true}]}),
            &tx
        )
        .await
        .unwrap()
        .is_none());
        assert!(rx.try_recv().is_err());
    }
    let (tx, _rx) = mpsc::channel(16);
    let done = map_record(
        AgentBackend::Claude,
        json!({"type":"result","subtype":"success","usage":{},"future_field":{"schema":"opaque"}}),
        &tx,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(done.outcome, AgentOutcome::Success);
}

#[tokio::test]
async fn result_success_is_explicit_and_unknown_subtypes_remain_failure_codes() {
    for backend in [AgentBackend::Claude, AgentBackend::Cursor] {
        for (subtype, is_error) in [("provider_future_result", false), ("success", true)] {
            let (tx, _rx) = mpsc::channel(16);
            let done = map_record(
                backend.clone(),
                json!({"type":"result","subtype":subtype,"is_error":is_error}),
                &tx,
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(done.outcome, AgentOutcome::Failure);
            assert_eq!(done.error_class.as_deref(), Some(subtype));
        }
    }
}

#[tokio::test]
async fn overflowing_opencode_step_does_not_corrupt_prior_usage() {
    let (tx, mut rx) = mpsc::channel(16);
    let mut stream = OpencodeStreamState::new("session".into());
    stream
        .push(
            json!({"type":"step_finish","part":{"tokens":{"input":7,"output":3}}}),
            &tx,
        )
        .await
        .unwrap();
    let error = stream
        .push(
            json!({"type":"step_finish","part":{"tokens":{"input":i64::MAX}}}),
            &tx,
        )
        .await
        .unwrap_err();
    assert!(matches!(error, AgentError::Protocol { .. }));
    stream.finish(&tx).await.unwrap();
    let event = rx.recv().await.unwrap();
    let usage = event.metadata().tokens.as_ref().unwrap();
    assert_eq!(
        (usage.input_tokens, usage.output_tokens, usage.total_tokens),
        (7, 3, 10)
    );
}

#[tokio::test]
async fn thinking_updates_are_explicit_metadata_without_a_visible_payload() {
    let (tx, mut rx) = mpsc::channel(16);
    let mut stream = ClaudeStreamState::new(
        "session".into(),
        &ClaudePermissionMode::default(),
        "/tmp".into(),
    );
    stream
        .push(
            json!({"type":"system","subtype":"thinking_tokens","estimated_tokens":42}),
            &tx,
        )
        .await
        .unwrap();
    let event = rx.recv().await.unwrap();
    let MappedAgentEvent::Metadata { metadata } = event else {
        panic!("thinking estimate must not create a visible log record")
    };
    assert_eq!(metadata.session_info.unwrap().thinking_tokens, Some(42));
    assert!(metadata.tokens.is_none());
    assert!(rx.try_recv().is_err());
}
