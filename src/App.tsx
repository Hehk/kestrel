import "./App.css";
import { Link } from "./Link";
import { LoggedOut } from "./LoggedOut";
import { send, useModel } from "./model";
import type { Theme } from "./model";
import type * as Router from "./router";
import * as Session from "./session";

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
  const settings = useModel((model) => model.get("settings"));
  const user = useModel((model) => model.get("user"));

  return (
    <section className="page-card">
      <p className="eyebrow">Settings</p>
      <h1>Settings</h1>
      <p>Signed in as {user.displayName}.</p>
      {settings.status === "loading" ? (
        <p>Loading settings...</p>
      ) : settings.status === "error" ? (
        <p>Settings could not be loaded. Try refreshing the page.</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send({ kind: "SettingsSaveRequested" });
          }}
        >
          <fieldset disabled={settings.saveStatus === "saving"}>
            <legend>Theme</legend>
            <ThemeOption theme="system" currentTheme={settings.draftTheme} label="System" />
            <ThemeOption theme="light" currentTheme={settings.draftTheme} label="Light" />
            <ThemeOption theme="dark" currentTheme={settings.draftTheme} label="Dark" />
          </fieldset>
          <button type="submit" className="counter" disabled={settings.saveStatus === "saving"}>
            {settings.saveStatus === "saving" ? "Saving..." : "Save settings"}
          </button>
          {settings.saveStatus === "saved" ? <p>Settings saved.</p> : null}
          {settings.saveStatus === "error" ? <p>Settings could not be saved.</p> : null}
        </form>
      )}
    </section>
  );
};

const ThemeOption = ({
  currentTheme,
  label,
  theme,
}: {
  currentTheme: Theme;
  label: string;
  theme: Theme;
}) => {
  return (
    <label>
      <input
        type="radio"
        name="theme"
        value={theme}
        checked={currentTheme === theme}
        onChange={() => send({ kind: "SettingsThemeChanged", theme })}
      />
      {label}
    </label>
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
