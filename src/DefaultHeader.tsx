import { Link } from "./Link";
import { appStore } from "./store";
import * as Session from "./session";

const DefaultHeader = () => {
  return (
    <header class="app-header">
      <p class="site-title">Kestrel</p>
      <nav class="app-nav" aria-label="Primary">
        <Link to={{ name: "Home" }}>Home</Link>
        <span class="nav-separator" aria-hidden="true">
          |
        </span>
        <Link to={{ name: "Settings" }}>Settings</Link>
        <span class="nav-separator" aria-hidden="true">
          |
        </span>
        <Link to={{ name: "PullRequest", repo: "kestrel", id: "42", view: "overview" }}>
          Sample PR
        </Link>
        <span class="nav-separator" aria-hidden="true">
          |
        </span>
        <AuthNav />
      </nav>
    </header>
  );
};

const AuthNav = () => {
  const displayName = appStore((state) => state.user.displayName);
  // TODO: just doing styling/refactoring now, but this should be part of an application message
  // rather than the session logic.
  const onLogout = () => Session.send({ kind: "LogoutRequested" });

  return (
    <>
      <span>{displayName()}</span>
      <button type="button" class="counter" onClick={onLogout}>
        Sign out
      </button>
    </>
  );
};

export default DefaultHeader;
