use axum::{routing::get, Json, Router};
use serde::Serialize;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;

use crate::{config::Config, openapi::ApiDoc};

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    status: HealthStatus,
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
pub(crate) async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: HealthStatus::Ok,
    })
}

pub fn app(config: &Config) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/openapi.json", get(openapi_json));

    let router = Router::new()
        .nest("/api", api)
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive());

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
    use serde_json::Value;
    use tower::ServiceExt;

    use super::app;
    use crate::config::{Config, Environment};

    fn test_config(environment: Environment) -> Config {
        Config {
            bind_addr: "127.0.0.1:0"
                .parse()
                .expect("test bind address should parse"),
            environment,
        }
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let response = app(&test_config(Environment::Development))
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

        assert_eq!(json, serde_json::json!({ "status": "ok" }));
    }

    #[tokio::test]
    async fn openapi_includes_health_path() {
        let response = app(&test_config(Environment::Development))
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
    }
}
