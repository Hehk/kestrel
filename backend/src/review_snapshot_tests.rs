use super::*;

const TEXT: &str = "diff --git a/app.rs b/app.rs\nindex 1111111..2222222 100644\n--- a/app.rs\n+++ b/app.rs\n@@ -1 +1 @@ context\n-old\n+new\n";
fn file(raw: &str) -> PullRequestDiffFileDto {
    pull_request_diff::parse_pull_request_diff(raw)
        .unwrap()
        .remove(0)
        .into()
}
fn object(sha: &str, mode: &str) -> Option<ObjectIdentity> {
    Some(ObjectIdentity {
        path: "app.rs".into(),
        sha: sha.repeat(40),
        mode: mode.into(),
    })
}
fn version(raw: &str) -> String {
    fingerprint(&file(raw), object("1", "100644"), object("2", "100644")).unwrap()
}

#[test]
fn identity_covers_blobs_modes_paths_context_lines_whitespace_and_missing_newline() {
    let original = version(TEXT);
    assert_eq!(
        original,
        "8b037ef0f9a480d901bd5d4e96cdbc3a368343825d8d17fc5b8f76aca2265913"
    );
    for changed in [
        TEXT.replace("app.rs", "other.rs"),
        TEXT.replace("@@ -1 +1 @@", "@@ -5 +5 @@"),
        TEXT.replace("@@ context", "@@ different context"),
        TEXT.replace("+new", "+ new"),
        format!("{TEXT}\\ No newline at end of file\n"),
    ] {
        assert_ne!(version(&changed), original);
    }
    // Even when the reviewable patch is identical, out-of-hunk or base content changes invalidate it.
    assert_ne!(
        fingerprint(&file(TEXT), object("1", "100644"), object("3", "100644")).unwrap(),
        original
    );
    assert_ne!(
        fingerprint(&file(TEXT), object("4", "100644"), object("2", "100644")).unwrap(),
        original
    );
    assert_ne!(
        fingerprint(&file(TEXT), object("1", "100644"), object("2", "100755")).unwrap(),
        original
    );
    // Git's abbreviation length isn't reviewable content. Head/base commit IDs are not fingerprint inputs.
    assert_eq!(
        version(&TEXT.replace("1111111..2222222", "1111111111..2222222222")),
        original
    );
    let joined = format!("{TEXT}{}", TEXT.replace("app.rs", "unrelated.rs"));
    assert_eq!(
        fingerprint(&file(&joined), object("1", "100644"), object("2", "100644")).unwrap(),
        original
    );
}

#[test]
fn binary_objects_and_absent_sides_have_distinct_identities() {
    let binary = file("diff --git a/picture b/picture\nindex 1111111..2222222 100644\nBinary files a/picture and b/picture differ\n");
    let one = fingerprint(&binary, object("1", "100644"), object("2", "100644")).unwrap();
    assert_ne!(
        one,
        fingerprint(&binary, object("1", "100644"), object("3", "100644")).unwrap()
    );
    assert_ne!(
        one,
        fingerprint(&binary, None, object("2", "100644")).unwrap()
    );
    assert_ne!(
        one,
        fingerprint(&binary, object("1", "100644"), None).unwrap()
    );
    for mode in ["120000", "160000"] {
        assert_ne!(
            one,
            fingerprint(&binary, object("1", mode), object("2", mode)).unwrap()
        );
    }
}

#[test]
fn lineage_is_explanatory_only_and_never_guesses_for_new_files_or_copies() {
    let previous = ReviewSnapshot {
        hash_algorithm: "sha1".into(),
        base_commit: "a".repeat(40),
        head_commit: "b".repeat(40),
        merge_base_commit: "c".repeat(40),
        id: "before".into(),
        repository_id: 42,
        files: vec![ReviewVersion {
            before: None,
            after: None,
            id: "old".into(),
            path: "app.rs".into(),
            predecessor: None,
        }],
    };
    let mut current = ReviewSnapshot {
        hash_algorithm: "sha1".into(),
        base_commit: "a".repeat(40),
        head_commit: "b".repeat(40),
        merge_base_commit: "c".repeat(40),
        id: "after".into(),
        repository_id: 42,
        files: vec![ReviewVersion {
            before: None,
            after: None,
            id: "new".into(),
            path: "app.rs".into(),
            predecessor: None,
        }],
    };
    lineage(&mut current, &previous, TEXT);
    assert_eq!(current.files[0].predecessor.as_deref(), Some("old"));
    assert_eq!(current.files[0].id, "new");
    let unchanged = current.clone();
    current.files[0].predecessor = None;
    lineage(&mut current, &unchanged, TEXT);
    assert_eq!(current.files[0].predecessor.as_deref(), Some("old"));
    current.files[0].predecessor = None;
    lineage(
        &mut current,
        &previous,
        "diff --git a/app.rs b/copy.rs\nsimilarity index 100%\ncopy from app.rs\ncopy to copy.rs\n",
    );
    assert!(current.files[0].predecessor.is_none());
    current.repository_id = 43;
    lineage(&mut current, &previous, TEXT);
    assert!(current.files[0].predecessor.is_none());
}

#[tokio::test]
async fn stored_snapshot_and_its_original_lineage_are_immutable() {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    crate::db::migrate(&pool).await.unwrap();
    sqlx::query("INSERT INTO users VALUES ('u', 'u', NULL, 'now', 'now')")
        .execute(&pool)
        .await
        .unwrap();
    let mut manifest: ReviewSnapshot = serde_json::from_value(serde_json::json!({
        "id": "snapshot", "repositoryId": 42, "hashAlgorithm": "sha1", "baseCommit": "a", "headCommit": "b", "mergeBaseCommit": "c",
        "files": [{"id": "version", "path": "app.rs", "predecessor": "original"}]
    })).unwrap();
    let mut tx = pool.begin().await.unwrap();
    crate::review::store_snapshot(&mut tx, "u", 1, &mut manifest, TEXT)
        .await
        .unwrap();
    manifest.files[0].predecessor = None;
    crate::review::store_snapshot(
        &mut tx,
        "u",
        1,
        &mut manifest,
        "different wire representation",
    )
    .await
    .unwrap();
    assert_eq!(manifest.files[0].predecessor.as_deref(), Some("original"));
    let raw: String = sqlx::query_scalar("SELECT diff FROM review_snapshots")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(raw, TEXT);
    tx.commit().await.unwrap();
}
