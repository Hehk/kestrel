import "./App.css";
import { apiUrl } from "./api/client";
import { Link } from "./Link";
import { send, useModel } from "./model";
import type * as Router from "./router";

const Page = ({ route }: { route: Router.Route }) => {
  switch (route.name) {
    case "Home":
      return <HomePage />;
    case "Settings":
      return <SettingsPage />;
    case "Login":
      return <LoginPage />;
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
  const auth = useModel((model) => model.get("auth"));

  if (auth.status === "loading") {
    return (
      <section className="page-card">
        <p className="eyebrow">Settings</p>
        <h1>Settings</h1>
        <p>Checking your session...</p>
      </section>
    );
  }

  if (auth.status === "signedOut") {
    return (
      <section className="page-card">
        <p className="eyebrow">Settings</p>
        <h1>Sign in required</h1>
        <p>You need to sign in before changing your settings.</p>
        <Link to={{ name: "Login" }}>Go to login</Link>
      </section>
    );
  }

  return (
    <section className="page-card">
      <p className="eyebrow">Settings</p>
      <h1>Settings</h1>
      <p>Signed in as {auth.user.displayName}. Settings controls are next.</p>
    </section>
  );
};

const LoginPage = () => {
  const auth = useModel((model) => model.get("auth"));

  if (auth.status === "signedIn") {
    return (
      <section className="page-card">
        <p className="eyebrow">Login</p>
        <h1>You are signed in</h1>
        <p>Signed in as {auth.user.displayName}.</p>
        <Link to={{ name: "Settings" }}>Go to settings</Link>
      </section>
    );
  }

  return (
    <section className="page-card">
      <p className="eyebrow">Login</p>
      <h1>Sign in to Kestrel</h1>
      <p>Use your GitHub account to create or continue your Kestrel session.</p>
      <a className="counter" href={apiUrl("/api/auth/github/start")}>
        Sign in with GitHub
      </a>
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

const AuthNav = () => {
  const auth = useModel((model) => model.get("auth"));

  switch (auth.status) {
    case "loading":
      return <span>Checking session...</span>;
    case "signedOut":
      return <Link to={{ name: "Login" }}>Login</Link>;
    case "signedIn":
      return (
        <>
          <span>{auth.user.displayName}</span>
          <button
            type="button"
            className="counter"
            onClick={() => send({ kind: "LogoutRequested" })}
          >
            Sign out
          </button>
        </>
      );
  }
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
          <span className="nav-separator" aria-hidden="true">
            |
          </span>
          <AuthNav />
        </nav>
      </header>
      <main>
        <Page route={route} />
      </main>
    </div>
  );
}

export default App;
