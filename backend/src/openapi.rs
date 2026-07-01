use utoipa::OpenApi;

use crate::{
    auth::{MeResponse, UserDto},
    http::{HealthResponse, HealthStatus},
    settings::{SettingsResponse, Theme, UpdateSettingsRequest},
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
        crate::http::health,
        crate::settings::get_settings,
        crate::settings::put_settings
    ),
    components(schemas(
        HealthResponse,
        HealthStatus,
        MeResponse,
        SettingsResponse,
        Theme,
        UpdateSettingsRequest,
        UserDto
    ))
)]
pub struct ApiDoc;
