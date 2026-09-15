ALTER TABLE tracked_repository_pull_request_details ADD COLUMN review_snapshot_json TEXT;

CREATE TABLE review_workspaces (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id INTEGER NOT NULL,
    number INTEGER NOT NULL CHECK(number > 0),
    schema_version INTEGER NOT NULL,
    document BLOB NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(user_id, repository_id, number)
) STRICT;

CREATE TABLE review_snapshots (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id INTEGER NOT NULL,
    number INTEGER NOT NULL,
    snapshot_id TEXT NOT NULL,
    manifest TEXT NOT NULL,
    diff TEXT NOT NULL,
    PRIMARY KEY(user_id, repository_id, number, snapshot_id)
) STRICT;

CREATE TABLE review_versions (
    user_id TEXT NOT NULL,
    repository_id INTEGER NOT NULL,
    number INTEGER NOT NULL,
    snapshot_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    PRIMARY KEY(user_id, repository_id, number, snapshot_id, version_id),
    FOREIGN KEY(user_id, repository_id, number, snapshot_id)
        REFERENCES review_snapshots(user_id, repository_id, number, snapshot_id) ON DELETE CASCADE
) STRICT;
