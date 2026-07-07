import { useEffect, useId, useRef, useState } from "react";
import "./App.css";
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
  const repositories = useModel((model) => model.get("repositories"));

  return (
    <section className="page-card">
      <p className="eyebrow">Repositories</p>
      <h1>Tracked repositories</h1>
      <RepositoryList repositories={repositories} />
      <AddRepositoryForm repositories={repositories} />
    </section>
  );
};

const RepositoryList = ({ repositories }: { repositories: Repositories.State }) => {
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
        <li className="repo-row" key={repository.fullName}>
          <a href={repository.htmlUrl}>{repository.fullName}</a>
          <span className="repo-provider">GitHub</span>
        </li>
      ))}
    </ul>
  );
};

const AddRepositoryForm = ({ repositories }: { repositories: Repositories.State }) => {
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const errorId = useId();
  const previousAddStatus = useRef(addStatus(repositories));
  const currentAddStatus = addStatus(repositories);
  const saving = currentAddStatus === "saving";
  const error = repositories.status === "loaded" ? addErrorText(repositories.addError) : undefined;

  useEffect(() => {
    if (submitted && previousAddStatus.current === "saving" && currentAddStatus === "idle") {
      setInput("");
      setSubmitted(false);
    } else if (submitted && currentAddStatus === "error") {
      setSubmitted(false);
    }

    previousAddStatus.current = currentAddStatus;
  }, [currentAddStatus, submitted]);

  return (
    <form
      className="repo-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (repositories.status !== "loaded" || saving) {
          return;
        }

        setSubmitted(true);
        send({ kind: "Repositories", msg: { kind: "AddRequested", repository: input } });
      }}
    >
      <label className="repo-add-label" htmlFor="repository-input">
        Add GitHub repository
      </label>
      <div className="repo-add-controls">
        <input
          aria-describedby={error ? errorId : undefined}
          disabled={repositories.status !== "loaded"}
          id="repository-input"
          onChange={(event) => setInput(event.currentTarget.value)}
          placeholder="owner/name or GitHub URL"
          type="text"
          value={input}
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
  return (
    <section className="page-card">
      <p className="eyebrow">Pull Request</p>
      <h1>{repo}</h1>
      <p>Viewing pull request #{id}.</p>
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
