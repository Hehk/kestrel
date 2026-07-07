use axum::{
    extract::{Query, State},
    http::{header::SET_COOKIE, StatusCode},
    response::{IntoResponse, Redirect, Response},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};
use utoipa::IntoParams;

use crate::{
    config::GitHubOAuthConfig,
    crypto::TokenCipher,
    http::AppState,
    session::{self, session_cookie},
};

const GITHUB_AUTHORIZE_URL: &str = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL: &str = "https://api.github.com/user";
const GITHUB_EMAILS_URL: &str = "https://api.github.com/user/emails";
const GITHUB_PROVIDER: &str = "github";
const GITHUB_SCOPES: &str = "read:user user:email";

#[utoipa::path(
    get,
    path = "/api/auth/github/start",
    responses(
        (status = 303, description = "Redirects to GitHub OAuth"),
        (status = 503, description = "GitHub OAuth is not configured")
    )
)]
pub(crate) async fn start(State(state): State<AppState>) -> Result<Redirect, StatusCode> {
    let oauth = state
        .config
        .github_oauth
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let oauth_state = create_oauth_state(&state.db).await.map_err(|error| {
        tracing::error!(%error, "failed to create OAuth state");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let authorize_url = github_authorize_url(oauth, &state.config.api_url, &oauth_state)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Redirect::to(authorize_url.as_str()))
}

#[derive(Deserialize, IntoParams)]
pub struct GitHubCallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/auth/github/callback",
    params(GitHubCallbackQuery),
    responses(
        (status = 303, description = "Creates a local session and redirects to the frontend"),
        (status = 503, description = "GitHub OAuth is not configured")
    )
)]
pub(crate) async fn callback(
    State(state): State<AppState>,
    Query(query): Query<GitHubCallbackQuery>,
) -> Result<Response, StatusCode> {
    let Some(oauth) = state.config.github_oauth.as_ref() else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };

    if query.error.is_some() {
        return Ok(frontend_redirect(
            &state.config.app_url,
            "/login?error=github_oauth_denied",
        ));
    }

    let Some(code) = query.code else {
        return Ok(frontend_redirect(
            &state.config.app_url,
            "/login?error=missing_code",
        ));
    };
    let Some(oauth_state) = query.state else {
        return Ok(frontend_redirect(
            &state.config.app_url,
            "/login?error=missing_state",
        ));
    };

    let valid_state = consume_oauth_state(&state.db, &oauth_state)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to validate OAuth state");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    if !valid_state {
        return Ok(frontend_redirect(
            &state.config.app_url,
            "/login?error=invalid_state",
        ));
    }

    let result = complete_github_login(&state, oauth, &code).await;
    match result {
        Ok(session_token) => {
            let cookie = session_cookie(&state.config.session, &session_token);
            Ok(([(SET_COOKIE, cookie)], Redirect::to(&state.config.app_url)).into_response())
        }
        Err(error) => {
            tracing::error!(%error, "GitHub OAuth callback failed");
            Ok(frontend_redirect(
                &state.config.app_url,
                "/login?error=github_oauth_failed",
            ))
        }
    }
}

async fn complete_github_login(
    state: &AppState,
    oauth: &GitHubOAuthConfig,
    code: &str,
) -> Result<session::SessionToken, GitHubOAuthError> {
    let token =
        exchange_code_for_token(&state.http_client, oauth, &state.config.api_url, code).await?;
    let access_token = token
        .access_token
        .ok_or(GitHubOAuthError::Provider("missing access token"))?;
    let user = fetch_github_user(&state.http_client, &access_token).await?;
    let email = fetch_primary_email(&state.http_client, &access_token)
        .await
        .ok()
        .flatten();
    let scopes = token
        .scope
        .unwrap_or_default()
        .split(',')
        .filter(|scope| !scope.is_empty())
        .map(ToString::to_string)
        .collect();

    let identity = GitHubIdentity {
        access_token,
        avatar_url: user.avatar_url,
        display_name: user.name,
        email,
        provider_user_id: user.id.to_string(),
        refresh_token: token.refresh_token,
        scopes,
        username: user.login,
    };
    let user_id = persist_github_login(&state.db, &state.token_cipher, &identity).await?;
    let session = session::create_session(&state.db, &user_id, &state.config.session).await?;

    Ok(session.token)
}

fn github_authorize_url(
    oauth: &GitHubOAuthConfig,
    api_url: &str,
    oauth_state: &str,
) -> Result<Url, GitHubOAuthError> {
    let mut url = Url::parse(GITHUB_AUTHORIZE_URL)?;
    let redirect_uri = format!("{}/api/auth/github/callback", api_url.trim_end_matches('/'));
    url.query_pairs_mut()
        .append_pair("client_id", &oauth.client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", GITHUB_SCOPES)
        .append_pair("state", oauth_state);
    Ok(url)
}

async fn exchange_code_for_token(
    client: &reqwest::Client,
    oauth: &GitHubOAuthConfig,
    api_url: &str,
    code: &str,
) -> Result<GitHubTokenResponse, GitHubOAuthError> {
    let redirect_uri = format!("{}/api/auth/github/callback", api_url.trim_end_matches('/'));
    let response = client
        .post(GITHUB_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", oauth.client_id.as_str()),
            ("client_secret", oauth.client_secret.as_str()),
            ("code", code),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .await?
        .error_for_status()?
        .json::<GitHubTokenResponse>()
        .await?;

    if response.error.is_some() {
        return Err(GitHubOAuthError::Provider("token exchange failed"));
    }

    Ok(response)
}

async fn fetch_github_user(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<GitHubUserResponse, GitHubOAuthError> {
    Ok(client
        .get(GITHUB_USER_URL)
        .bearer_auth(access_token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "kestrel")
        .send()
        .await?
        .error_for_status()?
        .json::<GitHubUserResponse>()
        .await?)
}

async fn fetch_primary_email(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<Option<String>, GitHubOAuthError> {
    let emails = client
        .get(GITHUB_EMAILS_URL)
        .bearer_auth(access_token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "kestrel")
        .send()
        .await?
        .error_for_status()?
        .json::<Vec<GitHubEmailResponse>>()
        .await?;

    Ok(emails
        .iter()
        .find(|email| email.primary && email.verified)
        .or_else(|| emails.iter().find(|email| email.primary))
        .or_else(|| emails.iter().find(|email| email.verified))
        .or_else(|| emails.first())
        .map(|email| email.email.clone()))
}

async fn create_oauth_state(db: &SqlitePool) -> Result<String, GitHubOAuthError> {
    cleanup_expired_oauth_states(db).await?;

    let oauth_state = random_urlsafe(32);
    let state_hash = hash_secret(&oauth_state);
    let now = format_timestamp(OffsetDateTime::now_utc())?;
    let expires_at = format_timestamp(OffsetDateTime::now_utc() + Duration::minutes(10))?;

    sqlx::query("INSERT INTO oauth_states (state_hash, expires_at, created_at) VALUES (?, ?, ?)")
        .bind(state_hash)
        .bind(expires_at)
        .bind(now)
        .execute(db)
        .await?;

    Ok(oauth_state)
}

async fn consume_oauth_state(db: &SqlitePool, oauth_state: &str) -> Result<bool, GitHubOAuthError> {
    let state_hash = hash_secret(oauth_state);
    let row =
        sqlx::query_as::<_, (String,)>("SELECT expires_at FROM oauth_states WHERE state_hash = ?")
            .bind(&state_hash)
            .fetch_optional(db)
            .await?;

    sqlx::query("DELETE FROM oauth_states WHERE state_hash = ?")
        .bind(&state_hash)
        .execute(db)
        .await?;

    let Some((expires_at,)) = row else {
        return Ok(false);
    };
    let expires_at = OffsetDateTime::parse(&expires_at, &Rfc3339)?;

    Ok(expires_at > OffsetDateTime::now_utc())
}

async fn cleanup_expired_oauth_states(db: &SqlitePool) -> Result<(), GitHubOAuthError> {
    let now = format_timestamp(OffsetDateTime::now_utc())?;
    sqlx::query("DELETE FROM oauth_states WHERE expires_at <= ?")
        .bind(now)
        .execute(db)
        .await?;
    Ok(())
}

async fn persist_github_login(
    db: &SqlitePool,
    token_cipher: &TokenCipher,
    identity: &GitHubIdentity,
) -> Result<String, GitHubOAuthError> {
    let mut tx = db.begin().await?;
    let now = format_timestamp(OffsetDateTime::now_utc())?;
    let display_name = identity
        .display_name
        .as_deref()
        .unwrap_or(&identity.username);
    let access_token = token_cipher.encrypt(&identity.access_token)?;
    let refresh_token = identity
        .refresh_token
        .as_deref()
        .map(|token| token_cipher.encrypt(token))
        .transpose()?;
    let scopes_json = serde_json::to_string(&identity.scopes)?;

    let existing_user_id = sqlx::query_scalar::<_, String>(
        "SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?",
    )
    .bind(GITHUB_PROVIDER)
    .bind(&identity.provider_user_id)
    .fetch_optional(&mut *tx)
    .await?;

    let user_id = match existing_user_id {
        Some(user_id) => {
            sqlx::query(
                "UPDATE users SET display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?",
            )
            .bind(display_name)
            .bind(&identity.avatar_url)
            .bind(&now)
            .bind(&user_id)
            .execute(&mut *tx)
            .await?;
            user_id
        }
        None => {
            let user_id = format!("user_{}", random_urlsafe(16));
            sqlx::query(
                "INSERT INTO users (id, display_name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&user_id)
            .bind(display_name)
            .bind(&identity.avatar_url)
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            user_id
        }
    };

    sqlx::query(
        "INSERT OR IGNORE INTO user_settings (user_id, created_at, updated_at) VALUES (?, ?, ?)",
    )
    .bind(&user_id)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, email, username, access_token_encrypted, refresh_token_encrypted, scopes_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, provider_user_id) DO UPDATE SET email = excluded.email, username = excluded.username, access_token_encrypted = excluded.access_token_encrypted, refresh_token_encrypted = excluded.refresh_token_encrypted, scopes_json = excluded.scopes_json, updated_at = excluded.updated_at",
    )
    .bind(format!("oauth_{}", random_urlsafe(16)))
    .bind(&user_id)
    .bind(GITHUB_PROVIDER)
    .bind(&identity.provider_user_id)
    .bind(&identity.email)
    .bind(&identity.username)
    .bind(access_token)
    .bind(refresh_token)
    .bind(scopes_json)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(user_id)
}

fn frontend_redirect(app_url: &str, path: &str) -> Response {
    Redirect::to(&format!("{}{}", app_url.trim_end_matches('/'), path)).into_response()
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

fn format_timestamp(timestamp: OffsetDateTime) -> Result<String, GitHubOAuthError> {
    Ok(timestamp.format(&Rfc3339)?)
}

#[derive(Deserialize)]
struct GitHubTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    refresh_token: Option<String>,
    scope: Option<String>,
}

#[derive(Deserialize)]
struct GitHubUserResponse {
    avatar_url: Option<String>,
    id: i64,
    login: String,
    name: Option<String>,
}

#[derive(Deserialize)]
struct GitHubEmailResponse {
    email: String,
    primary: bool,
    verified: bool,
}

struct GitHubIdentity {
    access_token: String,
    avatar_url: Option<String>,
    display_name: Option<String>,
    email: Option<String>,
    provider_user_id: String,
    refresh_token: Option<String>,
    scopes: Vec<String>,
    username: String,
}

#[derive(Debug)]
enum GitHubOAuthError {
    Crypto(crate::crypto::CryptoError),
    Provider(&'static str),
    Reqwest(reqwest::Error),
    Serde(serde_json::Error),
    Session(crate::session::SessionError),
    Sql(sqlx::Error),
    TimeFormat(time::error::Format),
    TimeParse(time::error::Parse),
    Url(url::ParseError),
}

impl From<crate::crypto::CryptoError> for GitHubOAuthError {
    fn from(error: crate::crypto::CryptoError) -> Self {
        Self::Crypto(error)
    }
}

impl From<reqwest::Error> for GitHubOAuthError {
    fn from(error: reqwest::Error) -> Self {
        Self::Reqwest(error)
    }
}

impl From<serde_json::Error> for GitHubOAuthError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serde(error)
    }
}

impl From<crate::session::SessionError> for GitHubOAuthError {
    fn from(error: crate::session::SessionError) -> Self {
        Self::Session(error)
    }
}

impl From<sqlx::Error> for GitHubOAuthError {
    fn from(error: sqlx::Error) -> Self {
        Self::Sql(error)
    }
}

impl From<time::error::Format> for GitHubOAuthError {
    fn from(error: time::error::Format) -> Self {
        Self::TimeFormat(error)
    }
}

impl From<time::error::Parse> for GitHubOAuthError {
    fn from(error: time::error::Parse) -> Self {
        Self::TimeParse(error)
    }
}

impl From<url::ParseError> for GitHubOAuthError {
    fn from(error: url::ParseError) -> Self {
        Self::Url(error)
    }
}

impl std::fmt::Display for GitHubOAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Crypto(error) => write!(f, "GitHub token encryption failed: {error}"),
            Self::Provider(message) => write!(f, "GitHub OAuth provider error: {message}"),
            Self::Reqwest(error) => write!(f, "GitHub HTTP request failed: {error}"),
            Self::Serde(error) => write!(f, "GitHub OAuth serialization failed: {error}"),
            Self::Session(error) => write!(f, "GitHub OAuth session creation failed: {error}"),
            Self::Sql(error) => write!(f, "GitHub OAuth database operation failed: {error}"),
            Self::TimeFormat(error) => write!(f, "GitHub OAuth time format failed: {error}"),
            Self::TimeParse(error) => write!(f, "GitHub OAuth time parse failed: {error}"),
            Self::Url(error) => write!(f, "GitHub OAuth URL build failed: {error}"),
        }
    }
}

impl std::error::Error for GitHubOAuthError {}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use sqlx::SqlitePool;

    use super::{
        consume_oauth_state, create_oauth_state, github_authorize_url, persist_github_login,
        GitHubIdentity,
    };
    use crate::{
        config::{Config, Environment, GitHubOAuthConfig, SessionConfig, TokenEncryptionKey},
        crypto::TokenCipher,
        db,
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
            github_app: None,
            github_oauth: Some(GitHubOAuthConfig {
                client_id: "client_id".to_string(),
                client_secret: "client_secret".to_string(),
            }),
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
        let config = test_config();
        let db = db::connect(&config).await.expect("test db should connect");
        db::migrate(&db).await.expect("test migrations should run");
        db
    }

    #[test]
    fn builds_github_authorize_url() {
        let config = test_config();
        let oauth = config.github_oauth.as_ref().expect("oauth should exist");

        let url =
            github_authorize_url(oauth, &config.api_url, "state_123").expect("url should build");
        let query = url.query().expect("url should have query");

        assert_eq!(
            url.as_str().split('?').next(),
            Some("https://github.com/login/oauth/authorize")
        );
        assert!(query.contains("client_id=client_id"));
        assert!(query.contains("scope=read%3Auser+user%3Aemail"));
        assert!(query.contains("state=state_123"));
        assert!(query.contains(
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Fauth%2Fgithub%2Fcallback"
        ));
    }

    #[tokio::test]
    async fn consumes_oauth_state_once() {
        let db = test_db().await;
        let oauth_state = create_oauth_state(&db).await.expect("state should create");

        assert!(consume_oauth_state(&db, &oauth_state)
            .await
            .expect("state should validate"));
        assert!(!consume_oauth_state(&db, &oauth_state)
            .await
            .expect("state should not validate twice"));
    }

    #[tokio::test]
    async fn persists_github_login_and_reuses_user() {
        let config = test_config();
        let db = test_db().await;
        let token_cipher = TokenCipher::new(&config.token_encryption_key);
        let identity = GitHubIdentity {
            access_token: "access_token".to_string(),
            avatar_url: Some("https://avatars.example.test/reg".to_string()),
            display_name: Some("Reg".to_string()),
            email: Some("reg@example.test".to_string()),
            provider_user_id: "123".to_string(),
            refresh_token: None,
            scopes: vec!["read:user".to_string(), "user:email".to_string()],
            username: "reg".to_string(),
        };

        let first_user_id = persist_github_login(&db, &token_cipher, &identity)
            .await
            .expect("login should persist");
        let second_user_id = persist_github_login(&db, &token_cipher, &identity)
            .await
            .expect("login should persist again");

        assert_eq!(first_user_id, second_user_id);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&db)
            .await
            .expect("user count should load");
        assert_eq!(count, 1);

        let (stored_token, scopes_json): (String, String) = sqlx::query_as(
            "SELECT access_token_encrypted, scopes_json FROM oauth_accounts WHERE provider = 'github' AND provider_user_id = '123'",
        )
        .fetch_one(&db)
        .await
        .expect("oauth account should load");

        assert_ne!(stored_token, "access_token");
        assert!(stored_token.starts_with("v1:"));
        assert_eq!(scopes_json, r#"["read:user","user:email"]"#);

        let settings_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_settings")
            .fetch_one(&db)
            .await
            .expect("settings count should load");
        assert_eq!(settings_count, 1);
    }
}
