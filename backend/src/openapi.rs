use utoipa::OpenApi;

use crate::{
    auth::{MeResponse, UserDto},
    http::{HealthResponse, HealthStatus},
};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Kestrel API",
        version = "0.1.0",
        description = "Backend API for Kestrel"
    ),
    paths(
        crate::auth::logout,
        crate::auth::me,
        crate::github_oauth::callback,
        crate::github_oauth::start,
        crate::http::health
    ),
    components(schemas(HealthResponse, HealthStatus, MeResponse, UserDto))
)]
pub struct ApiDoc;
