import { Link } from "./Link";
import { useModel } from "./model";
import * as Session from "./session";

const DefaultHeader = () => {
  return <header className="app-header">
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
}

const AuthNav = () => {
  const displayName = useModel((model) => model.get("user").displayName);
  // TODO: just doing styling/refactoring now, but this should part of a model message not the session stuff
  const onLogout = () => Session.send({ kind: "LogoutRequested" });

  return (
    <>
      <span>{displayName}</span>
      <button type="button" className="counter" onClick={onLogout}>
        Sign out
      </button>
    </>
  );
};

export default DefaultHeader;
