import "./App.css";
import { Link } from "./Link";
import { send, useModel } from "./model";
import type * as Router from "./router";

const Page = ({ route }: { route: Router.Route }) => {
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
  const count = useModel((model) => model.get("count"));

  return (
    <section className="page-card">
      <p className="eyebrow">Home</p>
      <h1>Kestrel</h1>
      <p>The home route is wired through the typed link and command-based navigation flow.</p>
      <button type="button" className="counter" onClick={() => send({ kind: "CountIncrement" })}>
        Count is {count}
      </button>
    </section>
  );
};

const SettingsPage = () => {
  return (
    <section className="page-card">
      <p className="eyebrow">Settings</p>
      <h1>Settings</h1>
      <p>This is the placeholder settings page.</p>
    </section>
  );
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

function App() {
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
        </nav>
      </header>
      <main>
        <Page route={route} />
      </main>
    </div>
  );
}

export default App;
