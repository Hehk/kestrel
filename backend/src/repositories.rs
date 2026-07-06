use axum::{extract::State, http::HeaderMap, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use url::Url;
use utoipa::ToSchema;

use crate::{auth, http::AppState};

const GITHUB_PROVIDER: &str = "github";

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDto {
    pub owner: String,
    pub name: String,
    pub full_name: String,
    pub html_url: String,
    pub created_at: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListRepositoriesResponse {
    pub repositories: Vec<RepositoryDto>,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateRepositoryRequest {
    pub repository: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateRepositoryResponse {
    pub repository: RepositoryDto,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryErrorResponse {
    pub error: RepositoryErrorCode,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RepositoryErrorCode {
    DuplicateRepository,
    InvalidRepository,
    RepositorySaveFailed,
}

#[utoipa::path(
    get,
    path = "/api/repositories",
    responses(
        (status = 200, description = "Current user's tracked repositories", body = ListRepositoriesResponse),
        (status = 401, description = "Authentication required")
    )
)]
pub(crate) async fn list_repositories(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ListRepositoriesResponse>, StatusCode> {
    let user_id = require_user_id(&state, &headers).await?;
    let repositories = load_repositories(&state, &user_id).await.map_err(|error| {
        tracing::error!(%error, "failed to load tracked repositories");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    Ok(Json(ListRepositoriesResponse { repositories }))
}

#[utoipa::path(
    post,
    path = "/api/repositories",
    request_body = CreateRepositoryRequest,
    responses(
        (status = 201, description = "Tracked repository created", body = CreateRepositoryResponse),
        (status = 400, description = "Invalid GitHub repository", body = RepositoryErrorResponse),
        (status = 401, description = "Authentication required", body = RepositoryErrorResponse),
        (status = 409, description = "Repository is already tracked", body = RepositoryErrorResponse)
    )
)]
pub(crate) async fn create_repository(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateRepositoryRequest>,
) -> Result<(StatusCode, Json<CreateRepositoryResponse>), (StatusCode, Json<RepositoryErrorResponse>)>
{
    let user_id = require_user_id(&state, &headers)
        .await
        .map_err(|status| api_error(status, RepositoryErrorCode::RepositorySaveFailed))?;
    let repository = parse_repository_input(&request.repository).map_err(|_| {
        api_error(
            StatusCode::BAD_REQUEST,
            RepositoryErrorCode::InvalidRepository,
        )
    })?;

    let repository = insert_repository(&state, &user_id, &repository)
        .await
        .map_err(|error| {
            tracing::error!(%error, "failed to create tracked repository");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                RepositoryErrorCode::RepositorySaveFailed,
            )
        })?
        .ok_or_else(|| {
            api_error(
                StatusCode::CONFLICT,
                RepositoryErrorCode::DuplicateRepository,
            )
        })?;

    Ok((
        StatusCode::CREATED,
        Json(CreateRepositoryResponse { repository }),
    ))
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

async fn load_repositories(
    state: &AppState,
    user_id: &str,
) -> Result<Vec<RepositoryDto>, RepositoryError> {
    let rows = sqlx::query_as::<_, (String, String, String)>(
        "SELECT owner, name, created_at FROM tracked_repositories WHERE user_id = ? AND provider = ? ORDER BY created_at ASC, owner ASC, name ASC",
    )
    .bind(user_id)
    .bind(GITHUB_PROVIDER)
    .fetch_all(&state.db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(owner, name, created_at)| repository_dto(owner, name, created_at))
        .collect())
}

async fn insert_repository(
    state: &AppState,
    user_id: &str,
    repository: &ParsedRepository,
) -> Result<Option<RepositoryDto>, RepositoryError> {
    let created_at = format_timestamp(OffsetDateTime::now_utc())?;
    let result = sqlx::query(
        "INSERT INTO tracked_repositories (user_id, provider, owner, name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, provider, owner, name) DO NOTHING",
    )
    .bind(user_id)
    .bind(GITHUB_PROVIDER)
    .bind(&repository.owner)
    .bind(&repository.name)
    .bind(&created_at)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Ok(None);
    }

    Ok(Some(repository_dto(
        repository.owner.clone(),
        repository.name.clone(),
        created_at,
    )))
}

fn repository_dto(owner: String, name: String, created_at: String) -> RepositoryDto {
    let full_name = format!("{owner}/{name}");
    RepositoryDto {
        owner,
        name,
        html_url: format!("https://github.com/{full_name}"),
        full_name,
        created_at,
    }
}

fn api_error(
    status: StatusCode,
    error: RepositoryErrorCode,
) -> (StatusCode, Json<RepositoryErrorResponse>) {
    (status, Json(RepositoryErrorResponse { error }))
}

fn format_timestamp(timestamp: OffsetDateTime) -> Result<String, RepositoryError> {
    Ok(timestamp.format(&Rfc3339)?)
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct ParsedRepository {
    pub owner: String,
    pub name: String,
}

pub(crate) fn parse_repository_input(
    input: &str,
) -> Result<ParsedRepository, RepositoryParseError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(RepositoryParseError);
    }

    let path = if input.starts_with("http://") || input.starts_with("https://") {
        parse_github_url(input)?
    } else if input.starts_with("github.com/") {
        parse_github_url(&format!("https://{input}"))?
    } else {
        input.to_string()
    };

    parse_repository_path(&path)
}

fn parse_github_url(input: &str) -> Result<String, RepositoryParseError> {
    let url = Url::parse(input).map_err(|_| RepositoryParseError)?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(RepositoryParseError);
    }
    if url.host_str() != Some("github.com") {
        return Err(RepositoryParseError);
    }
    Ok(url.path().trim_start_matches('/').to_string())
}

fn parse_repository_path(path: &str) -> Result<ParsedRepository, RepositoryParseError> {
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let owner = parts.next().ok_or(RepositoryParseError)?;
    let name = parts.next().ok_or(RepositoryParseError)?;
    if parts.next().is_some() || !valid_owner(owner) || !valid_repo_name(name) {
        return Err(RepositoryParseError);
    }

    Ok(ParsedRepository {
        owner: owner.to_lowercase(),
        name: name.to_lowercase(),
    })
}

fn valid_owner(owner: &str) -> bool {
    !owner.is_empty()
        && owner.len() <= 39
        && !owner.starts_with('-')
        && !owner.ends_with('-')
        && owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn valid_repo_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct RepositoryParseError;

impl std::fmt::Display for RepositoryParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid GitHub repository")
    }
}

impl std::error::Error for RepositoryParseError {}

#[derive(Debug)]
enum RepositoryError {
    Sql(sqlx::Error),
    TimeFormat(time::error::Format),
}

impl From<sqlx::Error> for RepositoryError {
    fn from(error: sqlx::Error) -> Self {
        Self::Sql(error)
    }
}

impl From<time::error::Format> for RepositoryError {
    fn from(error: time::error::Format) -> Self {
        Self::TimeFormat(error)
    }
}

impl std::fmt::Display for RepositoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sql(error) => write!(f, "tracked repository database operation failed: {error}"),
            Self::TimeFormat(error) => write!(f, "failed to format repository timestamp: {error}"),
        }
    }
}

impl std::error::Error for RepositoryError {}

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

    use super::{parse_repository_input, ParsedRepository, RepositoryParseError};
    use crate::{
        config::{Config, Environment, SessionConfig, TokenEncryptionKey},
        db,
        http::{app, AppState},
        session,
    };

    fn parsed(owner: &str, name: &str) -> ParsedRepository {
        ParsedRepository {
            owner: owner.to_string(),
            name: name.to_string(),
        }
    }

    fn test_config() -> Config {
        Config {
            api_url: "http://127.0.0.1:3000".to_string(),
            app_url: "http://127.0.0.1:5173".to_string(),
            bind_addr: "127.0.0.1:0"
                .parse()
                .expect("test bind address should parse"),
            database_url: "sqlite::memory:".to_string(),
            environment: Environment::Development,
            github_oauth: None,
            session: SessionConfig {
                cookie_name: "test_session".to_string(),
                cookie_secure: false,
                ttl_days: 30,
            },
            token_encryption_key: TokenEncryptionKey::from_base64(&STANDARD.encode([7_u8; 32]))
                .expect("test key should parse"),
        }
    }

    async fn test_db() -> SqlitePool {
        let config = test_config();
        let db = db::connect(&config).await.expect("test db should connect");
        db::migrate(&db).await.expect("test migrations should run");
        for user_id in ["user_1", "user_2"] {
            sqlx::query(
                "INSERT INTO users (id, display_name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(user_id)
            .bind(user_id)
            .bind(Option::<String>::None)
            .bind("2026-01-01T00:00:00Z")
            .bind("2026-01-01T00:00:00Z")
            .execute(&db)
            .await
            .expect("test user should insert");
        }
        db
    }

    async fn session_cookie(db: &SqlitePool, config: &Config, user_id: &str) -> String {
        let session = session::create_session(db, user_id, &config.session)
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

    #[test]
    fn parses_owner_and_repo() {
        assert_eq!(
            parse_repository_input("Kestrel/App"),
            Ok(parsed("kestrel", "app")),
        );
    }

    #[test]
    fn parses_github_urls() {
        assert_eq!(
            parse_repository_input("https://github.com/Kestrel/App"),
            Ok(parsed("kestrel", "app")),
        );
        assert_eq!(
            parse_repository_input("http://github.com/Kestrel/App/"),
            Ok(parsed("kestrel", "app")),
        );
        assert_eq!(
            parse_repository_input("github.com/Kestrel/App"),
            Ok(parsed("kestrel", "app")),
        );
    }

    #[test]
    fn trims_whitespace_and_git_suffix() {
        assert_eq!(
            parse_repository_input(" https://github.com/Kestrel/App.git "),
            Ok(parsed("kestrel", "app")),
        );
    }

    #[test]
    fn allows_common_repository_name_characters() {
        assert_eq!(
            parse_repository_input("Owner/repo.name_with-chars"),
            Ok(parsed("owner", "repo.name_with-chars")),
        );
    }

    #[test]
    fn allows_dot_prefixed_repository_names() {
        assert_eq!(
            parse_repository_input("Owner/.github"),
            Ok(parsed("owner", ".github")),
        );
    }

    #[test]
    fn ignores_github_url_query_strings_and_fragments() {
        assert_eq!(
            parse_repository_input("https://github.com/Owner/Repo?tab=readme"),
            Ok(parsed("owner", "repo")),
        );
        assert_eq!(
            parse_repository_input("https://github.com/Owner/Repo#readme"),
            Ok(parsed("owner", "repo")),
        );
        assert_eq!(
            parse_repository_input("https://github.com/Owner/Repo/?tab=readme#readme"),
            Ok(parsed("owner", "repo")),
        );
    }

    #[test]
    fn rejects_invalid_input() {
        for input in [
            "",
            "owner",
            "/owner/name",
            "owner/name/issues",
            "owner/",
            "/name",
            "-owner/name",
            "owner-/name",
            "owner/name with spaces",
            "https://example.com/owner/name",
            "https://github.com/owner/name/issues",
        ] {
            assert_eq!(parse_repository_input(input), Err(RepositoryParseError));
        }
    }

    #[tokio::test]
    async fn list_repositories_requires_authentication() {
        let config = test_config();
        let db = test_db().await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/repositories")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn list_repositories_returns_empty_list() {
        let config = test_config();
        let db = test_db().await;
        let cookie = session_cookie(&db, &config, "user_1").await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/repositories")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response_json(response).await,
            serde_json::json!({ "repositories": [] }),
        );
    }

    #[tokio::test]
    async fn create_repository_stores_lowercase_repository() {
        let config = test_config();
        let db = test_db().await;
        let cookie = session_cookie(&db, &config, "user_1").await;
        let response = app(&config, AppState::new(db.clone(), config.clone()))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repositories")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::COOKIE, cookie)
                    .body(Body::from(r#"{"repository":"Kestrel/App"}"#))
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::CREATED);
        let json = response_json(response).await;
        assert_eq!(json["repository"]["owner"], "kestrel");
        assert_eq!(json["repository"]["name"], "app");
        assert_eq!(json["repository"]["fullName"], "kestrel/app");
        assert_eq!(
            json["repository"]["htmlUrl"],
            "https://github.com/kestrel/app"
        );
        assert!(json["repository"]["createdAt"].is_string());

        let stored: (String, String) = sqlx::query_as(
            "SELECT owner, name FROM tracked_repositories WHERE user_id = ? AND provider = ?",
        )
        .bind("user_1")
        .bind("github")
        .fetch_one(&db)
        .await
        .expect("repository should be stored");
        assert_eq!(stored, ("kestrel".to_string(), "app".to_string()));
    }

    #[tokio::test]
    async fn create_repository_rejects_duplicate_repository() {
        let config = test_config();
        let db = test_db().await;
        let cookie = session_cookie(&db, &config, "user_1").await;
        let router = app(&config, AppState::new(db.clone(), config.clone()));

        let first = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repositories")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::COOKIE, &cookie)
                    .body(Body::from(r#"{"repository":"Kestrel/App"}"#))
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");
        assert_eq!(first.status(), StatusCode::CREATED);

        let second = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repositories")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::COOKIE, cookie)
                    .body(Body::from(
                        r#"{"repository":"https://github.com/kestrel/app.git"}"#,
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(second.status(), StatusCode::CONFLICT);
        assert_eq!(
            response_json(second).await,
            serde_json::json!({ "error": "duplicate_repository" }),
        );

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tracked_repositories")
            .fetch_one(&db)
            .await
            .expect("repository count should load");
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn create_repository_rejects_invalid_repository() {
        let config = test_config();
        let db = test_db().await;
        let cookie = session_cookie(&db, &config, "user_1").await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repositories")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::COOKIE, cookie)
                    .body(Body::from(r#"{"repository":"owner/name/issues"}"#))
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
    async fn list_repositories_is_scoped_to_current_user() {
        let config = test_config();
        let db = test_db().await;
        sqlx::query(
            "INSERT INTO tracked_repositories (user_id, provider, owner, name, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("user_1")
        .bind("github")
        .bind("kestrel")
        .bind("app")
        .bind("2026-01-01T00:00:00Z")
        .execute(&db)
        .await
        .expect("repository should insert");
        let cookie = session_cookie(&db, &config, "user_2").await;
        let response = app(&config, AppState::new(db, config.clone()))
            .oneshot(
                Request::builder()
                    .uri("/api/repositories")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response_json(response).await,
            serde_json::json!({ "repositories": [] }),
        );
    }
}
