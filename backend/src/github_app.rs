use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Redirect,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};
use url::Url;
use utoipa::IntoParams;

use crate::{auth, http::AppState};

const GITHUB_APP_URL: &str = "https://github.com/apps";
const USER_AGENT: &str = "kestrel";

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

pub(crate) async fn create_installation_token(
    state: &AppState,
    installation_id: &str,
) -> Result<InstallationAccessToken, GitHubAppError> {
    let github_app = state
        .config
        .github_app
        .as_ref()
        .ok_or(GitHubAppError::Config("GitHub App is not configured"))?;
    let app_jwt = create_app_jwt(github_app, OffsetDateTime::now_utc())?;
    let url = format!(
        "{}/app/installations/{installation_id}/access_tokens",
        state.config.github_api_url.trim_end_matches('/')
    );
    let response = state
        .http_client
        .post(url)
        .bearer_auth(app_jwt)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .send()
        .await?
        .error_for_status()?
        .json::<InstallationAccessTokenResponse>()
        .await?;

    Ok(InstallationAccessToken {
        expires_at: response.expires_at,
        token: response.token,
    })
}

pub(crate) async fn installation_ids_for_user(
    db: &SqlitePool,
    user_id: &str,
) -> Result<Vec<String>, GitHubAppError> {
    Ok(sqlx::query_scalar(
        "SELECT installation_id FROM github_app_installation_users WHERE user_id = ? ORDER BY created_at ASC",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?)
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

fn create_app_jwt(
    github_app: &crate::config::GitHubAppConfig,
    now: OffsetDateTime,
) -> Result<String, GitHubAppError> {
    let app_id = github_app
        .app_id
        .as_deref()
        .ok_or(GitHubAppError::Config("GITHUB_APP_ID is not configured"))?;
    let private_key_pem = github_app
        .private_key_pem
        .as_deref()
        .ok_or(GitHubAppError::Config(
            "GITHUB_APP_PRIVATE_KEY is not configured",
        ))?;
    let claims = AppJwtClaims {
        exp: (now + Duration::minutes(9)).unix_timestamp(),
        iat: (now - Duration::minutes(1)).unix_timestamp(),
        iss: app_id,
    };
    let key = EncodingKey::from_rsa_pem(private_key_pem.as_bytes())?;

    Ok(encode(&Header::new(Algorithm::RS256), &claims, &key)?)
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
pub(crate) enum GitHubAppError {
    Config(&'static str),
    Jwt(jsonwebtoken::errors::Error),
    Reqwest(reqwest::Error),
    Sql(sqlx::Error),
    TimeFormat(time::error::Format),
    TimeParse(time::error::Parse),
    Url(url::ParseError),
}

impl From<jsonwebtoken::errors::Error> for GitHubAppError {
    fn from(error: jsonwebtoken::errors::Error) -> Self {
        Self::Jwt(error)
    }
}

impl From<reqwest::Error> for GitHubAppError {
    fn from(error: reqwest::Error) -> Self {
        Self::Reqwest(error)
    }
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
            Self::Config(message) => write!(f, "GitHub App config error: {message}"),
            Self::Jwt(error) => write!(f, "GitHub App JWT operation failed: {error}"),
            Self::Reqwest(error) => write!(f, "GitHub App HTTP request failed: {error}"),
            Self::Sql(error) => write!(f, "GitHub App database operation failed: {error}"),
            Self::TimeFormat(error) => write!(f, "GitHub App time format failed: {error}"),
            Self::TimeParse(error) => write!(f, "GitHub App time parse failed: {error}"),
            Self::Url(error) => write!(f, "GitHub App URL parse failed: {error}"),
        }
    }
}

impl std::error::Error for GitHubAppError {}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct InstallationAccessToken {
    pub expires_at: String,
    pub token: String,
}

#[derive(Serialize)]
struct AppJwtClaims<'a> {
    exp: i64,
    iat: i64,
    iss: &'a str,
}

#[derive(Deserialize)]
struct InstallationAccessTokenResponse {
    expires_at: String,
    token: String,
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{header, Request, StatusCode},
    };
    use base64::{
        engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
        Engine,
    };
    use serde_json::Value;
    use sqlx::SqlitePool;
    use time::OffsetDateTime;
    use tower::ServiceExt;
    use url::Url;

    use crate::{
        config::{Config, Environment, GitHubAppConfig, SessionConfig, TokenEncryptionKey},
        db,
        http::{app, AppState},
        session,
    };

    use super::{authorize_url, create_app_jwt, create_setup_state};

    const TEST_PRIVATE_KEY: &str = r#"-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCtUYeFKD6eqX1W
0J9vYJ4wySvQxoFV4xx6SBaAwmg9LCiQc312et0ayn833+zBHpVV1EwP6yJs63c5
/6iUNCfGNU0YcPwmZXUm6zMotlxtum1+GvmyH3AUcL61LDidL8QKpc+uUQBBpRPE
gvzA8pAm8xb0TTv6O2gobAuAgAbdOrJTSJ2yeXruVTThN1Z5hdmByCfLymc2dkUH
Rm5bHIxGG+zqUiOCbCeLR4bZQ62jRY8KyUruscw4wTa2qeJ5W66mbHckFyAHTNaL
4e5X7Hkm73coZYBLcroX4hhq2OL+2AlZwffR5ZHcHxZCiYoPzPUwGsPi9U4IVQJE
o5tiRFNFAgMBAAECggEABfqpwk1WbH9sLG1x2qDkKpdK4V7ZWzIReCLgt9w9EvZh
IRHPsof5jorAcDG6IRo7f6SdY4n/YlX00BwcRjfOzKoBEpNI3gNvbIJkfbnEBYfb
1PDJGKNSAm22foyO5W+4HSZSor2QbmaFM8KeRc/FN+34WdqiQF2bscbmCXuHmrEn
5ivqCLQ2z4fr4iRimLCRxJpw52/A2U2uc4hZR+75X/2OWu0MtIALfzv49LI5fFv7
DHKG1VJyrioLjY/8+K9l3AznzKdCpWDz8qTkeYL2dQPbveaLwJAgqx8bL+r48OoB
udaEDC+Zh+FepblwjxKXGky2poRKKmOePCjhRTSZwQKBgQD0kfG4LKGscbH4xDwC
AajgGPwvjCH4abePSHfNHE5lGJZbgPiYFtYyHbTu9GvNRz29ZTvNLATSzFMXDQii
zwSANfiWTY8YFUI6SVx/8r3fda71dye3xeoKjlUGtG9rGUDdVE4wbhemzbZs5wO6
qaurONp6xfKYra4b1/FBQXdhYQKBgQC1ayAMNhFKmomwTUcQi3p1Ubg4wgYKhH1t
VWnSAPy5KC9lOF3DuTiuRvE4Wsj6O/TdC7MYzLuJCsoqcPFSEXNZB9gXgn9HSvXi
7TLLXgh0/Glr1Ro5LCFiElW4xKwQKGEIU42V3+AoU66zt/nQvrcMeN/GTrazGm4f
zOUB5svoZQKBgAqqWqo3eA13H9XDaQKFZAHx1P2V1N1qbtDWzjKpq1mJSvVOmIi5
ZjnlRcCt9A2Nr8mUopj99G/k7TKyJNBEyuN0dxTG6RiZxLuZ+2ixA0q9bRXTTm4b
OWugbWDPeZRoE4YTaR1/j5R8oBn7sRPw1kWvQwfbngq+eDtKnYDFBBnBAoGBAJOg
krmdHcEJtFWk7NlHxuTFFRYKvQO+AJsB0FS1vPGnA7pofdSRWtBmplBnf/gw5fci
WCEsKMdB4nVa5uUTkju2qF+pL42CMEjzIExhPpyD8f1vsiEoChpWNS9fy2xyj1NJ
OoPlY/Es95MDeOQm7anWirJCx2VDcq2p/AjqGLAJAoGALjmu1UzAE+zg3vzLg+l1
1NVWaESqfcImXd8OjWuW7ioVZ4zFNxE2DxJCswd/Aj4Fv61jgOTpRh9sstiuYj1h
kfa5MaBosQCdvsCK5Vi6zDZVeyIQ9JJLVnMq3fvyXqymSuTaq6HF+FIjcvc7lniK
vAyYm+x4Q92C4SBC+QZ4IfI=
-----END PRIVATE KEY-----"#;

    fn test_config(github_app: Option<GitHubAppConfig>) -> Config {
        Config {
            api_url: "http://127.0.0.1:3000".to_string(),
            app_url: "http://127.0.0.1:5173".to_string(),
            bind_addr: "127.0.0.1:0"
                .parse()
                .expect("test bind address should parse"),
            database_url: "sqlite::memory:".to_string(),
            environment: Environment::Development,
            github_api_url: "https://api.github.com".to_string(),
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
            app_id: None,
            private_key_pem: None,
            slug: "kestrel-test".to_string(),
        }
    }

    fn github_app_token_config() -> GitHubAppConfig {
        GitHubAppConfig {
            app_id: Some("12345".to_string()),
            private_key_pem: Some(TEST_PRIVATE_KEY.to_string()),
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

    #[test]
    fn creates_app_jwt() {
        let now =
            OffsetDateTime::from_unix_timestamp(1_700_000_000).expect("timestamp should be valid");
        let token = create_app_jwt(&github_app_token_config(), now).expect("jwt should create");
        let parts = token.split('.').collect::<Vec<_>>();

        assert_eq!(parts.len(), 3);

        let header: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(parts[0])
                .expect("header should base64 decode"),
        )
        .expect("header should be json");
        assert_eq!(header["alg"], "RS256");

        let claims: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(parts[1])
                .expect("claims should base64 decode"),
        )
        .expect("claims should be json");
        assert_eq!(claims["iss"], "12345");
        assert_eq!(claims["iat"], 1_699_999_940);
        assert_eq!(claims["exp"], 1_700_000_540);
    }

    #[test]
    fn app_jwt_requires_credentials() {
        let error = create_app_jwt(&github_app_config(), OffsetDateTime::now_utc())
            .expect_err("missing credentials should fail");

        assert_eq!(
            error.to_string(),
            "GitHub App config error: GITHUB_APP_ID is not configured"
        );
    }

    #[tokio::test]
    async fn installation_token_requires_app_config() {
        let config = test_config(None);
        let db = test_db().await;
        let state = AppState::new(db, config);
        let error = super::create_installation_token(&state, "123")
            .await
            .expect_err("missing config should fail");

        assert_eq!(
            error.to_string(),
            "GitHub App config error: GitHub App is not configured"
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
