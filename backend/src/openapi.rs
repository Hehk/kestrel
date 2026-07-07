use utoipa::OpenApi;

use crate::{
    auth::{MeResponse, UserDto},
    http::{HealthResponse, HealthStatus},
    pull_requests::{
        ListPullRequestsResponse, PullRequestDto, PullRequestErrorCode, PullRequestErrorResponse,
        SyncPullRequestsResponse,
    },
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
        crate::github_app::authorize,
        crate::github_app::callback,
        crate::github_oauth::callback,
        crate::github_oauth::start,
        crate::http::health,
        crate::pull_requests::list_pull_requests,
        crate::pull_requests::sync_pull_requests,
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
        ListPullRequestsResponse,
        MeResponse,
        PullRequestDto,
        PullRequestErrorCode,
        PullRequestErrorResponse,
        RepositoryDto,
        RepositoryErrorCode,
        RepositoryErrorResponse,
        SettingsResponse,
        SyncPullRequestsResponse,
        Theme,
        UpdateSettingsRequest,
        UserDto
    ))
)]
pub struct ApiDoc;
