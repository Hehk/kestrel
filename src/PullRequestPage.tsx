import { Tooltip } from "@kobalte/core/tooltip";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import type { Accessor, JSX, ParentProps } from "solid-js";
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
  const repositories = useModel((model) => model.repositories);
  const page = createMemo<PullRequestPageData | PullRequestMessageData>(() => {
    const state = repositories();

    if (state.status === "loading") {
      return { content: <p>Loading repository...</p>, kind: "message", title: repo };
    }

    if (state.status === "error") {
      return { content: <p>Repositories could not be loaded.</p>, kind: "message", title: repo };
    }

    const repository = state.repositories.find(
      (candidate) => candidate.fullName === repo.toLowerCase(),
    );
    if (repository === undefined) {
      return { content: <p>Repository is not tracked.</p>, kind: "message", title: repo };
    }

    const number = Number(id);
    if (!Number.isInteger(number) || number <= 0) {
      return { content: <p>Pull request number is invalid.</p>, kind: "message", title: repo };
    }

    const pullRequests = state.pullRequests[repository.fullName];
    if (pullRequests === undefined) {
      return {
        content: <p>Loading pull requests...</p>,
        kind: "message",
        title: `${repo} #${id}`,
      };
    }

    if (pullRequests.status === "loading" || pullRequests.status === "syncing") {
      return {
        content: (
          <p>{pullRequests.status === "loading" ? "Loading" : "Syncing"} pull requests...</p>
        ),
        kind: "message",
        title: `${repo} #${id}`,
      };
    }

    if (pullRequests.status === "error") {
      return {
        content: <PullRequestsError error={pullRequests.error} />,
        kind: "message",
        title: `${repo} #${id}`,
      };
    }

    const pullRequest = pullRequests.pullRequests.find((candidate) => candidate.number === number);
    if (pullRequest === undefined) {
      return {
        content: (
          <>
          <p>Pull request is not stored yet.</p>
          <button
            onClick={() =>
              send({ kind: "Repositories", msg: { kind: "PullRequestsSyncRequested", repository } })
            }
            type="button"
          >
            Sync pull requests
          </button>
          </>
        ),
        kind: "message",
        title: `${repo} #${id}`,
      };
    }

    const pullRequestDetail =
      state.pullRequestDetails[Repositories.pullRequestDetailKey(repository, number)];
    return { kind: "ready", number, pullRequest, pullRequestDetail, repository };
  });

  const ready = () => (page().kind === "ready" ? (page() as PullRequestPageData) : undefined);
  const message = () =>
    page().kind === "message" ? (page() as PullRequestMessageData) : undefined;

  return (
    <Switch>
      <Match when={ready()}>{(data) => <PullRequestContent data={data} />}</Match>
      <Match when={message()}>
        {(data) => (
          <PullRequestMessage title={data().title}>{data().content}</PullRequestMessage>
        )}
      </Match>
    </Switch>
  );
};

type PullRequestPageData = {
  kind: "ready";
  number: number;
  pullRequest: Repositories.PullRequest;
  pullRequestDetail: Repositories.PullRequestDetailState | undefined;
  repository: Repositories.Repository;
};

type PullRequestMessageData = {
  content: JSX.Element;
  kind: "message";
  title: string;
};

const PullRequestContent = (props: { data: Accessor<PullRequestPageData> }) => {
  const details = () => getDetails(props.data().pullRequestDetail);

  return (
    <div className="PullRequestPage">
      <aside aria-label="Pull request status" className="PullRequestPage-leftSidebar">
        <PullRequestActions data={props.data} />
        <PullRequestReviewStatus details={details} />
        <PullRequestChecks details={details} />
      </aside>
      <section className="PullRequestPage-content">
        <h1 className="PullRequestPage-title">{props.data().pullRequest.title}</h1>
        <PullRequestDetailPanel data={props.data} />
      </section>
      <aside aria-label="Pull request metadata" className="PullRequestPage-rightSidebar">
        <PullRequestMetadata data={props.data} />
        <Show when={details()}>
          {(detail) => (
            <>
              <PullRequestFiles files={() => detail().files} />
              <PullRequestCommits commits={() => detail().commits} />
            </>
          )}
        </Show>
      </aside>
    </div>
  );
};

const PullRequestMessage = ({ children, title }: ParentProps<{ title: string }>) => (
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

const PullRequestActions = (props: { data: Accessor<PullRequestPageData> }) => {
  return (
    <nav aria-label="Pull request actions" className="pr-sidebar-actions">
      <Tooltip closeDelay={150} gutter={8} openDelay={0}>
        <Tooltip.Trigger
          as={Link}
          aria-label="Back to home"
          className="pr-sidebar-action"
          to={{ name: "Home" }}
        >
          <ArrowLeftIcon />
        </Tooltip.Trigger>
        <PullRequestTooltip>Back to tracked repositories</PullRequestTooltip>
      </Tooltip>
      <Tooltip closeDelay={150} gutter={8} openDelay={0}>
        <Tooltip.Trigger
          as="a"
          aria-label="Open on GitHub"
          className="pr-sidebar-action"
          href={props.data().pullRequest.htmlUrl}
        >
          <GitHubIcon />
        </Tooltip.Trigger>
        <PullRequestTooltip>Open this pull request on GitHub</PullRequestTooltip>
      </Tooltip>
      <Tooltip closeDelay={150} gutter={8} openDelay={0}>
        <Tooltip.Trigger
          aria-busy={props.data().pullRequestDetail?.status === "syncing"}
          aria-label="Sync pull request from GitHub"
          className="pr-sidebar-action"
          disabled={
            props.data().pullRequestDetail?.status === "loading" ||
            props.data().pullRequestDetail?.status === "loadingTimeline" ||
            props.data().pullRequestDetail?.status === "syncing"
          }
          onClick={() =>
            send({
              kind: "Repositories",
              msg: {
                kind: "PullRequestDetailSyncRequested",
                number: props.data().number,
                repository: props.data().repository,
              },
            })
          }
          type="button"
        >
          <SyncIcon
            className={
              props.data().pullRequestDetail?.status === "syncing"
                ? "pr-sidebar-sync-icon"
                : undefined
            }
          />
        </Tooltip.Trigger>
        <PullRequestTooltip>
          <span>Sync pull request from GitHub</span>
          <span className="pr-tooltip-secondary">
            Last synced: {props.data().pullRequestDetail?.detail?.syncedAt === undefined
              ? "Never"
              : formatLocalDateTime(props.data().pullRequestDetail?.detail?.syncedAt ?? "")}
          </span>
        </PullRequestTooltip>
      </Tooltip>
    </nav>
  );
};

const PullRequestTooltip = ({ children }: ParentProps) => (
  <Tooltip.Portal>
    <Tooltip.Content className="pr-tooltip pr-tooltip-positioner">{children}</Tooltip.Content>
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

const PullRequestDetailPanel = (props: { data: Accessor<PullRequestPageData> }) => {
  const detailState = () => props.data().pullRequestDetail;
  const detail = () => getDetails(detailState());
  return (
    <Switch fallback={<p className="repo-pr-status">Pull request details not loaded.</p>}>
      <Match when={detailState()?.status === "loading"}>
        <p className="repo-pr-status">Loading pull request details...</p>
      </Match>
      <Match when={detailState()?.status === "syncing"}>
        <p className="repo-pr-status">Syncing pull request details...</p>
      </Match>
      <Match when={detailState()?.status === "error" && detail() === undefined}>
        <PullRequestDetailError
          error={
            (detailState() as Extract<Repositories.PullRequestDetailState, { status: "error" }>).error
          }
        />
      </Match>
      <Match when={detail()}>
        <div className="pr-detail-sections">
          <Show when={detailState()?.status === "error"}>
            <PullRequestDetailError
              error={
                (detailState() as Extract<Repositories.PullRequestDetailState, { status: "error" }>)
                  .error
              }
            />
          </Show>
          <PullRequestDescription body={() => detail()?.body} />
          <PullRequestTimeline data={props.data} />
        </div>
      </Match>
    </Switch>
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

const PullRequestFiles = (props: {
  files: Accessor<Repositories.PullRequestDetail["files"]>;
}) => {
  return (
    <section className="pr-sidebar-section">
      <header className="pr-sidebar-header">
        <h2 className="pr-sidebar-title">Files changed</h2>
        <span className="pr-sidebar-count">{props.files().length}</span>
      </header>
      {props.files().length === 0 ? (
        <p className="pr-sidebar-empty">None stored.</p>
      ) : (
        <ul className="pr-sidebar-list">
          <For each={props.files()}>
            {(file) => (
              <li className="pr-sidebar-data-row">
                <span className="pr-sidebar-data-primary">{file.filename}</span>
                <span className="pr-sidebar-data-secondary">{file.status}</span>
              </li>
            )}
          </For>
        </ul>
      )}
    </section>
  );
};

const PullRequestCommits = (props: {
  commits: Accessor<Repositories.PullRequestDetail["commits"]>;
}) => {
  return (
    <section className="pr-sidebar-section">
      <header className="pr-sidebar-header">
        <h2 className="pr-sidebar-title">Commits</h2>
        <span className="pr-sidebar-count">{props.commits().length}</span>
      </header>
      {props.commits().length === 0 ? (
        <p className="pr-sidebar-empty">None stored.</p>
      ) : (
        <ul className="pr-sidebar-list">
          <For each={props.commits()}>
            {(commit) => (
              <li className="pr-sidebar-data-row">
                <span className="pr-sidebar-data-primary">{commit.message}</span>
                <span className="pr-sidebar-data-secondary">{commit.sha.slice(0, 7)}</span>
              </li>
            )}
          </For>
        </ul>
      )}
    </section>
  );
};

const PullRequestDescription = (props: {
  body: Accessor<string | null | undefined>;
}) => {
  return (
    <section aria-label="Pull request description" className="pr-description">
      {props.body()?.trim() ? (
        <p>{props.body()}</p>
      ) : (
        <p className="repo-pr-status">No description provided.</p>
      )}
    </section>
  );
};

const PullRequestTimeline = (props: { data: Accessor<PullRequestPageData> }) => {
  const detailState = () => props.data().pullRequestDetail;
  const detail = () => getDetails(detailState());
  const timeline = () => detail()?.timeline ?? [];

  return (
    <section
      aria-labelledby="pull-request-activity-heading"
      className="pr-detail-section pr-activity"
    >
      <header className="pr-activity-heading">
        <h2 id="pull-request-activity-heading">Activity</h2>
        <span className="repo-pr-meta">
          {timeline().some((event) => event.id === undefined && event.occurredAt === undefined)
            ? "Stored activity; sync to refresh"
            : "Newest first"}
        </span>
      </header>
      {timeline().length === 0 ? (
        <p className="repo-pr-status">No activity stored.</p>
      ) : (
        <ol className="pr-activity-list">
          <For each={timeline()}>
            {(event) => <PullRequestTimelineItem event={event} />}
          </For>
        </ol>
      )}
      {detailState()?.status === "timelineError" ? (
        <p className="repo-pr-status" role="alert">
          Older activity could not be loaded. Try again.
        </p>
      ) : null}
      <Show when={detail()?.timelineHasOlder}>
        <button
          aria-busy={detailState()?.status === "loadingTimeline"}
          className="pr-activity-load-older"
          disabled={detailState()?.status === "loadingTimeline"}
          onClick={() =>
            send({
              kind: "Repositories",
              msg: {
                kind: "PullRequestTimelineOlderRequested",
                number: props.data().number,
                repository: props.data().repository,
              },
            })
          }
          type="button"
        >
          {detailState()?.status === "loadingTimeline"
            ? "Loading older activity..."
            : "Load older activity"}
        </button>
      </Show>
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
          {reviewComments.map((comment) => (
            <li>
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

const PullRequestChecks = (props: {
  details: Accessor<ReturnType<typeof getDetails>>;
}) => {
  return (
    <Show when={props.details()}>
      {(details) => (
        <section className="pr-sidebar-section">
          <header className="pr-sidebar-header">
            <h2 className="pr-sidebar-title">Checks</h2>
            <span className="pr-sidebar-count">
              {details().checkRuns.length + details().statuses.length}
            </span>
          </header>
          {details().checkRuns.length + details().statuses.length === 0 ? (
            <p className="pr-sidebar-empty">None stored.</p>
          ) : (
            <ul className="pr-sidebar-list">
              <For each={details().checkRuns}>
                {(check) => (
                  <li className="pr-sidebar-item">
                    <PullRequestStatusIcon
                      label={check.name}
                      state={check.state}
                      summary={check.summary}
                      title={check.title}
                      url={check.url}
                    />
                  </li>
                )}
              </For>
              <For each={details().statuses}>
                {(status) => (
                  <li className="pr-sidebar-item">
                    <PullRequestStatusIcon
                      description={status.description}
                      label={status.context}
                      state={status.state}
                      url={status.url}
                    />
                  </li>
                )}
              </For>
            </ul>
          )}
        </section>
      )}
    </Show>
  );
};

const PullRequestMetadata = (props: { data: Accessor<PullRequestPageData> }) => {
  return (
    <section className="pr-sidebar-section pr-sidebar-metadata">
      <header className="pr-sidebar-header">
        <h2 className="pr-sidebar-title">Details</h2>
      </header>
      <dl className="pr-sidebar-metadata-list">
        <div className="pr-sidebar-metadata-item">
          <dt>Repository</dt>
          <dd>{props.data().repository.fullName}</dd>
        </div>
        <div className="pr-sidebar-metadata-item">
          <dt>Number</dt>
          <dd>#{props.data().pullRequest.number}</dd>
        </div>
        <div className="pr-sidebar-metadata-item">
          <dt>State</dt>
          <dd>{props.data().pullRequest.state}</dd>
        </div>
        <div className="pr-sidebar-metadata-item">
          <dt>Author</dt>
          <dd>{props.data().pullRequest.authorLogin ?? "Unknown"}</dd>
        </div>
        <div className="pr-sidebar-metadata-item">
          <dt>Updated</dt>
          <dd>
            <time className="pr-sidebar-time" dateTime={props.data().pullRequest.updatedAt}>
              {formatLocalDateTime(props.data().pullRequest.updatedAt)}
            </time>
          </dd>
        </div>
      </dl>
    </section>
  );
};

const PullRequestReviewStatus = (props: {
  details: Accessor<ReturnType<typeof getDetails>>;
}) => {
  const decision = createMemo(() => reviewDecisionPresentation(props.details()));

  return (
    <section className="pr-sidebar-section pr-sidebar-review">
      <header className="pr-sidebar-header">
        <h2 className="pr-sidebar-title">Review status</h2>
      </header>
      <p className="pr-review-decision" data-status-kind={decision().kind}>
        <span className="pr-status-name" data-status-kind={decision().kind}>
          {decision().label}
        </span>
        <span className="pr-status-icon">
          {decision().kind === "success" ? <CheckIcon /> : null}
          {decision().kind === "failure" ? <XIcon /> : null}
          {decision().kind === "pending" ? <HourglassIcon /> : null}
          {decision().kind === "neutral" ? <MinusIcon /> : null}
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
    <Tooltip closeDelay={150} gutter={8} openDelay={0} placement="right">
      <Tooltip.Trigger
        aria-label={`${label}: ${accessibleState}`}
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
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="pr-check-tooltip pr-tooltip pr-tooltip-positioner">
          <p className="pr-tooltip-title">{label}</p>
          <p className="pr-tooltip-state">{accessibleState}</p>
          {title ? <p className="pr-tooltip-detail-title">{title}</p> : null}
          {detail ? <p className="pr-tooltip-description">{detail}</p> : null}
          {url ? (
            <a className="pr-tooltip-link" href={url} rel="noreferrer" target="_blank">
              View run
            </a>
          ) : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  );
};

export default PullRequestPage;
