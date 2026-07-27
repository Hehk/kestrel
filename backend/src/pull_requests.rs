use axum::{
    body::Body,
    extract::{rejection::PathRejection, Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
    Json,
};
use reqwest::StatusCode as ReqwestStatusCode;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sqlx::{Executor, Sqlite, SqlitePool};
use std::{collections::HashSet, time::Instant};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use utoipa::{IntoParams, ToSchema};

use crate::{
    auth, github_app,
    http::AppState,
    pull_request_diff::{
        self, DiffParseError, PullRequestDiffContent, PullRequestDiffFile, PullRequestDiffFileMode,
        PullRequestDiffFileOperation, PullRequestDiffHunk, PullRequestDiffLine,
        PullRequestDiffLineKind, MAX_DIFF_BYTES,
    },
    repositories,
};

const GITHUB_PROVIDER: &str = "github";
const PAGE_SIZE: u8 = 100;
const USER_AGENT: &str = "kestrel";
const GITHUB_TIMELINE_QUERY: &str = r#"
query PullRequestTimeline($owner: String!, $name: String!, $number: Int!, $before: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewDecision
      timelineItems(last: 100, before: $before) {
        nodes {
          __typename
          ... on IssueComment {
            id
            author { login }
            body
            createdAt
            url
          }
          ... on PullRequestCommit {
            id
            commit {
              oid
              message
              messageHeadline
              committedDate
              url
              author { user { login } }
            }
          }
          ... on PullRequestReview {
            id
            author { login }
            body
            state
            submittedAt
            url
            comments(first: 100) {
              nodes { id author { login } body createdAt url }
              pageInfo { hasNextPage }
            }
          }
          ... on ClosedEvent { id actor { login } createdAt }
          ... on ReopenedEvent { id actor { login } createdAt }
          ... on MergedEvent { id actor { login } createdAt commit { oid } }
          ... on ReadyForReviewEvent { id actor { login } createdAt }
          ... on ConvertToDraftEvent { id actor { login } createdAt }
          ... on ReviewRequestedEvent {
            id actor { login } createdAt
            requestedReviewer { ... on User { login } ... on Team { name } }
          }
          ... on ReviewRequestRemovedEvent {
            id actor { login } createdAt
            requestedReviewer { ... on User { login } ... on Team { name } }
          }
          ... on ReviewDismissedEvent {
            id actor { login } createdAt previousReviewState
            review { body state url author { login } }
          }
          ... on HeadRefForcePushedEvent {
            id actor { login } createdAt beforeCommit { oid } afterCommit { oid }
          }
          ... on BaseRefForcePushedEvent {
            id actor { login } createdAt beforeCommit { oid } afterCommit { oid }
          }
          ... on HeadRefDeletedEvent { id actor { login } createdAt headRefName }
          ... on HeadRefRestoredEvent { id actor { login } createdAt }
        }
        pageInfo { hasPreviousPage startCursor }
      }
    }
  }
}
"#;

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
pub struct PullRequestTimelineReviewCommentDto {
    #[serde(default)]
    pub actor_login: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub occurred_at: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestTimelineEventDto {
    pub actor_login: Option<String>,
    pub event: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub commit_sha: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub occurred_at: Option<String>,
    #[serde(default)]
    pub review_comments: Vec<PullRequestTimelineReviewCommentDto>,
    #[serde(default)]
    pub review_comments_has_more: bool,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetailDto {
    pub body: Option<String>,
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
    pub timeline_has_older: bool,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetailResponse {
    pub pull_request_detail: PullRequestDetailDto,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullRequestResponse {
    pub pull_request: PullRequestDto,
    pub pull_request_detail: PullRequestDetailDto,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDiffResponse {
    pub files: Vec<PullRequestDiffFileDto>,
    pub synced_at: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDiffFileDto {
    pub additions: u64,
    pub binary: bool,
    pub deletions: u64,
    pub hunks: Vec<PullRequestDiffHunkDto>,
    #[schema(required)]
    pub new_mode: Option<PullRequestDiffFileModeDto>,
    #[schema(required)]
    pub new_path: Option<String>,
    #[schema(required)]
    pub old_mode: Option<PullRequestDiffFileModeDto>,
    #[schema(required)]
    pub old_path: Option<String>,
    pub operation: PullRequestDiffFileOperationDto,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestDiffFileOperationDto {
    Added,
    Deleted,
    Modified,
    Renamed,
    Copied,
}

#[derive(Serialize, ToSchema)]
pub enum PullRequestDiffFileModeDto {
    #[serde(rename = "100644")]
    Regular,
    #[serde(rename = "100755")]
    Executable,
    #[serde(rename = "120000")]
    Symlink,
    #[serde(rename = "160000")]
    Gitlink,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDiffHunkDto {
    #[schema(required)]
    pub context: Option<String>,
    pub lines: Vec<PullRequestDiffLineDto>,
    pub new_count: u64,
    pub new_start: u64,
    pub old_count: u64,
    pub old_start: u64,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDiffLineDto {
    pub content: String,
    pub kind: PullRequestDiffLineKindDto,
    pub missing_newline: bool,
    #[schema(required)]
    pub new_line: Option<u64>,
    #[schema(required)]
    pub old_line: Option<u64>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestDiffLineKindDto {
    Context,
    Addition,
    Deletion,
}

impl From<PullRequestDiffFile> for PullRequestDiffFileDto {
    fn from(file: PullRequestDiffFile) -> Self {
        let (binary, hunks) = match file.content {
            PullRequestDiffContent::Binary => (true, Vec::new()),
            PullRequestDiffContent::Text { hunks } => {
                (false, hunks.into_iter().map(Into::into).collect())
            }
        };

        Self {
            additions: u64::from(file.additions),
            binary,
            deletions: u64::from(file.deletions),
            hunks,
            new_mode: file.new_mode.map(Into::into),
            new_path: file.new_path,
            old_mode: file.old_mode.map(Into::into),
            old_path: file.old_path,
            operation: file.operation.into(),
        }
    }
}

impl From<PullRequestDiffFileOperation> for PullRequestDiffFileOperationDto {
    fn from(operation: PullRequestDiffFileOperation) -> Self {
        match operation {
            PullRequestDiffFileOperation::Added => Self::Added,
            PullRequestDiffFileOperation::Deleted => Self::Deleted,
            PullRequestDiffFileOperation::Modified => Self::Modified,
            PullRequestDiffFileOperation::Renamed => Self::Renamed,
            PullRequestDiffFileOperation::Copied => Self::Copied,
        }
    }
}

impl From<PullRequestDiffFileMode> for PullRequestDiffFileModeDto {
    fn from(mode: PullRequestDiffFileMode) -> Self {
        match mode {
            PullRequestDiffFileMode::Regular => Self::Regular,
            PullRequestDiffFileMode::Executable => Self::Executable,
            PullRequestDiffFileMode::Symlink => Self::Symlink,
            PullRequestDiffFileMode::Gitlink => Self::Gitlink,
        }
    }
}

impl From<PullRequestDiffHunk> for PullRequestDiffHunkDto {
    fn from(hunk: PullRequestDiffHunk) -> Self {
        Self {
            context: hunk.context,
            lines: hunk.lines.into_iter().map(Into::into).collect(),
            new_count: u64::from(hunk.new_count),
            new_start: u64::from(hunk.new_start),
            old_count: u64::from(hunk.old_count),
            old_start: u64::from(hunk.old_start),
        }
    }
}

impl From<PullRequestDiffLine> for PullRequestDiffLineDto {
    fn from(line: PullRequestDiffLine) -> Self {
        Self {
            content: line.content,
            kind: line.kind.into(),
            missing_newline: line.missing_newline,
            new_line: line.new_line.map(u64::from),
            old_line: line.old_line.map(u64::from),
        }
    }
}

impl From<PullRequestDiffLineKind> for PullRequestDiffLineKindDto {
    fn from(kind: PullRequestDiffLineKind) -> Self {
        match kind {
            PullRequestDiffLineKind::Context => Self::Context,
            PullRequestDiffLineKind::Addition => Self::Addition,
            PullRequestDiffLineKind::Deletion => Self::Deletion,
        }
    }
}

struct PullRequestDiffBuild {
    body: Vec<u8>,
    dto_millis: u64,
    files: usize,
    hunks: usize,
    lines: usize,
    parse_millis: u64,
    serialize_millis: u64,
}

enum PullRequestDiffResponseError {
    Parse {
        error: DiffParseError,
        parse_millis: u64,
    },
    Serialize,
}

fn elapsed_millis(started_at: Instant) -> u64 {
    u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestErrorResponse {
    pub error: PullRequestErrorCode,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestErrorCode {
    AuthenticationRequired,
    AuthorizationRequired,
    DiffParseFailed,
    DiffResourceLimitExceeded,
    DiffUnavailable,
    InvalidPullRequest,
    InvalidRepository,
    PullRequestNotFound,
    RepositoryNotTracked,
    SyncFailed,
}

impl PullRequestErrorCode {
    fn as_str(&self) -> &'static str {
        match self {
            Self::AuthenticationRequired => "authentication_required",
            Self::AuthorizationRequired => "authorization_required",
            Self::DiffParseFailed => "diff_parse_failed",
            Self::DiffResourceLimitExceeded => "diff_resource_limit_exceeded",
            Self::DiffUnavailable => "diff_unavailable",
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
    get,
    path = "/api/repositories/{owner}/{name}/pull-requests/{number}/diff",
    params(PullRequestPath),
    responses(
        (status = 200, description = "Parsed pull request diff", body = PullRequestDiffResponse),
        (status = 400, description = "Invalid repository or pull request", body = PullRequestErrorResponse),
        (status = 401, description = "Authentication required", body = PullRequestErrorResponse),
        (status = 404, description = "Repository or pull request detail is not stored", body = PullRequestErrorResponse),
        (status = 409, description = "Stored pull request diff is unavailable", body = PullRequestErrorResponse),
        (status = 422, description = "Stored pull request diff exceeds parser limits", body = PullRequestErrorResponse),
        (status = 500, description = "Stored pull request diff could not be loaded or processed", body = PullRequestErrorResponse)
    )
)]
pub(crate) async fn get_pull_request_diff(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<PullRequestPath>, PathRejection>,
) -> Result<Response, (StatusCode, Json<PullRequestErrorResponse>)> {
    let request_started_at = Instant::now();
    let user_id = require_user_id(&state, &headers).await.map_err(|status| {
        tracing::info!(
            outcome = "authentication_failed",
            status = status.as_u16(),
            total_millis = elapsed_millis(request_started_at),
            "pull request diff request completed"
        );
        let code = if status == StatusCode::UNAUTHORIZED {
            PullRequestErrorCode::AuthenticationRequired
        } else {
            PullRequestErrorCode::SyncFailed
        };
        api_error(status, code)
    })?;
    let Path(path) = path.map_err(|_| {
        tracing::info!(
            outcome = "invalid_path",
            total_millis = elapsed_millis(request_started_at),
            "pull request diff request completed"
        );
        api_error(
            StatusCode::BAD_REQUEST,
            PullRequestErrorCode::InvalidPullRequest,
        )
    })?;
    let (repository, number) = parse_pull_request_path(path).inspect_err(|_| {
        tracing::info!(
            outcome = "invalid_path",
            total_millis = elapsed_millis(request_started_at),
            "pull request diff request completed"
        );
    })?;
    let tracked = load_tracked_repository(&state.db, &user_id, &repository)
        .await
        .map_err(|error| {
            tracing::error!(
                %error,
                outcome = "repository_load_failed",
                total_millis = elapsed_millis(request_started_at),
                "pull request diff request completed"
            );
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                PullRequestErrorCode::SyncFailed,
            )
        })?
        .ok_or_else(|| {
            tracing::info!(
                owner = %repository.owner,
                name = %repository.name,
                number,
                outcome = "repository_not_tracked",
                total_millis = elapsed_millis(request_started_at),
                "pull request diff request completed"
            );
            api_error(
                StatusCode::NOT_FOUND,
                PullRequestErrorCode::RepositoryNotTracked,
            )
        })?;
    let snapshot = load_pull_request_diff(&state.db, &tracked, number)
        .await
        .map_err(|error| {
            tracing::error!(
                %error,
                owner = %tracked.owner,
                name = %tracked.name,
                number,
                outcome = "snapshot_load_failed",
                total_millis = elapsed_millis(request_started_at),
                "pull request diff request completed"
            );
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                PullRequestErrorCode::SyncFailed,
            )
        })?
        .ok_or_else(|| {
            tracing::info!(
                owner = %tracked.owner,
                name = %tracked.name,
                number,
                outcome = "snapshot_not_found",
                total_millis = elapsed_millis(request_started_at),
                "pull request diff request completed"
            );
            api_error(
                StatusCode::NOT_FOUND,
                PullRequestErrorCode::PullRequestNotFound,
            )
        })?;
    if snapshot
        .diff_bytes
        .is_some_and(|bytes| bytes > MAX_DIFF_BYTES as i64)
    {
        tracing::warn!(
            owner = %tracked.owner,
            name = %tracked.name,
            number,
            outcome = "storage_limit",
            raw_bytes = snapshot.diff_bytes.unwrap_or_default(),
            total_millis = elapsed_millis(request_started_at),
            "stored pull request diff exceeded the byte limit"
        );
        return Err(api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            PullRequestErrorCode::DiffResourceLimitExceeded,
        ));
    }
    let raw = snapshot.diff.ok_or_else(|| {
        tracing::info!(
            owner = %tracked.owner,
            name = %tracked.name,
            number,
            outcome = "diff_unavailable",
            total_millis = elapsed_millis(request_started_at),
            "pull request diff request completed"
        );
        api_error(StatusCode::CONFLICT, PullRequestErrorCode::DiffUnavailable)
    })?;
    let raw_bytes = raw.len();
    let blocking_started_at = Instant::now();
    let built = tokio::task::spawn_blocking(move || {
        let parse_started_at = Instant::now();
        let parsed = pull_request_diff::parse_pull_request_diff(&raw);
        let parse_millis = elapsed_millis(parse_started_at);
        drop(raw);
        let parsed = parsed.map_err(|error| PullRequestDiffResponseError::Parse {
            error,
            parse_millis,
        })?;

        let dto_started_at = Instant::now();
        let files: Vec<PullRequestDiffFileDto> = parsed.into_iter().map(Into::into).collect();
        let hunks = files.iter().map(|file| file.hunks.len()).sum();
        let lines = files
            .iter()
            .flat_map(|file| &file.hunks)
            .map(|hunk| hunk.lines.len())
            .sum();
        let file_count = files.len();
        let response = PullRequestDiffResponse {
            files,
            synced_at: snapshot.synced_at,
        };
        let dto_millis = elapsed_millis(dto_started_at);

        let serialize_started_at = Instant::now();
        let body =
            serde_json::to_vec(&response).map_err(|_| PullRequestDiffResponseError::Serialize)?;
        let serialize_millis = elapsed_millis(serialize_started_at);
        Ok(PullRequestDiffBuild {
            body,
            dto_millis,
            files: file_count,
            hunks,
            lines,
            parse_millis,
            serialize_millis,
        })
    })
    .await;

    let build = match built {
        Ok(Ok(response)) => response,
        Ok(Err(PullRequestDiffResponseError::Parse {
            error: DiffParseError::LimitExceeded(limit),
            parse_millis,
        })) => {
            tracing::warn!(
                owner = %tracked.owner,
                name = %tracked.name,
                number,
                ?limit,
                outcome = "parser_limit",
                raw_bytes,
                parse_millis,
                blocking_millis = elapsed_millis(blocking_started_at),
                total_millis = elapsed_millis(request_started_at),
                "stored pull request diff exceeded a parser resource limit"
            );
            return Err(api_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                PullRequestErrorCode::DiffResourceLimitExceeded,
            ));
        }
        Ok(Err(PullRequestDiffResponseError::Parse {
            error: DiffParseError::InvalidDiff(_) | DiffParseError::NumberOutOfRange,
            parse_millis,
        })) => {
            tracing::error!(
                owner = %tracked.owner,
                name = %tracked.name,
                number,
                outcome = "parse_failed",
                raw_bytes,
                parse_millis,
                blocking_millis = elapsed_millis(blocking_started_at),
                total_millis = elapsed_millis(request_started_at),
                "stored pull request diff is malformed"
            );
            return Err(api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                PullRequestErrorCode::DiffParseFailed,
            ));
        }
        Ok(Err(PullRequestDiffResponseError::Serialize)) => {
            tracing::error!(
                owner = %tracked.owner,
                name = %tracked.name,
                number,
                outcome = "serialize_failed",
                raw_bytes,
                blocking_millis = elapsed_millis(blocking_started_at),
                total_millis = elapsed_millis(request_started_at),
                "failed to serialize pull request diff response"
            );
            return Err(api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                PullRequestErrorCode::SyncFailed,
            ));
        }
        Err(error) => {
            tracing::error!(
                owner = %tracked.owner,
                name = %tracked.name,
                number,
                cancelled = error.is_cancelled(),
                panicked = error.is_panic(),
                outcome = "blocking_task_failed",
                raw_bytes,
                blocking_millis = elapsed_millis(blocking_started_at),
                total_millis = elapsed_millis(request_started_at),
                "pull request diff blocking task failed"
            );
            return Err(api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                PullRequestErrorCode::SyncFailed,
            ));
        }
    };

    tracing::info!(
        owner = %tracked.owner,
        name = %tracked.name,
        number,
        outcome = "success",
        raw_bytes,
        response_bytes = build.body.len(),
        files = build.files,
        hunks = build.hunks,
        lines = build.lines,
        parse_millis = build.parse_millis,
        dto_millis = build.dto_millis,
        serialize_millis = build.serialize_millis,
        blocking_millis = elapsed_millis(blocking_started_at),
        total_millis = elapsed_millis(request_started_at),
        "served pull request diff"
    );
    let mut response = Response::new(Body::from(build.body));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/api/repositories/{owner}/{name}/pull-requests/{number}/sync",
    params(PullRequestPath),
    responses(
        (status = 200, description = "Pull request synced", body = SyncPullRequestResponse),
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
) -> Result<Json<SyncPullRequestResponse>, (StatusCode, Json<PullRequestErrorResponse>)> {
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

    let github_snapshot =
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
    let mut transaction = state.db.begin().await.map_err(|error| {
        tracing::error!(%error, "failed to start pull request sync transaction");
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            PullRequestErrorCode::SyncFailed,
        )
    })?;
    let pull_request = upsert_pull_request(
        &mut *transaction,
        &tracked,
        &github_snapshot.pull_request,
        &synced_at,
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "failed to store pull request");
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            PullRequestErrorCode::SyncFailed,
        )
    })?;
    let pull_request_detail = upsert_pull_request_detail(
        &mut *transaction,
        &tracked,
        number,
        &github_snapshot.detail,
        &synced_at,
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "failed to store pull request detail");
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            PullRequestErrorCode::SyncFailed,
        )
    })?;
    transaction.commit().await.map_err(|error| {
        tracing::error!(%error, "failed to commit pull request sync");
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            PullRequestErrorCode::SyncFailed,
        )
    })?;

    Ok(Json(SyncPullRequestResponse {
        pull_request,
        pull_request_detail,
    }))
}

#[utoipa::path(
    post,
    path = "/api/repositories/{owner}/{name}/pull-requests/{number}/timeline/older",
    params(PullRequestPath),
    responses(
        (status = 200, description = "Stored pull request detail with the next older timeline page", body = PullRequestDetailResponse),
        (status = 400, description = "Invalid repository or pull request", body = PullRequestErrorResponse),
        (status = 401, description = "Authentication required"),
        (status = 403, description = "GitHub App authorization required", body = PullRequestErrorResponse),
        (status = 404, description = "Repository or pull request detail is not stored", body = PullRequestErrorResponse),
        (status = 502, description = "GitHub timeline sync failed", body = PullRequestErrorResponse)
    )
)]
pub(crate) async fn load_older_pull_request_timeline(
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
            tracing::error!(%error, "failed to load tracked repository for older timeline");
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
    let mut detail = load_pull_request_detail(&state.db, &tracked, number)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to load pull request detail for older timeline");
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
    let (cursor, has_older) = load_timeline_page_state(&state.db, &tracked, number)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to load older timeline cursor");
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
    if !has_older {
        return Ok(Json(PullRequestDetailResponse {
            pull_request_detail: detail,
        }));
    }
    let cursor = cursor.ok_or_else(|| {
        tracing::error!(number, "stored timeline has older items but no cursor");
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            PullRequestErrorCode::SyncFailed,
        )
    })?;
    let page =
        match fetch_timeline_page_with_installation(&state, &user_id, &tracked, number, &cursor)
            .await
        {
            Ok(page) => page,
            Err(PullRequestSyncError::AuthorizationRequired) => {
                return Err(api_error(
                    StatusCode::FORBIDDEN,
                    PullRequestErrorCode::AuthorizationRequired,
                ));
            }
            Err(PullRequestSyncError::Other(error)) => {
                tracing::error!(%error, "failed to fetch older pull request timeline");
                return Err(api_error(
                    StatusCode::BAD_GATEWAY,
                    PullRequestErrorCode::SyncFailed,
                ));
            }
        };

    let mut stable_ids = detail
        .timeline
        .iter()
        .filter_map(|item| item.id.clone())
        .collect::<HashSet<_>>();
    detail
        .timeline
        .extend(page.items.into_iter().filter(|item| {
            item.id
                .as_ref()
                .is_none_or(|id| stable_ids.insert(id.clone()))
        }));
    detail.timeline_has_older = page.has_older;
    let updated = update_pull_request_timeline_if_current(
        &state.db,
        &tracked,
        number,
        &cursor,
        &detail.timeline,
        page.cursor.as_deref(),
        page.has_older,
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "failed to store older pull request timeline");
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            PullRequestErrorCode::SyncFailed,
        )
    })?;
    if !updated {
        detail = load_pull_request_detail(&state.db, &tracked, number)
            .await
            .map_err(|error| {
                tracing::error!(%error, "failed to reload pull request detail after timeline changed");
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
    }

    Ok(Json(PullRequestDetailResponse {
        pull_request_detail: detail,
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
        "SELECT body, files_json, commits_json, reviews_json, review_comments_json, review_decision, issue_comments_json, timeline_json, timeline_has_older, check_runs_json, statuses_json, diff, synced_at FROM tracked_repository_pull_request_details WHERE user_id = ? AND provider = ? AND owner = ? AND name = ? AND number = ?",
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

async fn load_pull_request_diff(
    db: &SqlitePool,
    repository: &TrackedRepository,
    number: i64,
) -> Result<Option<PullRequestDiffRow>, PullRequestDataError> {
    Ok(sqlx::query_as::<_, PullRequestDiffRow>(
        "SELECT CASE WHEN octet_length(diff) <= ? THEN diff END AS diff, octet_length(diff) AS diff_bytes, synced_at FROM tracked_repository_pull_request_details WHERE user_id = ? AND provider = ? AND owner = ? AND name = ? AND number = ?",
    )
    .bind(MAX_DIFF_BYTES as i64)
    .bind(&repository.user_id)
    .bind(GITHUB_PROVIDER)
    .bind(&repository.owner)
    .bind(&repository.name)
    .bind(number)
    .fetch_optional(db)
    .await?)
}

async fn load_timeline_page_state(
    db: &SqlitePool,
    repository: &TrackedRepository,
    number: i64,
) -> Result<Option<(Option<String>, bool)>, PullRequestDataError> {
    Ok(sqlx::query_as::<_, (Option<String>, bool)>(
        "SELECT timeline_cursor, timeline_has_older FROM tracked_repository_pull_request_details WHERE user_id = ? AND provider = ? AND owner = ? AND name = ? AND number = ?",
    )
    .bind(&repository.user_id)
    .bind(GITHUB_PROVIDER)
    .bind(&repository.owner)
    .bind(&repository.name)
    .bind(number)
    .fetch_optional(db)
    .await?)
}

async fn update_pull_request_timeline_if_current(
    db: &SqlitePool,
    repository: &TrackedRepository,
    number: i64,
    expected_cursor: &str,
    timeline: &[PullRequestTimelineEventDto],
    next_cursor: Option<&str>,
    has_older: bool,
) -> Result<bool, PullRequestDataError> {
    let timeline_json = serde_json::to_string(timeline)?;
    let update = sqlx::query(
        "UPDATE tracked_repository_pull_request_details SET timeline_json = ?, timeline_cursor = ?, timeline_has_older = ? WHERE user_id = ? AND provider = ? AND owner = ? AND name = ? AND number = ? AND timeline_cursor = ? AND timeline_has_older = 1",
    )
    .bind(&timeline_json)
    .bind(next_cursor)
    .bind(has_older)
    .bind(&repository.user_id)
    .bind(GITHUB_PROVIDER)
    .bind(&repository.owner)
    .bind(&repository.name)
    .bind(number)
    .bind(expected_cursor)
    .execute(db)
    .await?;

    Ok(update.rows_affected() == 1)
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
) -> Result<PullRequestSyncSnapshot, PullRequestSyncError> {
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

async fn fetch_timeline_page_with_installation(
    state: &AppState,
    user_id: &str,
    repository: &TrackedRepository,
    number: i64,
    before: &str,
) -> Result<GitHubTimelinePage, PullRequestSyncError> {
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
        match fetch_github_timeline_page(state, &token.token, repository, number, Some(before))
            .await
        {
            Ok(page) => return Ok(page),
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
) -> Result<PullRequestSyncSnapshot, PullRequestDataError> {
    let base_url = state.config.github_api_url.trim_end_matches('/');
    let pull_request_url = format!(
        "{base_url}/repos/{}/{}/pulls/{number}",
        repository.owner, repository.name
    );
    let pull_request: GitHubPullRequestDetail =
        fetch_github_json(state, token, &pull_request_url).await?;
    // TODO: Move timeline syncing to background pagination with rate-limit headers/backoff,
    // resumable cursors, webhook/incremental reconciliation, nested review-comment pagination,
    // and no large foreground syncs once background syncing exists.
    let timeline_page = fetch_github_timeline_page(state, token, repository, number, None).await?;
    let files: Vec<GitHubPullRequestFile> =
        fetch_github_json(state, token, &format!("{pull_request_url}/files")).await?;
    let commits: Vec<GitHubPullRequestCommit> =
        fetch_github_json(state, token, &format!("{pull_request_url}/commits")).await?;
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

    Ok(PullRequestSyncSnapshot {
        detail: PullRequestDetailSnapshot {
            body: pull_request.body.clone(),
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
            issue_comments: Vec::new(),
            review_comments: Vec::new(),
            review_decision: timeline_page.review_decision,
            reviews: Vec::new(),
            statuses: statuses
                .statuses
                .into_iter()
                .map(PullRequestStatusDto::from)
                .collect(),
            timeline: timeline_page.items,
            timeline_cursor: timeline_page.cursor,
            timeline_has_older: timeline_page.has_older,
        },
        pull_request: pull_request.pull_request,
    })
}

async fn fetch_github_timeline_page(
    state: &AppState,
    token: &str,
    repository: &TrackedRepository,
    number: i64,
    before: Option<&str>,
) -> Result<GitHubTimelinePage, PullRequestDataError> {
    let response = state
        .http_client
        .post(github_graphql_url(&state.config.github_api_url))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .json(&serde_json::json!({
            "query": GITHUB_TIMELINE_QUERY,
            "variables": {
                "owner": repository.owner,
                "name": repository.name,
                "number": number,
                "before": before,
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
        .json::<GitHubTimelineResponse>()
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

    let pull_request = response
        .data
        .and_then(|data| data.repository)
        .and_then(|repository| repository.pull_request)
        .ok_or_else(|| {
            PullRequestDataError::GitHubGraphQl(
                "GitHub GraphQL response did not include the pull request".to_string(),
            )
        })?;
    let mut items = pull_request
        .timeline_items
        .nodes
        .into_iter()
        .map(map_github_timeline_item)
        .collect::<Vec<_>>();
    items.reverse();

    Ok(GitHubTimelinePage {
        cursor: pull_request.timeline_items.page_info.start_cursor,
        has_older: pull_request.timeline_items.page_info.has_previous_page,
        items,
        review_decision: pull_request.review_decision,
    })
}

fn github_graphql_url(api_url: &str) -> String {
    let api_url = api_url.trim_end_matches('/');
    match api_url.strip_suffix("/api/v3") {
        Some(host) => format!("{host}/api/graphql"),
        None => format!("{api_url}/graphql"),
    }
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
        saved.push(upsert_pull_request(db, repository, pull_request, synced_at).await?);
    }

    Ok(saved)
}

async fn upsert_pull_request<'e, E>(
    executor: E,
    repository: &TrackedRepository,
    pull_request: &GitHubPullRequest,
    synced_at: &str,
) -> Result<PullRequestDto, PullRequestDataError>
where
    E: Executor<'e, Database = Sqlite>,
{
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
    .execute(executor)
    .await?;

    Ok(PullRequestDto {
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
    })
}

async fn upsert_pull_request_detail<'e, E>(
    executor: E,
    repository: &TrackedRepository,
    number: i64,
    detail: &PullRequestDetailSnapshot,
    synced_at: &str,
) -> Result<PullRequestDetailDto, PullRequestDataError>
where
    E: Executor<'e, Database = Sqlite>,
{
    let files_json = serde_json::to_string(&detail.files)?;
    let commits_json = serde_json::to_string(&detail.commits)?;
    let reviews_json = serde_json::to_string(&detail.reviews)?;
    let review_comments_json = serde_json::to_string(&detail.review_comments)?;
    let issue_comments_json = serde_json::to_string(&detail.issue_comments)?;
    let timeline_json = serde_json::to_string(&detail.timeline)?;
    let check_runs_json = serde_json::to_string(&detail.check_runs)?;
    let statuses_json = serde_json::to_string(&detail.statuses)?;

    sqlx::query(
        "INSERT INTO tracked_repository_pull_request_details (user_id, provider, owner, name, number, body, files_json, commits_json, reviews_json, review_comments_json, review_decision, issue_comments_json, timeline_json, timeline_cursor, timeline_has_older, check_runs_json, statuses_json, diff, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, provider, owner, name, number) DO UPDATE SET body = excluded.body, files_json = excluded.files_json, commits_json = excluded.commits_json, reviews_json = excluded.reviews_json, review_comments_json = excluded.review_comments_json, review_decision = excluded.review_decision, issue_comments_json = excluded.issue_comments_json, timeline_json = excluded.timeline_json, timeline_cursor = excluded.timeline_cursor, timeline_has_older = excluded.timeline_has_older, check_runs_json = excluded.check_runs_json, statuses_json = excluded.statuses_json, diff = excluded.diff, synced_at = excluded.synced_at",
    )
    .bind(&repository.user_id)
    .bind(GITHUB_PROVIDER)
    .bind(&repository.owner)
    .bind(&repository.name)
    .bind(number)
    .bind(&detail.body)
    .bind(&files_json)
    .bind(&commits_json)
    .bind(&reviews_json)
    .bind(&review_comments_json)
    .bind(&detail.review_decision)
    .bind(&issue_comments_json)
    .bind(&timeline_json)
    .bind(&detail.timeline_cursor)
    .bind(detail.timeline_has_older)
    .bind(&check_runs_json)
    .bind(&statuses_json)
    .bind(&detail.diff)
    .bind(synced_at)
    .execute(executor)
    .await?;

    Ok(PullRequestDetailDto {
        body: detail.body.clone(),
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
        timeline_has_older: detail.timeline_has_older,
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
    body: Option<String>,
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
    timeline_cursor: Option<String>,
    timeline_has_older: bool,
}

struct PullRequestSyncSnapshot {
    detail: PullRequestDetailSnapshot,
    pull_request: GitHubPullRequest,
}

#[derive(sqlx::FromRow)]
struct PullRequestDetailRow {
    body: Option<String>,
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
    timeline_has_older: bool,
}

#[derive(sqlx::FromRow)]
struct PullRequestDiffRow {
    diff: Option<String>,
    diff_bytes: Option<i64>,
    synced_at: String,
}

impl PullRequestDetailRow {
    fn into_dto(self) -> Result<PullRequestDetailDto, PullRequestDataError> {
        Ok(PullRequestDetailDto {
            body: self.body,
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
            timeline_has_older: self.timeline_has_older,
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

struct GitHubTimelinePage {
    cursor: Option<String>,
    has_older: bool,
    items: Vec<PullRequestTimelineEventDto>,
    review_decision: Option<String>,
}

#[derive(Deserialize)]
struct GitHubTimelineResponse {
    data: Option<GitHubTimelineData>,
    #[serde(default)]
    errors: Vec<GitHubGraphQlError>,
}

#[derive(Deserialize)]
struct GitHubTimelineData {
    repository: Option<GitHubTimelineRepository>,
}

#[derive(Deserialize)]
struct GitHubTimelineRepository {
    #[serde(rename = "pullRequest")]
    pull_request: Option<GitHubTimelinePullRequest>,
}

#[derive(Deserialize)]
struct GitHubTimelinePullRequest {
    #[serde(rename = "reviewDecision")]
    review_decision: Option<String>,
    #[serde(rename = "timelineItems")]
    timeline_items: GitHubTimelineConnection,
}

#[derive(Deserialize)]
struct GitHubTimelineConnection {
    #[serde(default)]
    nodes: Vec<serde_json::Value>,
    #[serde(rename = "pageInfo")]
    page_info: GitHubTimelinePageInfo,
}

#[derive(Deserialize)]
struct GitHubTimelinePageInfo {
    #[serde(rename = "hasPreviousPage")]
    has_previous_page: bool,
    #[serde(rename = "startCursor")]
    start_cursor: Option<String>,
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
    body: Option<String>,
    head: GitHubPullRequestHead,
    #[serde(flatten)]
    pull_request: GitHubPullRequest,
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

fn map_github_timeline_item(item: serde_json::Value) -> PullRequestTimelineEventDto {
    let typename = json_string(&item, &["__typename"]);
    let event = match typename.as_deref() {
        Some("IssueComment") => "commented",
        Some("PullRequestCommit") => "committed",
        Some("PullRequestReview") => "reviewed",
        Some("ClosedEvent") => "closed",
        Some("ReopenedEvent") => "reopened",
        Some("MergedEvent") => "merged",
        Some("ReadyForReviewEvent") => "ready_for_review",
        Some("ConvertToDraftEvent") => "converted_to_draft",
        Some("ReviewRequestedEvent") => "review_requested",
        Some("ReviewRequestRemovedEvent") => "review_request_removed",
        Some("ReviewDismissedEvent") => "review_dismissed",
        Some("HeadRefForcePushedEvent") => "head_ref_force_pushed",
        Some("BaseRefForcePushedEvent") => "base_ref_force_pushed",
        Some("HeadRefDeletedEvent") => "head_ref_deleted",
        Some("HeadRefRestoredEvent") => "head_ref_restored",
        _ => "unknown",
    }
    .to_string();
    let actor_login = json_string(&item, &["actor", "login"])
        .or_else(|| json_string(&item, &["author", "login"]))
        .or_else(|| json_string(&item, &["commit", "author", "user", "login"]))
        .or_else(|| json_string(&item, &["review", "author", "login"]));
    let body = json_string(&item, &["body"])
        .or_else(|| json_string(&item, &["commit", "message"]))
        .or_else(|| json_string(&item, &["review", "body"]));
    let commit_sha = json_string(&item, &["commit", "oid"])
        .or_else(|| json_string(&item, &["afterCommit", "oid"]));
    let occurred_at = json_string(&item, &["createdAt"])
        .or_else(|| json_string(&item, &["submittedAt"]))
        .or_else(|| json_string(&item, &["commit", "committedDate"]));
    let review_comments = item
        .pointer("/comments/nodes")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .map(|comment| PullRequestTimelineReviewCommentDto {
            actor_login: json_string(comment, &["author", "login"]),
            body: json_string(comment, &["body"]),
            id: json_string(comment, &["id"]),
            occurred_at: json_string(comment, &["createdAt"]),
            url: json_string(comment, &["url"]),
        })
        .collect();
    let review_comments_has_more = item
        .pointer("/comments/pageInfo/hasNextPage")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let state = json_string(&item, &["state"])
        .or_else(|| json_string(&item, &["review", "state"]))
        .or_else(|| json_string(&item, &["previousReviewState"]));
    let title = json_string(&item, &["requestedReviewer", "login"])
        .or_else(|| json_string(&item, &["requestedReviewer", "name"]))
        .or_else(|| json_string(&item, &["headRefName"]))
        .or_else(|| json_string(&item, &["commit", "messageHeadline"]))
        .or_else(|| (event == "unknown").then_some(typename).flatten());
    let url = json_string(&item, &["url"])
        .or_else(|| json_string(&item, &["commit", "url"]))
        .or_else(|| json_string(&item, &["review", "url"]));

    PullRequestTimelineEventDto {
        actor_login,
        body,
        commit_sha,
        event,
        id: json_string(&item, &["id"]),
        occurred_at,
        review_comments,
        review_comments_has_more,
        state,
        title,
        url,
    }
}

fn json_string(value: &serde_json::Value, path: &[&str]) -> Option<String> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
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
    use std::{collections::HashMap, fmt::Write};
    use tokio::net::TcpListener;
    use tower::ServiceExt;

    use super::{
        fetch_github_pull_request_detail, fetch_github_pull_requests, load_pull_request_detail,
        load_pull_requests, load_tracked_repository, update_pull_request_timeline_if_current,
        update_sync_error, update_sync_state, upsert_pull_request_detail, upsert_pull_requests,
        GitHubPullRequest, GitHubUser, PullRequestCheckRunDto, PullRequestCommentDto,
        PullRequestCommitDto, PullRequestDetailSnapshot, PullRequestFileDto, PullRequestReviewDto,
        PullRequestStatusDto, PullRequestTimelineEventDto, TrackedRepository,
    };
    use crate::{
        config::{Config, Environment, SessionConfig, TokenEncryptionKey},
        db,
        http::{app, AppState},
        repositories, session,
    };

    const MULTI_FILE_DIFF: &str =
        include_str!("../tests/fixtures/pull_request_diffs/multi-file.diff");
    const MALFORMED_DIFF: &str =
        include_str!("../tests/fixtures/pull_request_diffs/malformed.diff");

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

    #[test]
    fn derives_graphql_url_from_public_and_enterprise_api_urls() {
        assert_eq!(
            super::github_graphql_url("https://api.github.com"),
            "https://api.github.com/graphql"
        );
        assert_eq!(
            super::github_graphql_url("https://github.example/api/v3/"),
            "https://github.example/api/graphql"
        );
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
            assert_eq!(body["variables"]["before"], Value::Null);

            Json(serde_json::json!({
                "data": {
                    "repository": {
                        "pullRequest": {
                            "reviewDecision": "APPROVED",
                            "timelineItems": {
                                "nodes": [
                                    {
                                        "__typename": "IssueComment",
                                        "id": "comment-1",
                                        "author": { "login": "octocat" },
                                        "body": "looks good",
                                        "createdAt": "2026-01-02T00:00:00Z",
                                        "url": "https://github.com/kestrel/app/pull/42#issuecomment-1"
                                    },
                                    {
                                        "__typename": "PullRequestCommit",
                                        "id": "commit-1",
                                        "commit": {
                                            "oid": "head-sha",
                                            "message": "Add syncing",
                                            "messageHeadline": "Add syncing",
                                            "committedDate": "2026-01-03T00:00:00Z",
                                            "url": "https://github.com/kestrel/app/commit/head-sha",
                                            "author": { "user": { "login": "octocat" } }
                                        }
                                    }
                                ],
                                "pageInfo": {
                                    "hasPreviousPage": true,
                                    "startCursor": "older-cursor"
                                }
                            }
                        }
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
                "closed_at": null,
                "created_at": "2026-01-01T00:00:00Z",
                "draft": false,
                "body": "This pull request adds syncing.",
                "head": { "sha": "head-sha" },
                "html_url": "https://github.com/kestrel/app/pull/42",
                "id": 1042,
                "merged_at": null,
                "number": 42,
                "state": "open",
                "title": "Add syncing",
                "updated_at": "2026-01-02T00:00:00Z",
                "user": { "login": "octocat" }
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

    async fn insert_pull_request_diff_snapshot(db: &SqlitePool, diff: Option<&str>) {
        sqlx::query(
            "INSERT INTO tracked_repository_pull_request_details (user_id, provider, owner, name, number, body, files_json, commits_json, reviews_json, review_comments_json, review_decision, issue_comments_json, timeline_json, timeline_cursor, timeline_has_older, check_runs_json, statuses_json, diff, synced_at) VALUES (?, ?, ?, ?, ?, NULL, '[]', '[]', '[]', '[]', NULL, '[]', '[]', NULL, 0, '[]', '[]', ?, ?)",
        )
        .bind("user_1")
        .bind("github")
        .bind("kestrel")
        .bind("app")
        .bind(42_i64)
        .bind(diff)
        .bind("2026-01-04T00:00:00Z")
        .execute(db)
        .await
        .expect("pull request diff snapshot should insert");
    }

    fn pull_request_diff_request(cookie: &str, uri: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .header(header::COOKIE, cookie)
            .body(Body::empty())
            .expect("request should build")
    }

    fn assert_private_no_store(response: &axum::response::Response) {
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("private, no-store")
        );
    }

    #[tokio::test]
    async fn pull_request_diff_requires_authentication() {
        let config = test_config();
        let db = test_db().await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/repositories/kestrel/app/pull-requests/42/diff")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_private_no_store(&response);
        assert_eq!(
            response_json(response).await,
            serde_json::json!({ "error": "authentication_required" })
        );
    }

    #[tokio::test]
    async fn pull_request_diff_rejects_invalid_paths() {
        let config = test_config();
        let db = test_db().await;
        let cookie = session_cookie(&db, &config).await;
        let router = app(&config, AppState::new(db, config.clone()));

        let invalid_repository = router
            .clone()
            .oneshot(pull_request_diff_request(
                &cookie,
                "/api/repositories/bad%20owner/app/pull-requests/42/diff",
            ))
            .await
            .expect("request should complete");
        assert_eq!(invalid_repository.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(invalid_repository).await,
            serde_json::json!({ "error": "invalid_repository" })
        );

        let invalid_number = router
            .clone()
            .oneshot(pull_request_diff_request(
                &cookie,
                "/api/repositories/kestrel/app/pull-requests/0/diff",
            ))
            .await
            .expect("request should complete");
        assert_eq!(invalid_number.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(invalid_number).await,
            serde_json::json!({ "error": "invalid_pull_request" })
        );

        let nonnumeric_number = router
            .oneshot(pull_request_diff_request(
                &cookie,
                "/api/repositories/kestrel/app/pull-requests/not-a-number/diff",
            ))
            .await
            .expect("request should complete");
        assert_eq!(nonnumeric_number.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(nonnumeric_number).await,
            serde_json::json!({ "error": "invalid_pull_request" })
        );
    }

    #[tokio::test]
    async fn pull_request_diff_requires_a_tracked_repository_and_snapshot() {
        let config = test_config();
        let db = test_db().await;
        let cookie = session_cookie(&db, &config).await;
        let router = app(&config, AppState::new(db.clone(), config.clone()));

        let untracked = router
            .clone()
            .oneshot(pull_request_diff_request(
                &cookie,
                "/api/repositories/kestrel/app/pull-requests/42/diff",
            ))
            .await
            .expect("request should complete");
        assert_eq!(untracked.status(), StatusCode::NOT_FOUND);
        assert_private_no_store(&untracked);
        assert_eq!(
            response_json(untracked).await,
            serde_json::json!({ "error": "repository_not_tracked" })
        );

        insert_tracked_repository(&db).await;
        let missing = router
            .oneshot(pull_request_diff_request(
                &cookie,
                "/api/repositories/kestrel/app/pull-requests/42/diff",
            ))
            .await
            .expect("request should complete");
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response_json(missing).await,
            serde_json::json!({ "error": "pull_request_not_found" })
        );
    }

    #[tokio::test]
    async fn pull_request_diff_is_scoped_to_the_authenticated_user() {
        let config = test_config();
        let db = test_db().await;
        insert_tracked_repository(&db).await;
        insert_pull_request_diff_snapshot(&db, Some(MULTI_FILE_DIFF)).await;
        sqlx::query(
            "INSERT INTO users (id, display_name, avatar_url, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)",
        )
        .bind("user_2")
        .bind("User Two")
        .bind("2026-01-01T00:00:00Z")
        .bind("2026-01-01T00:00:00Z")
        .execute(&db)
        .await
        .expect("second user should insert");
        sqlx::query(
            "INSERT INTO tracked_repositories (user_id, provider, owner, name, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("user_2")
        .bind("github")
        .bind("kestrel")
        .bind("app")
        .bind("2026-01-01T00:00:00Z")
        .execute(&db)
        .await
        .expect("second user's tracked repository should insert");
        sqlx::query(
            "INSERT INTO tracked_repository_pull_request_details (user_id, provider, owner, name, number, body, files_json, commits_json, reviews_json, review_comments_json, review_decision, issue_comments_json, timeline_json, timeline_cursor, timeline_has_older, check_runs_json, statuses_json, diff, synced_at) VALUES (?, ?, ?, ?, ?, NULL, '[]', '[]', '[]', '[]', NULL, '[]', '[]', NULL, 0, '[]', '[]', ?, ?)",
        )
        .bind("user_2")
        .bind("github")
        .bind("kestrel")
        .bind("app")
        .bind(42_i64)
        .bind("")
        .bind("2026-01-05T00:00:00Z")
        .execute(&db)
        .await
        .expect("second user's pull request diff snapshot should insert");
        let session = session::create_session(&db, "user_2", &config.session)
            .await
            .expect("second user session should create");
        let cookie = format!("test_session={}", session.token.expose());
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(pull_request_diff_request(
                &cookie,
                "/api/repositories/kestrel/app/pull-requests/42/diff",
            ))
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response_json(response).await,
            serde_json::json!({
                "files": [],
                "syncedAt": "2026-01-05T00:00:00Z"
            })
        );
    }

    #[tokio::test]
    async fn pull_request_diff_distinguishes_unavailable_and_empty_diffs() {
        let config = test_config();
        let null_db = test_db().await;
        insert_tracked_repository(&null_db).await;
        insert_pull_request_diff_snapshot(&null_db, None).await;
        let null_cookie = session_cookie(&null_db, &config).await;
        let unavailable = app(&config, AppState::new(null_db.clone(), config.clone()))
            .oneshot(pull_request_diff_request(
                &null_cookie,
                "/api/repositories/kestrel/app/pull-requests/42/diff",
            ))
            .await
            .expect("request should complete");
        assert_eq!(unavailable.status(), StatusCode::CONFLICT);
        assert_eq!(
            response_json(unavailable).await,
            serde_json::json!({ "error": "diff_unavailable" })
        );

        let empty_db = test_db().await;
        insert_tracked_repository(&empty_db).await;
        insert_pull_request_diff_snapshot(&empty_db, Some("")).await;
        let empty_cookie = session_cookie(&empty_db, &config).await;
        let empty = app(&config, AppState::new(empty_db, config.clone()))
            .oneshot(pull_request_diff_request(
                &empty_cookie,
                "/api/repositories/kestrel/app/pull-requests/42/diff",
            ))
            .await
            .expect("request should complete");
        assert_eq!(empty.status(), StatusCode::OK);
        assert_eq!(
            response_json(empty).await,
            serde_json::json!({
                "files": [],
                "syncedAt": "2026-01-04T00:00:00Z"
            })
        );
    }

    #[tokio::test]
    async fn pull_request_diff_returns_semantic_files_in_source_order() {
        let config = test_config();
        let db = test_db().await;
        insert_tracked_repository(&db).await;
        insert_pull_request_diff_snapshot(&db, Some(MULTI_FILE_DIFF)).await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(pull_request_diff_request(
                &cookie,
                "/api/repositories/kestrel/app/pull-requests/42/diff",
            ))
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("private, no-store")
        );
        let body = response_json(response).await;
        assert_eq!(body["syncedAt"], "2026-01-04T00:00:00Z");
        assert_eq!(body["files"].as_array().map(Vec::len), Some(2));
        assert_eq!(body["files"][0]["oldPath"], "src/math.rs");
        assert_eq!(body["files"][0]["newPath"], "src/math.rs");
        assert_eq!(body["files"][0]["operation"], "modified");
        assert_eq!(body["files"][0]["additions"], 3);
        assert_eq!(body["files"][0]["deletions"], 2);
        assert_eq!(body["files"][0]["binary"], false);
        assert_eq!(body["files"][0]["oldMode"], Value::Null);
        assert_eq!(body["files"][0]["newMode"], Value::Null);
        assert_eq!(body["files"][0]["hunks"][0]["oldStart"], 1);
        assert_eq!(body["files"][0]["hunks"][0]["newCount"], 4);
        assert_eq!(
            body["files"][0]["hunks"][0]["context"],
            "pub fn add(left: u32, right: u32) -> u32 {"
        );
        assert_eq!(
            body["files"][0]["hunks"][0]["lines"][1],
            serde_json::json!({
                "content": "    left + right",
                "kind": "deletion",
                "missingNewline": false,
                "newLine": null,
                "oldLine": 2
            })
        );
        assert_eq!(body["files"][1]["newPath"], "README.md");
    }

    #[tokio::test]
    async fn pull_request_diff_parse_failure_preserves_stored_raw_diff() {
        let config = test_config();
        let db = test_db().await;
        insert_tracked_repository(&db).await;
        insert_pull_request_diff_snapshot(&db, Some(MALFORMED_DIFF)).await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db.clone(), config.clone()))
            .oneshot(pull_request_diff_request(
                &cookie,
                "/api/repositories/kestrel/app/pull-requests/42/diff",
            ))
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            response_json(response).await,
            serde_json::json!({ "error": "diff_parse_failed" })
        );
        let stored: String = sqlx::query_scalar(
            "SELECT diff FROM tracked_repository_pull_request_details WHERE user_id = 'user_1' AND provider = 'github' AND owner = 'kestrel' AND name = 'app' AND number = 42",
        )
        .fetch_one(&db)
        .await
        .expect("stored diff should load");
        assert_eq!(stored.as_bytes(), MALFORMED_DIFF.as_bytes());
    }

    #[tokio::test]
    async fn pull_request_diff_reports_resource_limits_separately() {
        let config = test_config();
        let db = test_db().await;
        insert_tracked_repository(&db).await;
        let oversized = "\n".repeat(300_001);
        insert_pull_request_diff_snapshot(&db, Some(&oversized)).await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(pull_request_diff_request(
                &cookie,
                "/api/repositories/kestrel/app/pull-requests/42/diff",
            ))
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_private_no_store(&response);
        assert_eq!(
            response_json(response).await,
            serde_json::json!({ "error": "diff_resource_limit_exceeded" })
        );
    }

    #[tokio::test]
    async fn pull_request_diff_rejects_oversized_storage_before_loading_it() {
        let config = test_config();
        let db = test_db().await;
        insert_tracked_repository(&db).await;
        insert_pull_request_diff_snapshot(&db, Some("")).await;
        sqlx::query(
            "UPDATE tracked_repository_pull_request_details SET diff = CAST(zeroblob(?) AS TEXT) WHERE user_id = 'user_1' AND provider = 'github' AND owner = 'kestrel' AND name = 'app' AND number = 42",
        )
        .bind((crate::pull_request_diff::MAX_DIFF_BYTES + 1) as i64)
        .execute(&db)
        .await
        .expect("oversized stored diff should insert");
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(pull_request_diff_request(
                &cookie,
                "/api/repositories/kestrel/app/pull-requests/42/diff",
            ))
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            response_json(response).await,
            serde_json::json!({ "error": "diff_resource_limit_exceeded" })
        );
    }

    #[tokio::test]
    async fn pull_request_diff_serialization_excludes_binary_payloads() {
        let config = test_config();
        let db = test_db().await;
        insert_tracked_repository(&db).await;
        let literal_payload = "LcmZQzWcm*P0SW;F\n".repeat(16_384);
        let delta_payload = "ccmV+t0PX*P2!IH%^Z^9`00000v-trB0x!=5aR2}S\n".repeat(16_384);
        let raw = format!(
            "diff --git a/large.bin b/large.bin\nindex 1111111..2222222 100644\nGIT binary patch\nliteral 1048576\n{literal_payload}\ndelta 1048576\n{delta_payload}\n"
        );
        assert!(raw.len() > 500_000);
        insert_pull_request_diff_snapshot(&db, Some(&raw)).await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(pull_request_diff_request(
                &cookie,
                "/api/repositories/kestrel/app/pull-requests/42/diff",
            ))
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 4 * 1024)
            .await
            .expect("binary response should remain small");
        assert!(!body.windows(16).any(|window| window == b"LcmZQzWcm*P0SW;F"));
        let json: Value = serde_json::from_slice(&body).expect("body should be json");
        assert_eq!(json["files"].as_array().map(Vec::len), Some(1));
        assert!(json["files"].as_array().is_some_and(|files| files
            .iter()
            .all(|file| file["binary"] == true && file["hunks"] == serde_json::json!([]))));
    }

    #[tokio::test]
    async fn pull_request_diff_serializes_50_000_semantic_lines() {
        let config = test_config();
        let db = test_db().await;
        insert_tracked_repository(&db).await;
        let mut raw = String::from(
            "diff --git a/large.txt b/large.txt\nindex 1111111..2222222 100644\n--- a/large.txt\n+++ b/large.txt\n@@ -1,25000 +1,25000 @@\n",
        );
        for index in 0..25_000 {
            writeln!(raw, "-old-{index}").expect("deletion should write");
        }
        for index in 0..25_000 {
            writeln!(raw, "+new-{index}").expect("addition should write");
        }
        insert_pull_request_diff_snapshot(&db, Some(&raw)).await;
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(pull_request_diff_request(
                &cookie,
                "/api/repositories/kestrel/app/pull-requests/42/diff",
            ))
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .expect("large response should stay within the expected bound");
        let json: Value = serde_json::from_slice(&body).expect("body should be json");
        let lines = json["files"][0]["hunks"][0]["lines"]
            .as_array()
            .expect("lines should be an array");
        assert_eq!(lines.len(), 50_000);
        assert_eq!(lines[49_999]["newLine"], 25_000);
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
    async fn load_older_timeline_requires_authentication() {
        let config = test_config();
        let db = test_db().await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repositories/kestrel/app/pull-requests/42/timeline/older")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn load_older_timeline_returns_unchanged_detail_when_complete() {
        let config = test_config();
        let db = test_db().await;
        insert_tracked_repository(&db).await;
        sqlx::query(
            "INSERT INTO tracked_repository_pull_request_details (user_id, provider, owner, name, number, body, files_json, commits_json, reviews_json, review_comments_json, review_decision, issue_comments_json, timeline_json, timeline_cursor, timeline_has_older, check_runs_json, statuses_json, diff, synced_at) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', NULL, '[]', '[]', NULL, 0, '[]', '[]', NULL, ?)",
        )
        .bind("user_1")
        .bind("github")
        .bind("kestrel")
        .bind("app")
        .bind(42_i64)
        .bind("Stored description")
        .bind("2026-01-03T00:00:00Z")
        .execute(&db)
        .await
        .expect("pull request detail should insert");
        let cookie = session_cookie(&db, &config).await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repositories/kestrel/app/pull-requests/42/timeline/older")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::OK);
        let json = response_json(response).await;
        assert_eq!(json["pullRequestDetail"]["body"], "Stored description");
        assert_eq!(json["pullRequestDetail"]["timelineHasOlder"], false);
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

        let snapshot =
            fetch_github_pull_request_detail(&state, "installation_token", &repository, 42)
                .await
                .expect("pull request detail should fetch from mock GitHub API");

        server.abort();
        assert_eq!(snapshot.pull_request.title, "Add syncing");
        assert_eq!(snapshot.pull_request.state, "open");
        let detail = snapshot.detail;
        assert_eq!(detail.files[0].filename, "app.rs");
        assert_eq!(detail.commits[0].sha, "head-sha");
        assert_eq!(detail.commits[0].message, "Add syncing");
        assert!(detail.reviews.is_empty());
        assert_eq!(detail.review_decision.as_deref(), Some("APPROVED"));
        assert!(detail.review_comments.is_empty());
        assert!(detail.issue_comments.is_empty());
        assert_eq!(
            detail.body.as_deref(),
            Some("This pull request adds syncing.")
        );
        assert_eq!(detail.timeline[0].event, "committed");
        assert_eq!(detail.timeline[0].id.as_deref(), Some("commit-1"));
        assert_eq!(detail.timeline[0].commit_sha.as_deref(), Some("head-sha"));
        assert_eq!(detail.timeline[1].event, "commented");
        assert!(detail.timeline_has_older);
        assert_eq!(detail.timeline_cursor.as_deref(), Some("older-cursor"));
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
            body: Some("This pull request adds syncing.".to_string()),
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
                body: None,
                commit_sha: Some("head-sha".to_string()),
                event: "committed".to_string(),
                id: Some("timeline-1".to_string()),
                occurred_at: Some("2026-01-02T00:00:00Z".to_string()),
                review_comments: Vec::new(),
                review_comments_has_more: false,
                state: None,
                title: Some("Add syncing".to_string()),
                url: None,
            }],
            timeline_cursor: Some("cursor-1".to_string()),
            timeline_has_older: true,
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
        assert_eq!(
            saved.body.as_deref(),
            Some("This pull request adds syncing.")
        );
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
        assert!(loaded.timeline_has_older);
        assert_eq!(loaded.timeline[0].id.as_deref(), Some("timeline-1"));
        assert_eq!(
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT timeline_cursor FROM tracked_repository_pull_request_details WHERE user_id = ? AND provider = ? AND owner = ? AND name = ? AND number = ?",
            )
            .bind("user_1")
            .bind("github")
            .bind("kestrel")
            .bind("app")
            .bind(42_i64)
            .fetch_one(&db)
            .await
            .expect("timeline cursor should load")
            .as_deref(),
            Some("cursor-1"),
        );
        assert_eq!(loaded.synced_at, "2026-01-03T00:00:00Z");
    }

    #[tokio::test]
    async fn older_timeline_update_requires_the_stored_cursor() {
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
        sqlx::query(
            "INSERT INTO tracked_repository_pull_request_details (user_id, provider, owner, name, number, body, files_json, commits_json, reviews_json, review_comments_json, review_decision, issue_comments_json, timeline_json, timeline_cursor, timeline_has_older, check_runs_json, statuses_json, diff, synced_at) VALUES (?, ?, ?, ?, ?, NULL, '[]', '[]', '[]', '[]', NULL, '[]', ?, ?, 1, '[]', '[]', NULL, ?)",
        )
        .bind("user_1")
        .bind("github")
        .bind("kestrel")
        .bind("app")
        .bind(42_i64)
        .bind(r#"[{"actorLogin":"octocat","event":"commented"}]"#)
        .bind("current-cursor")
        .bind("2026-01-03T00:00:00Z")
        .execute(&db)
        .await
        .expect("pull request detail should insert");
        let replacement = vec![PullRequestTimelineEventDto {
            actor_login: Some("reviewer".to_string()),
            body: None,
            commit_sha: None,
            event: "reviewed".to_string(),
            id: Some("review-1".to_string()),
            occurred_at: Some("2026-01-02T00:00:00Z".to_string()),
            review_comments: Vec::new(),
            review_comments_has_more: false,
            state: Some("APPROVED".to_string()),
            title: None,
            url: None,
        }];

        let stale_update = update_pull_request_timeline_if_current(
            &db,
            &repository,
            42,
            "stale-cursor",
            &replacement,
            None,
            false,
        )
        .await
        .expect("stale update should complete");
        assert!(!stale_update);
        assert_eq!(
            load_pull_request_detail(&db, &repository, 42)
                .await
                .expect("detail should load")
                .expect("detail should exist")
                .timeline[0]
                .event,
            "commented",
        );

        let current_update = update_pull_request_timeline_if_current(
            &db,
            &repository,
            42,
            "current-cursor",
            &replacement,
            None,
            false,
        )
        .await
        .expect("current update should complete");
        assert!(current_update);
        let loaded = load_pull_request_detail(&db, &repository, 42)
            .await
            .expect("detail should load")
            .expect("detail should exist");
        assert_eq!(loaded.timeline[0].event, "reviewed");
        assert!(!loaded.timeline_has_older);
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

    #[test]
    fn timeline_dto_deserializes_legacy_sparse_json() {
        let timeline: Vec<PullRequestTimelineEventDto> =
            serde_json::from_str(r#"[{"actorLogin":"octocat","event":"closed"}]"#)
                .expect("legacy timeline should deserialize");

        assert_eq!(timeline[0].actor_login.as_deref(), Some("octocat"));
        assert_eq!(timeline[0].event, "closed");
        assert_eq!(timeline[0].id, None);
        assert_eq!(timeline[0].occurred_at, None);
        assert!(timeline[0].review_comments.is_empty());
        assert!(!timeline[0].review_comments_has_more);
    }

    #[test]
    fn review_timeline_item_exposes_truncated_comments() {
        let item = super::map_github_timeline_item(serde_json::json!({
            "__typename": "PullRequestReview",
            "id": "review-1",
            "author": { "login": "reviewer" },
            "state": "APPROVED",
            "url": "https://github.com/kestrel/app/pull/42#pullrequestreview-1",
            "comments": {
                "nodes": [{
                    "id": "comment-1",
                    "author": { "login": "reviewer" },
                    "body": "One of many comments"
                }],
                "pageInfo": { "hasNextPage": true }
            }
        }));

        assert_eq!(item.event, "reviewed");
        assert_eq!(item.review_comments.len(), 1);
        assert!(item.review_comments_has_more);
    }

    #[test]
    fn unknown_graphql_timeline_item_maps_to_generic_fallback() {
        let item = super::map_github_timeline_item(serde_json::json!({
            "__typename": "FutureTimelineEvent",
            "id": "future-1"
        }));

        assert_eq!(item.event, "unknown");
        assert_eq!(item.id.as_deref(), Some("future-1"));
        assert_eq!(item.title.as_deref(), Some("FutureTimelineEvent"));
    }
}
