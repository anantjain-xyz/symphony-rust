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
