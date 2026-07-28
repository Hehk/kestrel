import { createMemo, createSignal, createUniqueId, For, Match, Switch } from "solid-js";
import "./App.css";
import { Link } from "./Link";
import { LoggedOut } from "./LoggedOut";
import { appStore, send } from "./store";
import * as Repositories from "./repositoriesSlice";
import type * as Router from "./router";
import * as Session from "./session";
import { SettingsPage } from "./SettingsPage";
import DefaultHeader from "./DefaultHeader";
import PullRequestPage from "./PullRequestPage";
import PullRequestsError from "./PullRequestError";

const Page = (props: { route: Router.AuthenticatedRoute }) => {
  const view = createMemo(() => {
    switch (props.route.name) {
      case "Home":
        return <HomePage />;
      case "Settings":
        return <SettingsPage />;
      case "PullRequest":
        return (
          <PullRequestPage repo={props.route.repo} id={props.route.id} view={props.route.view} />
        );
      case "NotFound":
        return <NotFoundPage path={props.route.path} />;
    }
  });
  return <>{view}</>;
};

const HomePage = () => {
  return (
    <div class="default-page">
      <DefaultHeader />
      <section class="page-card">
        <p class="eyebrow">Repositories</p>
        <h1>Tracked repositories</h1>
        <RepositoryList />
        <AddRepositoryForm />
      </section>
    </div>
  );
};

const RepositoryList = () => {
  const repositories = appStore((state) => state.repositories);
  return (
    <Switch>
      <Match when={repositories().status === "loading"}>
        <p class="repo-status">Loading repositories...</p>
      </Match>
      <Match when={repositories().status === "error"}>
        <p class="repo-status">Repositories could not be loaded.</p>
      </Match>
      <Match when={repositories().repositories.length === 0}>
        <p class="repo-status">No repositories tracked yet.</p>
      </Match>
      <Match when={repositories().status === "loaded"}>
        <ul class="repo-list" aria-label="Tracked repositories">
          <For each={repositories().repositories}>
            {(repository) => (
              <RepositoryRow
                pullRequests={repositories().pullRequests[repository.fullName]}
                repository={repository}
              />
            )}
          </For>
        </ul>
      </Match>
    </Switch>
  );
};

const RepositoryRow = (props: {
  pullRequests: Repositories.PullRequestsState | undefined;
  repository: Repositories.Repository;
}) => {
  return (
    <li class="repo-row">
      <div class="repo-row-header">
        <a href={props.repository.htmlUrl}>{props.repository.fullName}</a>
        <span class="repo-provider">GitHub</span>
      </div>
      <div class="repo-actions">
        <button
          aria-label={`Load PRs for ${props.repository.fullName}`}
          disabled={
            props.pullRequests?.status === "loading" || props.pullRequests?.status === "syncing"
          }
          onClick={() =>
            send({
              kind: "Repositories",
              msg: { kind: "PullRequestsLoadRequested", repository: props.repository },
            })
          }
          type="button"
        >
          Load PRs
        </button>
        <button
          aria-label={`Sync PRs for ${props.repository.fullName}`}
          disabled={props.pullRequests?.status === "syncing"}
          onClick={() =>
            send({
              kind: "Repositories",
              msg: { kind: "PullRequestsSyncRequested", repository: props.repository },
            })
          }
          type="button"
        >
          {props.pullRequests?.status === "syncing" ? "Syncing..." : "Sync PRs"}
        </button>
      </div>
      <RepositorySyncStatus repository={props.repository} />
      <PullRequestsSummary pullRequests={props.pullRequests} repository={props.repository} />
    </li>
  );
};

const RepositorySyncStatus = ({ repository }: { repository: Repositories.Repository }) => {
  if (repository.pullRequestsSyncError) {
    return (
      <p class="repo-pr-status">
        Last PR sync failed: {repositorySyncErrorText(repository.pullRequestsSyncError)}
      </p>
    );
  }

  if (repository.pullRequestsSyncedAt) {
    return <p class="repo-pr-status">Last PR sync: {repository.pullRequestsSyncedAt}</p>;
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

const PullRequestsSummary = (props: {
  pullRequests: Repositories.PullRequestsState | undefined;
  repository: Repositories.Repository;
}) => {
  return (
    <Switch fallback={<p class="repo-pr-status">Pull requests not loaded.</p>}>
      <Match when={props.pullRequests?.status === "loading"}>
        <p class="repo-pr-status">Loading pull requests...</p>
      </Match>
      <Match when={props.pullRequests?.status === "syncing"}>
        <p class="repo-pr-status">Syncing pull requests...</p>
      </Match>
      <Match when={props.pullRequests?.status === "error"}>
        <PullRequestsError
          error={
            (props.pullRequests as Extract<Repositories.PullRequestsState, { status: "error" }>)
              .error
          }
        />
      </Match>
      <Match
        when={
          props.pullRequests?.status === "loaded" && props.pullRequests.pullRequests.length === 0
        }
      >
        <p class="repo-pr-status">No pull requests stored yet.</p>
      </Match>
      <Match when={props.pullRequests?.status === "loaded"}>
        <ul class="repo-pr-list" aria-label={`Pull requests for ${props.repository.fullName}`}>
          <For each={props.pullRequests?.pullRequests}>
            {(pullRequest) => (
              <li>
                <Link
                  to={{
                    name: "PullRequest",
                    repo: props.repository.fullName,
                    id: String(pullRequest.number),
                    view: "overview",
                  }}
                >
                  #{pullRequest.number} {pullRequest.title}
                </Link>
                <span class="repo-pr-meta">{pullRequest.state}</span>
              </li>
            )}
          </For>
        </ul>
      </Match>
    </Switch>
  );
};

const AddRepositoryForm = () => {
  const errorId = createUniqueId();
  const [repositoryInput, setRepositoryInput] = createSignal("");

  const repositories = appStore((state) => state.repositories);
  const saving = () => addStatus(repositories()) === "saving";
  const error = () => {
    const state = repositories();
    return state.status === "loaded" ? addErrorText(state.addError) : undefined;
  };

  return (
    <form
      class="repo-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (repositories().status !== "loaded" || saving()) {
          return;
        }

        send({
          kind: "Repositories",
          msg: {
            kind: "AddRequested",
            repository: repositoryInput(),
          },
        });
        event.currentTarget.reset();
        setRepositoryInput("");
      }}
    >
      <label class="repo-add-label" for="repository-input">
        Add GitHub repository
      </label>
      <div class="repo-add-controls">
        <input
          aria-describedby={error() ? errorId : undefined}
          disabled={repositories().status !== "loaded" || saving()}
          id="repository-input"
          name="repository"
          onInput={(event) => setRepositoryInput(event.currentTarget.value)}
          placeholder="owner/name or GitHub URL"
          type="text"
          value={repositoryInput()}
        />
        <button disabled={repositories().status !== "loaded" || saving()} type="submit">
          {saving() ? "Tracking..." : "Track repo"}
        </button>
      </div>
      {error() ? (
        <p class="repo-add-error" id={errorId}>
          {error()}
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
    <div class="default-page">
      <DefaultHeader />
      <section class="page-card">
        <p class="eyebrow">Not Found</p>
        <h1>Route not found</h1>
        <p>No page exists for {path}.</p>
      </section>
    </div>
  );
};

const AuthenticatedApp = () => {
  const route = appStore((state) => state.route);

  return (
    <main>
      <Page route={route()} />
    </main>
  );
};

function App() {
  const status = Session.useSession((state) => state.status);
  const publicRoute = Session.useSession((state) =>
    state.status === "loggedOut" ? state.route : null,
  );

  const view = createMemo(() => {
    const route = publicRoute();
    return status() === "loggedOut" && route !== null ? (
      <LoggedOut route={route} />
    ) : (
      <AuthenticatedApp />
    );
  });
  return <>{view}</>;
}

export default App;
