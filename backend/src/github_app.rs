use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Redirect,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};
use url::Url;
use utoipa::IntoParams;

use crate::{auth, http::AppState};

const GITHUB_APP_URL: &str = "https://github.com/apps";

#[utoipa::path(
    get,
    path = "/api/github-app/authorize",
    operation_id = "github_app_authorize",
    responses(
        (status = 303, description = "Redirects to GitHub App installation flow"),
        (status = 401, description = "Authentication required"),
        (status = 503, description = "GitHub App is not configured")
    )
)]
pub(crate) async fn authorize(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Redirect, StatusCode> {
    let app = state
        .config
        .github_app
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let user_id = require_user_id(&state, &headers).await?;
    let setup_state = create_setup_state(&state.db, &user_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to create GitHub App setup state");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    let authorize_url = authorize_url(&app.slug, &setup_state).map_err(|error| {
        tracing::error!(%error, "failed to build GitHub App authorize URL");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    Ok(Redirect::to(authorize_url.as_str()))
}

#[derive(Deserialize, IntoParams)]
pub(crate) struct CallbackQuery {
    pub installation_id: Option<i64>,
    pub setup_action: Option<String>,
    pub state: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/github-app/callback",
    operation_id = "github_app_callback",
    params(CallbackQuery),
    responses(
        (status = 303, description = "Stores GitHub App installation and redirects to frontend"),
        (status = 401, description = "Authentication required")
    )
)]
pub(crate) async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<CallbackQuery>,
) -> Result<Redirect, StatusCode> {
    let user_id = require_user_id(&state, &headers).await?;
    let Some(setup_state) = query.state else {
        return Ok(frontend_redirect(
            &state.config.app_url,
            "/?github_app_error=missing_state",
        ));
    };
    let valid_state = consume_setup_state(&state.db, &user_id, &setup_state)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to validate GitHub App setup state");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    if !valid_state {
        return Ok(frontend_redirect(
            &state.config.app_url,
            "/?github_app_error=invalid_state",
        ));
    }

    let Some(installation_id) = query.installation_id else {
        return Ok(frontend_redirect(
            &state.config.app_url,
            "/?github_app_error=missing_installation",
        ));
    };

    persist_installation(&state.db, &user_id, installation_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, ?query.setup_action, "failed to persist GitHub App installation");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    Ok(frontend_redirect(
        &state.config.app_url,
        "/?github_app=authorized",
    ))
}

async fn require_user_id(state: &AppState, headers: &HeaderMap) -> Result<String, StatusCode> {
    auth::current_user_id(state, headers)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to load authenticated user");
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .ok_or(StatusCode::UNAUTHORIZED)
}

fn authorize_url(slug: &str, setup_state: &str) -> Result<Url, GitHubAppError> {
    let mut url = Url::parse(&format!(
        "{}/{}/installations/new",
        GITHUB_APP_URL,
        slug.trim_matches('/')
    ))?;
    url.query_pairs_mut().append_pair("state", setup_state);
    Ok(url)
}

async fn create_setup_state(db: &SqlitePool, user_id: &str) -> Result<String, GitHubAppError> {
    cleanup_expired_setup_states(db).await?;

    let setup_state = random_urlsafe(32);
    let state_hash = hash_secret(&setup_state);
    let now = format_timestamp(OffsetDateTime::now_utc())?;
    let expires_at = format_timestamp(OffsetDateTime::now_utc() + Duration::minutes(10))?;

    sqlx::query(
        "INSERT INTO github_app_setup_states (state_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(state_hash)
    .bind(user_id)
    .bind(expires_at)
    .bind(now)
    .execute(db)
    .await?;

    Ok(setup_state)
}

async fn consume_setup_state(
    db: &SqlitePool,
    user_id: &str,
    setup_state: &str,
) -> Result<bool, GitHubAppError> {
    let state_hash = hash_secret(setup_state);
    let row = sqlx::query_as::<_, (String,)>(
        "SELECT expires_at FROM github_app_setup_states WHERE state_hash = ? AND user_id = ?",
    )
    .bind(&state_hash)
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    sqlx::query("DELETE FROM github_app_setup_states WHERE state_hash = ?")
        .bind(&state_hash)
        .execute(db)
        .await?;

    let Some((expires_at,)) = row else {
        return Ok(false);
    };
    let expires_at = OffsetDateTime::parse(&expires_at, &Rfc3339)?;

    Ok(expires_at > OffsetDateTime::now_utc())
}

async fn cleanup_expired_setup_states(db: &SqlitePool) -> Result<(), GitHubAppError> {
    let now = format_timestamp(OffsetDateTime::now_utc())?;
    sqlx::query("DELETE FROM github_app_setup_states WHERE expires_at <= ?")
        .bind(now)
        .execute(db)
        .await?;
    Ok(())
}

async fn persist_installation(
    db: &SqlitePool,
    user_id: &str,
    installation_id: i64,
) -> Result<(), GitHubAppError> {
    let mut tx = db.begin().await?;
    let now = format_timestamp(OffsetDateTime::now_utc())?;
    let installation_id = installation_id.to_string();

    sqlx::query(
        "INSERT INTO github_app_installations (installation_id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(installation_id) DO UPDATE SET updated_at = excluded.updated_at",
    )
    .bind(&installation_id)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT OR IGNORE INTO github_app_installation_users (installation_id, user_id, created_at) VALUES (?, ?, ?)",
    )
    .bind(&installation_id)
    .bind(user_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

fn frontend_redirect(app_url: &str, path: &str) -> Redirect {
    Redirect::to(&format!("{}{}", app_url.trim_end_matches('/'), path))
}

fn random_urlsafe(byte_len: usize) -> String {
    let mut bytes = vec![0_u8; byte_len];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_secret(secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

fn format_timestamp(timestamp: OffsetDateTime) -> Result<String, GitHubAppError> {
    Ok(timestamp.format(&Rfc3339)?)
}

#[derive(Debug)]
enum GitHubAppError {
    Sql(sqlx::Error),
    TimeFormat(time::error::Format),
    TimeParse(time::error::Parse),
    Url(url::ParseError),
}

impl From<sqlx::Error> for GitHubAppError {
    fn from(error: sqlx::Error) -> Self {
        Self::Sql(error)
    }
}

impl From<time::error::Format> for GitHubAppError {
    fn from(error: time::error::Format) -> Self {
        Self::TimeFormat(error)
    }
}

impl From<time::error::Parse> for GitHubAppError {
    fn from(error: time::error::Parse) -> Self {
        Self::TimeParse(error)
    }
}

impl From<url::ParseError> for GitHubAppError {
    fn from(error: url::ParseError) -> Self {
        Self::Url(error)
    }
}

impl std::fmt::Display for GitHubAppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sql(error) => write!(f, "GitHub App database operation failed: {error}"),
            Self::TimeFormat(error) => write!(f, "GitHub App time format failed: {error}"),
            Self::TimeParse(error) => write!(f, "GitHub App time parse failed: {error}"),
            Self::Url(error) => write!(f, "GitHub App URL parse failed: {error}"),
        }
    }
}

impl std::error::Error for GitHubAppError {}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{header, Request, StatusCode},
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    use sqlx::SqlitePool;
    use tower::ServiceExt;
    use url::Url;

    use crate::{
        config::{Config, Environment, GitHubAppConfig, SessionConfig, TokenEncryptionKey},
        db,
        http::{app, AppState},
        session,
    };

    use super::{authorize_url, create_setup_state};

    fn test_config(github_app: Option<GitHubAppConfig>) -> Config {
        Config {
            api_url: "http://127.0.0.1:3000".to_string(),
            app_url: "http://127.0.0.1:5173".to_string(),
            bind_addr: "127.0.0.1:0"
                .parse()
                .expect("test bind address should parse"),
            database_url: "sqlite::memory:".to_string(),
            environment: Environment::Development,
            github_app,
            github_oauth: None,
            session: SessionConfig {
                cookie_name: "test_session".to_string(),
                cookie_secure: false,
                ttl_days: 30,
            },
            token_encryption_key: TokenEncryptionKey::from_base64(&STANDARD.encode([8_u8; 32]))
                .expect("test key should parse"),
        }
    }

    async fn test_db() -> SqlitePool {
        let config = test_config(None);
        let db = db::connect(&config).await.expect("test db should connect");
        db::migrate(&db).await.expect("test migrations should run");
        sqlx::query(
            "INSERT INTO users (id, display_name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("user_1")
        .bind("User One")
        .bind(Option::<String>::None)
        .bind("2026-01-01T00:00:00Z")
        .bind("2026-01-01T00:00:00Z")
        .execute(&db)
        .await
        .expect("test user should insert");
        db
    }

    async fn session_cookie(db: &SqlitePool, config: &Config) -> String {
        let session = session::create_session(db, "user_1", &config.session)
            .await
            .expect("session should create");
        format!("test_session={}", session.token.expose())
    }

    fn github_app_config() -> GitHubAppConfig {
        GitHubAppConfig {
            slug: "kestrel-test".to_string(),
        }
    }

    #[test]
    fn builds_authorize_url() {
        let url = authorize_url("kestrel-test", "state_123").expect("url should build");

        assert_eq!(
            url.as_str(),
            "https://github.com/apps/kestrel-test/installations/new?state=state_123"
        );
    }

    #[tokio::test]
    async fn authorize_requires_authentication() {
        let config = test_config(Some(github_app_config()));
        let db = test_db().await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/github-app/authorize")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn authorize_returns_unavailable_without_config() {
        let config = test_config(None);
        let db = test_db().await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/github-app/authorize")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn authorize_redirects_to_github_and_stores_setup_state() {
        let config = test_config(Some(github_app_config()));
        let db = test_db().await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db.clone(), config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/github-app/authorize")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        let location = response
            .headers()
            .get(header::LOCATION)
            .expect("location should be set")
            .to_str()
            .expect("location should be valid");
        let url = Url::parse(location).expect("location should parse");
        assert_eq!(url.host_str(), Some("github.com"));
        assert_eq!(url.path(), "/apps/kestrel-test/installations/new");
        assert!(url
            .query_pairs()
            .any(|(key, value)| key == "state" && !value.is_empty()));

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM github_app_setup_states")
            .fetch_one(&db)
            .await
            .expect("setup state count should load");
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn callback_requires_authentication() {
        let config = test_config(Some(github_app_config()));
        let db = test_db().await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/github-app/callback?installation_id=123&state=state")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn callback_stores_installation_for_user() {
        let config = test_config(Some(github_app_config()));
        let db = test_db().await;
        let cookie = session_cookie(&db, &config).await;
        let setup_state = create_setup_state(&db, "user_1")
            .await
            .expect("setup state should create");
        let response = app(&config, AppState::new(db.clone(), config.clone()))
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/github-app/callback?installation_id=123&setup_action=install&state={setup_state}"
                    ))
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok()),
            Some("http://127.0.0.1:5173/?github_app=authorized"),
        );

        let installation_id: String = sqlx::query_scalar(
            "SELECT installation_id FROM github_app_installation_users WHERE user_id = ?",
        )
        .bind("user_1")
        .fetch_one(&db)
        .await
        .expect("installation user link should load");
        assert_eq!(installation_id, "123");
    }

    #[tokio::test]
    async fn callback_rejects_invalid_state() {
        let config = test_config(Some(github_app_config()));
        let db = test_db().await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db.clone(), config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/github-app/callback?installation_id=123&state=wrong")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok()),
            Some("http://127.0.0.1:5173/?github_app_error=invalid_state"),
        );

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM github_app_installations")
            .fetch_one(&db)
            .await
            .expect("installation count should load");
        assert_eq!(count, 0);
    }
}
