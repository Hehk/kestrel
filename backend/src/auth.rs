use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use utoipa::ToSchema;

use crate::{
    http::AppState,
    session::{self, clear_session_cookie, SessionToken},
};

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub user: Option<UserDto>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserDto {
    pub id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/auth/me",
    responses(
        (status = 200, description = "Current authenticated user, if any", body = MeResponse)
    )
)]
pub(crate) async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MeResponse>, StatusCode> {
    let user = current_user(&state, &headers).await.map_err(|error| {
        tracing::error!(%error, "failed to load current user");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    Ok(Json(MeResponse { user }))
}

#[utoipa::path(
    post,
    path = "/api/auth/logout",
    responses(
        (status = 204, description = "Session cleared")
    )
)]
pub(crate) async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(token) = session_token_from_headers(&state, &headers) {
        if let Err(error) = session::delete_session(&state.db, &token).await {
            tracing::error!(%error, "failed to delete session during logout");
        }
    }

    (
        [(
            header::SET_COOKIE,
            clear_session_cookie(&state.config.session),
        )],
        StatusCode::NO_CONTENT,
    )
        .into_response()
}

pub(crate) async fn current_user_id(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<String>, AuthError> {
    let Some(token) = session_token_from_headers(state, headers) else {
        return Ok(None);
    };

    Ok(session::load_session_user_id(&state.db, &token).await?)
}

async fn current_user(state: &AppState, headers: &HeaderMap) -> Result<Option<UserDto>, AuthError> {
    let Some(user_id) = current_user_id(state, headers).await? else {
        return Ok(None);
    };

    let user = sqlx::query_as::<_, (String, String, Option<String>)>(
        "SELECT id, display_name, avatar_url FROM users WHERE id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .map(|(id, display_name, avatar_url)| UserDto {
        id,
        display_name,
        avatar_url,
    });

    Ok(user)
}

fn session_token_from_headers(state: &AppState, headers: &HeaderMap) -> Option<SessionToken> {
    let cookie_header = headers.get(header::COOKIE)?.to_str().ok()?;

    cookie_header.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        if name == state.config.session.cookie_name {
            SessionToken::from_raw(value)
        } else {
            None
        }
    })
}

#[derive(Debug)]
pub(crate) enum AuthError {
    Session(session::SessionError),
    Sql(sqlx::Error),
}

impl From<session::SessionError> for AuthError {
    fn from(error: session::SessionError) -> Self {
        Self::Session(error)
    }
}

impl From<sqlx::Error> for AuthError {
    fn from(error: sqlx::Error) -> Self {
        Self::Sql(error)
    }
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Session(error) => write!(f, "session lookup failed: {error}"),
            Self::Sql(error) => write!(f, "current user lookup failed: {error}"),
        }
    }
}

impl std::error::Error for AuthError {}

#[cfg(test)]
mod tests {
    use axum::{
        body::{to_bytes, Body},
        http::{header, Request, StatusCode},
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::Value;
    use sqlx::SqlitePool;
    use tower::ServiceExt;

    use crate::{
        config::{Config, Environment, SessionConfig, TokenEncryptionKey},
        db,
        http::{app, AppState},
        session,
    };

    fn test_config() -> Config {
        Config {
            api_url: "http://127.0.0.1:3000".to_string(),
            app_url: "http://127.0.0.1:5173".to_string(),
            bind_addr: "127.0.0.1:0"
                .parse()
                .expect("test bind address should parse"),
            database_url: "sqlite::memory:".to_string(),
            environment: Environment::Development,
            github_api_url: "https://api.github.com".to_string(),
            github_app: None,
            github_oauth: None,
            session: SessionConfig {
                cookie_name: "test_session".to_string(),
                cookie_secure: false,
                ttl_days: 30,
            },
            token_encryption_key: TokenEncryptionKey::from_base64(&STANDARD.encode([4_u8; 32]))
                .expect("test key should parse"),
        }
    }

    async fn test_db() -> SqlitePool {
        let config = test_config();
        let db = db::connect(&config).await.expect("test db should connect");
        db::migrate(&db).await.expect("test migrations should run");
        sqlx::query(
            "INSERT INTO users (id, display_name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("user_1")
        .bind("User One")
        .bind("https://avatars.example.test/user_1")
        .bind("2026-01-01T00:00:00Z")
        .bind("2026-01-01T00:00:00Z")
        .execute(&db)
        .await
        .expect("test user should insert");
        db
    }

    #[tokio::test]
    async fn me_returns_null_without_session() {
        let config = test_config();
        let db = test_db().await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/auth/me")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::OK);

        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should collect");
        let json: Value = serde_json::from_slice(&body).expect("body should be json");

        assert_eq!(json, serde_json::json!({ "user": null }));
    }

    #[tokio::test]
    async fn me_returns_user_with_valid_session() {
        let config = test_config();
        let db = test_db().await;
        let created_session = session::create_session(&db, "user_1", &config.session)
            .await
            .expect("session should create");
        let cookie = format!("test_session={}", created_session.token.expose());

        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/auth/me")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::OK);

        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should collect");
        let json: Value = serde_json::from_slice(&body).expect("body should be json");

        assert_eq!(
            json,
            serde_json::json!({
                "user": {
                    "id": "user_1",
                    "displayName": "User One",
                    "avatarUrl": "https://avatars.example.test/user_1"
                }
            })
        );
    }

    #[tokio::test]
    async fn logout_deletes_session_and_clears_cookie() {
        let config = test_config();
        let db = test_db().await;
        let created_session = session::create_session(&db, "user_1", &config.session)
            .await
            .expect("session should create");
        let cookie = format!("test_session={}", created_session.token.expose());

        let response = app(&config, AppState::new(db.clone(), config.clone()))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/logout")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(response
            .headers()
            .get(header::SET_COOKIE)
            .expect("set-cookie should exist")
            .to_str()
            .expect("set-cookie should be valid")
            .contains("Max-Age=0"));
        assert_eq!(
            session::load_session_user_id(&db, &created_session.token)
                .await
                .expect("session lookup should run"),
            None
        );
    }
}
