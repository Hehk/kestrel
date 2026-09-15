use super::*;
use crate::config::{Config, Environment, SessionConfig, TokenEncryptionKey};
use axum::{
    http::{HeaderMap, Uri},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::sync::{Arc, Mutex};

#[tokio::test]
async fn immutable_comparison_and_merge_base_trees_supply_complete_identity() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let observed = requests.clone();
    let mock = Router::new().fallback(get(move |uri: Uri, headers: HeaderMap| {
        let observed = observed.clone();
        async move {
            let path = uri.path().to_owned();
            let accept = headers["accept"].to_str().unwrap().to_owned();
            observed.lock().unwrap().push((path.clone(), accept.clone()));
            if path.contains("/compare/") {
                if accept.contains("diff") {
                    return "diff --git a/src/app.rs b/src/app.rs\nindex 3333333..4444444 100644\n--- a/src/app.rs\n+++ b/src/app.rs\n@@ -1 +1 @@\n-old\n+new\n".into_response();
                }
                return Json(serde_json::json!({"merge_base_commit": {"sha": "c".repeat(40)}})).into_response();
            }
            if path.ends_with(&format!("/git/commits/{}", "c".repeat(40))) {
                return Json(serde_json::json!({"tree": {"sha": "before-root"}})).into_response();
            }
            if path.contains("/git/commits/") {
                return Json(serde_json::json!({"tree": {"sha": "after-root"}})).into_response();
            }
            let (name, sha, mode) = if path.ends_with("before-root") { ("src", "before-src".into(), "040000") }
                else if path.ends_with("after-root") { ("src", "after-src".into(), "040000") }
                else if path.ends_with("before-src") { ("app.rs", "3".repeat(40), "100644") }
                else { ("app.rs", "4".repeat(40), "100755") };
            Json(serde_json::json!({"truncated": false, "tree": [{"path": name, "sha": sha, "mode": mode}]})).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let github_url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, mock).await.unwrap();
    });
    let config = Config {
        api_url: "http://localhost:3000".into(),
        app_url: "http://localhost:5173".into(),
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        database_url: "sqlite::memory:".into(),
        environment: Environment::Development,
        github_api_url: github_url,
        github_app: None,
        github_oauth: None,
        session: SessionConfig {
            cookie_name: "test".into(),
            cookie_secure: false,
            ttl_days: 1,
        },
        token_encryption_key: TokenEncryptionKey::from_base64(&STANDARD.encode([3u8; 32])).unwrap(),
    };
    let state = AppState::new(
        sqlx::SqlitePool::connect_lazy("sqlite::memory:").unwrap(),
        config,
    );
    let base = "a".repeat(40);
    let head = "b".repeat(40);
    let (_, snapshot) = fetch(&state, "test-token", "example/demo", 42, &base, &head)
        .await
        .unwrap();
    let file = &snapshot.files[0];
    assert_eq!(snapshot.merge_base_commit, "c".repeat(40));
    assert_eq!(snapshot.base_commit, base);
    assert_eq!(snapshot.head_commit, head);
    assert_eq!(file.before.as_ref().unwrap().sha, "3".repeat(40));
    assert_eq!(file.after.as_ref().unwrap().sha, "4".repeat(40));
    assert_eq!(file.after.as_ref().unwrap().mode, "100755");
    assert_eq!(file.before.as_ref().unwrap().path, "src/app.rs");
    let calls = requests.lock().unwrap().clone();
    assert!(calls
        .iter()
        .all(|(path, _)| !path.contains("/pulls/") && !path.contains("/heads/")));
    assert_eq!(
        calls
            .iter()
            .filter(|(path, _)| path.ends_with(&format!("/compare/{base}...{head}")))
            .count(),
        2
    );
    assert!(calls
        .iter()
        .any(|(path, _)| path.ends_with(&format!("/git/commits/{}", "c".repeat(40)))));
    let (_, rebased) = fetch(
        &state,
        "test-token",
        "example/demo",
        42,
        &"d".repeat(40),
        &"e".repeat(40),
    )
    .await
    .unwrap();
    assert_eq!(rebased.files[0].id, snapshot.files[0].id);
    assert_ne!(rebased.id, snapshot.id);
    task.abort();
}
