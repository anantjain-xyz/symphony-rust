use super::{apply_migrations, migrate, MIGRATIONS};
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};
use std::{collections::BTreeSet, path::Path};

const SHIPPED_MIGRATION_SHA256: &[(&str, &str)] = &[
    (
        "0001_init",
        "45e2e343d3ddd69970a684945c7e5c7f9f909fd7dbe6a77e1c8abc798301a69f",
    ),
    (
        "0002_run_session_info",
        "59253ffb8720ba715651b180e9355ff0c0bcf15977838fd3a1df0fd9d351042a",
    ),
    (
        "0003_run_repo_name",
        "9775429de2fbce9ad6791166ebaaf99586bc61b305906382b953e91d8057209d",
    ),
    (
        "0004_token_usage",
        "51af2bd033dbdeb0d477514b4d748f9b5f527ef95ee1d8eee00bbc7ef13bbb85",
    ),
    (
        "0005_issue_dispatch_suppressions",
        "73a6835a0397b7199daad002cbcf815e54625cb7923a840c30080d06b721eeaf",
    ),
    (
        "0006_retros",
        "c0c043f1ed9e9a7e19672a29cc972ff99c377ddc086ac215992fea6196100e65",
    ),
    (
        "0007_retro_review",
        "60e6725415326b50e3515e60deedcde1eee0f1b604e666ea93ab30ffb9ea3331",
    ),
    (
        "0008_repo_workflow_retro_targets",
        "1192b8dceef91542d731af9ff8f73c35644b433bc01790af139bfae74fca8586",
    ),
    (
        "0009_workspace_cleanup_queue",
        "736bf253affecd8b71ca740c6002d29d59deede7a22f6f7d48015f5e316b948a",
    ),
];

#[test]
fn migration_directory_exactly_matches_the_registry() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/migrations");
    let mut files = std::fs::read_dir(&directory)
        .unwrap()
        .map(|entry| {
            entry
                .unwrap()
                .file_name()
                .into_string()
                .expect("migration filenames must be UTF-8")
        })
        .collect::<Vec<_>>();
    files.sort();

    let registered = MIGRATIONS
        .iter()
        .map(|(id, _)| format!("{id}.sql"))
        .collect::<Vec<_>>();
    assert_eq!(
        files, registered,
        "migration files and the registered migration list must match exactly"
    );
}

#[test]
fn migration_ids_are_unique_ordered_and_contiguous() {
    let ids = MIGRATIONS.iter().map(|(id, _)| *id).collect::<Vec<_>>();
    let unique = ids.iter().copied().collect::<BTreeSet<_>>();
    assert_eq!(unique.len(), ids.len(), "migration IDs must be unique");
    assert!(
        ids.windows(2).all(|pair| pair[0] < pair[1]),
        "migration IDs must be strictly ordered: {ids:?}"
    );
    for (index, id) in ids.iter().enumerate() {
        let expected = index + 1;
        let prefix = id
            .split_once('_')
            .unwrap_or_else(|| panic!("migration ID lacks a descriptive suffix: {id}"))
            .0;
        assert_eq!(
            prefix,
            format!("{expected:04}"),
            "migration IDs must be contiguous"
        );
    }
}

#[test]
fn shipped_migration_contents_are_frozen() {
    assert_eq!(
        MIGRATIONS.len(),
        SHIPPED_MIGRATION_SHA256.len(),
        "add an explicit checksum whenever a migration ships"
    );
    for ((id, sql), (expected_id, expected_hash)) in MIGRATIONS.iter().zip(SHIPPED_MIGRATION_SHA256)
    {
        assert_eq!(id, expected_id, "checksum registry order drifted");
        let actual = format!("{:x}", Sha256::digest(sql.as_bytes()));
        assert_eq!(
            actual, *expected_hash,
            "shipped migration {id} changed; append a new migration instead"
        );
    }
}

async fn temp_pool(path: &Path) -> SqlitePool {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap()
}

async fn execute_sentinel(pool: &SqlitePool, prefix_len: usize, sql: &str) {
    sqlx::query(sql)
        .execute(pool)
        .await
        .unwrap_or_else(|error| panic!("could not seed prefix {prefix_len}: {error}\n{sql}"));
}

async fn seed_historical_prefix(pool: &SqlitePool, prefix_len: usize) {
    if prefix_len == 0 {
        return;
    }

    for sql in [
        r#"insert into workflows
           (id, source_hash, parsed, prompt_template, loaded_at)
           values
           ('workflow-sentinel', 'source-hash-sentinel', '{"sentinel":true}',
            'prompt-sentinel', '2025-01-01T00:00:00.000Z')"#,
        r#"insert into issues
           (id, identifier, title, description, priority, state, branch, labels, blockers,
            pr_urls, raw, last_seen_at)
           values
           ('issue-sentinel', 'SYM-123', 'Sentinel issue', 'preserve this issue', 7,
            'In Progress', 'sentinel-branch', '["contract"]', '["SYM-100"]',
            '["https://example.invalid/pull/123"]', '{"sentinel":true}',
            '2025-01-02T00:00:00.000Z')"#,
        r#"insert into runs
           (id, issue_id, run_number, workspace_path, status, started_at, ended_at,
            error_class, error_message, worker_pid, created_at)
           values
           ('run-sentinel', 'issue-sentinel', 3, '/tmp/sentinel-workspace', 'success',
            '2025-01-03T00:00:00.000Z', '2025-01-03T00:01:00.000Z',
            'sentinel-class', 'sentinel-message', 4242, '2025-01-03T00:00:00.000Z')"#,
        r#"insert into live_sessions
           (run_id, session_id, thread_id, turn_id, input_tokens, output_tokens,
            total_tokens, last_event_at, started_at)
           values
           ('run-sentinel', 'session-sentinel', 'thread-sentinel', 'turn-sentinel',
            11, 13, 24, '2025-01-03T00:00:30.000Z', '2025-01-03T00:00:00.000Z')"#,
        r#"insert into agent_events
           (run_id, kind, payload, created_at)
           values
           ('run-sentinel', 'humanized', '{"message":"sentinel"}',
            '2025-01-03T00:00:45.000Z')"#,
        r#"insert into retry_queue
           (issue_id, run_number, due_at, error_class, error_message, created_at)
           values
           ('issue-sentinel', 4, '2025-01-04T00:00:00.000Z', 'retry-sentinel',
            'retry-message-sentinel', '2025-01-03T00:02:00.000Z')"#,
        r#"insert into hook_runs
           (run_id, hook, exit_code, duration_ms, stderr_tail, created_at)
           values
           ('run-sentinel', 'after_run', 17, 250, 'stderr-sentinel',
            '2025-01-03T00:01:00.000Z')"#,
        r#"insert into rate_limit_state
           (source, remaining, reset_at, updated_at)
           values
           ('source-sentinel', 41, '2025-01-05T00:00:00.000Z',
            '2025-01-04T00:00:00.000Z')"#,
        r#"insert into worker_heartbeat
           (id, started_at, last_beat_at, worker_pid)
           values
           ('worker', '2025-01-01T00:00:00.000Z', '2025-01-01T00:01:00.000Z', 4343)"#,
    ] {
        execute_sentinel(pool, prefix_len, sql).await;
    }

    if prefix_len >= 2 {
        execute_sentinel(
            pool,
            prefix_len,
            r#"update runs set session_info = '{"session":"sentinel"}' where id = 'run-sentinel'"#,
        )
        .await;
    }
    if prefix_len >= 3 {
        execute_sentinel(
            pool,
            prefix_len,
            "update runs set repo_name = 'repo-sentinel' where id = 'run-sentinel'",
        )
        .await;
    }
    if prefix_len >= 4 {
        execute_sentinel(
            pool,
            prefix_len,
            r#"insert into token_usage
               (source, input_tokens, output_tokens, total_tokens, run_count, updated_at)
               values ('token-source-sentinel', 23, 29, 52, 2, '2025-01-06T00:00:00.000Z')"#,
        )
        .await;
    }
    if prefix_len >= 5 {
        execute_sentinel(
            pool,
            prefix_len,
            r#"insert into issue_dispatch_suppressions
               (issue_id, reason, issue_fingerprint, created_at)
               values
               ('issue-sentinel', 'reason-sentinel', 'fingerprint-sentinel',
                '2025-01-07T00:00:00.000Z')"#,
        )
        .await;
    }
    if prefix_len >= 6 {
        for sql in [
            r#"insert into retros
               (id, since_at, until_at, status, run_count, issue_count, report_json,
                error_message, created_at, completed_at)
               values
               ('retro-sentinel', '2025-01-01T00:00:00.000Z',
                '2025-01-08T00:00:00.000Z', 'completed', 1, 1,
                '{"report":"sentinel"}', null, '2025-01-08T00:00:00.000Z',
                '2025-01-08T00:01:00.000Z')"#,
            r#"insert into retro_inputs
               (retro_id, run_id, issue_id, repo_name, workpad_comment_id, workpad_hash)
               values
               ('retro-sentinel', 'run-sentinel', 'issue-sentinel', 'repo-sentinel',
                'comment-sentinel', 'workpad-hash-sentinel')"#,
            r#"insert into workpad_snapshots
               (issue_id, comment_id, body_hash, body, comment_created_at,
                comment_updated_at, fetched_at)
               values
               ('issue-sentinel', 'comment-sentinel', 'body-hash-sentinel',
                'body-sentinel', '2025-01-08T00:00:00.000Z',
                '2025-01-08T00:00:30.000Z', '2025-01-08T00:01:00.000Z')"#,
        ] {
            execute_sentinel(pool, prefix_len, sql).await;
        }
    }
    if prefix_len >= 7 {
        for sql in [
            r#"insert into retro_suggestions
               (id, retro_id, repo_name, repo_url, finding_index, target_type, target_id,
                target_path, title, body, rationale, confidence, guidance, before_content,
                after_content, unified_diff, base_ref, base_hash, proposal_status,
                proposal_error, decision, decided_at, created_at)
               values
               ('suggestion-sentinel', 'retro-sentinel', 'repo-sentinel',
                'https://example.invalid/repo', 9, 'prompt', 'target-sentinel',
                'WORKFLOW.md', 'title-sentinel', 'body-sentinel', 'rationale-sentinel',
                'high', 'guidance-sentinel', 'before-sentinel', 'after-sentinel',
                'diff-sentinel', 'main', 'base-hash-sentinel', 'ready', null, 'accepted',
                '2025-01-09T00:00:30.000Z', '2025-01-09T00:00:00.000Z')"#,
            r#"insert into retro_batches
               (id, retro_id, kind, repo_name, repo_url, base_ref, state, progress, error,
                pr_url, created_at, completed_at)
               values
               ('batch-sentinel', 'retro-sentinel', 'repo_pr', 'repo-sentinel',
                'https://example.invalid/repo', 'main', 'completed', 'done-sentinel',
                null, 'https://example.invalid/pull/123', '2025-01-09T00:00:00.000Z',
                '2025-01-09T00:01:00.000Z')"#,
            r#"insert into retro_batch_items (batch_id, suggestion_id)
               values ('batch-sentinel', 'suggestion-sentinel')"#,
        ] {
            execute_sentinel(pool, prefix_len, sql).await;
        }
    }
}

async fn assert_historical_sentinels(pool: &SqlitePool, prefix_len: usize) {
    if prefix_len == 0 {
        return;
    }

    let workflow: (String, String, String) = sqlx::query_as(
        "select source_hash, parsed, prompt_template from workflows where id = 'workflow-sentinel'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(
        workflow,
        (
            "source-hash-sentinel".to_string(),
            r#"{"sentinel":true}"#.to_string(),
            "prompt-sentinel".to_string(),
        ),
        "prefix {prefix_len} did not preserve its workflow"
    );

    let core_relationships: (String, String, String, String, String, String) = sqlx::query_as(
        r#"select i.identifier, r.workspace_path, l.session_id, e.payload,
                  q.error_class, h.stderr_tail
           from issues i
           join runs r on r.issue_id = i.id
           join live_sessions l on l.run_id = r.id
           join agent_events e on e.run_id = r.id
           join retry_queue q on q.issue_id = i.id
           join hook_runs h on h.run_id = r.id
           where i.id = 'issue-sentinel'
             and r.id = 'run-sentinel'"#,
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(
        core_relationships,
        (
            "SYM-123".to_string(),
            "/tmp/sentinel-workspace".to_string(),
            "session-sentinel".to_string(),
            r#"{"message":"sentinel"}"#.to_string(),
            "retry-sentinel".to_string(),
            "stderr-sentinel".to_string(),
        ),
        "prefix {prefix_len} did not preserve its issue/run relationship graph"
    );

    let rate_limit: (i64, String) = sqlx::query_as(
        "select remaining, reset_at from rate_limit_state where source = 'source-sentinel'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(
        rate_limit,
        (41, "2025-01-05T00:00:00.000Z".to_string()),
        "prefix {prefix_len} did not preserve rate-limit state"
    );

    if prefix_len >= 2 {
        let session_info: String =
            sqlx::query_scalar("select session_info from runs where id = 'run-sentinel'")
                .fetch_one(pool)
                .await
                .unwrap();
        assert_eq!(
            session_info, r#"{"session":"sentinel"}"#,
            "prefix {prefix_len} did not preserve run session info"
        );
    }
    if prefix_len >= 3 {
        let repo_name: String =
            sqlx::query_scalar("select repo_name from runs where id = 'run-sentinel'")
                .fetch_one(pool)
                .await
                .unwrap();
        assert_eq!(
            repo_name, "repo-sentinel",
            "prefix {prefix_len} did not preserve the run repository"
        );
    }
    if prefix_len >= 4 {
        let usage: (i64, i64, i64, i64) = sqlx::query_as(
            r#"select input_tokens, output_tokens, total_tokens, run_count
               from token_usage where source = 'token-source-sentinel'"#,
        )
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(
            usage,
            (23, 29, 52, 2),
            "prefix {prefix_len} did not preserve token usage"
        );
    }
    if prefix_len >= 5 {
        let suppression: (String, String) = sqlx::query_as(
            r#"select s.reason, s.issue_fingerprint
               from issue_dispatch_suppressions s
               join issues i on i.id = s.issue_id
               where i.id = 'issue-sentinel'"#,
        )
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(
            suppression,
            (
                "reason-sentinel".to_string(),
                "fingerprint-sentinel".to_string(),
            ),
            "prefix {prefix_len} did not preserve issue dispatch suppression"
        );
    }
    if prefix_len >= 6 {
        let retro_graph: (String, String, String, String) = sqlx::query_as(
            r#"select r.report_json, ri.repo_name, w.comment_id, w.body
               from retros r
               join retro_inputs ri on ri.retro_id = r.id
               join runs run on run.id = ri.run_id
               join issues i on i.id = ri.issue_id and i.id = run.issue_id
               join workpad_snapshots w on w.issue_id = i.id
               where r.id = 'retro-sentinel'"#,
        )
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(
            retro_graph,
            (
                r#"{"report":"sentinel"}"#.to_string(),
                "repo-sentinel".to_string(),
                "comment-sentinel".to_string(),
                "body-sentinel".to_string(),
            ),
            "prefix {prefix_len} did not preserve the retro input graph"
        );
    }
    if prefix_len >= 7 {
        let review_graph: (String, String, String, String, String) = sqlx::query_as(
            r#"select s.target_type, s.title, b.kind, b.progress, r.status
               from retro_batch_items bi
               join retro_suggestions s on s.id = bi.suggestion_id
               join retro_batches b on b.id = bi.batch_id and b.retro_id = s.retro_id
               join retros r on r.id = s.retro_id
               where bi.batch_id = 'batch-sentinel'
                 and bi.suggestion_id = 'suggestion-sentinel'"#,
        )
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(
            review_graph,
            (
                "prompt".to_string(),
                "title-sentinel".to_string(),
                "repo_pr".to_string(),
                "done-sentinel".to_string(),
                "completed".to_string(),
            ),
            "prefix {prefix_len} did not preserve the retro review graph"
        );
    }
}

#[tokio::test]
async fn every_historical_prefix_upgrades_safely_to_head() {
    let directory = tempfile::tempdir().unwrap();
    let expected_ids = MIGRATIONS
        .iter()
        .map(|(id, _)| id.to_string())
        .collect::<Vec<_>>();

    for prefix_len in 0..=MIGRATIONS.len() {
        let path = directory.path().join(format!("prefix-{prefix_len}.sqlite"));
        let pool = temp_pool(&path).await;
        apply_migrations(&pool, &MIGRATIONS[..prefix_len])
            .await
            .unwrap_or_else(|error| panic!("prefix {prefix_len} failed: {error}"));
        seed_historical_prefix(&pool, prefix_len).await;
        pool.close().await;

        let pool = temp_pool(&path).await;
        migrate(&pool)
            .await
            .unwrap_or_else(|error| panic!("prefix {prefix_len} did not reach head: {error}"));
        migrate(&pool)
            .await
            .unwrap_or_else(|error| panic!("prefix {prefix_len} was not idempotent: {error}"));

        let applied: Vec<String> =
            sqlx::query_scalar("select id from schema_migrations order by id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            applied, expected_ids,
            "prefix {prefix_len} recorded the wrong migration set"
        );
        assert_historical_sentinels(&pool, prefix_len).await;

        let integrity: String = sqlx::query_scalar("pragma integrity_check")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            integrity, "ok",
            "prefix {prefix_len} failed integrity_check"
        );

        let foreign_keys_enabled: i64 = sqlx::query_scalar("pragma foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            foreign_keys_enabled, 1,
            "prefix {prefix_len} disabled foreign-key enforcement"
        );
        let foreign_key_violations = sqlx::query("pragma foreign_key_check")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(
            foreign_key_violations.is_empty(),
            "prefix {prefix_len} has foreign-key violations"
        );
        pool.close().await;
    }
}
