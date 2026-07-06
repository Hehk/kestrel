use utoipa::OpenApi;

use crate::{
    auth::{MeResponse, UserDto},
    http::{HealthResponse, HealthStatus},
    repositories::{
        CreateRepositoryRequest, CreateRepositoryResponse, ListRepositoriesResponse, RepositoryDto,
        RepositoryErrorCode, RepositoryErrorResponse,
    },
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
        crate::repositories::create_repository,
        crate::repositories::list_repositories,
        crate::settings::get_settings,
        crate::settings::put_settings
    ),
    components(schemas(
        CreateRepositoryRequest,
        CreateRepositoryResponse,
        HealthResponse,
        HealthStatus,
        ListRepositoriesResponse,
        MeResponse,
        RepositoryDto,
        RepositoryErrorCode,
        RepositoryErrorResponse,
        SettingsResponse,
        Theme,
        UpdateSettingsRequest,
        UserDto
    ))
)]
pub struct ApiDoc;
