CREATE TABLE tracked_repository_pull_request_details (
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    number INTEGER NOT NULL,
    pull_request_json TEXT NOT NULL,
    files_json TEXT NOT NULL,
    commits_json TEXT NOT NULL,
    reviews_json TEXT NOT NULL,
    review_comments_json TEXT NOT NULL,
    issue_comments_json TEXT NOT NULL,
    timeline_json TEXT NOT NULL,
    check_runs_json TEXT NOT NULL,
    statuses_json TEXT NOT NULL,
    diff TEXT,
    synced_at TEXT NOT NULL,
    PRIMARY KEY (user_id, provider, owner, name, number),
    FOREIGN KEY (user_id, provider, owner, name) REFERENCES tracked_repositories(user_id, provider, owner, name) ON DELETE CASCADE
) STRICT;

CREATE INDEX tracked_repository_pull_request_details_repo_idx ON tracked_repository_pull_request_details(user_id, provider, owner, name);
