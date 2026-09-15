use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use super::{
    fetch_github_diff, fetch_github_json, AppState, PullRequestDataError, PullRequestDiffFileDto,
};

#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewManifest {
    pub repository_id: String,
    pub snapshot_id: String,
    pub file_versions: Vec<Option<String>>,
}

#[derive(Deserialize, Serialize)]
pub(super) struct StoredManifest {
    raw_digest: String,
    objects: Vec<Option<FileIdentity>>,
    manifest: ReviewManifest,
}

#[derive(Deserialize)]
pub(super) struct Base {
    pub sha: String,
    pub repo: Repository,
}

#[derive(Deserialize)]
pub(super) struct Repository {
    id: u64,
}

#[derive(Deserialize)]
struct Compare {
    merge_base_commit: Object,
}

#[derive(Deserialize)]
struct Object {
    sha: String,
}

#[derive(Deserialize)]
struct Commit {
    tree: Object,
}

#[derive(Deserialize)]
struct Tree {
    truncated: bool,
    tree: Vec<Entry>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Entry {
    path: String,
    mode: String,
    sha: String,
}

#[derive(Deserialize, Serialize)]
struct FileIdentity {
    before: Option<Entry>,
    after: Option<Entry>,
}

pub(super) async fn fetch(
    state: &AppState,
    token: &str,
    repository_url: &str,
    base: &Base,
    head: &str,
) -> Result<(String, Option<String>), PullRequestDataError> {
    if !oid(&base.sha) || !oid(head) {
        return Err(PullRequestDataError::InvalidStoredData(
            "invalid Git comparison identity".into(),
        ));
    }
    // Both requests address the same immutable comparison, never the moving /pulls/N diff.
    let url = format!("{repository_url}/compare/{}...{head}", base.sha);
    let comparison: Compare = fetch_github_json(state, token, &url).await?;
    let raw = fetch_github_diff(state, token, &url).await?;
    if !oid(&comparison.merge_base_commit.sha) {
        return Ok((raw, None));
    }
    let before = tree(
        state,
        token,
        repository_url,
        &comparison.merge_base_commit.sha,
    )
    .await?;
    let after = tree(state, token, repository_url, head).await?;
    let manifest = build(base.repo.id, &raw, before, after);
    Ok((
        raw,
        manifest
            .map(|value| serde_json::to_string(&value))
            .transpose()?,
    ))
}

async fn tree(
    state: &AppState,
    token: &str,
    repo: &str,
    commit: &str,
) -> Result<Tree, PullRequestDataError> {
    let commit: Commit =
        fetch_github_json(state, token, &format!("{repo}/git/commits/{commit}")).await?;
    if !oid(&commit.tree.sha) {
        return Err(PullRequestDataError::InvalidStoredData(
            "invalid Git tree identity".into(),
        ));
    }
    fetch_github_json(
        state,
        token,
        &format!("{repo}/git/trees/{}?recursive=1", commit.tree.sha),
    )
    .await
}

fn build(repository: u64, raw: &str, before: Tree, after: Tree) -> Option<StoredManifest> {
    let incomplete = before.truncated || after.truncated;
    let before: HashMap<_, _> = before
        .tree
        .into_iter()
        .map(|entry| (entry.path.clone(), entry))
        .collect();
    let after: HashMap<_, _> = after
        .tree
        .into_iter()
        .map(|entry| (entry.path.clone(), entry))
        .collect();
    let files = crate::pull_request_diff::parse_pull_request_diff(raw).ok()?;
    let mut objects = Vec::with_capacity(files.len());
    let file_versions: Vec<_> = files
        .into_iter()
        .map(|file| {
            let dto = PullRequestDiffFileDto::from(file);
            let identity = if incomplete {
                None
            } else {
                identify(&dto, &before, &after)
            };
            let version = identity
                .as_ref()
                .and_then(|identity| fingerprint(&dto, identity));
            objects.push(identity);
            version
        })
        .collect();
    let raw_digest = digest(raw.as_bytes());
    let snapshot_digest = digest(
        &serde_json::to_vec(&(
            "kestrel-snapshot-v1",
            repository,
            &raw_digest,
            &file_versions,
        ))
        .ok()?,
    );
    Some(StoredManifest {
        raw_digest,
        objects,
        manifest: ReviewManifest {
            repository_id: format!("github:{repository}"),
            snapshot_id: format!("snapshot:v1:{snapshot_digest}"),
            file_versions,
        },
    })
}

pub(super) fn load(
    json: Option<&str>,
    raw: &str,
    files: &[PullRequestDiffFileDto],
) -> Option<ReviewManifest> {
    let stored: StoredManifest = serde_json::from_str(json?).ok()?;
    if stored.raw_digest != digest(raw.as_bytes())
        || stored.objects.len() != files.len()
        || stored.manifest.file_versions.len() != files.len()
    {
        return None;
    }
    for ((file, identity), version) in files
        .iter()
        .zip(&stored.objects)
        .zip(&stored.manifest.file_versions)
    {
        if identity
            .as_ref()
            .and_then(|identity| fingerprint(file, identity))
            != *version
        {
            return None;
        }
    }
    Some(stored.manifest)
}

fn identify(
    file: &PullRequestDiffFileDto,
    before: &HashMap<String, Entry>,
    after: &HashMap<String, Entry>,
) -> Option<FileIdentity> {
    use super::PullRequestDiffFileOperationDto::*;
    let (old, new) = match &file.operation {
        Added { path, .. } if before.get(path).is_none_or(|entry| entry.mode == "040000") => {
            (None, Some(after.get(path)?))
        }
        Deleted { path, .. } if after.get(path).is_none_or(|entry| entry.mode == "040000") => {
            (Some(before.get(path)?), None)
        }
        Modified { path, .. } => (Some(before.get(path)?), Some(after.get(path)?)),
        Renamed {
            old_path, new_path, ..
        }
        | Copied {
            old_path, new_path, ..
        } => (Some(before.get(old_path)?), Some(after.get(new_path)?)),
        _ => return None,
    };
    if [old, new].into_iter().flatten().any(|entry| {
        !oid(&entry.sha)
            || !matches!(
                entry.mode.as_str(),
                "100644" | "100755" | "120000" | "160000"
            )
    }) {
        return None;
    }
    Some(FileIdentity {
        before: old.cloned(),
        after: new.cloned(),
    })
}

fn fingerprint(file: &PullRequestDiffFileDto, identity: &FileIdentity) -> Option<String> {
    let canonical = serde_json::to_vec(&(
        "kestrel-file-v1",
        "sha1",
        &identity.before,
        &identity.after,
        file,
    ))
    .ok()?;
    Some(format!("file:v1:{}", digest(&canonical)))
}

fn oid(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    const RAW: &str = "diff --git a/file.txt b/file.txt\nindex 1111111..2222222 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";

    fn trees(blob: char, mode: &str) -> Tree {
        Tree {
            truncated: false,
            tree: vec![Entry {
                path: "file.txt".into(),
                mode: mode.into(),
                sha: blob.to_string().repeat(40),
            }],
        }
    }

    fn version(raw: &str, blob: char, mode: &str) -> String {
        build(42, raw, trees('1', "100644"), trees(blob, mode))
            .unwrap()
            .manifest
            .file_versions[0]
            .clone()
            .unwrap()
    }

    #[test]
    fn versions_include_complete_objects_modes_and_hunks_not_pr_head() {
        let first = version(RAW, '2', "100644");
        assert_eq!(first, version(RAW, '2', "100644"));
        assert_ne!(first, version(RAW, '3', "100644"));
        assert_ne!(first, version(RAW, '2', "100755"));
        assert_ne!(
            first,
            version(&RAW.replace("+new", "+different"), '2', "100644")
        );
        assert_ne!(
            first,
            version(&RAW.replace("@@ -1 +1 @@", "@@ -2 +2 @@"), '2', "100644")
        );
        assert_ne!(
            first,
            version(
                &RAW.replace("+new\n", "+new\n\\ No newline at end of file\n"),
                '2',
                "100644"
            )
        );
    }

    #[test]
    fn binary_identity_uses_full_objects_and_ignores_other_files() {
        let raw = "diff --git a/file.txt b/file.txt\nindex 1111111..2222222 100644\nBinary files a/file.txt and b/file.txt differ\n";
        assert_ne!(version(raw, '2', "100644"), version(raw, '3', "100644"));
        let mut after = trees('2', "100644");
        after.tree.push(Entry {
            path: "unrelated".into(),
            mode: "100644".into(),
            sha: "f".repeat(40),
        });
        assert_eq!(
            version(raw, '2', "100644"),
            build(42, raw, trees('1', "100644"), after)
                .unwrap()
                .manifest
                .file_versions[0]
                .clone()
                .unwrap()
        );
    }

    #[test]
    fn absent_sides_paths_copies_symlinks_and_gitlinks_have_distinct_identities() {
        let added = "diff --git a/file.txt b/file.txt\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/file.txt\n@@ -0,0 +1 @@\n+new\n";
        let deleted = "diff --git a/file.txt b/file.txt\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/file.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n";
        let empty = || Tree {
            truncated: false,
            tree: vec![],
        };
        let add = build(42, added, empty(), trees('2', "100644")).unwrap();
        let delete = build(42, deleted, trees('1', "100644"), empty()).unwrap();
        assert!(add.objects[0].as_ref().unwrap().before.is_none());
        assert!(delete.objects[0].as_ref().unwrap().after.is_none());
        assert_ne!(add.manifest.file_versions, delete.manifest.file_versions);
        let renamed = "diff --git a/file.txt b/moved.txt\nsimilarity index 100%\nrename from file.txt\nrename to moved.txt\n";
        let mut moved = trees('1', "100644");
        moved.tree[0].path = "moved.txt".into();
        let rename = build(42, renamed, trees('1', "100644"), moved).unwrap();
        let mut copied = trees('1', "100644");
        copied.tree.push(Entry {
            path: "moved.txt".into(),
            mode: "100644".into(),
            sha: "1".repeat(40),
        });
        let copy = build(
            42,
            &renamed.replace("rename", "copy"),
            trees('1', "100644"),
            copied,
        )
        .unwrap();
        assert!(rename.manifest.file_versions[0].is_some());
        assert!(copy.manifest.file_versions[0].is_some());
        assert_ne!(rename.manifest.file_versions, copy.manifest.file_versions);
        let regular = version(RAW, '2', "100644");
        assert_ne!(regular, version(RAW, '2', "120000"));
        assert_ne!(regular, version(RAW, '2', "160000"));
        assert_eq!(
            regular,
            version(
                &RAW.replace("1111111..2222222", "1111111111..2222222222"),
                '2',
                "100644"
            )
        );
    }

    #[test]
    fn incomplete_identity_and_mismatched_snapshot_never_reuse_marks() {
        let mut after = trees('2', "100644");
        after.truncated = true;
        assert!(build(42, RAW, trees('1', "100644"), after)
            .unwrap()
            .manifest
            .file_versions[0]
            .is_none());
        let stored = build(42, RAW, trees('1', "100644"), trees('2', "100644")).unwrap();
        let json = serde_json::to_string(&stored).unwrap();
        let mut files: Vec<_> = crate::pull_request_diff::parse_pull_request_diff(RAW)
            .unwrap()
            .into_iter()
            .map(PullRequestDiffFileDto::from)
            .collect();
        assert!(load(Some(&json), RAW, &files).is_some());
        assert!(load(Some(&json), &RAW.replace("new", "changed"), &files).is_none());
        assert!(load(Some(&json), RAW, &[]).is_none());
        assert!(load(None, RAW, &files).is_none());
        files[0].additions += 1;
        assert!(
            load(Some(&json), RAW, &files).is_none(),
            "parser/schema changes cannot reuse incompatible identities"
        );
        let missing = Tree {
            truncated: false,
            tree: vec![],
        };
        assert!(build(42, RAW, missing, trees('2', "100644"))
            .unwrap()
            .manifest
            .file_versions[0]
            .is_none());
    }
}
