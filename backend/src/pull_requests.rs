use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use reqwest::StatusCode as ReqwestStatusCode;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sqlx::SqlitePool;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use utoipa::{IntoParams, ToSchema};

use crate::{auth, github_app, http::AppState, repositories};

const GITHUB_PROVIDER: &str = "github";
const PAGE_SIZE: u8 = 100;
const USER_AGENT: &str = "kestrel";

#[derive(Deserialize, IntoParams)]
pub(crate) struct RepositoryPath {
    owner: String,
    name: String,
}

#[derive(Deserialize, IntoParams)]
pub(crate) struct PullRequestPath {
    owner: String,
    name: String,
    number: i64,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDto {
    pub author_login: Option<String>,
    pub closed_at: Option<String>,
    pub created_at: String,
    pub draft: bool,
    pub github_id: i64,
    pub html_url: String,
    pub merged_at: Option<String>,
    pub number: i64,
    pub state: String,
    pub synced_at: String,
    pub title: String,
    pub updated_at: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListPullRequestsResponse {
    pub pull_requests: Vec<PullRequestDto>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullRequestsResponse {
    pub complete: bool,
    pub next_page: Option<i64>,
    pub pull_requests: Vec<PullRequestDto>,
    pub synced_count: usize,
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCheckRunDto {
    pub name: String,
    pub state: String,
    pub summary: Option<String>,
    pub title: Option<String>,
    pub url: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCommentDto {
    pub author_login: Option<String>,
    pub body: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCommitDto {
    pub message: String,
    pub sha: String,
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestFileDto {
    pub filename: String,
    pub status: String,
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewDto {
    pub author_login: Option<String>,
    pub state: String,
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestStatusDto {
    pub context: String,
    pub description: Option<String>,
    pub state: String,
    pub url: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestTimelineEventDto {
    pub actor_login: Option<String>,
    pub event: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetailDto {
    pub check_runs: Vec<PullRequestCheckRunDto>,
    pub commits: Vec<PullRequestCommitDto>,
    pub diff: Option<String>,
    pub files: Vec<PullRequestFileDto>,
    pub issue_comments: Vec<PullRequestCommentDto>,
    pub review_comments: Vec<PullRequestCommentDto>,
    pub review_decision: Option<String>,
    pub reviews: Vec<PullRequestReviewDto>,
    pub statuses: Vec<PullRequestStatusDto>,
    pub synced_at: String,
    pub timeline: Vec<PullRequestTimelineEventDto>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetailResponse {
    pub pull_request_detail: PullRequestDetailDto,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestErrorResponse {
    pub error: PullRequestErrorCode,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestErrorCode {
    AuthorizationRequired,
    InvalidPullRequest,
    InvalidRepository,
    PullRequestNotFound,
    RepositoryNotTracked,
    SyncFailed,
}

impl PullRequestErrorCode {
    fn as_str(&self) -> &'static str {
        match self {
            Self::AuthorizationRequired => "authorization_required",
            Self::InvalidPullRequest => "invalid_pull_request",
            Self::InvalidRepository => "invalid_repository",
            Self::PullRequestNotFound => "pull_request_not_found",
            Self::RepositoryNotTracked => "repository_not_tracked",
            Self::SyncFailed => "sync_failed",
        }
    }
}

#[utoipa::path(
    get,
    path = "/api/repositories/{owner}/{name}/pull-requests",
    params(RepositoryPath),
    responses(
        (status = 200, description = "Stored pull requests for a tracked repository", body = ListPullRequestsResponse),
        (status = 400, description = "Invalid repository", body = PullRequestErrorResponse),
        (status = 401, description = "Authentication required"),
        (status = 404, description = "Repository is not tracked", body = PullRequestErrorResponse)
    )
)]
pub(crate) async fn list_pull_requests(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(path): Path<RepositoryPath>,
) -> Result<Json<ListPullRequestsResponse>, (StatusCode, Json<PullRequestErrorResponse>)> {
    let user_id = require_user_id(&state, &headers)
        .await
        .map_err(|status| api_error(status, PullRequestErrorCode::SyncFailed))?;
    let repository = parse_repository_path(path)?;
    let tracked = load_tracked_repository(&state.db, &user_id, &repository)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to load tracked repository");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                PullRequestErrorCode::SyncFailed,
            )
        })?
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                PullRequestErrorCode::RepositoryNotTracked,
            )
        })?;
    let pull_requests = load_pull_requests(&state.db, &tracked)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to load stored pull requests");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                PullRequestErrorCode::SyncFailed,
            )
        })?;

    Ok(Json(ListPullRequestsResponse { pull_requests }))
}

#[utoipa::path(
    post,
    path = "/api/repositories/{owner}/{name}/pull-requests/sync",
    params(RepositoryPath),
    responses(
        (status = 200, description = "One page of pull requests synced", body = SyncPullRequestsResponse),
        (status = 400, description = "Invalid repository", body = PullRequestErrorResponse),
        (status = 401, description = "Authentication required"),
        (status = 403, description = "GitHub App authorization required", body = PullRequestErrorResponse),
        (status = 404, description = "Repository is not tracked", body = PullRequestErrorResponse)
    )
)]
pub(crate) async fn sync_pull_requests(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(path): Path<RepositoryPath>,
) -> Result<Json<SyncPullRequestsResponse>, (StatusCode, Json<PullRequestErrorResponse>)> {
    let user_id = require_user_id(&state, &headers)
        .await
        .map_err(|status| api_error(status, PullRequestErrorCode::SyncFailed))?;
    let repository = parse_repository_path(path)?;
    let tracked = load_tracked_repository(&state.db, &user_id, &repository)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to load tracked repository");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                PullRequestErrorCode::SyncFailed,
            )
        })?
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                PullRequestErrorCode::RepositoryNotTracked,
            )
        })?;

    let github_pull_requests =
        match fetch_pull_requests_with_installation(&state, &user_id, &tracked).await {
            Ok(pull_requests) => pull_requests,
            Err(error) => {
                let (status, code) = match error {
                    PullRequestSyncError::AuthorizationRequired => (
                        StatusCode::FORBIDDEN,
                        PullRequestErrorCode::AuthorizationRequired,
                    ),
                    PullRequestSyncError::Other(error) => {
                        tracing::error!(%error, "failed to sync pull requests");
                        (StatusCode::BAD_GATEWAY, PullRequestErrorCode::SyncFailed)
                    }
                };
                if let Err(error) = update_sync_error(&state.db, &tracked, code.as_str()).await {
                    tracing::error!(%error, "failed to store pull request sync error");
                }
                return Err(api_error(status, code));
            }
        };
    let synced_at = format_timestamp(OffsetDateTime::now_utc()).map_err(|error| {
        tracing::error!(%error, "failed to format pull request sync timestamp");
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            PullRequestErrorCode::SyncFailed,
        )
    })?;
    let complete = github_pull_requests.len() < usize::from(PAGE_SIZE);
    let pull_requests =
        upsert_pull_requests(&state.db, &tracked, &github_pull_requests, &synced_at)
            .await
            .map_err(|error| {
                tracing::error!(%error, "failed to store pull requests");
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    PullRequestErrorCode::SyncFailed,
                )
            })?;
    let next_page = if complete {
        None
    } else {
        Some(tracked.sync_page + 1)
    };
    update_sync_state(&state.db, &tracked, next_page, &synced_at)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to update pull request sync state");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                PullRequestErrorCode::SyncFailed,
            )
        })?;

    Ok(Json(SyncPullRequestsResponse {
        complete,
        next_page,
        synced_count: pull_requests.len(),
        pull_requests,
    }))
}

#[utoipa::path(
    get,
    path = "/api/repositories/{owner}/{name}/pull-requests/{number}",
    params(PullRequestPath),
    responses(
        (status = 200, description = "Stored pull request detail snapshot", body = PullRequestDetailResponse),
        (status = 400, description = "Invalid repository or pull request", body = PullRequestErrorResponse),
        (status = 401, description = "Authentication required"),
        (status = 404, description = "Repository or pull request detail is not stored", body = PullRequestErrorResponse)
    )
)]
pub(crate) async fn get_pull_request_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(path): Path<PullRequestPath>,
) -> Result<Json<PullRequestDetailResponse>, (StatusCode, Json<PullRequestErrorResponse>)> {
    let user_id = require_user_id(&state, &headers)
        .await
        .map_err(|status| api_error(status, PullRequestErrorCode::SyncFailed))?;
    let (repository, number) = parse_pull_request_path(path)?;
    let tracked = load_tracked_repository(&state.db, &user_id, &repository)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to load tracked repository");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                PullRequestErrorCode::SyncFailed,
            )
        })?
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                PullRequestErrorCode::RepositoryNotTracked,
            )
        })?;
    let pull_request_detail = load_pull_request_detail(&state.db, &tracked, number)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to load stored pull request detail");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                PullRequestErrorCode::SyncFailed,
            )
        })?
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                PullRequestErrorCode::PullRequestNotFound,
            )
        })?;

    Ok(Json(PullRequestDetailResponse {
        pull_request_detail,
    }))
}

#[utoipa::path(
    post,
    path = "/api/repositories/{owner}/{name}/pull-requests/{number}/sync",
    params(PullRequestPath),
    responses(
        (status = 200, description = "Pull request detail synced", body = PullRequestDetailResponse),
        (status = 400, description = "Invalid repository or pull request", body = PullRequestErrorResponse),
        (status = 401, description = "Authentication required"),
        (status = 403, description = "GitHub App authorization required", body = PullRequestErrorResponse),
        (status = 404, description = "Repository is not tracked", body = PullRequestErrorResponse)
    )
)]
pub(crate) async fn sync_pull_request_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(path): Path<PullRequestPath>,
) -> Result<Json<PullRequestDetailResponse>, (StatusCode, Json<PullRequestErrorResponse>)> {
    let user_id = require_user_id(&state, &headers)
        .await
        .map_err(|status| api_error(status, PullRequestErrorCode::SyncFailed))?;
    let (repository, number) = parse_pull_request_path(path)?;
    let tracked = load_tracked_repository(&state.db, &user_id, &repository)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to load tracked repository");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                PullRequestErrorCode::SyncFailed,
            )
        })?
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                PullRequestErrorCode::RepositoryNotTracked,
            )
        })?;

    let github_detail =
        match fetch_pull_request_detail_with_installation(&state, &user_id, &tracked, number).await
        {
            Ok(detail) => detail,
            Err(error) => {
                let (status, code) = match error {
                    PullRequestSyncError::AuthorizationRequired => (
                        StatusCode::FORBIDDEN,
                        PullRequestErrorCode::AuthorizationRequired,
                    ),
                    PullRequestSyncError::Other(error) => {
                        tracing::error!(%error, "failed to sync pull request detail");
                        (StatusCode::BAD_GATEWAY, PullRequestErrorCode::SyncFailed)
                    }
                };
                return Err(api_error(status, code));
            }
        };
    let synced_at = format_timestamp(OffsetDateTime::now_utc()).map_err(|error| {
        tracing::error!(%error, "failed to format pull request detail sync timestamp");
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            PullRequestErrorCode::SyncFailed,
        )
    })?;
    let pull_request_detail =
        upsert_pull_request_detail(&state.db, &tracked, number, &github_detail, &synced_at)
            .await
            .map_err(|error| {
                tracing::error!(%error, "failed to store pull request detail");
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    PullRequestErrorCode::SyncFailed,
                )
            })?;

    Ok(Json(PullRequestDetailResponse {
        pull_request_detail,
    }))
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

fn parse_repository_path(
    path: RepositoryPath,
) -> Result<repositories::ParsedRepository, (StatusCode, Json<PullRequestErrorResponse>)> {
    repositories::parse_repository_input(&format!("{}/{}", path.owner, path.name)).map_err(|_| {
        api_error(
            StatusCode::BAD_REQUEST,
            PullRequestErrorCode::InvalidRepository,
        )
    })
}

fn parse_pull_request_path(
    path: PullRequestPath,
) -> Result<(repositories::ParsedRepository, i64), (StatusCode, Json<PullRequestErrorResponse>)> {
    let repository = repositories::parse_repository_input(&format!("{}/{}", path.owner, path.name))
        .map_err(|_| {
            api_error(
                StatusCode::BAD_REQUEST,
                PullRequestErrorCode::InvalidRepository,
            )
        })?;
    if path.number < 1 {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            PullRequestErrorCode::InvalidPullRequest,
        ));
    }

    Ok((repository, path.number))
}

async fn load_tracked_repository(
    db: &SqlitePool,
    user_id: &str,
    repository: &repositories::ParsedRepository,
) -> Result<Option<TrackedRepository>, PullRequestDataError> {
    let row = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT owner, name, pull_requests_sync_page FROM tracked_repositories WHERE user_id = ? AND provider = ? AND owner = ? AND name = ?",
    )
    .bind(user_id)
    .bind(GITHUB_PROVIDER)
    .bind(&repository.owner)
    .bind(&repository.name)
    .fetch_optional(db)
    .await?;

    Ok(row.map(|(owner, name, sync_page)| TrackedRepository {
        name,
        owner,
        sync_page,
        user_id: user_id.to_string(),
    }))
}

async fn load_pull_requests(
    db: &SqlitePool,
    repository: &TrackedRepository,
) -> Result<Vec<PullRequestDto>, PullRequestDataError> {
    let rows = sqlx::query_as::<_, PullRequestRow>(
        "SELECT github_id, number, title, state, draft, author_login, html_url, created_at, updated_at, closed_at, merged_at, synced_at FROM tracked_repository_pull_requests WHERE user_id = ? AND provider = ? AND owner = ? AND name = ? ORDER BY created_at DESC, number DESC",
    )
    .bind(&repository.user_id)
    .bind(GITHUB_PROVIDER)
    .bind(&repository.owner)
    .bind(&repository.name)
    .fetch_all(db)
    .await?;

    Ok(rows.into_iter().map(PullRequestRow::into_dto).collect())
}

async fn load_pull_request_detail(
    db: &SqlitePool,
    repository: &TrackedRepository,
    number: i64,
) -> Result<Option<PullRequestDetailDto>, PullRequestDataError> {
    let row = sqlx::query_as::<_, PullRequestDetailRow>(
        "SELECT files_json, commits_json, reviews_json, review_comments_json, review_decision, issue_comments_json, timeline_json, check_runs_json, statuses_json, diff, synced_at FROM tracked_repository_pull_request_details WHERE user_id = ? AND provider = ? AND owner = ? AND name = ? AND number = ?",
    )
    .bind(&repository.user_id)
    .bind(GITHUB_PROVIDER)
    .bind(&repository.owner)
    .bind(&repository.name)
    .bind(number)
    .fetch_optional(db)
    .await?;

    row.map(PullRequestDetailRow::into_dto).transpose()
}

async fn fetch_pull_requests_with_installation(
    state: &AppState,
    user_id: &str,
    repository: &TrackedRepository,
) -> Result<Vec<GitHubPullRequest>, PullRequestSyncError> {
    let installation_ids = github_app::installation_ids_for_user(&state.db, user_id)
        .await
        .map_err(|error| PullRequestSyncError::Other(error.into()))?;
    if installation_ids.is_empty() {
        return Err(PullRequestSyncError::AuthorizationRequired);
    }

    let mut last_error: Option<PullRequestDataError> = None;
    for installation_id in installation_ids {
        let token = github_app::create_installation_token(state, &installation_id)
            .await
            .map_err(|error| PullRequestSyncError::Other(error.into()))?;
        match fetch_github_pull_requests(state, &token.token, repository).await {
            Ok(pull_requests) => return Ok(pull_requests),
            Err(PullRequestDataError::GitHubAccessDenied) => continue,
            Err(error) => last_error = Some(error),
        }
    }

    match last_error {
        Some(error) => Err(PullRequestSyncError::Other(error)),
        None => Err(PullRequestSyncError::AuthorizationRequired),
    }
}

async fn fetch_pull_request_detail_with_installation(
    state: &AppState,
    user_id: &str,
    repository: &TrackedRepository,
    number: i64,
) -> Result<PullRequestDetailSnapshot, PullRequestSyncError> {
    let installation_ids = github_app::installation_ids_for_user(&state.db, user_id)
        .await
        .map_err(|error| PullRequestSyncError::Other(error.into()))?;
    if installation_ids.is_empty() {
        return Err(PullRequestSyncError::AuthorizationRequired);
    }

    let mut last_error: Option<PullRequestDataError> = None;
    for installation_id in installation_ids {
        let token = github_app::create_installation_token(state, &installation_id)
            .await
            .map_err(|error| PullRequestSyncError::Other(error.into()))?;
        match fetch_github_pull_request_detail(state, &token.token, repository, number).await {
            Ok(detail) => return Ok(detail),
            Err(PullRequestDataError::GitHubAccessDenied) => continue,
            Err(error) => last_error = Some(error),
        }
    }

    match last_error {
        Some(error) => Err(PullRequestSyncError::Other(error)),
        None => Err(PullRequestSyncError::AuthorizationRequired),
    }
}

async fn fetch_github_pull_requests(
    state: &AppState,
    token: &str,
    repository: &TrackedRepository,
) -> Result<Vec<GitHubPullRequest>, PullRequestDataError> {
    let response = state
        .http_client
        .get(format!(
            "{}/repos/{}/{}/pulls",
            state.config.github_api_url.trim_end_matches('/'),
            repository.owner,
            repository.name
        ))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .query(&[
            ("state", "all"),
            ("sort", "created"),
            ("direction", "desc"),
            ("per_page", &PAGE_SIZE.to_string()),
            ("page", &repository.sync_page.to_string()),
        ])
        .send()
        .await?;
    if response.status() == ReqwestStatusCode::FORBIDDEN
        || response.status() == ReqwestStatusCode::NOT_FOUND
    {
        return Err(PullRequestDataError::GitHubAccessDenied);
    }

    Ok(response
        .error_for_status()?
        .json::<Vec<GitHubPullRequest>>()
        .await?)
}

async fn fetch_github_pull_request_detail(
    state: &AppState,
    token: &str,
    repository: &TrackedRepository,
    number: i64,
) -> Result<PullRequestDetailSnapshot, PullRequestDataError> {
    let base_url = state.config.github_api_url.trim_end_matches('/');
    let pull_request_url = format!(
        "{base_url}/repos/{}/{}/pulls/{number}",
        repository.owner, repository.name
    );
    let pull_request: GitHubPullRequestDetail =
        fetch_github_json(state, token, &pull_request_url).await?;
    let review_decision = fetch_github_review_decision(state, token, repository, number).await?;
    let files: Vec<GitHubPullRequestFile> =
        fetch_github_json(state, token, &format!("{pull_request_url}/files")).await?;
    let commits: Vec<GitHubPullRequestCommit> =
        fetch_github_json(state, token, &format!("{pull_request_url}/commits")).await?;
    let reviews: Vec<GitHubPullRequestReview> =
        fetch_github_json(state, token, &format!("{pull_request_url}/reviews")).await?;
    let review_comments: Vec<GitHubPullRequestComment> =
        fetch_github_json(state, token, &format!("{pull_request_url}/comments")).await?;
    let issue_comments: Vec<GitHubPullRequestComment> = fetch_github_json(
        state,
        token,
        &format!(
            "{base_url}/repos/{}/{}/issues/{number}/comments",
            repository.owner, repository.name
        ),
    )
    .await?;
    let timeline: Vec<GitHubPullRequestTimelineEvent> = fetch_github_json(
        state,
        token,
        &format!(
            "{base_url}/repos/{}/{}/issues/{number}/timeline",
            repository.owner, repository.name
        ),
    )
    .await?;
    let check_runs: GitHubCheckRuns = fetch_github_json(
        state,
        token,
        &format!(
            "{base_url}/repos/{}/{}/commits/{head_sha}/check-runs",
            repository.owner,
            repository.name,
            head_sha = pull_request.head.sha,
        ),
    )
    .await?;
    let statuses: GitHubStatuses = fetch_github_json(
        state,
        token,
        &format!(
            "{base_url}/repos/{}/{}/commits/{head_sha}/status",
            repository.owner,
            repository.name,
            head_sha = pull_request.head.sha,
        ),
    )
    .await?;
    let diff = fetch_github_text(
        state,
        token,
        &pull_request_url,
        "application/vnd.github.v3.diff",
    )
    .await?;

    Ok(PullRequestDetailSnapshot {
        check_runs: check_runs
            .check_runs
            .into_iter()
            .map(PullRequestCheckRunDto::from)
            .collect(),
        commits: commits
            .into_iter()
            .map(PullRequestCommitDto::from)
            .collect(),
        diff: Some(diff),
        files: files.into_iter().map(PullRequestFileDto::from).collect(),
        issue_comments: issue_comments
            .into_iter()
            .map(PullRequestCommentDto::from)
            .collect(),
        review_comments: review_comments
            .into_iter()
            .map(PullRequestCommentDto::from)
            .collect(),
        review_decision,
        reviews: reviews
            .into_iter()
            .map(PullRequestReviewDto::from)
            .collect(),
        statuses: statuses
            .statuses
            .into_iter()
            .map(PullRequestStatusDto::from)
            .collect(),
        timeline: timeline
            .into_iter()
            .map(PullRequestTimelineEventDto::from)
            .collect(),
    })
}

async fn fetch_github_review_decision(
    state: &AppState,
    token: &str,
    repository: &TrackedRepository,
    number: i64,
) -> Result<Option<String>, PullRequestDataError> {
    let response = state
        .http_client
        .post(format!(
            "{}/graphql",
            state.config.github_api_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .json(&serde_json::json!({
            "query": "query PullRequestReviewDecision($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewDecision } } }",
            "variables": {
                "owner": repository.owner,
                "name": repository.name,
                "number": number,
            }
        }))
        .send()
        .await?;
    if response.status() == ReqwestStatusCode::FORBIDDEN
        || response.status() == ReqwestStatusCode::NOT_FOUND
    {
        return Err(PullRequestDataError::GitHubAccessDenied);
    }

    let response = response
        .error_for_status()?
        .json::<GitHubReviewDecisionResponse>()
        .await?;
    if !response.errors.is_empty() {
        return Err(PullRequestDataError::GitHubGraphQl(
            response
                .errors
                .into_iter()
                .map(|error| error.message)
                .collect::<Vec<_>>()
                .join("; "),
        ));
    }

    response
        .data
        .and_then(|data| data.repository)
        .and_then(|repository| repository.pull_request)
        .map(|pull_request| pull_request.review_decision)
        .ok_or_else(|| {
            PullRequestDataError::GitHubGraphQl(
                "GitHub GraphQL response did not include the pull request".to_string(),
            )
        })
}

async fn fetch_github_json<T: DeserializeOwned>(
    state: &AppState,
    token: &str,
    url: &str,
) -> Result<T, PullRequestDataError> {
    let response = state
        .http_client
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .send()
        .await?;
    if response.status() == ReqwestStatusCode::FORBIDDEN
        || response.status() == ReqwestStatusCode::NOT_FOUND
    {
        return Err(PullRequestDataError::GitHubAccessDenied);
    }

    Ok(response.error_for_status()?.json::<T>().await?)
}

async fn fetch_github_text(
    state: &AppState,
    token: &str,
    url: &str,
    accept: &str,
) -> Result<String, PullRequestDataError> {
    let response = state
        .http_client
        .get(url)
        .bearer_auth(token)
        .header("Accept", accept)
        .header("User-Agent", USER_AGENT)
        .send()
        .await?;
    if response.status() == ReqwestStatusCode::FORBIDDEN
        || response.status() == ReqwestStatusCode::NOT_FOUND
    {
        return Err(PullRequestDataError::GitHubAccessDenied);
    }

    Ok(response.error_for_status()?.text().await?)
}

async fn upsert_pull_requests(
    db: &SqlitePool,
    repository: &TrackedRepository,
    pull_requests: &[GitHubPullRequest],
    synced_at: &str,
) -> Result<Vec<PullRequestDto>, PullRequestDataError> {
    let mut saved = Vec::with_capacity(pull_requests.len());
    for pull_request in pull_requests {
        sqlx::query(
            "INSERT INTO tracked_repository_pull_requests (user_id, provider, owner, name, number, github_id, title, state, draft, author_login, html_url, created_at, updated_at, closed_at, merged_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, provider, owner, name, number) DO UPDATE SET github_id = excluded.github_id, title = excluded.title, state = excluded.state, draft = excluded.draft, author_login = excluded.author_login, html_url = excluded.html_url, created_at = excluded.created_at, updated_at = excluded.updated_at, closed_at = excluded.closed_at, merged_at = excluded.merged_at, synced_at = excluded.synced_at",
        )
        .bind(&repository.user_id)
        .bind(GITHUB_PROVIDER)
        .bind(&repository.owner)
        .bind(&repository.name)
        .bind(pull_request.number)
        .bind(pull_request.id)
        .bind(&pull_request.title)
        .bind(&pull_request.state)
        .bind(pull_request.draft)
        .bind(pull_request.user.as_ref().map(|user| user.login.as_str()))
        .bind(&pull_request.html_url)
        .bind(&pull_request.created_at)
        .bind(&pull_request.updated_at)
        .bind(&pull_request.closed_at)
        .bind(&pull_request.merged_at)
        .bind(synced_at)
        .execute(db)
        .await?;

        saved.push(PullRequestDto {
            author_login: pull_request.user.as_ref().map(|user| user.login.clone()),
            closed_at: pull_request.closed_at.clone(),
            created_at: pull_request.created_at.clone(),
            draft: pull_request.draft,
            github_id: pull_request.id,
            html_url: pull_request.html_url.clone(),
            merged_at: pull_request.merged_at.clone(),
            number: pull_request.number,
            state: pull_request.state.clone(),
            synced_at: synced_at.to_string(),
            title: pull_request.title.clone(),
            updated_at: pull_request.updated_at.clone(),
        });
    }

    Ok(saved)
}

async fn upsert_pull_request_detail(
    db: &SqlitePool,
    repository: &TrackedRepository,
    number: i64,
    detail: &PullRequestDetailSnapshot,
    synced_at: &str,
) -> Result<PullRequestDetailDto, PullRequestDataError> {
    let files_json = serde_json::to_string(&detail.files)?;
    let commits_json = serde_json::to_string(&detail.commits)?;
    let reviews_json = serde_json::to_string(&detail.reviews)?;
    let review_comments_json = serde_json::to_string(&detail.review_comments)?;
    let issue_comments_json = serde_json::to_string(&detail.issue_comments)?;
    let timeline_json = serde_json::to_string(&detail.timeline)?;
    let check_runs_json = serde_json::to_string(&detail.check_runs)?;
    let statuses_json = serde_json::to_string(&detail.statuses)?;

    sqlx::query(
        "INSERT INTO tracked_repository_pull_request_details (user_id, provider, owner, name, number, files_json, commits_json, reviews_json, review_comments_json, review_decision, issue_comments_json, timeline_json, check_runs_json, statuses_json, diff, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, provider, owner, name, number) DO UPDATE SET files_json = excluded.files_json, commits_json = excluded.commits_json, reviews_json = excluded.reviews_json, review_comments_json = excluded.review_comments_json, review_decision = excluded.review_decision, issue_comments_json = excluded.issue_comments_json, timeline_json = excluded.timeline_json, check_runs_json = excluded.check_runs_json, statuses_json = excluded.statuses_json, diff = excluded.diff, synced_at = excluded.synced_at",
    )
    .bind(&repository.user_id)
    .bind(GITHUB_PROVIDER)
    .bind(&repository.owner)
    .bind(&repository.name)
    .bind(number)
    .bind(&files_json)
    .bind(&commits_json)
    .bind(&reviews_json)
    .bind(&review_comments_json)
    .bind(&detail.review_decision)
    .bind(&issue_comments_json)
    .bind(&timeline_json)
    .bind(&check_runs_json)
    .bind(&statuses_json)
    .bind(&detail.diff)
    .bind(synced_at)
    .execute(db)
    .await?;

    Ok(PullRequestDetailDto {
        check_runs: detail.check_runs.clone(),
        commits: detail.commits.clone(),
        diff: detail.diff.clone(),
        files: detail.files.clone(),
        issue_comments: detail.issue_comments.clone(),
        review_comments: detail.review_comments.clone(),
        review_decision: detail.review_decision.clone(),
        reviews: detail.reviews.clone(),
        statuses: detail.statuses.clone(),
        synced_at: synced_at.to_string(),
        timeline: detail.timeline.clone(),
    })
}

async fn update_sync_state(
    db: &SqlitePool,
    repository: &TrackedRepository,
    next_page: Option<i64>,
    synced_at: &str,
) -> Result<(), PullRequestDataError> {
    sqlx::query(
        "UPDATE tracked_repositories SET pull_requests_sync_page = ?, pull_requests_synced_at = ?, pull_requests_sync_error = NULL WHERE user_id = ? AND provider = ? AND owner = ? AND name = ?",
    )
    .bind(next_page.unwrap_or(1))
    .bind(synced_at)
    .bind(&repository.user_id)
    .bind(GITHUB_PROVIDER)
    .bind(&repository.owner)
    .bind(&repository.name)
    .execute(db)
    .await?;

    Ok(())
}

async fn update_sync_error(
    db: &SqlitePool,
    repository: &TrackedRepository,
    sync_error: &str,
) -> Result<(), PullRequestDataError> {
    sqlx::query(
        "UPDATE tracked_repositories SET pull_requests_sync_error = ? WHERE user_id = ? AND provider = ? AND owner = ? AND name = ?",
    )
    .bind(sync_error)
    .bind(&repository.user_id)
    .bind(GITHUB_PROVIDER)
    .bind(&repository.owner)
    .bind(&repository.name)
    .execute(db)
    .await?;

    Ok(())
}

fn api_error(
    status: StatusCode,
    error: PullRequestErrorCode,
) -> (StatusCode, Json<PullRequestErrorResponse>) {
    (status, Json(PullRequestErrorResponse { error }))
}

fn format_timestamp(timestamp: OffsetDateTime) -> Result<String, PullRequestDataError> {
    Ok(timestamp.format(&Rfc3339)?)
}

#[derive(Debug)]
enum PullRequestSyncError {
    AuthorizationRequired,
    Other(PullRequestDataError),
}

#[derive(Debug)]
enum PullRequestDataError {
    GitHubAccessDenied,
    GitHubApp(github_app::GitHubAppError),
    GitHubGraphQl(String),
    Reqwest(reqwest::Error),
    Serde(serde_json::Error),
    Sql(sqlx::Error),
    TimeFormat(time::error::Format),
}

impl From<github_app::GitHubAppError> for PullRequestDataError {
    fn from(error: github_app::GitHubAppError) -> Self {
        Self::GitHubApp(error)
    }
}

impl From<reqwest::Error> for PullRequestDataError {
    fn from(error: reqwest::Error) -> Self {
        Self::Reqwest(error)
    }
}

impl From<serde_json::Error> for PullRequestDataError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serde(error)
    }
}

impl From<sqlx::Error> for PullRequestDataError {
    fn from(error: sqlx::Error) -> Self {
        Self::Sql(error)
    }
}

impl From<time::error::Format> for PullRequestDataError {
    fn from(error: time::error::Format) -> Self {
        Self::TimeFormat(error)
    }
}

impl std::fmt::Display for PullRequestDataError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GitHubAccessDenied => write!(f, "GitHub App cannot access repository"),
            Self::GitHubApp(error) => write!(f, "GitHub App operation failed: {error}"),
            Self::GitHubGraphQl(error) => write!(f, "GitHub GraphQL operation failed: {error}"),
            Self::Reqwest(error) => write!(f, "GitHub pull request HTTP request failed: {error}"),
            Self::Serde(error) => write!(f, "pull request JSON operation failed: {error}"),
            Self::Sql(error) => write!(f, "pull request database operation failed: {error}"),
            Self::TimeFormat(error) => write!(f, "pull request time format failed: {error}"),
        }
    }
}

impl std::error::Error for PullRequestDataError {}

#[derive(Clone)]
struct TrackedRepository {
    name: String,
    owner: String,
    sync_page: i64,
    user_id: String,
}

#[derive(sqlx::FromRow)]
struct PullRequestRow {
    author_login: Option<String>,
    closed_at: Option<String>,
    created_at: String,
    draft: bool,
    github_id: i64,
    html_url: String,
    merged_at: Option<String>,
    number: i64,
    state: String,
    synced_at: String,
    title: String,
    updated_at: String,
}

struct PullRequestDetailSnapshot {
    check_runs: Vec<PullRequestCheckRunDto>,
    commits: Vec<PullRequestCommitDto>,
    diff: Option<String>,
    files: Vec<PullRequestFileDto>,
    issue_comments: Vec<PullRequestCommentDto>,
    review_comments: Vec<PullRequestCommentDto>,
    review_decision: Option<String>,
    reviews: Vec<PullRequestReviewDto>,
    statuses: Vec<PullRequestStatusDto>,
    timeline: Vec<PullRequestTimelineEventDto>,
}

#[derive(sqlx::FromRow)]
struct PullRequestDetailRow {
    check_runs_json: String,
    commits_json: String,
    diff: Option<String>,
    files_json: String,
    issue_comments_json: String,
    review_comments_json: String,
    review_decision: Option<String>,
    reviews_json: String,
    statuses_json: String,
    synced_at: String,
    timeline_json: String,
}

impl PullRequestDetailRow {
    fn into_dto(self) -> Result<PullRequestDetailDto, PullRequestDataError> {
        Ok(PullRequestDetailDto {
            check_runs: serde_json::from_str(&self.check_runs_json)?,
            commits: serde_json::from_str(&self.commits_json)?,
            diff: self.diff,
            files: serde_json::from_str(&self.files_json)?,
            issue_comments: serde_json::from_str(&self.issue_comments_json)?,
            review_comments: serde_json::from_str(&self.review_comments_json)?,
            review_decision: self.review_decision,
            reviews: serde_json::from_str(&self.reviews_json)?,
            statuses: serde_json::from_str(&self.statuses_json)?,
            synced_at: self.synced_at,
            timeline: serde_json::from_str(&self.timeline_json)?,
        })
    }
}

impl PullRequestRow {
    fn into_dto(self) -> PullRequestDto {
        PullRequestDto {
            author_login: self.author_login,
            closed_at: self.closed_at,
            created_at: self.created_at,
            draft: self.draft,
            github_id: self.github_id,
            html_url: self.html_url,
            merged_at: self.merged_at,
            number: self.number,
            state: self.state,
            synced_at: self.synced_at,
            title: self.title,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Deserialize)]
struct GitHubReviewDecisionResponse {
    data: Option<GitHubReviewDecisionData>,
    #[serde(default)]
    errors: Vec<GitHubGraphQlError>,
}

#[derive(Deserialize)]
struct GitHubReviewDecisionData {
    repository: Option<GitHubReviewDecisionRepository>,
}

#[derive(Deserialize)]
struct GitHubReviewDecisionRepository {
    #[serde(rename = "pullRequest")]
    pull_request: Option<GitHubReviewDecisionPullRequest>,
}

#[derive(Deserialize)]
struct GitHubReviewDecisionPullRequest {
    #[serde(rename = "reviewDecision")]
    review_decision: Option<String>,
}

#[derive(Deserialize)]
struct GitHubGraphQlError {
    message: String,
}

#[derive(Deserialize)]
struct GitHubPullRequest {
    closed_at: Option<String>,
    created_at: String,
    draft: bool,
    html_url: String,
    id: i64,
    merged_at: Option<String>,
    number: i64,
    state: String,
    title: String,
    updated_at: String,
    user: Option<GitHubUser>,
}

#[derive(Deserialize)]
struct GitHubUser {
    login: String,
}

#[derive(Deserialize)]
struct GitHubPullRequestDetail {
    head: GitHubPullRequestHead,
}

#[derive(Deserialize)]
struct GitHubPullRequestHead {
    sha: String,
}

#[derive(Deserialize)]
struct GitHubPullRequestFile {
    filename: String,
    status: String,
}

impl From<GitHubPullRequestFile> for PullRequestFileDto {
    fn from(file: GitHubPullRequestFile) -> Self {
        Self {
            filename: file.filename,
            status: file.status,
        }
    }
}

#[derive(Deserialize)]
struct GitHubPullRequestCommit {
    commit: GitHubPullRequestCommitData,
    sha: String,
}

#[derive(Deserialize)]
struct GitHubPullRequestCommitData {
    message: String,
}

impl From<GitHubPullRequestCommit> for PullRequestCommitDto {
    fn from(commit: GitHubPullRequestCommit) -> Self {
        Self {
            message: commit.commit.message,
            sha: commit.sha,
        }
    }
}

#[derive(Deserialize)]
struct GitHubPullRequestReview {
    state: String,
    user: Option<GitHubUser>,
}

impl From<GitHubPullRequestReview> for PullRequestReviewDto {
    fn from(review: GitHubPullRequestReview) -> Self {
        Self {
            author_login: review.user.map(|user| user.login),
            state: review.state,
        }
    }
}

#[derive(Deserialize)]
struct GitHubPullRequestComment {
    body: Option<String>,
    user: Option<GitHubUser>,
}

impl From<GitHubPullRequestComment> for PullRequestCommentDto {
    fn from(comment: GitHubPullRequestComment) -> Self {
        Self {
            author_login: comment.user.map(|user| user.login),
            body: comment.body,
        }
    }
}

#[derive(Deserialize)]
struct GitHubPullRequestTimelineEvent {
    actor: Option<GitHubUser>,
    event: String,
}

impl From<GitHubPullRequestTimelineEvent> for PullRequestTimelineEventDto {
    fn from(event: GitHubPullRequestTimelineEvent) -> Self {
        Self {
            actor_login: event.actor.map(|actor| actor.login),
            event: event.event,
        }
    }
}

#[derive(Deserialize)]
struct GitHubCheckRuns {
    check_runs: Vec<GitHubCheckRun>,
}

#[derive(Deserialize)]
struct GitHubCheckRun {
    conclusion: Option<String>,
    details_url: Option<String>,
    html_url: Option<String>,
    name: String,
    output: Option<GitHubCheckRunOutput>,
    status: String,
}

#[derive(Deserialize)]
struct GitHubCheckRunOutput {
    summary: Option<String>,
    title: Option<String>,
}

impl From<GitHubCheckRun> for PullRequestCheckRunDto {
    fn from(check_run: GitHubCheckRun) -> Self {
        let (title, summary) = check_run
            .output
            .map(|output| (output.title, output.summary))
            .unwrap_or_default();

        Self {
            name: check_run.name,
            state: check_run.conclusion.unwrap_or(check_run.status),
            summary,
            title,
            url: check_run.details_url.or(check_run.html_url),
        }
    }
}

#[derive(Deserialize)]
struct GitHubStatuses {
    statuses: Vec<GitHubStatus>,
}

#[derive(Deserialize)]
struct GitHubStatus {
    context: String,
    description: Option<String>,
    state: String,
    target_url: Option<String>,
}

impl From<GitHubStatus> for PullRequestStatusDto {
    fn from(status: GitHubStatus) -> Self {
        Self {
            context: status.context,
            description: status.description,
            state: status.state,
            url: status.target_url,
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{to_bytes, Body},
        extract::Query,
        http::{header, HeaderMap, Request, StatusCode},
        response::IntoResponse,
        routing::{get, post},
        Json, Router,
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::Value;
    use sqlx::SqlitePool;
    use std::collections::HashMap;
    use tokio::net::TcpListener;
    use tower::ServiceExt;

    use super::{
        fetch_github_pull_request_detail, fetch_github_pull_requests, load_pull_request_detail,
        load_pull_requests, load_tracked_repository, update_sync_error, update_sync_state,
        upsert_pull_request_detail, upsert_pull_requests, GitHubPullRequest, GitHubUser,
        PullRequestCheckRunDto, PullRequestCommentDto, PullRequestCommitDto,
        PullRequestDetailSnapshot, PullRequestFileDto, PullRequestReviewDto, PullRequestStatusDto,
        PullRequestTimelineEventDto, TrackedRepository,
    };
    use crate::{
        config::{Config, Environment, SessionConfig, TokenEncryptionKey},
        db,
        http::{app, AppState},
        repositories, session,
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
            token_encryption_key: TokenEncryptionKey::from_base64(&STANDARD.encode([10_u8; 32]))
                .expect("test key should parse"),
        }
    }

    async fn mock_github_api() -> (String, tokio::task::JoinHandle<()>) {
        async fn pulls(Query(query): Query<HashMap<String, String>>) -> Json<Value> {
            assert_eq!(query.get("state"), Some(&"all".to_string()));
            assert_eq!(query.get("sort"), Some(&"created".to_string()));
            assert_eq!(query.get("direction"), Some(&"desc".to_string()));
            assert_eq!(query.get("per_page"), Some(&"100".to_string()));
            assert_eq!(query.get("page"), Some(&"1".to_string()));

            Json(serde_json::json!([{
                "closed_at": null,
                "created_at": "2026-01-01T00:00:00Z",
                "draft": false,
                "html_url": "https://github.com/kestrel/app/pull/42",
                "id": 1001,
                "merged_at": null,
                "number": 42,
                "state": "open",
                "title": "Add syncing",
                "updated_at": "2026-01-02T00:00:00Z",
                "user": { "login": "octocat" }
            }]))
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock GitHub listener should bind");
        let address = listener
            .local_addr()
            .expect("mock GitHub address should load");
        let app = Router::new().route("/repos/kestrel/app/pulls", get(pulls));
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("mock GitHub server should run");
        });

        (format!("http://{address}"), handle)
    }

    async fn mock_github_detail_api() -> (String, tokio::task::JoinHandle<()>) {
        async fn graphql(Json(body): Json<Value>) -> Json<Value> {
            assert!(body["query"]
                .as_str()
                .is_some_and(|query| query.contains("reviewDecision")));
            assert_eq!(body["variables"]["owner"], "kestrel");
            assert_eq!(body["variables"]["name"], "app");
            assert_eq!(body["variables"]["number"], 42);

            Json(serde_json::json!({
                "data": {
                    "repository": {
                        "pullRequest": { "reviewDecision": "APPROVED" }
                    }
                }
            }))
        }

        async fn pull(headers: HeaderMap) -> axum::response::Response {
            if headers
                .get(header::ACCEPT)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.contains("application/vnd.github.v3.diff"))
            {
                return "diff --git a/app.rs b/app.rs".into_response();
            }

            Json(serde_json::json!({
                "head": { "sha": "head-sha" },
                "html_url": "https://github.com/kestrel/app/pull/42",
                "number": 42,
                "title": "Add syncing"
            }))
            .into_response()
        }

        async fn files() -> Json<Value> {
            Json(serde_json::json!([{ "filename": "app.rs", "status": "modified" }]))
        }

        async fn commits() -> Json<Value> {
            Json(serde_json::json!([{
                "commit": { "message": "Add syncing" },
                "sha": "head-sha"
            }]))
        }

        async fn reviews() -> Json<Value> {
            Json(serde_json::json!([{ "state": "APPROVED", "user": { "login": "reviewer" } }]))
        }

        async fn review_comments() -> Json<Value> {
            Json(serde_json::json!([{
                "body": "nit",
                "path": "app.rs",
                "user": { "login": "reviewer" }
            }]))
        }

        async fn issue_comments() -> Json<Value> {
            Json(serde_json::json!([{
                "body": "looks good",
                "user": { "login": "octocat" }
            }]))
        }

        async fn timeline() -> Json<Value> {
            Json(serde_json::json!([{
                "actor": { "login": "octocat" },
                "event": "committed"
            }]))
        }

        async fn check_runs() -> Json<Value> {
            Json(serde_json::json!({
                "total_count": 2,
                "check_runs": [
                    {
                        "name": "test",
                        "conclusion": "success",
                        "status": "completed",
                        "details_url": "https://ci.example.test/runs/42",
                        "html_url": "https://github.com/kestrel/app/runs/42",
                        "output": {
                            "title": "Tests passed",
                            "summary": "All test suites completed successfully."
                        }
                    },
                    {
                        "name": "lint",
                        "conclusion": null,
                        "status": "in_progress",
                        "details_url": null,
                        "html_url": "https://github.com/kestrel/app/runs/43",
                        "output": {
                            "title": null,
                            "summary": "Lint is still running."
                        }
                    }
                ]
            }))
        }

        async fn statuses() -> Json<Value> {
            Json(serde_json::json!({
                "state": "success",
                "statuses": [
                    {
                        "context": "ci",
                        "description": "Build passed",
                        "state": "success",
                        "target_url": "https://ci.example.test/builds/42"
                    },
                    {
                        "context": "deploy",
                        "description": null,
                        "state": "pending",
                        "target_url": null
                    }
                ]
            }))
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock GitHub listener should bind");
        let address = listener
            .local_addr()
            .expect("mock GitHub address should load");
        let app = Router::new()
            .route("/graphql", post(graphql))
            .route("/repos/kestrel/app/pulls/42", get(pull))
            .route("/repos/kestrel/app/pulls/42/files", get(files))
            .route("/repos/kestrel/app/pulls/42/commits", get(commits))
            .route("/repos/kestrel/app/pulls/42/reviews", get(reviews))
            .route("/repos/kestrel/app/pulls/42/comments", get(review_comments))
            .route("/repos/kestrel/app/issues/42/comments", get(issue_comments))
            .route("/repos/kestrel/app/issues/42/timeline", get(timeline))
            .route(
                "/repos/kestrel/app/commits/head-sha/check-runs",
                get(check_runs),
            )
            .route("/repos/kestrel/app/commits/head-sha/status", get(statuses));
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("mock GitHub server should run");
        });

        (format!("http://{address}"), handle)
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

    async fn response_json(response: axum::response::Response) -> Value {
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should collect");
        serde_json::from_slice(&body).expect("body should be json")
    }

    async fn insert_tracked_repository(db: &SqlitePool) {
        sqlx::query(
            "INSERT INTO tracked_repositories (user_id, provider, owner, name, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("user_1")
        .bind("github")
        .bind("kestrel")
        .bind("app")
        .bind("2026-01-01T00:00:00Z")
        .execute(db)
        .await
        .expect("tracked repository should insert");
    }

    #[tokio::test]
    async fn list_pull_requests_requires_authentication() {
        let config = test_config();
        let db = test_db().await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/repositories/kestrel/app/pull-requests")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn sync_pull_requests_requires_authentication() {
        let config = test_config();
        let db = test_db().await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repositories/kestrel/app/pull-requests/sync")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn list_pull_requests_rejects_invalid_repository() {
        let config = test_config();
        let db = test_db().await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/repositories/bad!/app/pull-requests")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(response).await,
            serde_json::json!({ "error": "invalid_repository" }),
        );
    }

    #[tokio::test]
    async fn sync_pull_requests_rejects_invalid_repository() {
        let config = test_config();
        let db = test_db().await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repositories/bad!/app/pull-requests/sync")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(response).await,
            serde_json::json!({ "error": "invalid_repository" }),
        );
    }

    #[tokio::test]
    async fn list_pull_requests_returns_stored_pull_requests() {
        let config = test_config();
        let db = test_db().await;
        insert_tracked_repository(&db).await;
        sqlx::query(
            "INSERT INTO tracked_repository_pull_requests (user_id, provider, owner, name, number, github_id, title, state, draft, author_login, html_url, created_at, updated_at, closed_at, merged_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("user_1")
        .bind("github")
        .bind("kestrel")
        .bind("app")
        .bind(42_i64)
        .bind(1001_i64)
        .bind("Add syncing")
        .bind("open")
        .bind(false)
        .bind("octocat")
        .bind("https://github.com/kestrel/app/pull/42")
        .bind("2026-01-01T00:00:00Z")
        .bind("2026-01-02T00:00:00Z")
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .bind("2026-01-03T00:00:00Z")
        .execute(&db)
        .await
        .expect("pull request should insert");
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/repositories/kestrel/app/pull-requests")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response_json(response).await,
            serde_json::json!({
                "pullRequests": [{
                    "authorLogin": "octocat",
                    "closedAt": null,
                    "createdAt": "2026-01-01T00:00:00Z",
                    "draft": false,
                    "githubId": 1001,
                    "htmlUrl": "https://github.com/kestrel/app/pull/42",
                    "mergedAt": null,
                    "number": 42,
                    "state": "open",
                    "syncedAt": "2026-01-03T00:00:00Z",
                    "title": "Add syncing",
                    "updatedAt": "2026-01-02T00:00:00Z"
                }]
            }),
        );
    }

    #[tokio::test]
    async fn sync_pull_requests_requires_tracked_repository() {
        let config = test_config();
        let db = test_db().await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repositories/kestrel/app/pull-requests/sync")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response_json(response).await,
            serde_json::json!({ "error": "repository_not_tracked" }),
        );
    }

    #[tokio::test]
    async fn sync_pull_requests_requires_github_app_authorization() {
        let config = test_config();
        let db = test_db().await;
        insert_tracked_repository(&db).await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db.clone(), config.clone()))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repositories/kestrel/app/pull-requests/sync")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            response_json(response).await,
            serde_json::json!({ "error": "authorization_required" }),
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT pull_requests_sync_error FROM tracked_repositories WHERE user_id = ? AND provider = ? AND owner = ? AND name = ?",
            )
            .bind("user_1")
            .bind("github")
            .bind("kestrel")
            .bind("app")
            .fetch_one(&db)
            .await
            .expect("sync error should load"),
            "authorization_required",
        );
    }

    #[tokio::test]
    async fn fetch_pull_requests_uses_configured_github_api_url() {
        let (github_api_url, server) = mock_github_api().await;
        let mut config = test_config();
        config.github_api_url = github_api_url;
        let db = test_db().await;
        let state = AppState::new(db, config);
        let repository = TrackedRepository {
            name: "app".to_string(),
            owner: "kestrel".to_string(),
            sync_page: 1,
            user_id: "user_1".to_string(),
        };

        let pull_requests = fetch_github_pull_requests(&state, "installation_token", &repository)
            .await
            .expect("pull requests should fetch from mock GitHub API");

        server.abort();
        assert_eq!(pull_requests.len(), 1);
        assert_eq!(pull_requests[0].number, 42);
        assert_eq!(pull_requests[0].title, "Add syncing");
        assert_eq!(
            pull_requests[0]
                .user
                .as_ref()
                .map(|user| user.login.as_str()),
            Some("octocat"),
        );
    }

    #[tokio::test]
    async fn fetch_pull_request_detail_uses_configured_github_api_url() {
        let (github_api_url, server) = mock_github_detail_api().await;
        let mut config = test_config();
        config.github_api_url = github_api_url;
        let db = test_db().await;
        let state = AppState::new(db, config);
        let repository = TrackedRepository {
            name: "app".to_string(),
            owner: "kestrel".to_string(),
            sync_page: 1,
            user_id: "user_1".to_string(),
        };

        let detail =
            fetch_github_pull_request_detail(&state, "installation_token", &repository, 42)
                .await
                .expect("pull request detail should fetch from mock GitHub API");

        server.abort();
        assert_eq!(detail.files[0].filename, "app.rs");
        assert_eq!(detail.commits[0].sha, "head-sha");
        assert_eq!(detail.commits[0].message, "Add syncing");
        assert_eq!(detail.reviews[0].state, "APPROVED");
        assert_eq!(detail.review_decision.as_deref(), Some("APPROVED"));
        assert_eq!(detail.review_comments[0].body.as_deref(), Some("nit"));
        assert_eq!(detail.issue_comments[0].body.as_deref(), Some("looks good"));
        assert_eq!(detail.timeline[0].event, "committed");
        assert_eq!(detail.check_runs[0].state, "success");
        assert_eq!(
            detail.check_runs[0].url.as_deref(),
            Some("https://ci.example.test/runs/42")
        );
        assert_eq!(detail.check_runs[0].title.as_deref(), Some("Tests passed"));
        assert_eq!(
            detail.check_runs[0].summary.as_deref(),
            Some("All test suites completed successfully.")
        );
        assert_eq!(detail.check_runs[1].state, "in_progress");
        assert_eq!(
            detail.check_runs[1].url.as_deref(),
            Some("https://github.com/kestrel/app/runs/43")
        );
        assert_eq!(detail.check_runs[1].title, None);
        assert_eq!(detail.statuses[0].state, "success");
        assert_eq!(
            detail.statuses[0].description.as_deref(),
            Some("Build passed")
        );
        assert_eq!(
            detail.statuses[0].url.as_deref(),
            Some("https://ci.example.test/builds/42")
        );
        assert_eq!(detail.statuses[1].description, None);
        assert_eq!(detail.statuses[1].url, None);
        assert_eq!(detail.diff.as_deref(), Some("diff --git a/app.rs b/app.rs"));
    }

    #[tokio::test]
    async fn one_page_sync_storage_upserts_pull_requests_and_advances_cursor() {
        let db = test_db().await;
        insert_tracked_repository(&db).await;
        let repository = load_tracked_repository(
            &db,
            "user_1",
            &repositories::ParsedRepository {
                owner: "kestrel".to_string(),
                name: "app".to_string(),
            },
        )
        .await
        .expect("tracked repository should load")
        .expect("tracked repository should exist");
        let pull_requests = vec![GitHubPullRequest {
            closed_at: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            draft: false,
            html_url: "https://github.com/kestrel/app/pull/42".to_string(),
            id: 1001,
            merged_at: None,
            number: 42,
            state: "open".to_string(),
            title: "Add syncing".to_string(),
            updated_at: "2026-01-02T00:00:00Z".to_string(),
            user: Some(GitHubUser {
                login: "octocat".to_string(),
            }),
        }];

        let saved = upsert_pull_requests(&db, &repository, &pull_requests, "2026-01-03T00:00:00Z")
            .await
            .expect("pull requests should upsert");
        update_sync_error(&db, &repository, "sync_failed")
            .await
            .expect("sync error should update");
        update_sync_state(&db, &repository, Some(2), "2026-01-03T00:00:00Z")
            .await
            .expect("sync state should update");

        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].number, 42);
        let stored = load_pull_requests(&db, &repository)
            .await
            .expect("stored pull requests should load");
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].title, "Add syncing");
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT pull_requests_sync_page FROM tracked_repositories WHERE user_id = ? AND provider = ? AND owner = ? AND name = ?",
            )
            .bind("user_1")
            .bind("github")
            .bind("kestrel")
            .bind("app")
            .fetch_one(&db)
            .await
            .expect("sync page should load"),
            2,
        );
        assert_eq!(
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT pull_requests_sync_error FROM tracked_repositories WHERE user_id = ? AND provider = ? AND owner = ? AND name = ?",
            )
            .bind("user_1")
            .bind("github")
            .bind("kestrel")
            .bind("app")
            .fetch_one(&db)
            .await
            .expect("sync error should load"),
            None,
        );
    }

    #[tokio::test]
    async fn pull_request_detail_storage_upserts_snapshot() {
        let db = test_db().await;
        insert_tracked_repository(&db).await;
        let repository = load_tracked_repository(
            &db,
            "user_1",
            &repositories::ParsedRepository {
                owner: "kestrel".to_string(),
                name: "app".to_string(),
            },
        )
        .await
        .expect("tracked repository should load")
        .expect("tracked repository should exist");
        let detail = PullRequestDetailSnapshot {
            check_runs: vec![PullRequestCheckRunDto {
                name: "test".to_string(),
                state: "success".to_string(),
                summary: Some("All test suites completed successfully.".to_string()),
                title: Some("Tests passed".to_string()),
                url: Some("https://ci.example.test/runs/42".to_string()),
            }],
            commits: vec![PullRequestCommitDto {
                message: "Add syncing".to_string(),
                sha: "head-sha".to_string(),
            }],
            diff: Some("diff --git a/app.rs b/app.rs".to_string()),
            files: vec![PullRequestFileDto {
                filename: "app.rs".to_string(),
                status: "modified".to_string(),
            }],
            issue_comments: vec![PullRequestCommentDto {
                author_login: Some("octocat".to_string()),
                body: Some("ship it".to_string()),
            }],
            review_comments: vec![PullRequestCommentDto {
                author_login: Some("reviewer".to_string()),
                body: Some("nit".to_string()),
            }],
            reviews: vec![PullRequestReviewDto {
                author_login: Some("reviewer".to_string()),
                state: "APPROVED".to_string(),
            }],
            review_decision: Some("CHANGES_REQUESTED".to_string()),
            statuses: vec![PullRequestStatusDto {
                context: "ci".to_string(),
                description: Some("Build passed".to_string()),
                state: "success".to_string(),
                url: Some("https://ci.example.test/builds/42".to_string()),
            }],
            timeline: vec![PullRequestTimelineEventDto {
                actor_login: Some("octocat".to_string()),
                event: "committed".to_string(),
            }],
        };

        let saved =
            upsert_pull_request_detail(&db, &repository, 42, &detail, "2026-01-03T00:00:00Z")
                .await
                .expect("pull request detail should upsert");
        let loaded = load_pull_request_detail(&db, &repository, 42)
            .await
            .expect("pull request detail should load")
            .expect("pull request detail should exist");

        assert_eq!(saved.commits[0].message, "Add syncing");
        assert_eq!(loaded.files[0].filename, "app.rs");
        assert_eq!(loaded.issue_comments[0].body.as_deref(), Some("ship it"));
        assert_eq!(saved.review_decision.as_deref(), Some("CHANGES_REQUESTED"));
        assert_eq!(loaded.review_decision.as_deref(), Some("CHANGES_REQUESTED"));
        assert_eq!(
            loaded.check_runs[0].summary.as_deref(),
            Some("All test suites completed successfully.")
        );
        assert_eq!(
            loaded.check_runs[0].url.as_deref(),
            Some("https://ci.example.test/runs/42")
        );
        assert_eq!(
            loaded.statuses[0].description.as_deref(),
            Some("Build passed")
        );
        assert_eq!(
            loaded.statuses[0].url.as_deref(),
            Some("https://ci.example.test/builds/42")
        );
        assert_eq!(loaded.diff.as_deref(), Some("diff --git a/app.rs b/app.rs"));
        assert_eq!(loaded.synced_at, "2026-01-03T00:00:00Z");
    }

    #[test]
    fn check_and_status_dtos_deserialize_legacy_json_without_metadata() {
        let check_runs: Vec<PullRequestCheckRunDto> =
            serde_json::from_str(r#"[{"name":"test","state":"success"}]"#)
                .expect("legacy check runs should deserialize");
        let statuses: Vec<PullRequestStatusDto> =
            serde_json::from_str(r#"[{"context":"ci","state":"success"}]"#)
                .expect("legacy statuses should deserialize");

        assert_eq!(check_runs[0].summary, None);
        assert_eq!(check_runs[0].title, None);
        assert_eq!(check_runs[0].url, None);
        assert_eq!(statuses[0].description, None);
        assert_eq!(statuses[0].url, None);
    }
}
