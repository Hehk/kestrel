import "./App.css";
import { useEffectEvent, useEffect, useState } from "react";
import { api } from "./api/client";
import * as Cache from "./cache";
import { Link } from "./Link";
import { LoggedOut } from "./LoggedOut";
import * as Model from "./model";
import { send, useModel } from "./model";
import type { Theme, User } from "./model";
import type * as Router from "./router";
import * as RouterValue from "./router";

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

const equalUser = (a: User, b: User) => {
  return a.id === b.id && a.displayName === b.displayName && a.avatarUrl === b.avatarUrl;
};

function App() {
  const [user, setUser] = useState<User | null>(() => {
    const cachedUser = Cache.readCachedUser();
    if (cachedUser !== null) {
      Model.start(cachedUser);
    }

    return cachedUser;
  });
  const [shouldCheckSession, setShouldCheckSession] = useState(true);

  const startAuthenticated = useEffectEvent((nextUser: User, route: Router.AuthenticatedRoute) => {
    Cache.writeCachedUser(nextUser);
    Model.start(nextUser, route);
    setShouldCheckSession(false);
    setUser(nextUser);
  });

  const endSession = useEffectEvent((route: Router.LoginRoute) => {
    if (user !== null) {
      Cache.clearCachedSettings(user.id);
    }

    Cache.clearCachedUser();
    Model.stop();
    RouterValue.navigate(route, { replace: true });
    setShouldCheckSession(false);
    setUser(null);
  });

  useEffect(() => {
    if (!shouldCheckSession) {
      return;
    }

    const controller = new AbortController();

    const checkSession = async () => {
      const { data, error } = await api.GET("/api/auth/me", { signal: controller.signal });
      if (controller.signal.aborted || error || data === undefined) {
        return;
      }

      const loadedUser = data.user;
      if (loadedUser == null) {
        setShouldCheckSession(false);
        if (user !== null) {
          endSession({ name: "Login" });
        }
        return;
      }

      setShouldCheckSession(false);

      if (user === null) {
        startAuthenticated(loadedUser, { name: "Home" });
        return;
      }

      Cache.writeCachedUser(loadedUser);
      send({ kind: "UserRefreshed", user: loadedUser });
      setUser((currentUser) => {
        if (currentUser !== null && equalUser(currentUser, loadedUser)) {
          return currentUser;
        }

        return loadedUser;
      });
    };

    void checkSession();

    return () => {
      controller.abort();
    };
  }, [shouldCheckSession, user]);

  const logout = useEffectEvent(() => {
    endSession({ name: "Login" });
    void api.POST("/api/auth/logout");
  });

  if (user === null) {
    return <LoggedOut />;
  }

  return <AuthenticatedApp onLogout={logout} />;
}

export default App;
