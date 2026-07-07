import { useId, useRef } from "react";
import "./App.css";
import { apiUrl } from "./api/client";
import { Link } from "./Link";
import { LoggedOut } from "./LoggedOut";
import { send, useModel } from "./model";
import type * as Repositories from "./repositoriesSlice";
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
      <PullRequestsSummary pullRequests={pullRequests} repository={repository} />
    </li>
  );
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
    </section>
  );
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
