import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, createUniqueId, For, Match, Switch } from "solid-js";
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
import { styles as baseStyles } from "./styles/base.stylex";
import { tokens } from "./styles/tokens.stylex";

const mobile = "@media (max-width: 640px)";

const styles = stylex.create({
  defaultPage: {
    width: { default: "min(720px, calc(100vw - 32px))", [mobile]: "min(100% - 24px, 720px)" },
    margin: "0 auto",
    padding: { default: "40px 0 64px", [mobile]: "24px 0 48px" },
  },
  pageCard: {
    textAlign: "left",
  },
  pageCardHeading: {
    marginTop: 0,
  },
  eyebrow: {
    margin: "0 0 0.35rem",
    color: tokens.textMuted,
    fontFamily: tokens.mono,
    fontSize: "0.78rem",
  },
  repoStatus: {
    color: tokens.textMuted,
  },
  repoList: {
    display: "grid",
    gap: "0.5rem",
    padding: 0,
    margin: "0 0 1.5rem",
    listStyle: "none",
  },
  repoRow: {
    display: "grid",
    gap: "0.45rem",
    padding: "0.45rem 0",
    borderBottom: `1px solid ${tokens.rule}`,
  },
  row: {
    display: "flex",
    alignItems: { default: "baseline", [mobile]: "stretch" },
    justifyContent: "space-between",
    gap: "1rem",
    flexDirection: { default: "row", [mobile]: "column" },
  },
  repoActions: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "flex-start",
    gap: "0.5rem",
  },
  repoProvider: {
    color: tokens.textMuted,
    fontFamily: tokens.mono,
    fontSize: "0.78rem",
  },
  repoPrStatus: {
    margin: 0,
    color: tokens.textMuted,
    fontSize: "0.92rem",
  },
  repoPrList: {
    display: "grid",
    gap: "0.25rem",
    padding: 0,
    margin: "0.15rem 0 0",
    listStyle: "none",
  },
  repoPrMeta: {
    color: tokens.textMuted,
    fontFamily: tokens.mono,
    fontSize: "0.78rem",
  },
  repoAddForm: {
    display: "grid",
    gap: "0.45rem",
    paddingTop: "1rem",
    marginTop: "1.5rem",
    borderTop: `1px solid ${tokens.rule}`,
  },
  repoAddLabel: {
    fontWeight: 700,
  },
  repoAddControls: {
    display: "flex",
    gap: "0.5rem",
    flexDirection: { default: "row", [mobile]: "column" },
    alignItems: { default: "normal", [mobile]: "stretch" },
  },
  repoInput: {
    minWidth: 0,
    flexGrow: 1,
    padding: "0.25rem 0.4rem",
    color: tokens.text,
    backgroundColor: tokens.background,
    border: `1px solid ${tokens.border}`,
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
  },
  repoAddError: {
    margin: 0,
    color: tokens.textMuted,
  },
});

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
    <div {...stylex.attrs(styles.defaultPage)}>
      <DefaultHeader />
      <section {...stylex.attrs(styles.pageCard)}>
        <p {...stylex.attrs(baseStyles.paragraph, styles.eyebrow)}>Repositories</p>
        <h1 {...stylex.attrs(baseStyles.heading, baseStyles.heading1, styles.pageCardHeading)}>
          Tracked repositories
        </h1>
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
        <p {...stylex.attrs(baseStyles.paragraph, styles.repoStatus)}>Loading repositories...</p>
      </Match>
      <Match when={repositories().status === "error"}>
        <p {...stylex.attrs(baseStyles.paragraph, styles.repoStatus)}>
          Repositories could not be loaded.
        </p>
      </Match>
      <Match when={repositories().repositories.length === 0}>
        <p {...stylex.attrs(baseStyles.paragraph, styles.repoStatus)}>
          No repositories tracked yet.
        </p>
      </Match>
      <Match when={repositories().status === "loaded"}>
        <ul {...stylex.attrs(styles.repoList)} aria-label="Tracked repositories">
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
    <li {...stylex.attrs(styles.repoRow)}>
      <div {...stylex.attrs(styles.row)}>
        <a {...stylex.attrs(baseStyles.link)} href={props.repository.htmlUrl}>
          {props.repository.fullName}
        </a>
        <span {...stylex.attrs(styles.repoProvider)}>GitHub</span>
      </div>
      <div {...stylex.attrs(styles.repoActions)}>
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
          {...stylex.attrs(baseStyles.button)}
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
          {...stylex.attrs(baseStyles.button)}
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
      <p {...stylex.attrs(baseStyles.paragraph, styles.repoPrStatus)}>
        Last PR sync failed: {repositorySyncErrorText(repository.pullRequestsSyncError)}
      </p>
    );
  }

  if (repository.pullRequestsSyncedAt) {
    return (
      <p {...stylex.attrs(baseStyles.paragraph, styles.repoPrStatus)}>
        Last PR sync: {repository.pullRequestsSyncedAt}
      </p>
    );
  }

  return null;
};

const repositorySyncErrorText = (error: string) => {
  switch (error) {
    case "authorizationRequired":
      return "GitHub App authorization required.";
    case "syncFailed":
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
    <Switch
      fallback={
        <p {...stylex.attrs(baseStyles.paragraph, styles.repoPrStatus)}>
          Pull requests not loaded.
        </p>
      }
    >
      <Match when={props.pullRequests?.status === "loading"}>
        <p {...stylex.attrs(baseStyles.paragraph, styles.repoPrStatus)}>Loading pull requests...</p>
      </Match>
      <Match when={props.pullRequests?.status === "syncing"}>
        <p {...stylex.attrs(baseStyles.paragraph, styles.repoPrStatus)}>Syncing pull requests...</p>
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
        <p {...stylex.attrs(baseStyles.paragraph, styles.repoPrStatus)}>
          No pull requests stored yet.
        </p>
      </Match>
      <Match when={props.pullRequests?.status === "loaded"}>
        <ul
          {...stylex.attrs(styles.repoPrList)}
          aria-label={`Pull requests for ${props.repository.fullName}`}
        >
          <For each={props.pullRequests?.pullRequests}>
            {(pullRequest) => (
              <li {...stylex.attrs(styles.row)}>
                <Link
                  {...stylex.attrs(baseStyles.link)}
                  to={{
                    name: "PullRequest",
                    repo: props.repository.fullName,
                    id: String(pullRequest.number),
                    view: "overview",
                  }}
                >
                  #{pullRequest.number} {pullRequest.title}
                </Link>
                <span {...stylex.attrs(styles.repoPrMeta)}>{pullRequest.state}</span>
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
      {...stylex.attrs(styles.repoAddForm)}
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
      <label {...stylex.attrs(styles.repoAddLabel)} for="repository-input">
        Add GitHub repository
      </label>
      <div {...stylex.attrs(styles.repoAddControls)}>
        <input
          aria-describedby={error() ? errorId : undefined}
          disabled={repositories().status !== "loaded" || saving()}
          id="repository-input"
          name="repository"
          onInput={(event) => setRepositoryInput(event.currentTarget.value)}
          placeholder="owner/name or GitHub URL"
          type="text"
          value={repositoryInput()}
          {...stylex.attrs(baseStyles.input, styles.repoInput)}
        />
        <button
          disabled={repositories().status !== "loaded" || saving()}
          type="submit"
          {...stylex.attrs(baseStyles.button)}
        >
          {saving() ? "Tracking..." : "Track repo"}
        </button>
      </div>
      {error() ? (
        <p {...stylex.attrs(baseStyles.paragraph, styles.repoAddError)} id={errorId}>
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
    <div {...stylex.attrs(styles.defaultPage)}>
      <DefaultHeader />
      <section {...stylex.attrs(styles.pageCard)}>
        <p {...stylex.attrs(baseStyles.paragraph, styles.eyebrow)}>Not Found</p>
        <h1 {...stylex.attrs(baseStyles.heading, baseStyles.heading1, styles.pageCardHeading)}>
          Route not found
        </h1>
        <p {...stylex.attrs(baseStyles.paragraph)}>No page exists for {path}.</p>
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
