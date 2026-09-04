UPDATE tracked_repositories
SET pull_requests_sync_error = CASE pull_requests_sync_error
  WHEN 'authentication_required' THEN 'authenticationRequired'
  WHEN 'authorization_required' THEN 'authorizationRequired'
  WHEN 'diff_parse_failed' THEN 'diffParseFailed'
  WHEN 'diff_resource_limit_exceeded' THEN 'diffResourceLimitExceeded'
  WHEN 'diff_unavailable' THEN 'diffUnavailable'
  WHEN 'invalid_pull_request' THEN 'invalidPullRequest'
  WHEN 'invalid_repository' THEN 'invalidRepository'
  WHEN 'pull_request_not_found' THEN 'pullRequestNotFound'
  WHEN 'repository_not_tracked' THEN 'repositoryNotTracked'
  WHEN 'sync_failed' THEN 'syncFailed'
  ELSE pull_requests_sync_error
END
WHERE pull_requests_sync_error IS NOT NULL;
