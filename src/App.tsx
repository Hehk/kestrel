import { useId, useRef } from "react";
import "./App.css";
import { Link } from "./Link";
import { LoggedOut } from "./LoggedOut";
import { send, useModel } from "./model";
import * as Repositories from "./repositoriesSlice";
import type * as Router from "./router";
import * as Session from "./session";
import { SettingsPage } from "./SettingsPage";
import DefaultHeader from "./DefaultHeader";
import PullRequestPage from "./PullRequestPage";
import PullRequestsError from "./PullRequestError";

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
    <>
      <DefaultHeader />
      <section className="page-card">
        <p className="eyebrow">Repositories</p>
        <h1>Tracked repositories</h1>
        <RepositoryList />
        <AddRepositoryForm />
      </section>
    </>
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


const NotFoundPage = ({ path }: { path: string }) => {
  return (
    <>
      <DefaultHeader />
      <section className="page-card">
        <p className="eyebrow">Not Found</p>
        <h1>Route not found</h1>
        <p>No page exists for {path}.</p>
      </section>
    </>
  );
};

const AuthenticatedApp = () => {
  const route = useModel((model) => model.get("route"));

  return (
    <div className="app-shell">
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

  return <AuthenticatedApp />;
}

export default App;
