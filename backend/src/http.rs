use axum::{extract::State, http::StatusCode, routing::get, Json, Router};
use reqwest::Client;
use serde::Serialize;
use sqlx::SqlitePool;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;

use crate::{config::Config, crypto::TokenCipher, db, github_oauth, openapi::ApiDoc};

#[derive(Clone)]
pub struct AppState {
    pub(crate) config: Config,
    pub(crate) db: SqlitePool,
    pub(crate) http_client: Client,
    pub(crate) token_cipher: TokenCipher,
}

impl AppState {
    pub fn new(db: SqlitePool, config: Config) -> Self {
        let token_cipher = TokenCipher::new(&config.token_encryption_key);
        Self {
            config,
            db,
            http_client: Client::new(),
            token_cipher,
        }
    }
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: HealthStatus,
    pub database: HealthStatus,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum HealthStatus {
    Ok,
}

#[utoipa::path(
    get,
    path = "/api/health",
    responses(
        (status = 200, description = "Backend health check", body = HealthResponse)
    )
)]
pub(crate) async fn health(
    State(state): State<AppState>,
) -> Result<Json<HealthResponse>, StatusCode> {
    db::health_check(&state.db)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    Ok(Json(HealthResponse {
        status: HealthStatus::Ok,
        database: HealthStatus::Ok,
    }))
}

pub fn app(config: &Config, state: AppState) -> Router {
    let api = Router::new()
        .route("/auth/github/callback", get(github_oauth::callback))
        .route("/auth/github/start", get(github_oauth::start))
        .route("/health", get(health))
        .route("/openapi.json", get(openapi_json));

    let router = Router::new()
        .nest("/api", api)
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state);

    if config.environment.is_development() {
        router.merge(SwaggerUi::new("/api/docs").url("/api/docs/openapi.json", ApiDoc::openapi()))
    } else {
        router
    }
}

async fn openapi_json() -> Json<utoipa::openapi::OpenApi> {
    Json(ApiDoc::openapi())
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::Value;
    use tower::ServiceExt;

    use super::{app, AppState};
    use crate::{
        config::{Config, Environment, GitHubOAuthConfig, SessionConfig, TokenEncryptionKey},
        db,
    };

    fn test_config(environment: Environment) -> Config {
        Config {
            api_url: "http://127.0.0.1:3000".to_string(),
            app_url: "http://127.0.0.1:5173".to_string(),
            bind_addr: "127.0.0.1:0"
                .parse()
                .expect("test bind address should parse"),
            database_url: "sqlite::memory:".to_string(),
            environment,
            github_oauth: Some(GitHubOAuthConfig {
                client_id: "client_id".to_string(),
                client_secret: "client_secret".to_string(),
            }),
            session: SessionConfig {
                cookie_name: "test_session".to_string(),
                cookie_secure: false,
                ttl_days: 30,
            },
            token_encryption_key: TokenEncryptionKey::from_base64(&STANDARD.encode([3_u8; 32]))
                .expect("test key should parse"),
        }
    }

    async fn test_app(environment: Environment) -> axum::Router {
        let config = test_config(environment);
        let db = db::connect(&config).await.expect("test db should connect");
        db::migrate(&db).await.expect("test migrations should run");
        app(&config, AppState::new(db, config.clone()))
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let response = test_app(Environment::Development)
            .await
            .oneshot(
                Request::builder()
                    .uri("/api/health")
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
            serde_json::json!({ "database": "ok", "status": "ok" })
        );
    }

    #[tokio::test]
    async fn openapi_includes_health_path() {
        let response = test_app(Environment::Development)
            .await
            .oneshot(
                Request::builder()
                    .uri("/api/openapi.json")
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

        assert!(json["paths"]["/api/health"].is_object());
        assert!(json["components"]["schemas"]["HealthResponse"]["required"]
            .as_array()
            .expect("required fields should be an array")
            .contains(&serde_json::json!("database")));
    }
}
