import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, createUniqueId, For, Match, Switch } from "solid-js";
import { Link } from "./Link";
import { Anchor } from "./components/Anchor";
import { Button } from "./components/Button";
import { PageLayout } from "./components/PageLayout";
import { LoggedOut } from "./LoggedOut";
import { appStore, send } from "./store";
import * as Repositories from "./repositoriesSlice";
import type * as Router from "./router";
import * as Session from "./session";
import { SettingsPage } from "./SettingsPage";
import DefaultHeader from "./DefaultHeader";
import PullRequestPage from "./PullRequestPage";
import PullRequestsError from "./PullRequestError";
import { styles as baseStyles } from "./styles/base";
import { tokens } from "./styles/tokens.stylex";

const mobile = "@media (max-width: 640px)";

const styles = stylex.create({
  pageCardHeading: {
    marginTop: 0,
  },
  eyebrow: {
    marginTop: "0",
    marginRight: "0",
    marginBottom: "0.35rem",
    marginLeft: "0",
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
    marginTop: "0",
    marginRight: "0",
    marginBottom: "1.5rem",
    marginLeft: "0",
    listStyle: "none",
  },
  repoRow: {
    display: "grid",
    gap: "0.45rem",
    paddingBlock: "0.45rem",
    paddingInline: "0",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.rule,
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
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
    color: tokens.textMuted,
    fontSize: "0.92rem",
  },
  repoPrList: {
    display: "grid",
    gap: "0.25rem",
    padding: 0,
    marginTop: "0.15rem",
    marginRight: "0",
    marginBottom: "0",
    marginLeft: "0",
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
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: tokens.rule,
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
    flexBasis: "0%",
    paddingBlock: "0.25rem",
    paddingInline: "0.4rem",
    color: tokens.text,
    backgroundColor: tokens.background,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.border,
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
  },
  repoAddError: {
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
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
    <PageLayout header={<DefaultHeader />}>
      <p {...stylex.attrs(baseStyles.paragraph, styles.eyebrow)}>Repositories</p>
      <h1 {...stylex.attrs(baseStyles.heading, baseStyles.heading1, styles.pageCardHeading)}>
        Tracked repositories
      </h1>
      <RepositoryList />
      <AddRepositoryForm />
    </PageLayout>
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
        <Anchor href={props.repository.htmlUrl}>{props.repository.fullName}</Anchor>
        <span {...stylex.attrs(styles.repoProvider)}>GitHub</span>
      </div>
      <div {...stylex.attrs(styles.repoActions)}>
        <Button
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
        >
          Load PRs
        </Button>
        <Button
          aria-label={`Sync PRs for ${props.repository.fullName}`}
          disabled={props.pullRequests?.status === "syncing"}
          onClick={() =>
            send({
              kind: "Repositories",
              msg: { kind: "PullRequestsSyncRequested", repository: props.repository },
            })
          }
        >
          {props.pullRequests?.status === "syncing" ? "Syncing..." : "Sync PRs"}
        </Button>
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
        <Button disabled={repositories().status !== "loaded" || saving()} type="submit">
          {saving() ? "Tracking..." : "Track repo"}
        </Button>
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
    <PageLayout header={<DefaultHeader />}>
      <p {...stylex.attrs(baseStyles.paragraph, styles.eyebrow)}>Not Found</p>
      <h1 {...stylex.attrs(baseStyles.heading, baseStyles.heading1, styles.pageCardHeading)}>
        Route not found
      </h1>
      <p {...stylex.attrs(baseStyles.paragraph)}>No page exists for {path}.</p>
    </PageLayout>
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
