use crate::{
    http::AppState,
    pull_request_diff,
    pull_requests::{
        fetch_github_diff, fetch_github_json, PullRequestDataError, PullRequestDiffFileDto,
        PullRequestDiffFileOperationDto,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use utoipa::ToSchema;

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSnapshot {
    pub hash_algorithm: String,
    pub base_commit: String,
    pub head_commit: String,
    pub merge_base_commit: String,
    pub id: String,
    pub repository_id: i64,
    pub files: Vec<ReviewVersion>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewVersion {
    pub before: Option<ObjectIdentity>,
    pub after: Option<ObjectIdentity>,
    pub id: String,
    pub path: String,
    pub predecessor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct ObjectIdentity {
    path: String,
    sha: String,
    mode: String,
}
#[derive(Deserialize)]
struct Commit {
    tree: ObjectRef,
}
#[derive(Deserialize)]
struct ObjectRef {
    sha: String,
}
#[derive(Deserialize)]
struct Comparison {
    merge_base_commit: ObjectRef,
}
#[derive(Clone, Deserialize)]
struct Tree {
    tree: Vec<Entry>,
    #[serde(default)]
    truncated: bool,
}
#[derive(Clone, Deserialize)]
struct Entry {
    path: String,
    sha: String,
    mode: String,
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) async fn fetch(
    state: &AppState,
    token: &str,
    repository: &str,
    repository_id: i64,
    base: &str,
    head: &str,
) -> Result<(String, ReviewSnapshot), PullRequestDataError> {
    for sha in [base, head] {
        if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid("invalid Git object identity"));
        }
    }
    let url = format!(
        "{}/repos/{repository}",
        state.config.github_api_url.trim_end_matches('/')
    );
    let comparison_url = format!("{url}/compare/{base}...{head}");
    let comparison: Comparison = fetch_github_json(state, token, &comparison_url).await?;
    let diff = fetch_github_diff(state, token, &comparison_url).await?;
    let files = pull_request_diff::parse_pull_request_diff(&diff)
        .map_err(|_| invalid("comparison diff is invalid"))?
        .into_iter()
        .map(PullRequestDiffFileDto::from)
        .collect::<Vec<_>>();
    let before: Commit = fetch_github_json(
        state,
        token,
        &format!("{url}/git/commits/{}", comparison.merge_base_commit.sha),
    )
    .await?;
    let after: Commit =
        fetch_github_json(state, token, &format!("{url}/git/commits/{head}")).await?;
    let mut trees = HashMap::new();
    let mut versions = Vec::new();
    for file in &files {
        let (old_path, new_path) = paths(file);
        let old = object_at(state, token, &url, &before.tree.sha, old_path, &mut trees).await?;
        let new = object_at(state, token, &url, &after.tree.sha, new_path, &mut trees).await?;
        versions.push(ReviewVersion {
            id: fingerprint(file, old.clone(), new.clone())?,
            before: old,
            after: new,
            path: new_path.or(old_path).unwrap_or_default().into(),
            predecessor: None,
        });
    }
    let id = digest(&serde_json::to_vec(&(
        "kestrel-snapshot-v1",
        repository_id,
        base,
        head,
        &comparison.merge_base_commit.sha,
        &versions,
    ))?);
    Ok((
        diff,
        ReviewSnapshot {
            hash_algorithm: "sha1".into(),
            base_commit: base.into(),
            head_commit: head.into(),
            merge_base_commit: comparison.merge_base_commit.sha,
            id,
            repository_id,
            files: versions,
        },
    ))
}

async fn object_at(
    state: &AppState,
    token: &str,
    url: &str,
    root: &str,
    path: Option<&str>,
    trees: &mut HashMap<String, Tree>,
) -> Result<Option<ObjectIdentity>, PullRequestDataError> {
    let Some(path) = path else {
        return Ok(None);
    };
    let mut sha = root.to_owned();
    let parts = path.split('/').collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        if !trees.contains_key(&sha) {
            let tree: Tree =
                fetch_github_json(state, token, &format!("{url}/git/trees/{sha}")).await?;
            if tree.truncated {
                return Err(invalid("Git tree is truncated"));
            }
            trees.insert(sha.clone(), tree);
        }
        let entry = trees[&sha]
            .tree
            .iter()
            .find(|entry| entry.path == *part)
            .ok_or_else(|| invalid("comparison path is missing from its immutable tree"))?;
        if index == parts.len() - 1 {
            if entry.sha.len() != 40
                || !entry.sha.bytes().all(|b| b.is_ascii_hexdigit())
                || !["100644", "100755", "120000", "160000"].contains(&entry.mode.as_str())
            {
                return Err(invalid("unsupported Git object"));
            }
            return Ok(Some(ObjectIdentity {
                path: path.into(),
                sha: entry.sha.clone(),
                mode: entry.mode.clone(),
            }));
        }
        if entry.mode != "040000" {
            return Err(invalid("expected a Git tree"));
        }
        sha = entry.sha.clone();
    }
    Err(invalid("invalid path"))
}

fn fingerprint(
    file: &PullRequestDiffFileDto,
    before: Option<ObjectIdentity>,
    after: Option<ObjectIdentity>,
) -> Result<String, serde_json::Error> {
    let (old_path, new_path) = paths(file);
    let operation = match &file.operation {
        PullRequestDiffFileOperationDto::Added { .. } => "added",
        PullRequestDiffFileOperationDto::Deleted { .. } => "deleted",
        PullRequestDiffFileOperationDto::Modified { .. } => "modified",
        PullRequestDiffFileOperationDto::Renamed { .. } => "renamed",
        PullRequestDiffFileOperationDto::Copied { .. } => "copied",
    };
    Ok(digest(&serde_json::to_vec(&(
        "kestrel-file-version-v1",
        "sha1",
        old_path,
        new_path,
        before,
        after,
        operation,
        &file.content,
    ))?))
}

fn paths(file: &PullRequestDiffFileDto) -> (Option<&str>, Option<&str>) {
    match &file.operation {
        PullRequestDiffFileOperationDto::Added { path, .. } => (None, Some(path)),
        PullRequestDiffFileOperationDto::Deleted { path, .. } => (Some(path), None),
        PullRequestDiffFileOperationDto::Modified { path, .. } => (Some(path), Some(path)),
        PullRequestDiffFileOperationDto::Renamed {
            old_path, new_path, ..
        }
        | PullRequestDiffFileOperationDto::Copied {
            old_path, new_path, ..
        } => (Some(old_path), Some(new_path)),
    }
}

pub(crate) fn lineage(current: &mut ReviewSnapshot, previous: &ReviewSnapshot, raw: &str) {
    if current.repository_id != previous.repository_id {
        return;
    }
    let Ok(parsed) = pull_request_diff::parse_pull_request_diff(raw) else {
        return;
    };
    for (version, file) in current
        .files
        .iter_mut()
        .zip(parsed.into_iter().map(PullRequestDiffFileDto::from))
    {
        if let Some(unchanged) = previous.files.iter().find(|entry| entry.id == version.id) {
            version.predecessor.clone_from(&unchanged.predecessor);
            continue;
        }
        // Only explicit modify/rename operations carry lineage. Adds and copies are new entries.
        let old = match &file.operation {
            PullRequestDiffFileOperationDto::Modified { path, .. } => Some(path),
            PullRequestDiffFileOperationDto::Renamed { old_path, .. } => Some(old_path),
            _ => None,
        };
        let mut candidates = previous
            .files
            .iter()
            .filter(|entry| Some(&entry.path) == old);
        if let Some(predecessor) = candidates.next() {
            if candidates.next().is_none() && predecessor.id != version.id {
                version.predecessor = Some(predecessor.id.clone());
            }
        }
    }
}

fn invalid(message: &str) -> PullRequestDataError {
    PullRequestDataError::InvalidStoredData(message.into())
}

#[cfg(test)]
#[path = "review_snapshot_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "review_snapshot_http_tests.rs"]
mod http_tests;
