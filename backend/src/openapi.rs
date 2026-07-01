use utoipa::OpenApi;

use crate::http::{HealthResponse, HealthStatus};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Kestrel API",
        version = "0.1.0",
        description = "Backend API for Kestrel"
    ),
    paths(crate::http::health),
    components(schemas(HealthResponse, HealthStatus))
)]
pub struct ApiDoc;
