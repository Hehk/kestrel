use axum::{extract::State, http::HeaderMap, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use utoipa::ToSchema;

use crate::{auth, http::AppState};

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsResponse {
    pub theme: Theme,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsRequest {
    pub theme: Theme,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Dark,
    Light,
    System,
}

impl Theme {
    fn as_str(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
            Self::System => "system",
        }
    }

    fn from_db(value: &str) -> Result<Self, SettingsError> {
        match value {
            "dark" => Ok(Self::Dark),
            "light" => Ok(Self::Light),
            "system" => Ok(Self::System),
            _ => Err(SettingsError::InvalidStoredTheme(value.to_string())),
        }
    }
}

#[utoipa::path(
    get,
    path = "/api/settings",
    responses(
        (status = 200, description = "Current user settings", body = SettingsResponse),
        (status = 401, description = "Authentication required")
    )
)]
pub(crate) async fn get_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SettingsResponse>, StatusCode> {
    let user_id = require_user_id(&state, &headers).await?;
    let settings = load_settings(&state, &user_id).await.map_err(|error| {
        tracing::error!(%error, "failed to load settings");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    Ok(Json(settings))
}

#[utoipa::path(
    put,
    path = "/api/settings",
    request_body = UpdateSettingsRequest,
    responses(
        (status = 200, description = "Updated user settings", body = SettingsResponse),
        (status = 401, description = "Authentication required")
    )
)]
pub(crate) async fn put_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<UpdateSettingsRequest>,
) -> Result<Json<SettingsResponse>, StatusCode> {
    let user_id = require_user_id(&state, &headers).await?;
    let settings = update_settings(&state, &user_id, request.theme)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to update settings");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    Ok(Json(settings))
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

async fn load_settings(state: &AppState, user_id: &str) -> Result<SettingsResponse, SettingsError> {
    let theme =
        sqlx::query_scalar::<_, String>("SELECT theme FROM user_settings WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;
    let Some(theme) = theme else {
        return create_default_settings(state, user_id).await;
    };

    Ok(SettingsResponse {
        theme: Theme::from_db(&theme)?,
    })
}

async fn create_default_settings(
    state: &AppState,
    user_id: &str,
) -> Result<SettingsResponse, SettingsError> {
    let now = format_timestamp(OffsetDateTime::now_utc())?;
    sqlx::query("INSERT INTO user_settings (user_id, created_at, updated_at) VALUES (?, ?, ?)")
        .bind(user_id)
        .bind(&now)
        .bind(&now)
        .execute(&state.db)
        .await?;

    Ok(SettingsResponse {
        theme: Theme::System,
    })
}

async fn update_settings(
    state: &AppState,
    user_id: &str,
    theme: Theme,
) -> Result<SettingsResponse, SettingsError> {
    let now = format_timestamp(OffsetDateTime::now_utc())?;
    sqlx::query(
        "INSERT INTO user_settings (user_id, theme, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme, updated_at = excluded.updated_at",
    )
    .bind(user_id)
    .bind(theme.as_str())
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await?;

    Ok(SettingsResponse { theme })
}

fn format_timestamp(timestamp: OffsetDateTime) -> Result<String, SettingsError> {
    Ok(timestamp.format(&Rfc3339)?)
}

#[derive(Debug)]
enum SettingsError {
    InvalidStoredTheme(String),
    Sql(sqlx::Error),
    TimeFormat(time::error::Format),
}

impl From<sqlx::Error> for SettingsError {
    fn from(error: sqlx::Error) -> Self {
        Self::Sql(error)
    }
}

impl From<time::error::Format> for SettingsError {
    fn from(error: time::error::Format) -> Self {
        Self::TimeFormat(error)
    }
}

impl std::fmt::Display for SettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidStoredTheme(theme) => write!(f, "invalid stored theme {theme:?}"),
            Self::Sql(error) => write!(f, "settings database operation failed: {error}"),
            Self::TimeFormat(error) => write!(f, "failed to format settings timestamp: {error}"),
        }
    }
}

impl std::error::Error for SettingsError {}

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
            token_encryption_key: TokenEncryptionKey::from_base64(&STANDARD.encode([6_u8; 32]))
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

    async fn session_cookie(db: &SqlitePool, config: &Config) -> String {
        let session = session::create_session(db, "user_1", &config.session)
            .await
            .expect("session should create");
        format!("test_session={}", session.token.expose())
    }

    #[tokio::test]
    async fn get_settings_requires_authentication() {
        let config = test_config();
        let db = test_db().await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/settings")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn get_settings_returns_default_settings() {
        let config = test_config();
        let db = test_db().await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/settings")
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

        assert_eq!(json, serde_json::json!({ "theme": "system" }));
    }

    #[tokio::test]
    async fn put_settings_updates_theme() {
        let config = test_config();
        let db = test_db().await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db.clone(), config.clone()))
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/settings")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::COOKIE, cookie)
                    .body(Body::from(r#"{"theme":"dark"}"#))
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::OK);

        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should collect");
        let json: Value = serde_json::from_slice(&body).expect("body should be json");
        assert_eq!(json, serde_json::json!({ "theme": "dark" }));

        let theme: String = sqlx::query_scalar("SELECT theme FROM user_settings WHERE user_id = ?")
            .bind("user_1")
            .fetch_one(&db)
            .await
            .expect("settings theme should load");
        assert_eq!(theme, "dark");
    }

    #[tokio::test]
    async fn put_settings_rejects_invalid_theme() {
        let config = test_config();
        let db = test_db().await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/settings")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::COOKIE, cookie)
                    .body(Body::from(r#"{"theme":"blue"}"#))
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
}
