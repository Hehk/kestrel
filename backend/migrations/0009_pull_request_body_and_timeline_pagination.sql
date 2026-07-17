ALTER TABLE tracked_repository_pull_request_details ADD COLUMN body TEXT;
ALTER TABLE tracked_repository_pull_request_details ADD COLUMN timeline_cursor TEXT;
ALTER TABLE tracked_repository_pull_request_details ADD COLUMN timeline_has_older INTEGER NOT NULL DEFAULT 0 CHECK (timeline_has_older IN (0, 1));
