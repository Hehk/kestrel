import type { ReactNode } from "react";
import { useId, useRef } from "react";
import "./App.css";
import { apiUrl } from "./api/client";
import { Link } from "./Link";
import { LoggedOut } from "./LoggedOut";
import { send, useModel } from "./model";
import * as Repositories from "./repositoriesSlice";
import type * as Router from "./router";
import * as Session from "./session";
import { SettingsPage } from "./SettingsPage";

const Page = ({ route }: { route: Router.AuthenticatedRoute }) => {
  switch (route.name) {
    case "Home":
      return <HomePage />;
    case "Settings":
      return <SettingsPage />;
    case "PullRequest":
      return <PullRequestPage repo={route.repo} id={route.id} />;
    case "NotFound":
      return <NotFoundPage path={route.path} />;
  }
};

const HomePage = () => {
  return (
    <section className="page-card">
      <p className="eyebrow">Repositories</p>
      <h1>Tracked repositories</h1>
      <RepositoryList />
      <AddRepositoryForm />
    </section>
  );
};

const RepositoryList = () => {
  const repositories = useModel((model) => model.get("repositories"));
  if (repositories.status === "loading") {
    return <p className="repo-status">Loading repositories...</p>;
  }

  if (repositories.status === "error") {
    return <p className="repo-status">Repositories could not be loaded.</p>;
  }

  if (repositories.repositories.isEmpty()) {
    return <p className="repo-status">No repositories tracked yet.</p>;
  }

  return (
    <ul className="repo-list" aria-label="Tracked repositories">
      {repositories.repositories.toArray().map((repository) => (
        <RepositoryRow
          key={repository.fullName}
          pullRequests={repositories.pullRequests.get(repository.fullName)}
          repository={repository}
        />
      ))}
    </ul>
  );
};

const RepositoryRow = ({
  pullRequests,
  repository,
}: {
  pullRequests: Repositories.PullRequestsState | undefined;
  repository: Repositories.Repository;
}) => {
  const busy = pullRequests?.status === "loading" || pullRequests?.status === "syncing";

  return (
    <li className="repo-row">
      <div className="repo-row-header">
        <a href={repository.htmlUrl}>{repository.fullName}</a>
        <span className="repo-provider">GitHub</span>
      </div>
      <div className="repo-actions">
        <button
          aria-label={`Load PRs for ${repository.fullName}`}
          disabled={busy}
          onClick={() =>
            send({ kind: "Repositories", msg: { kind: "PullRequestsLoadRequested", repository } })
          }
          type="button"
        >
          Load PRs
        </button>
        <button
          aria-label={`Sync PRs for ${repository.fullName}`}
          disabled={pullRequests?.status === "syncing"}
          onClick={() =>
            send({ kind: "Repositories", msg: { kind: "PullRequestsSyncRequested", repository } })
          }
          type="button"
        >
          {pullRequests?.status === "syncing" ? "Syncing..." : "Sync PRs"}
        </button>
      </div>
      <RepositorySyncStatus repository={repository} />
      <PullRequestsSummary pullRequests={pullRequests} repository={repository} />
    </li>
  );
};

const RepositorySyncStatus = ({ repository }: { repository: Repositories.Repository }) => {
  if (repository.pullRequestsSyncError) {
    return (
      <p className="repo-pr-status">
        Last PR sync failed: {repositorySyncErrorText(repository.pullRequestsSyncError)}
      </p>
    );
  }

  if (repository.pullRequestsSyncedAt) {
    return <p className="repo-pr-status">Last PR sync: {repository.pullRequestsSyncedAt}</p>;
  }

  return null;
};

const repositorySyncErrorText = (error: string) => {
  switch (error) {
    case "authorization_required":
      return "GitHub App authorization required.";
    case "sync_failed":
      return "GitHub sync failed.";
    default:
      return "Unknown sync error.";
  }
};

const PullRequestsSummary = ({
  pullRequests,
  repository,
}: {
  pullRequests: Repositories.PullRequestsState | undefined;
  repository: Repositories.Repository;
}) => {
  if (pullRequests === undefined) {
    return <p className="repo-pr-status">Pull requests not loaded.</p>;
  }

  switch (pullRequests.status) {
    case "loading":
      return <p className="repo-pr-status">Loading pull requests...</p>;
    case "syncing":
      return <p className="repo-pr-status">Syncing pull requests...</p>;
    case "error":
      return <PullRequestsError error={pullRequests.error} />;
    case "loaded":
      if (pullRequests.pullRequests.isEmpty()) {
        return <p className="repo-pr-status">No pull requests stored yet.</p>;
      }

      return (
        <ul className="repo-pr-list" aria-label={`Pull requests for ${repository.fullName}`}>
          {pullRequests.pullRequests.toArray().map((pullRequest) => (
            <li key={pullRequest.number}>
              <Link
                to={{
                  name: "PullRequest",
                  repo: repository.fullName,
                  id: String(pullRequest.number),
                }}
              >
                #{pullRequest.number} {pullRequest.title}
              </Link>
              <span className="repo-pr-meta">{pullRequest.state}</span>
            </li>
          ))}
        </ul>
      );
  }
};

const PullRequestsError = ({ error }: { error: Repositories.PullRequestsError }) => {
  switch (error) {
    case "authorizationRequired":
      return (
        <p className="repo-pr-status">
          GitHub App authorization required.{" "}
          <a href={apiUrl("/api/github-app/authorize")}>Authorize more repos</a>.
        </p>
      );
    case "repositoryNotTracked":
      return <p className="repo-pr-status">Repository is not tracked.</p>;
    case "pullRequestNotFound":
      return <p className="repo-pr-status">Pull request is not stored yet.</p>;
    case "syncFailed":
      return <p className="repo-pr-status">Pull requests could not be synced.</p>;
  }
};

const AddRepositoryForm = () => {
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const repositories = useModel((model) => model.get("repositories"));
  const currentAddStatus = addStatus(repositories);
  const saving = currentAddStatus === "saving";
  const error = repositories.status === "loaded" ? addErrorText(repositories.addError) : undefined;

  return (
    <form
      className="repo-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (repositories.status !== "loaded" || saving) {
          return;
        }

        send({
          kind: "Repositories",
          msg: { kind: "AddRequested", repository: inputRef.current?.value ?? "" },
        });
        event.currentTarget.reset();
      }}
    >
      <label className="repo-add-label" htmlFor="repository-input">
        Add GitHub repository
      </label>
      <div className="repo-add-controls">
        <input
          aria-describedby={error ? errorId : undefined}
          disabled={repositories.status !== "loaded" || saving}
          id="repository-input"
          placeholder="owner/name or GitHub URL"
          ref={inputRef}
          type="text"
        />
        <button disabled={repositories.status !== "loaded" || saving} type="submit">
          {saving ? "Tracking..." : "Track repo"}
        </button>
      </div>
      {error ? (
        <p className="repo-add-error" id={errorId}>
          {error}
        </p>
      ) : null}
    </form>
  );
};

const addStatus = (repositories: Repositories.State) => {
  return repositories.status === "loaded" ? repositories.addStatus : "idle";
};

const addErrorText = (error: Repositories.AddError | null) => {
  switch (error) {
    case "duplicate":
      return "That repository is already tracked.";
    case "invalid":
      return "Enter a GitHub repository as owner/name or a GitHub URL.";
    case "saveFailed":
      return "Repository could not be added. Try again.";
    case null:
      return undefined;
  }
};

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

const PullRequestFiles = ({ files }: { files: unknown }) => {
  const rows = asArray(files);
  return (
    <PullRequestSection count={rows.length} title="Files changed">
      <ul className="pr-detail-list">
        {rows.map((file, index) => (
          <li key={index}>
            <span>{stringAt(file, "filename") ?? "Unknown file"}</span>
            <span className="repo-pr-meta">{stringAt(file, "status") ?? "changed"}</span>
          </li>
        ))}
      </ul>
    </PullRequestSection>
  );
};

const PullRequestCommits = ({ commits }: { commits: unknown }) => {
  const rows = asArray(commits);
  return (
    <PullRequestSection count={rows.length} title="Commits">
      <ul className="pr-detail-list">
        {rows.map((commit, index) => (
          <li key={index}>
            <span>{stringAt(commit, "commit.message") ?? "Commit"}</span>
            <span className="repo-pr-meta">{shortSha(stringAt(commit, "sha"))}</span>
          </li>
        ))}
      </ul>
    </PullRequestSection>
  );
};

const PullRequestReviews = ({ reviews }: { reviews: unknown }) => {
  const rows = asArray(reviews);
  return (
    <PullRequestSection count={rows.length} title="Reviews">
      <ul className="pr-detail-list">
        {rows.map((review, index) => (
          <li key={index}>
            <span>{stringAt(review, "user.login") ?? "Unknown reviewer"}</span>
            <span className="repo-pr-meta">{stringAt(review, "state") ?? "reviewed"}</span>
          </li>
        ))}
      </ul>
    </PullRequestSection>
  );
};

const PullRequestComments = ({ comments, title }: { comments: unknown; title: string }) => {
  const rows = asArray(comments);
  return (
    <PullRequestSection count={rows.length} title={title}>
      <ul className="pr-detail-list">
        {rows.map((comment, index) => (
          <li key={index}>
            <span>{stringAt(comment, "body") ?? "Comment"}</span>
            <span className="repo-pr-meta">{stringAt(comment, "user.login") ?? "unknown"}</span>
          </li>
        ))}
      </ul>
    </PullRequestSection>
  );
};

const PullRequestTimeline = ({ timeline }: { timeline: unknown }) => {
  const rows = asArray(timeline);
  return (
    <PullRequestSection count={rows.length} title="Timeline">
      <ul className="pr-detail-list">
        {rows.map((event, index) => (
          <li key={index}>
            <span>{stringAt(event, "event") ?? stringAt(event, "state") ?? "event"}</span>
            <span className="repo-pr-meta">{stringAt(event, "actor.login") ?? "GitHub"}</span>
          </li>
        ))}
      </ul>
    </PullRequestSection>
  );
};

const PullRequestChecks = ({ checkRuns, statuses }: { checkRuns: unknown; statuses: unknown }) => {
  const checkRows = asArray(valueAt(checkRuns, "check_runs"));
  const statusRows = asArray(valueAt(statuses, "statuses"));
  return (
    <PullRequestSection count={checkRows.length + statusRows.length} title="Checks and statuses">
      <ul className="pr-detail-list">
        {checkRows.map((check, index) => (
          <li key={`check-${index}`}>
            <span>{stringAt(check, "name") ?? "Check"}</span>
            <span className="repo-pr-meta">
              {stringAt(check, "conclusion") ?? stringAt(check, "status") ?? "unknown"}
            </span>
          </li>
        ))}
        {statusRows.map((status, index) => (
          <li key={`status-${index}`}>
            <span>{stringAt(status, "context") ?? "Status"}</span>
            <span className="repo-pr-meta">{stringAt(status, "state") ?? "unknown"}</span>
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

const asArray = (value: unknown): unknown[] => {
  return Array.isArray(value) ? value : [];
};

const valueAt = (value: unknown, path: string): unknown => {
  return path.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }

    return (current as Record<string, unknown>)[key];
  }, value);
};

const stringAt = (value: unknown, path: string): string | undefined => {
  const current = valueAt(value, path);
  return typeof current === "string" ? current : undefined;
};

const shortSha = (sha: string | undefined): string => {
  return sha === undefined ? "unknown" : sha.slice(0, 7);
};

const NotFoundPage = ({ path }: { path: string }) => {
  return (
    <section className="page-card">
      <p className="eyebrow">Not Found</p>
      <h1>Route not found</h1>
      <p>No page exists for {path}.</p>
    </section>
  );
};

const AuthNav = ({ onLogout }: { onLogout: () => void }) => {
  const displayName = useModel((model) => model.get("user").displayName);

  return (
    <>
      <span>{displayName}</span>
      <button type="button" className="counter" onClick={onLogout}>
        Sign out
      </button>
    </>
  );
};

const AuthenticatedApp = ({ onLogout }: { onLogout: () => void }) => {
  const route = useModel((model) => model.get("route"));

  return (
    <div className="app-shell">
      <header className="app-header">
        <p className="site-title">Kestrel</p>
        <nav className="app-nav" aria-label="Primary">
          <Link to={{ name: "Home" }}>Home</Link>
          <span className="nav-separator" aria-hidden="true">
            |
          </span>
          <Link to={{ name: "Settings" }}>Settings</Link>
          <span className="nav-separator" aria-hidden="true">
            |
          </span>
          <Link to={{ name: "PullRequest", repo: "kestrel", id: "42" }}>Sample PR</Link>
          <span className="nav-separator" aria-hidden="true">
            |
          </span>
          <AuthNav onLogout={onLogout} />
        </nav>
      </header>
      <main>
        <Page route={route} />
      </main>
    </div>
  );
};

function App() {
  const session = Session.useSession((state) => state);

  if (session.status === "loggedOut") {
    return <LoggedOut route={session.route} />;
  }

  return <AuthenticatedApp onLogout={() => Session.send({ kind: "LogoutRequested" })} />;
}

export default App;
