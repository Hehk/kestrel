use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use cookie::{Cookie, SameSite};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};

use crate::config::SessionConfig;

#[derive(Clone)]
pub struct SessionToken(String);

impl SessionToken {
    pub(crate) fn from_raw(value: &str) -> Option<Self> {
        if value.is_empty() {
            return None;
        }

        Some(Self(value.to_string()))
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SessionToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionToken(<redacted>)")
    }
}

pub struct CreatedSession {
    pub token: SessionToken,
}

pub async fn create_session(
    db: &SqlitePool,
    user_id: &str,
    session_config: &SessionConfig,
) -> Result<CreatedSession, SessionError> {
    let expires_at = OffsetDateTime::now_utc() + Duration::days(session_config.ttl_days);
    create_session_with_expiry(db, user_id, expires_at).await
}

async fn create_session_with_expiry(
    db: &SqlitePool,
    user_id: &str,
    expires_at: OffsetDateTime,
) -> Result<CreatedSession, SessionError> {
    let id = random_urlsafe(16);
    let token = SessionToken(random_urlsafe(32));
    let token_hash = hash_token(&token);
    let now = format_timestamp(OffsetDateTime::now_utc())?;
    let expires_at_text = format_timestamp(expires_at)?;

    sqlx::query(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(token_hash)
    .bind(expires_at_text)
    .bind(now)
    .execute(db)
    .await?;

    Ok(CreatedSession { token })
}

pub async fn load_session_user_id(
    db: &SqlitePool,
    token: &SessionToken,
) -> Result<Option<String>, SessionError> {
    let token_hash = hash_token(token);
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?",
    )
    .bind(&token_hash)
    .fetch_optional(db)
    .await?;

    let Some((user_id, expires_at)) = row else {
        return Ok(None);
    };

    let expires_at = OffsetDateTime::parse(&expires_at, &Rfc3339)?;
    if expires_at <= OffsetDateTime::now_utc() {
        delete_session_by_token_hash(db, &token_hash).await?;
        return Ok(None);
    }

    Ok(Some(user_id))
}

pub async fn delete_session(db: &SqlitePool, token: &SessionToken) -> Result<(), SessionError> {
    let token_hash = hash_token(token);
    delete_session_by_token_hash(db, &token_hash).await
}

async fn delete_session_by_token_hash(
    db: &SqlitePool,
    token_hash: &str,
) -> Result<(), SessionError> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
        .bind(token_hash)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn cleanup_expired_sessions(db: &SqlitePool) -> Result<u64, SessionError> {
    let now = format_timestamp(OffsetDateTime::now_utc())?;
    let result = sqlx::query("DELETE FROM sessions WHERE expires_at <= ?")
        .bind(now)
        .execute(db)
        .await?;
    Ok(result.rows_affected())
}

pub fn session_cookie(session_config: &SessionConfig, token: &SessionToken) -> String {
    Cookie::build((
        session_config.cookie_name.clone(),
        token.expose().to_string(),
    ))
    .http_only(true)
    .max_age(cookie::time::Duration::days(session_config.ttl_days))
    .path("/")
    .same_site(SameSite::Lax)
    .secure(session_config.cookie_secure)
    .build()
    .to_string()
}

pub fn clear_session_cookie(session_config: &SessionConfig) -> String {
    Cookie::build((session_config.cookie_name.clone(), "".to_string()))
        .http_only(true)
        .max_age(cookie::time::Duration::ZERO)
        .path("/")
        .same_site(SameSite::Lax)
        .secure(session_config.cookie_secure)
        .build()
        .to_string()
}

fn random_urlsafe(byte_len: usize) -> String {
    let mut bytes = vec![0_u8; byte_len];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_token(token: &SessionToken) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.expose().as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

fn format_timestamp(timestamp: OffsetDateTime) -> Result<String, SessionError> {
    Ok(timestamp.format(&Rfc3339)?)
}

#[derive(Debug)]
pub enum SessionError {
    FormatTime(time::error::Format),
    ParseTime(time::error::Parse),
    Sql(sqlx::Error),
}

impl From<sqlx::Error> for SessionError {
    fn from(error: sqlx::Error) -> Self {
        Self::Sql(error)
    }
}

impl From<time::error::Format> for SessionError {
    fn from(error: time::error::Format) -> Self {
        Self::FormatTime(error)
    }
}

impl From<time::error::Parse> for SessionError {
    fn from(error: time::error::Parse) -> Self {
        Self::ParseTime(error)
    }
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FormatTime(error) => write!(f, "failed to format session timestamp: {error}"),
            Self::ParseTime(error) => write!(f, "failed to parse session timestamp: {error}"),
            Self::Sql(error) => write!(f, "session database operation failed: {error}"),
        }
    }
}

impl std::error::Error for SessionError {}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use sqlx::SqlitePool;

    use super::{
        cleanup_expired_sessions, clear_session_cookie, create_session, create_session_with_expiry,
        delete_session, hash_token, load_session_user_id, session_cookie,
    };
    use crate::{
        config::{Config, Environment, SessionConfig, TokenEncryptionKey},
        db,
    };

    fn session_config(cookie_secure: bool) -> SessionConfig {
        SessionConfig {
            cookie_name: "test_session".to_string(),
            cookie_secure,
            ttl_days: 30,
        }
    }

    fn test_config() -> Config {
        Config {
            api_url: "http://127.0.0.1:3000".to_string(),
            app_url: "http://127.0.0.1:5173".to_string(),
            bind_addr: "127.0.0.1:0"
                .parse()
                .expect("test bind address should parse"),
            database_url: "sqlite::memory:".to_string(),
            environment: Environment::Development,
            github_oauth: None,
            session: session_config(false),
            token_encryption_key: TokenEncryptionKey::from_base64(
                &base64::engine::general_purpose::STANDARD.encode([5_u8; 32]),
            )
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
        .bind(Option::<String>::None)
        .bind("2026-01-01T00:00:00Z")
        .bind("2026-01-01T00:00:00Z")
        .execute(&db)
        .await
        .expect("test user should insert");
        db
    }

    #[tokio::test]
    async fn creates_session_without_storing_raw_token() {
        let db = test_db().await;
        let created = create_session(&db, "user_1", &session_config(false))
            .await
            .expect("session should create");

        assert_eq!(format!("{:?}", created.token), "SessionToken(<redacted>)");

        let stored_hash: String = sqlx::query_scalar("SELECT token_hash FROM sessions")
            .fetch_one(&db)
            .await
            .expect("session hash should load");

        assert_ne!(stored_hash, created.token.expose());
        assert_eq!(stored_hash, hash_token(&created.token));
    }

    #[tokio::test]
    async fn loads_valid_session_user_id() {
        let db = test_db().await;
        let created = create_session(&db, "user_1", &session_config(false))
            .await
            .expect("session should create");

        assert_eq!(
            load_session_user_id(&db, &created.token)
                .await
                .expect("session should load"),
            Some("user_1".to_string())
        );
    }

    #[tokio::test]
    async fn rejects_and_removes_expired_sessions() {
        let db = test_db().await;
        let created = create_session_with_expiry(
            &db,
            "user_1",
            time::OffsetDateTime::now_utc() - time::Duration::minutes(1),
        )
        .await
        .expect("session should create");

        assert_eq!(
            load_session_user_id(&db, &created.token)
                .await
                .expect("session should load"),
            None
        );

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
            .fetch_one(&db)
            .await
            .expect("session count should load");
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn deletes_session() {
        let db = test_db().await;
        let created = create_session(&db, "user_1", &session_config(false))
            .await
            .expect("session should create");

        delete_session(&db, &created.token)
            .await
            .expect("session should delete");

        assert_eq!(
            load_session_user_id(&db, &created.token)
                .await
                .expect("session should load"),
            None
        );
    }

    #[tokio::test]
    async fn cleans_up_expired_sessions() {
        let db = test_db().await;
        create_session_with_expiry(
            &db,
            "user_1",
            time::OffsetDateTime::now_utc() - time::Duration::minutes(1),
        )
        .await
        .expect("expired session should create");
        create_session(&db, "user_1", &session_config(false))
            .await
            .expect("valid session should create");

        assert_eq!(
            cleanup_expired_sessions(&db)
                .await
                .expect("cleanup should run"),
            1
        );

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
            .fetch_one(&db)
            .await
            .expect("session count should load");
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn builds_session_cookies() {
        let db = test_db().await;
        let created = create_session(&db, "user_1", &session_config(false))
            .await
            .expect("session should create");

        let cookie = session_cookie(&session_config(false), &created.token);

        assert!(cookie.starts_with("test_session="));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Lax"));
        assert!(cookie.contains("Path=/"));
        assert!(cookie.contains("Max-Age="));
        assert!(!cookie.contains("Secure"));
    }

    #[test]
    fn production_cookie_is_secure() {
        let token = super::SessionToken("token".to_string());
        let cookie = session_cookie(&session_config(true), &token);

        assert!(cookie.contains("Secure"));
    }

    #[test]
    fn clear_cookie_expires_session_cookie() {
        let cookie = clear_session_cookie(&session_config(true));

        assert!(cookie.starts_with("test_session="));
        assert!(cookie.contains("Max-Age=0"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("Secure"));
    }
}
