CREATE TABLE tracked_repository_pull_request_details_normalized (
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    number INTEGER NOT NULL,
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

INSERT INTO tracked_repository_pull_request_details_normalized (
    user_id,
    provider,
    owner,
    name,
    number,
    files_json,
    commits_json,
    reviews_json,
    review_comments_json,
    issue_comments_json,
    timeline_json,
    check_runs_json,
    statuses_json,
    diff,
    synced_at
)
SELECT
    detail.user_id,
    detail.provider,
    detail.owner,
    detail.name,
    detail.number,
    COALESCE((
        SELECT json_group_array(json_object(
            'filename', json_extract(file.value, '$.filename'),
            'status', json_extract(file.value, '$.status')
        ))
        FROM json_each(detail.files_json) AS file
    ), '[]'),
    COALESCE((
        SELECT json_group_array(json_object(
            'message', json_extract(commit_entry.value, '$.commit.message'),
            'sha', json_extract(commit_entry.value, '$.sha')
        ))
        FROM json_each(detail.commits_json) AS commit_entry
    ), '[]'),
    COALESCE((
        SELECT json_group_array(json_object(
            'authorLogin', json_extract(review.value, '$.user.login'),
            'state', json_extract(review.value, '$.state')
        ))
        FROM json_each(detail.reviews_json) AS review
    ), '[]'),
    COALESCE((
        SELECT json_group_array(json_object(
            'authorLogin', json_extract(comment.value, '$.user.login'),
            'body', json_extract(comment.value, '$.body')
        ))
        FROM json_each(detail.review_comments_json) AS comment
    ), '[]'),
    COALESCE((
        SELECT json_group_array(json_object(
            'authorLogin', json_extract(comment.value, '$.user.login'),
            'body', json_extract(comment.value, '$.body')
        ))
        FROM json_each(detail.issue_comments_json) AS comment
    ), '[]'),
    COALESCE((
        SELECT json_group_array(json_object(
            'actorLogin', json_extract(timeline_event.value, '$.actor.login'),
            'event', json_extract(timeline_event.value, '$.event')
        ))
        FROM json_each(detail.timeline_json) AS timeline_event
    ), '[]'),
    COALESCE((
        SELECT json_group_array(json_object(
            'name', json_extract(check_run.value, '$.name'),
            'state', COALESCE(
                json_extract(check_run.value, '$.conclusion'),
                json_extract(check_run.value, '$.status')
            )
        ))
        FROM json_each(detail.check_runs_json, '$.check_runs') AS check_run
    ), '[]'),
    COALESCE((
        SELECT json_group_array(json_object(
            'context', json_extract(status.value, '$.context'),
            'state', json_extract(status.value, '$.state')
        ))
        FROM json_each(detail.statuses_json, '$.statuses') AS status
    ), '[]'),
    detail.diff,
    detail.synced_at
FROM tracked_repository_pull_request_details AS detail;

DROP INDEX tracked_repository_pull_request_details_repo_idx;
DROP TABLE tracked_repository_pull_request_details;
ALTER TABLE tracked_repository_pull_request_details_normalized RENAME TO tracked_repository_pull_request_details;

CREATE INDEX tracked_repository_pull_request_details_repo_idx ON tracked_repository_pull_request_details(user_id, provider, owner, name);
