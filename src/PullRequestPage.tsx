import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";
import { useModel, send } from "./model";
import * as Repositories from "./repositoriesSlice";
import { apiUrl } from "./api/client";
import { Link } from "./Link";
import {
  ArrowLeftIcon,
  CheckIcon,
  GitHubIcon,
  HourglassIcon,
  MinusIcon,
  SyncIcon,
  XIcon,
} from "./icons/Icons";
import PullRequestsError from "./PullRequestError";

// TODO: Figure out a better way to handle all the error cases
const PullRequestPage = ({ repo, id }: { repo: string; id: string }) => {
  const repositories = useModel((model) => model.get("repositories"));

  if (repositories.status === "loading") {
    return (
      <PullRequestMessage title={repo}>
        <p>Loading repository...</p>
      </PullRequestMessage>
    );
  }

  if (repositories.status === "error") {
    return (
      <PullRequestMessage title={repo}>
        <p>Repositories could not be loaded.</p>
      </PullRequestMessage>
    );
  }

  const repository = repositories.repositories.find(
    (candidate) => candidate.fullName === repo.toLowerCase(),
  );
  if (repository === undefined) {
    return (
      <PullRequestMessage title={repo}>
        <p>Repository is not tracked.</p>
      </PullRequestMessage>
    );
  }

  const number = Number(id);
  if (!Number.isInteger(number) || number <= 0) {
    return (
      <PullRequestMessage title={repo}>
        <p>Pull request number is invalid.</p>
      </PullRequestMessage>
    );
  }

  const pullRequests = repositories.pullRequests.get(repository.fullName);
  if (pullRequests === undefined) {
    return (
      <PullRequestMessage title={`${repo} #${id}`}>
        <p>Loading pull requests...</p>
      </PullRequestMessage>
    );
  }

  if (pullRequests.status === "loading" || pullRequests.status === "syncing") {
    return (
      <PullRequestMessage title={`${repo} #${id}`}>
        <p>{pullRequests.status === "loading" ? "Loading" : "Syncing"} pull requests...</p>
      </PullRequestMessage>
    );
  }

  if (pullRequests.status === "error") {
    return (
      <PullRequestMessage title={`${repo} #${id}`}>
        <PullRequestsError error={pullRequests.error} />
      </PullRequestMessage>
    );
  }

  const pullRequest = pullRequests.pullRequests.find((candidate) => candidate.number === number);
  if (pullRequest === undefined) {
    return (
      <PullRequestMessage title={`${repo} #${id}`}>
        <p>Pull request is not stored yet.</p>
        <button
          onClick={() =>
            send({ kind: "Repositories", msg: { kind: "PullRequestsSyncRequested", repository } })
          }
          type="button"
        >
          Sync pull requests
        </button>
      </PullRequestMessage>
    );
  }

  const pullRequestDetail = repositories.pullRequestDetails.get(
    Repositories.pullRequestDetailKey(repository, number),
  );
  const details = getDetails(pullRequestDetail);

  return (
    <Tooltip.Provider>
      <div className="PullRequestPage">
        <aside aria-label="Pull request status" className="PullRequestPage-leftSidebar">
          <PullRequestActions
            detailState={pullRequestDetail}
            number={number}
            pullRequest={pullRequest}
            repository={repository}
          />
          <PullRequestReviewStatus details={details} />
          <PullRequestChecks details={details} />
        </aside>
        <section className="PullRequestPage-content">
          <h1 className="PullRequestPage-title">{pullRequest.title}</h1>
          <PullRequestDetailPanel
            detailState={pullRequestDetail}
            number={number}
            repository={repository}
          />
        </section>
        <aside aria-label="Pull request metadata" className="PullRequestPage-rightSidebar">
          <PullRequestMetadata pullRequest={pullRequest} repository={repository} />
          {details === undefined ? null : <PullRequestFiles files={details.files} />}
          {details === undefined ? null : <PullRequestCommits commits={details.commits} />}
        </aside>
      </div>
    </Tooltip.Provider>
  );
};

const PullRequestMessage = ({ children, title }: { children: ReactNode; title: string }) => (
  <section className="default-page page-card">
    <Link
      aria-label="Back to home"
      className="pr-page-back pr-sidebar-action"
      title="Back to home"
      to={{ name: "Home" }}
    >
      <ArrowLeftIcon />
    </Link>
    <h1>{title}</h1>
    {children}
  </section>
);

const PullRequestActions = ({
  detailState,
  number,
  pullRequest,
  repository,
}: {
  detailState: Repositories.PullRequestDetailState | undefined;
  number: number;
  pullRequest: Repositories.PullRequest;
  repository: Repositories.Repository;
}) => {
  const loading = detailState?.status === "loading";
  const loadingTimeline = detailState?.status === "loadingTimeline";
  const syncing = detailState?.status === "syncing";
  const syncedAt = detailState?.detail?.syncedAt;

  return (
    <nav aria-label="Pull request actions" className="pr-sidebar-actions">
      <Tooltip.Root>
        <Tooltip.Trigger
          aria-label="Back to home"
          closeOnClick={false}
          render={<Link className="pr-sidebar-action" to={{ name: "Home" }} />}
        >
          <ArrowLeftIcon />
        </Tooltip.Trigger>
        <PullRequestTooltip>Back to tracked repositories</PullRequestTooltip>
      </Tooltip.Root>
      <Tooltip.Root>
        <Tooltip.Trigger
          aria-label="Open on GitHub"
          closeOnClick={false}
          render={
            <a className="pr-sidebar-action" href={pullRequest.htmlUrl}>
              <GitHubIcon />
            </a>
          }
        />
        <PullRequestTooltip>Open this pull request on GitHub</PullRequestTooltip>
      </Tooltip.Root>
      <Tooltip.Root>
        <Tooltip.Trigger
          aria-busy={syncing}
          aria-label="Sync pull request from GitHub"
          closeOnClick={false}
          render={
            <button
              className="pr-sidebar-action"
              disabled={loading || loadingTimeline || syncing}
              onClick={() =>
                send({
                  kind: "Repositories",
                  msg: { kind: "PullRequestDetailSyncRequested", number, repository },
                })
              }
              type="button"
            />
          }
        >
          <SyncIcon className={syncing ? "pr-sidebar-sync-icon" : undefined} />
        </Tooltip.Trigger>
        <PullRequestTooltip>
          <span>Sync pull request from GitHub</span>
          <span className="pr-tooltip-secondary">
            Last synced: {syncedAt === undefined ? "Never" : formatLocalDateTime(syncedAt)}
          </span>
        </PullRequestTooltip>
      </Tooltip.Root>
    </nav>
  );
};

const PullRequestTooltip = ({ children }: { children: ReactNode }) => (
  <Tooltip.Portal keepMounted>
    <Tooltip.Positioner className="pr-tooltip-positioner" sideOffset={8}>
      <Tooltip.Popup className="pr-tooltip" role="tooltip">
        {children}
      </Tooltip.Popup>
    </Tooltip.Positioner>
  </Tooltip.Portal>
);

const getDetails = (details: Repositories.PullRequestDetailState | undefined) => {
  if (details === undefined) {
    return undefined;
  }
  if (details.detail !== null) {
    return details.detail;
  }
  return undefined;
};

const PullRequestDetailPanel = ({
  detailState,
  number,
  repository,
}: {
  detailState: Repositories.PullRequestDetailState | undefined;
  number: number;
  repository: Repositories.Repository;
}) => {
  if (detailState === undefined) {
    return <p className="repo-pr-status">Pull request details not loaded.</p>;
  }

  if (detailState.status === "loading") {
    return <p className="repo-pr-status">Loading pull request details...</p>;
  }

  if (detailState.status === "syncing") {
    return <p className="repo-pr-status">Syncing pull request details...</p>;
  }

  if (detailState.status === "error" && detailState.detail === null) {
    return <PullRequestDetailError error={detailState.error} />;
  }

  const detail = detailState.detail;
  if (detail === null) {
    return <p className="repo-pr-status">Pull request details not loaded.</p>;
  }

  return (
    <div className="pr-detail-sections">
      {detailState.status === "error" ? <PullRequestDetailError error={detailState.error} /> : null}
      <PullRequestDescription body={detail.body} />
      <PullRequestTimeline
        detailState={detailState}
        number={number}
        repository={repository}
        timeline={detail.timeline}
      />
    </div>
  );
};

const PullRequestDetailError = ({ error }: { error: Repositories.PullRequestsError }) => {
  switch (error) {
    case "authorizationRequired":
      return (
        <p className="repo-pr-status">
          GitHub App authorization required.{" "}
          <a href={apiUrl("/api/github-app/authorize")}>Authorize more repos</a>.
        </p>
      );
    case "pullRequestNotFound":
      return <p className="repo-pr-status">Pull request details are not stored yet.</p>;
    case "repositoryNotTracked":
      return <p className="repo-pr-status">Repository is not tracked.</p>;
    case "syncFailed":
      return <p className="repo-pr-status">Pull request details could not be loaded.</p>;
  }
};

const PullRequestFiles = ({ files }: { files: Repositories.PullRequestDetail["files"] }) => {
  return (
    <section className="pr-sidebar-section">
      <header className="pr-sidebar-header">
        <h2 className="pr-sidebar-title">Files changed</h2>
        <span className="pr-sidebar-count">{files.length}</span>
      </header>
      {files.length === 0 ? (
        <p className="pr-sidebar-empty">None stored.</p>
      ) : (
        <ul className="pr-sidebar-list">
          {files.map((file, index) => (
            <li className="pr-sidebar-data-row" key={index}>
              <span className="pr-sidebar-data-primary">{file.filename}</span>
              <span className="pr-sidebar-data-secondary">{file.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const PullRequestCommits = ({
  commits,
}: {
  commits: Repositories.PullRequestDetail["commits"];
}) => {
  return (
    <section className="pr-sidebar-section">
      <header className="pr-sidebar-header">
        <h2 className="pr-sidebar-title">Commits</h2>
        <span className="pr-sidebar-count">{commits.length}</span>
      </header>
      {commits.length === 0 ? (
        <p className="pr-sidebar-empty">None stored.</p>
      ) : (
        <ul className="pr-sidebar-list">
          {commits.map((commit, index) => (
            <li className="pr-sidebar-data-row" key={index}>
              <span className="pr-sidebar-data-primary">{commit.message}</span>
              <span className="pr-sidebar-data-secondary">{commit.sha.slice(0, 7)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const PullRequestDescription = ({ body }: { body?: string | null | undefined }) => {
  return (
    <section aria-label="Pull request description" className="pr-description">
      {body?.trim() ? <p>{body}</p> : <p className="repo-pr-status">No description provided.</p>}
    </section>
  );
};

const PullRequestTimeline = ({
  detailState,
  number,
  repository,
  timeline,
}: {
  detailState: Repositories.PullRequestDetailState;
  number: number;
  repository: Repositories.Repository;
  timeline: Repositories.PullRequestDetail["timeline"];
}) => {
  const loadingOlder = detailState.status === "loadingTimeline";
  const timelineError = detailState.status === "timelineError";
  const legacyTimeline = timeline.some(
    (event) => event.id === undefined && event.occurredAt === undefined,
  );

  return (
    <section
      aria-labelledby="pull-request-activity-heading"
      className="pr-detail-section pr-activity"
    >
      <header className="pr-activity-heading">
        <h2 id="pull-request-activity-heading">Activity</h2>
        <span className="repo-pr-meta">
          {legacyTimeline ? "Stored activity; sync to refresh" : "Newest first"}
        </span>
      </header>
      {timeline.length === 0 ? (
        <p className="repo-pr-status">No activity stored.</p>
      ) : (
        <ol className="pr-activity-list">
          {timeline.map((event, index) => (
            <PullRequestTimelineItem
              event={event}
              key={event.id ?? `${event.event}-${event.occurredAt ?? index}`}
            />
          ))}
        </ol>
      )}
      {timelineError ? (
        <p className="repo-pr-status" role="alert">
          Older activity could not be loaded. Try again.
        </p>
      ) : null}
      {detailState.detail?.timelineHasOlder ? (
        <button
          aria-busy={loadingOlder}
          className="pr-activity-load-older"
          disabled={loadingOlder}
          onClick={() =>
            send({
              kind: "Repositories",
              msg: { kind: "PullRequestTimelineOlderRequested", number, repository },
            })
          }
          type="button"
        >
          {loadingOlder ? "Loading older activity..." : "Load older activity"}
        </button>
      ) : null}
    </section>
  );
};

type TimelineEvent = Repositories.PullRequestDetail["timeline"][number];

const PullRequestTimelineItem = ({ event }: { event: TimelineEvent }) => {
  const action = timelineAction(event);
  const actor = event.actorLogin ?? "GitHub";
  const reviewComments = event.reviewComments ?? [];

  return (
    <li className="pr-activity-item">
      <div className="pr-activity-item-heading">
        <span>
          <strong>{actor}</strong>{" "}
          {event.url ? (
            <a href={event.url} rel="noreferrer" target="_blank">
              {action}
            </a>
          ) : (
            action
          )}
        </span>
        {event.occurredAt ? (
          <time className="repo-pr-meta" dateTime={event.occurredAt}>
            {formatLocalDateTime(event.occurredAt)}
          </time>
        ) : null}
      </div>
      {event.body ? <p className="pr-activity-body">{event.body}</p> : null}
      {reviewComments.length === 0 ? null : (
        <ul aria-label="Review comments" className="pr-activity-review-comments">
          {reviewComments.map((comment, index) => (
            <li key={comment.id ?? `${comment.actorLogin ?? "github"}-${index}`}>
              <div className="pr-activity-review-comment-heading">
                <strong>{comment.actorLogin ?? "GitHub"}</strong>
                {comment.occurredAt ? (
                  <time className="repo-pr-meta" dateTime={comment.occurredAt}>
                    {formatLocalDateTime(comment.occurredAt)}
                  </time>
                ) : null}
              </div>
              {comment.body ? <p className="pr-activity-body">{comment.body}</p> : null}
            </li>
          ))}
        </ul>
      )}
      {event.reviewCommentsHasMore ? (
        <p className="pr-activity-truncated">
          Additional review comments are available.{" "}
          {event.url ? (
            <a href={event.url} rel="noreferrer" target="_blank">
              View the complete review on GitHub
            </a>
          ) : (
            "Open the review on GitHub to see them."
          )}
        </p>
      ) : null}
    </li>
  );
};

const timelineAction = (event: TimelineEvent) => {
  switch (event.event) {
    case "commented":
      return "commented";
    case "committed":
      return event.commitSha ? `committed ${event.commitSha.slice(0, 7)}` : "committed";
    case "reviewed":
      return reviewAction(event.state);
    case "closed":
      return "closed the pull request";
    case "reopened":
      return "reopened the pull request";
    case "merged":
      return "merged the pull request";
    case "ready_for_review":
      return "marked the pull request ready for review";
    case "converted_to_draft":
      return "converted the pull request to draft";
    case "review_requested":
      return event.title ? `requested a review from ${event.title}` : "requested a review";
    case "review_request_removed":
      return event.title
        ? `removed the review request for ${event.title}`
        : "removed a review request";
    case "review_dismissed":
      return "dismissed a review";
    case "head_ref_force_pushed":
      return "force-pushed the head branch";
    case "base_ref_force_pushed":
      return "force-pushed the base branch";
    case "head_ref_deleted":
      return event.title ? `deleted the ${event.title} branch` : "deleted the head branch";
    case "head_ref_restored":
      return "restored the head branch";
    default:
      return event.title ? humanizeEvent(event.title) : humanizeEvent(event.event);
  }
};

const reviewAction = (state?: string | null | undefined) => {
  switch (state) {
    case "APPROVED":
      return "approved the pull request";
    case "CHANGES_REQUESTED":
      return "requested changes";
    case "COMMENTED":
      return "reviewed with comments";
    case "DISMISSED":
      return "submitted a dismissed review";
    default:
      return "submitted a review";
  }
};

const humanizeEvent = (event: string) => {
  const label = event
    .replace(/Event$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .trim()
    .toLowerCase();
  return label === "" ? "updated the pull request" : label;
};

const PullRequestChecks = ({ details }: { details: ReturnType<typeof getDetails> }) => {
  if (details === undefined) {
    return null;
  }
  const checkRuns = details.checkRuns;
  const statuses = details.statuses;
  const count = checkRuns.length + statuses.length;

  return (
    <section className="pr-sidebar-section">
      <header className="pr-sidebar-header">
        <h2 className="pr-sidebar-title">Checks</h2>
        <span className="pr-sidebar-count">{count}</span>
      </header>
      {count === 0 ? (
        <p className="pr-sidebar-empty">None stored.</p>
      ) : (
        <ul className="pr-sidebar-list">
          {checkRuns.map((check, index) => (
            <li className="pr-sidebar-item" key={`check-${index}`}>
              <PullRequestStatusIcon
                label={check.name}
                state={check.state}
                summary={check.summary}
                title={check.title}
                url={check.url}
              />
            </li>
          ))}
          {statuses.map((status, index) => (
            <li className="pr-sidebar-item" key={`status-${index}`}>
              <PullRequestStatusIcon
                description={status.description}
                label={status.context}
                state={status.state}
                url={status.url}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const PullRequestMetadata = ({
  pullRequest,
  repository,
}: {
  pullRequest: Repositories.PullRequest;
  repository: Repositories.Repository;
}) => {
  return (
    <section className="pr-sidebar-section pr-sidebar-metadata">
      <header className="pr-sidebar-header">
        <h2 className="pr-sidebar-title">Details</h2>
      </header>
      <dl className="pr-sidebar-metadata-list">
        <div className="pr-sidebar-metadata-item">
          <dt>Repository</dt>
          <dd>{repository.fullName}</dd>
        </div>
        <div className="pr-sidebar-metadata-item">
          <dt>Number</dt>
          <dd>#{pullRequest.number}</dd>
        </div>
        <div className="pr-sidebar-metadata-item">
          <dt>State</dt>
          <dd>{pullRequest.state}</dd>
        </div>
        <div className="pr-sidebar-metadata-item">
          <dt>Author</dt>
          <dd>{pullRequest.authorLogin ?? "Unknown"}</dd>
        </div>
        <div className="pr-sidebar-metadata-item">
          <dt>Updated</dt>
          <dd>
            <time className="pr-sidebar-time" dateTime={pullRequest.updatedAt}>
              {formatLocalDateTime(pullRequest.updatedAt)}
            </time>
          </dd>
        </div>
      </dl>
    </section>
  );
};

const PullRequestReviewStatus = ({ details }: { details: ReturnType<typeof getDetails> }) => {
  const decision = reviewDecisionPresentation(details);

  return (
    <section className="pr-sidebar-section pr-sidebar-review">
      <header className="pr-sidebar-header">
        <h2 className="pr-sidebar-title">Review status</h2>
      </header>
      <p className="pr-review-decision" data-status-kind={decision.kind}>
        <span className="pr-status-name" data-status-kind={decision.kind}>
          {decision.label}
        </span>
        <span className="pr-status-icon">
          {decision.kind === "success" ? <CheckIcon /> : null}
          {decision.kind === "failure" ? <XIcon /> : null}
          {decision.kind === "pending" ? <HourglassIcon /> : null}
          {decision.kind === "neutral" ? <MinusIcon /> : null}
        </span>
      </p>
    </section>
  );
};

const reviewDecisionPresentation = (
  details: ReturnType<typeof getDetails>,
): { kind: StatusKind; label: string } => {
  if (details === undefined) {
    return { kind: "neutral", label: "Not loaded" };
  }

  switch (details.reviewDecision) {
    case "APPROVED":
      return { kind: "success", label: "Approved" };
    case "CHANGES_REQUESTED":
      return { kind: "failure", label: "Changes requested" };
    case "REVIEW_REQUIRED":
      return { kind: "pending", label: "Review required" };
    case null:
    case undefined:
      return { kind: "neutral", label: "No decision" };
    default:
      return { kind: "neutral", label: statusLabel(details.reviewDecision) };
  }
};

const formatLocalDateTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
};

type StatusKind = "failure" | "neutral" | "pending" | "success";

const statusKind = (state: string): StatusKind => {
  switch (state.toLowerCase()) {
    case "success":
      return "success";
    case "pending":
    case "queued":
    case "in_progress":
    case "waiting":
    case "requested":
      return "pending";
    case "failure":
    case "error":
    case "cancelled":
    case "timed_out":
    case "action_required":
    case "startup_failure":
    case "stale":
      return "failure";
    case "neutral":
    case "skipped":
    default:
      return "neutral";
  }
};

const statusLabel = (state: string) => {
  const label = state.trim().replaceAll("_", " ").toLowerCase();
  return label === "" ? "Unknown" : label.charAt(0).toUpperCase() + label.slice(1);
};

const PullRequestStatusIcon = ({
  description,
  label,
  state,
  summary,
  title,
  url,
}: {
  description?: string | null | undefined;
  label: string;
  state: string;
  summary?: string | null | undefined;
  title?: string | null | undefined;
  url?: string | null | undefined;
}) => {
  const kind = statusKind(state);
  const accessibleState = statusLabel(state);
  const detail = description ?? summary;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        aria-label={`${label}: ${accessibleState}`}
        className="pr-status-trigger"
        closeOnClick={false}
        data-status-kind={kind}
        type="button"
      >
        <span className="pr-status-name">{label}</span>
        <span className="pr-status-icon">
          {kind === "success" ? <CheckIcon /> : null}
          {kind === "failure" ? <XIcon /> : null}
          {kind === "pending" ? <HourglassIcon /> : null}
          {kind === "neutral" ? <MinusIcon /> : null}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal keepMounted>
        <Tooltip.Positioner className="pr-tooltip-positioner" side="right" sideOffset={8}>
          <Tooltip.Popup className="pr-check-tooltip pr-tooltip" role="tooltip">
            <p className="pr-tooltip-title">{label}</p>
            <p className="pr-tooltip-state">{accessibleState}</p>
            {title ? <p className="pr-tooltip-detail-title">{title}</p> : null}
            {detail ? <p className="pr-tooltip-description">{detail}</p> : null}
            {url ? (
              <a className="pr-tooltip-link" href={url} rel="noreferrer" target="_blank">
                View run
              </a>
            ) : null}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
};

export default PullRequestPage;
