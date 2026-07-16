ALTER TABLE tracked_repositories ADD COLUMN pull_requests_sync_page INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tracked_repositories ADD COLUMN pull_requests_synced_at TEXT;
ALTER TABLE tracked_repositories ADD COLUMN pull_requests_sync_error TEXT;

CREATE TABLE tracked_repository_pull_requests (
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    number INTEGER NOT NULL,
    github_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
    draft INTEGER NOT NULL CHECK (draft IN (0, 1)),
    author_login TEXT,
    html_url TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    merged_at TEXT,
    synced_at TEXT NOT NULL,
    PRIMARY KEY (user_id, provider, owner, name, number),
    FOREIGN KEY (user_id, provider, owner, name) REFERENCES tracked_repositories(user_id, provider, owner, name) ON DELETE CASCADE
) STRICT;

CREATE INDEX tracked_repository_pull_requests_repo_idx ON tracked_repository_pull_requests(user_id, provider, owner, name);
CREATE INDEX tracked_repository_pull_requests_updated_at_idx ON tracked_repository_pull_requests(updated_at);
