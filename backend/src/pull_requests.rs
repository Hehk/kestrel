use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use reqwest::StatusCode as ReqwestStatusCode;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use utoipa::{IntoParams, ToSchema};

use crate::{auth, github_app, http::AppState, repositories};

const GITHUB_API_URL: &str = "https://api.github.com";
const GITHUB_PROVIDER: &str = "github";
const PAGE_SIZE: u8 = 100;
const USER_AGENT: &str = "kestrel";

#[derive(Deserialize, IntoParams)]
pub(crate) struct RepositoryPath {
    owner: String,
    name: String,
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

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestErrorResponse {
    pub error: PullRequestErrorCode,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestErrorCode {
    AuthorizationRequired,
    InvalidRepository,
    RepositoryNotTracked,
    SyncFailed,
}

impl PullRequestErrorCode {
    fn as_str(&self) -> &'static str {
        match self {
            Self::AuthorizationRequired => "authorization_required",
            Self::InvalidRepository => "invalid_repository",
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

async fn fetch_github_pull_requests(
    state: &AppState,
    token: &str,
    repository: &TrackedRepository,
) -> Result<Vec<GitHubPullRequest>, PullRequestDataError> {
    let response = state
        .http_client
        .get(format!(
            "{GITHUB_API_URL}/repos/{}/{}/pulls",
            repository.owner, repository.name
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
    Reqwest(reqwest::Error),
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
            Self::Reqwest(error) => write!(f, "GitHub pull request HTTP request failed: {error}"),
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

    use super::{
        load_pull_requests, load_tracked_repository, update_sync_error, update_sync_state,
        upsert_pull_requests, GitHubPullRequest, GitHubUser,
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
}
