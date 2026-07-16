import { Popover } from "@base-ui/react/popover";
import type { ReactNode } from "react";
import { useModel, send } from "./model";
import * as Repositories from "./repositoriesSlice";
import { apiUrl } from "./api/client";
import { CheckIcon, HourglassIcon, MinusIcon, XIcon } from "./icons/Icons";
import PullRequestsError from "./PullRequestError";

// TODO: Figure out a better way to handle all the error cases
const PullRequestPage = ({ repo, id }: { repo: string; id: string }) => {
  const repositories = useModel((model) => model.get("repositories"));

  if (repositories.status === "loading") {
    return (
      <section className="default-page page-card">
        <h1>{repo}</h1>
        <p>Loading repository...</p>
      </section>
    );
  }

  if (repositories.status === "error") {
    return (
      <section className="default-page page-card">
        <h1>{repo}</h1>
        <p>Repositories could not be loaded.</p>
      </section>
    );
  }

  const repository = repositories.repositories.find(
    (candidate) => candidate.fullName === repo.toLowerCase(),
  );
  if (repository === undefined) {
    return (
      <section className="default-page page-card">
        <h1>{repo}</h1>
        <p>Repository is not tracked.</p>
      </section>
    );
  }

  const number = Number(id);
  if (!Number.isInteger(number) || number <= 0) {
    return (
      <section className="default-page page-card">
        <h1>{repo}</h1>
        <p>Pull request number is invalid.</p>
      </section>
    );
  }

  const pullRequests = repositories.pullRequests.get(repository.fullName);
  if (pullRequests === undefined) {
    return (
      <section className="default-page page-card">
        <h1>
          {repo} #{id}
        </h1>
        <p>Loading pull requests...</p>
      </section>
    );
  }

  if (pullRequests.status === "loading" || pullRequests.status === "syncing") {
    return (
      <section className="default-page page-card">
        <h1>
          {repo} #{id}
        </h1>
        <p>{pullRequests.status === "loading" ? "Loading" : "Syncing"} pull requests...</p>
      </section>
    );
  }

  if (pullRequests.status === "error") {
    return (
      <section className="default-page page-card">
        <h1>
          {repo} #{id}
        </h1>
        <PullRequestsError error={pullRequests.error} />
      </section>
    );
  }

  const pullRequest = pullRequests.pullRequests.find((candidate) => candidate.number === number);
  if (pullRequest === undefined) {
    return (
      <section className="default-page page-card">
        <h1>
          {repo} #{id}
        </h1>
        <p>Pull request is not stored yet.</p>
        <button
          onClick={() =>
            send({ kind: "Repositories", msg: { kind: "PullRequestsSyncRequested", repository } })
          }
          type="button"
        >
          Sync pull requests
        </button>
      </section>
    );
  }

  const pullRequestDetail = repositories.pullRequestDetails.get(
    Repositories.pullRequestDetailKey(repository, number),
  );
  const details = getDetails(pullRequestDetail);

  return (
    <div className="PullRequestPage">
      <aside aria-label="Pull request status" className="PullRequestPage-leftSidebar">
        <PullRequestChecks details={details} />
        <PullRequestReviewStatus details={details} />
      </aside>
      <section className="PullRequestPage-content">
        <h1 className="PullRequestPage-title">{pullRequest.title}</h1>
        <p>
          <a href={pullRequest.htmlUrl}>Open on GitHub</a>
        </p>
        <div className="pr-detail-actions">
          <button
            disabled={
              pullRequestDetail?.status === "loading" || pullRequestDetail?.status === "syncing"
            }
            onClick={() =>
              send({
                kind: "Repositories",
                msg: { kind: "PullRequestDetailLoadRequested", number, repository },
              })
            }
            type="button"
          >
            Load stored details
          </button>
          <button
            disabled={
              pullRequestDetail?.status === "loading" || pullRequestDetail?.status === "syncing"
            }
            onClick={() =>
              send({
                kind: "Repositories",
                msg: { kind: "PullRequestDetailSyncRequested", number, repository },
              })
            }
            type="button"
          >
            {pullRequestDetail?.status === "syncing" ? "Syncing details..." : "Sync details"}
          </button>
        </div>
        <PullRequestDetailPanel detailState={pullRequestDetail} />
      </section>
      <aside aria-label="Pull request metadata" className="PullRequestPage-rightSidebar">
        <PullRequestMetadata pullRequest={pullRequest} repository={repository} />
        {details === undefined ? null : <PullRequestFiles files={details.files} />}
        {details === undefined ? null : <PullRequestCommits commits={details.commits} />}
      </aside>
    </div>
  );
};

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
}: {
  detailState: Repositories.PullRequestDetailState | undefined;
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
      <p className="repo-pr-status">Details synced: {detail.syncedAt}</p>
      <PullRequestComments title="Review comments" comments={detail.reviewComments} />
      <PullRequestComments title="Conversation comments" comments={detail.issueComments} />
      <PullRequestTimeline timeline={detail.timeline} />
      <PullRequestDiff diff={detail.diff} />
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

const PullRequestComments = ({
  comments,
  title,
}: {
  comments: Repositories.PullRequestDetail["issueComments"];
  title: string;
}) => {
  return (
    <PullRequestSection count={comments.length} title={title}>
      <ul className="pr-detail-list">
        {comments.map((comment, index) => (
          <li key={index}>
            <span>{comment.body ?? "Comment"}</span>
            <span className="repo-pr-meta">{comment.authorLogin ?? "unknown"}</span>
          </li>
        ))}
      </ul>
    </PullRequestSection>
  );
};

const PullRequestTimeline = ({
  timeline,
}: {
  timeline: Repositories.PullRequestDetail["timeline"];
}) => {
  return (
    <PullRequestSection count={timeline.length} title="Timeline">
      <ul className="pr-detail-list">
        {timeline.map((event, index) => (
          <li key={index}>
            <span>{event.event}</span>
            <span className="repo-pr-meta">{event.actorLogin ?? "GitHub"}</span>
          </li>
        ))}
      </ul>
    </PullRequestSection>
  );
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
    <Popover.Root>
      <Popover.Trigger
        aria-label={`${label}: ${accessibleState}. Show run details`}
        className="pr-status-trigger"
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
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="pr-status-positioner" side="right" sideOffset={8}>
          <Popover.Popup className="pr-status-popover">
            <Popover.Title className="pr-status-popover-title">{label}</Popover.Title>
            <p className="pr-status-popover-state">{accessibleState}</p>
            {title ? <p className="pr-status-popover-detail-title">{title}</p> : null}
            {detail ? (
              <Popover.Description className="pr-status-popover-description">
                {detail}
              </Popover.Description>
            ) : null}
            {url ? (
              <a className="pr-status-popover-link" href={url} rel="noreferrer" target="_blank">
                View run
              </a>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

const PullRequestDiff = ({ diff }: { diff?: string | null | undefined }) => {
  return (
    <PullRequestSection title="Diff">
      {diff ? (
        <pre className="pr-diff">{diff}</pre>
      ) : (
        <p className="repo-pr-status">No diff stored.</p>
      )}
    </PullRequestSection>
  );
};

const PullRequestSection = ({
  children,
  count,
  title,
}: {
  children: ReactNode;
  count?: number;
  title: string;
}) => {
  return (
    <section className="pr-detail-section">
      <h2>
        {title}
        {count === undefined ? null : <span className="repo-pr-meta"> {count}</span>}
      </h2>
      {count === 0 ? <p className="repo-pr-status">None stored.</p> : children}
    </section>
  );
};

export default PullRequestPage;
