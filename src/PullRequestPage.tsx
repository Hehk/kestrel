import type { ReactNode } from "react";
import { useModel, send } from "./model";
import * as Repositories from "./repositoriesSlice";
import { apiUrl } from "./api/client";
import PullRequestsError from "./PullRequestError";

const PullRequestPage = ({ repo, id }: { repo: string; id: string }) => {
  const repositories = useModel((model) => model.get("repositories"));

  if (repositories.status === "loading") {
    return (
      <section className="page-card">
        <p className="eyebrow">Pull Request</p>
        <h1>{repo}</h1>
        <p>Loading repository...</p>
      </section>
    );
  }

  if (repositories.status === "error") {
    return (
      <section className="page-card">
        <p className="eyebrow">Pull Request</p>
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
      <section className="page-card">
        <p className="eyebrow">Pull Request</p>
        <h1>{repo}</h1>
        <p>Repository is not tracked.</p>
      </section>
    );
  }

  const number = Number(id);
  if (!Number.isInteger(number) || number <= 0) {
    return (
      <section className="page-card">
        <p className="eyebrow">Pull Request</p>
        <h1>{repo}</h1>
        <p>Pull request number is invalid.</p>
      </section>
    );
  }

  const pullRequests = repositories.pullRequests.get(repository.fullName);
  if (pullRequests === undefined) {
    return (
      <section className="page-card">
        <p className="eyebrow">Pull Request</p>
        <h1>
          {repo} #{id}
        </h1>
        <p>Loading pull requests...</p>
      </section>
    );
  }

  if (pullRequests.status === "loading" || pullRequests.status === "syncing") {
    return (
      <section className="page-card">
        <p className="eyebrow">Pull Request</p>
        <h1>
          {repo} #{id}
        </h1>
        <p>{pullRequests.status === "loading" ? "Loading" : "Syncing"} pull requests...</p>
      </section>
    );
  }

  if (pullRequests.status === "error") {
    return (
      <section className="page-card">
        <p className="eyebrow">Pull Request</p>
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
      <section className="page-card">
        <p className="eyebrow">Pull Request</p>
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

  return (
    <section className="page-card">
      <p className="eyebrow">Pull Request</p>
      <h1>{pullRequest.title}</h1>
      <dl className="pr-details">
        <div>
          <dt>Repository</dt>
          <dd>{repository.fullName}</dd>
        </div>
        <div>
          <dt>Number</dt>
          <dd>#{pullRequest.number}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{pullRequest.state}</dd>
        </div>
        <div>
          <dt>Author</dt>
          <dd>{pullRequest.authorLogin ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{pullRequest.updatedAt}</dd>
        </div>
      </dl>
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
  );
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
      <PullRequestFiles files={detail.files} />
      <PullRequestCommits commits={detail.commits} />
      <PullRequestReviews reviews={detail.reviews} />
      <PullRequestComments title="Review comments" comments={detail.reviewComments} />
      <PullRequestComments title="Conversation comments" comments={detail.issueComments} />
      <PullRequestTimeline timeline={detail.timeline} />
      <PullRequestChecks checkRuns={detail.checkRuns} statuses={detail.statuses} />
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
    <PullRequestSection count={files.length} title="Files changed">
      <ul className="pr-detail-list">
        {files.map((file, index) => (
          <li key={index}>
            <span>{file.filename}</span>
            <span className="repo-pr-meta">{file.status}</span>
          </li>
        ))}
      </ul>
    </PullRequestSection>
  );
};

const PullRequestCommits = ({
  commits,
}: {
  commits: Repositories.PullRequestDetail["commits"];
}) => {
  return (
    <PullRequestSection count={commits.length} title="Commits">
      <ul className="pr-detail-list">
        {commits.map((commit, index) => (
          <li key={index}>
            <span>{commit.message}</span>
            <span className="repo-pr-meta">{commit.sha.slice(0, 7)}</span>
          </li>
        ))}
      </ul>
    </PullRequestSection>
  );
};

const PullRequestReviews = ({
  reviews,
}: {
  reviews: Repositories.PullRequestDetail["reviews"];
}) => {
  return (
    <PullRequestSection count={reviews.length} title="Reviews">
      <ul className="pr-detail-list">
        {reviews.map((review, index) => (
          <li key={index}>
            <span>{review.authorLogin ?? "Unknown reviewer"}</span>
            <span className="repo-pr-meta">{review.state}</span>
          </li>
        ))}
      </ul>
    </PullRequestSection>
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

const PullRequestChecks = ({
  checkRuns,
  statuses,
}: {
  checkRuns: Repositories.PullRequestDetail["checkRuns"];
  statuses: Repositories.PullRequestDetail["statuses"];
}) => {
  return (
    <PullRequestSection count={checkRuns.length + statuses.length} title="Checks and statuses">
      <ul className="pr-detail-list">
        {checkRuns.map((check, index) => (
          <li key={`check-${index}`}>
            <span>{check.name}</span>
            <span className="repo-pr-meta">{check.state}</span>
          </li>
        ))}
        {statuses.map((status, index) => (
          <li key={`status-${index}`}>
            <span>{status.context}</span>
            <span className="repo-pr-meta">{status.state}</span>
          </li>
        ))}
      </ul>
    </PullRequestSection>
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
