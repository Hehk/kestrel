use crate::{auth, http::AppState, review_snapshot::ReviewSnapshot};
use automerge::ActorId;
use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, State, WebSocketUpgrade,
    },
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use review_core::{Capability, Command, Contribution, Importance, Proposal, Workspace};
use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, Transaction};
use utoipa::ToSchema;

const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_MESSAGE_BYTES: usize = 128 * 1024;
type ApiResult<T> = Result<T, (StatusCode, Json<ReviewError>)>;

#[derive(Serialize, ToSchema)]
pub struct ReviewError {
    pub error: String,
}
fn error(status: StatusCode, message: &str) -> (StatusCode, Json<ReviewError>) {
    (
        status,
        Json(ReviewError {
            error: message.into(),
        }),
    )
}
fn internal(_: impl std::fmt::Display) -> (StatusCode, Json<ReviewError>) {
    error(StatusCode::SERVICE_UNAVAILABLE, "storageUnavailable")
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewReceipt {
    pub protocol: u32,
    pub user_id: String,
    pub document: Vec<u8>,
    pub revision: i64,
    pub acknowledged: Vec<String>,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewUpdate {
    protocol: u32,
    user_id: String,
    entries: Vec<ReviewEntry>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct ReviewEntry {
    snapshot: String,
    proposal: Proposal,
}

pub(crate) async fn store_snapshot(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    number: i64,
    manifest: &mut ReviewSnapshot,
    diff: &str,
) -> Result<(), sqlx::Error> {
    let existing: Option<String> = sqlx::query_scalar("SELECT manifest FROM review_snapshots WHERE user_id = ? AND repository_id = ? AND number = ? AND snapshot_id = ?")
        .bind(user).bind(manifest.repository_id).bind(number).bind(&manifest.id).fetch_optional(&mut **tx).await?;
    if let Some(existing) = existing {
        *manifest =
            serde_json::from_str(&existing).map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        return Ok(());
    }
    let json = serde_json::to_string(manifest).map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
    let retained_bytes: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(octet_length(diff)), 0) FROM review_snapshots WHERE user_id = ? AND repository_id = ? AND number = ? AND snapshot_id != ?")
        .bind(user).bind(manifest.repository_id).bind(number).bind(&manifest.id).fetch_one(&mut **tx).await?;
    if retained_bytes + diff.len() as i64 > 512 * 1024 * 1024 {
        return Err(sqlx::Error::Protocol(
            "review snapshot storage quota exceeded".into(),
        ));
    }
    sqlx::query("INSERT OR IGNORE INTO review_snapshots (user_id, repository_id, number, snapshot_id, manifest, diff) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(user).bind(manifest.repository_id).bind(number).bind(&manifest.id).bind(json).bind(diff).execute(&mut **tx).await?;
    for file in &manifest.files {
        sqlx::query("INSERT OR IGNORE INTO review_versions (user_id, repository_id, number, snapshot_id, version_id) VALUES (?, ?, ?, ?, ?)")
            .bind(user).bind(manifest.repository_id).bind(number).bind(&manifest.id).bind(&file.id).execute(&mut **tx).await?;
    }
    Ok(())
}

fn check_origin(state: &AppState, headers: &HeaderMap) -> ApiResult<()> {
    let expected = url::Url::parse(&state.config.app_url)
        .map_err(internal)?
        .origin()
        .ascii_serialization();
    if headers.get("origin").and_then(|h| h.to_str().ok()) != Some(expected.as_str()) {
        return Err(error(StatusCode::FORBIDDEN, "invalidOrigin"));
    }
    Ok(())
}

async fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    repo: i64,
    number: i64,
) -> ApiResult<String> {
    let user = auth::current_user_id(state, headers)
        .await
        .map_err(internal)?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "authenticationRequired"))?;
    let allowed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tracked_repository_pull_request_details WHERE user_id = ? AND number = ? AND json_extract(review_snapshot_json, '$.repositoryId') = ?)")
        .bind(&user).bind(number).bind(repo).fetch_one(&state.db).await.map_err(internal)?;
    if !allowed {
        return Err(error(StatusCode::FORBIDDEN, "workspaceUnavailable"));
    }
    Ok(user)
}

async fn load(
    tx: &mut Transaction<'_, Sqlite>,
    user: &str,
    repo: i64,
    number: i64,
) -> ApiResult<(Workspace, i64)> {
    let row: Option<(Vec<u8>, i64, i64)> = sqlx::query_as("SELECT document, revision, schema_version FROM review_workspaces WHERE user_id = ? AND repository_id = ? AND number = ?")
        .bind(user).bind(repo).bind(number).fetch_optional(&mut **tx).await.map_err(internal)?;
    if let Some((bytes, revision, schema)) = row {
        if schema != i64::from(review_core::SCHEMA_VERSION) {
            return Err(error(StatusCode::CONFLICT, "upgradeRequired"));
        }
        return Ok((
            Workspace::load_trusted(&bytes, ActorId::random()).map_err(internal)?,
            revision,
        ));
    }
    let doc = Workspace::bootstrap().map_err(internal)?;
    sqlx::query("INSERT INTO review_workspaces (user_id, repository_id, number, schema_version, document) VALUES (?, ?, ?, ?, ?)")
        .bind(user).bind(repo).bind(number).bind(review_core::SCHEMA_VERSION).bind(doc.save()).execute(&mut **tx).await.map_err(internal)?;
    Ok((doc, 0))
}

async fn commit(
    mut tx: Transaction<'_, Sqlite>,
    (user, repo, number): (String, i64, i64),
    doc: Workspace,
    revision: i64,
    acknowledged: Vec<String>,
    changed: bool,
) -> ApiResult<ReviewReceipt> {
    let bytes = doc.save();
    if bytes.len() > MAX_DOCUMENT_BYTES || doc.document().get_changes(&[]).len() > 20_000 {
        return Err(error(StatusCode::CONFLICT, "workspaceQuotaExceeded"));
    }
    let revision = revision + i64::from(changed);
    if changed {
        sqlx::query("UPDATE review_workspaces SET document = ?, revision = ? WHERE user_id = ? AND repository_id = ? AND number = ?")
            .bind(&bytes).bind(revision).bind(&user).bind(repo).bind(number).execute(&mut *tx).await.map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(ReviewReceipt {
        protocol: review_core::PROTOCOL_VERSION,
        user_id: user,
        document: bytes,
        revision,
        acknowledged,
    })
}

#[utoipa::path(get, path = "/api/review/{repository_id}/{number}",
    params(("repository_id" = i64, Path), ("number" = i64, Path)),
    responses((status = 200, body = ReviewReceipt), (status = 401, body = ReviewError), (status = 403, body = ReviewError)))]
pub(crate) async fn discover(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((repo, number)): Path<(i64, i64)>,
) -> ApiResult<Json<ReviewReceipt>> {
    let user = authorize(&state, &headers, repo, number).await?;
    let tx = state
        .db
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(internal)?;
    let mut tx = tx;
    let (doc, revision) = load(&mut tx, &user, repo, number).await?;
    Ok(Json(
        commit(tx, (user, repo, number), doc, revision, vec![], false).await?,
    ))
}

#[utoipa::path(post, path = "/api/review/{repository_id}/{number}",
    params(("repository_id" = i64, Path), ("number" = i64, Path)), request_body = ReviewUpdate,
    responses((status = 200, body = ReviewReceipt), (status = 401, body = ReviewError), (status = 403, body = ReviewError), (status = 409, body = ReviewError), (status = 413)))]
pub(crate) async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((repo, number)): Path<(i64, i64)>,
    Json(update): Json<ReviewUpdate>,
) -> ApiResult<Json<ReviewReceipt>> {
    check_origin(&state, &headers)?;
    apply_update(&state, &headers, repo, number, update)
        .await
        .map(Json)
}

async fn apply_update(
    state: &AppState,
    headers: &HeaderMap,
    repo: i64,
    number: i64,
    update: ReviewUpdate,
) -> ApiResult<ReviewReceipt> {
    let user = authorize(state, headers, repo, number).await?;
    if update.user_id != user {
        return Err(error(StatusCode::FORBIDDEN, "accountChanged"));
    }
    if update.protocol != review_core::PROTOCOL_VERSION {
        return Err(error(StatusCode::CONFLICT, "upgradeRequired"));
    }
    if update.entries.len() > 64 {
        return Err(error(StatusCode::PAYLOAD_TOO_LARGE, "tooManyCommands"));
    }
    let mut tx = state
        .db
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(internal)?;
    let (mut doc, revision) = load(&mut tx, &user, repo, number).await?;
    let mut acknowledged = Vec::new();
    let mut changed = false;
    for entry in update.entries {
        if entry.snapshot.len() != 64 || entry.proposal.command.version().len() != 64 {
            return Err(error(StatusCode::BAD_REQUEST, "invalidVersion"));
        }
        let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM review_versions WHERE user_id = ? AND repository_id = ? AND number = ? AND snapshot_id = ? AND version_id = ?)")
            .bind(&user).bind(repo).bind(number).bind(entry.snapshot).bind(entry.proposal.command.version()).fetch_one(&mut *tx).await.map_err(internal)?;
        if !valid {
            return Err(error(StatusCode::FORBIDDEN, "unknownSnapshotVersion"));
        }
        changed |= doc
            .accept(&entry.proposal)
            .map_err(|_| error(StatusCode::CONFLICT, "rejectedHistory"))?;
        acknowledged.push(entry.proposal.hash);
    }
    commit(
        tx,
        (user, repo, number),
        doc,
        revision,
        acknowledged,
        changed,
    )
    .await
}

pub(crate) async fn websocket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((repo, number)): Path<(i64, i64)>,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    check_origin(&state, &headers)?;
    authorize(&state, &headers, repo, number).await?;
    Ok(ws
        .max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| connection(socket, state, headers, repo, number)))
}

async fn poll(
    state: &AppState,
    headers: &HeaderMap,
    repo: i64,
    number: i64,
    last_revision: i64,
) -> ApiResult<Option<ReviewReceipt>> {
    let user = authorize(state, headers, repo, number).await?;
    let stored: Option<(i64, i64)> = sqlx::query_as("SELECT revision, schema_version FROM review_workspaces WHERE user_id = ? AND repository_id = ? AND number = ?")
        .bind(&user).bind(repo).bind(number).fetch_optional(&state.db).await.map_err(internal)?;
    if let Some((revision, schema)) = stored {
        if schema != i64::from(review_core::SCHEMA_VERSION) {
            return Err(error(StatusCode::CONFLICT, "upgradeRequired"));
        }
        if revision == last_revision {
            return Ok(None);
        }
    }
    discover(State(state.clone()), headers.clone(), Path((repo, number)))
        .await
        .map(|Json(receipt)| Some(receipt))
}

async fn connection(
    mut socket: WebSocket,
    state: AppState,
    headers: HeaderMap,
    repo: i64,
    number: i64,
) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(3));
    let mut last_revision = -1;
    loop {
        let result = tokio::select! {
            _ = tick.tick() => {
                match poll(&state, &headers, repo, number, last_revision).await {
                    Ok(None) => continue,
                    Ok(Some(receipt)) => Ok(receipt),
                    Err(e) => Err(e),
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => match serde_json::from_str::<ReviewUpdate>(&text) {
                        Ok(update) => apply_update(&state, &headers, repo, number, update).await,
                        Err(_) => Err(error(StatusCode::BAD_REQUEST, "invalidCommand")),
                    },
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
                    _ => break,
                }
            }
        };
        match result {
            Ok(receipt) => {
                last_revision = receipt.revision;
                let Ok(json) = serde_json::to_string(&receipt) else {
                    break;
                };
                if socket.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }
            Err((status, Json(err))) => {
                let json =
                    serde_json::json!({"error": err.error, "status": status.as_u16()}).to_string();
                let _ = socket.send(Message::Text(json.into())).await;
                break;
            }
        }
    }
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRequest {
    user_id: String,
    snapshot: String,
    version: String,
}

#[utoipa::path(post, path = "/api/review/{repository_id}/{number}/demo-agent",
    params(("repository_id" = i64, Path), ("number" = i64, Path)), request_body = AgentRequest,
    responses((status = 200, body = ReviewReceipt), (status = 401, body = ReviewError), (status = 403, body = ReviewError)))]
pub(crate) async fn fake_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((repo, number)): Path<(i64, i64)>,
    Json(request): Json<AgentRequest>,
) -> ApiResult<Json<ReviewReceipt>> {
    check_origin(&state, &headers)?;
    let user = authorize(&state, &headers, repo, number).await?;
    if request.user_id != user {
        return Err(error(StatusCode::FORBIDDEN, "accountChanged"));
    }
    let mut tx = state
        .db
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(internal)?;
    let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM review_versions WHERE user_id = ? AND repository_id = ? AND number = ? AND snapshot_id = ? AND version_id = ?)")
        .bind(&user).bind(repo).bind(number).bind(&request.snapshot).bind(&request.version).fetch_one(&mut *tx).await.map_err(internal)?;
    if !valid {
        return Err(error(StatusCode::FORBIDDEN, "unknownSnapshotVersion"));
    }
    let (mut doc, revision) = load(&mut tx, &user, repo, number).await?;
    let changed = submit_assessment(&mut doc, &request.version)
        .map_err(|_| error(StatusCode::CONFLICT, "assessmentRejected"))?;
    Ok(Json(
        commit(tx, (user, repo, number), doc, revision, vec![], changed).await?,
    ))
}

fn submit_assessment(doc: &mut Workspace, version: &str) -> review_core::Result<bool> {
    doc.apply(Capability::Agent, Command::Assess { contribution: Contribution {
        id: format!("demo:{version}"), version: version.into(), agent: "Kestrel demo agent".into(),
        run: format!("demo:{version}"), importance: Importance::Unimportant,
        evidence: vec![version.into()],
        context: format!("Demonstration assessment, not a code analysis. Bound to immutable file version {version}. Human importance decisions take precedence."),
    } })
}
