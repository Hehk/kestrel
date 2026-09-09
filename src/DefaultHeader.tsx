import * as stylex from "@stylexjs/stylex";
import { Link } from "./Link";
import { appStore } from "./store";
import * as Session from "./session";
import { Button } from "./components/Button";
import { SiteHeader } from "./components/SiteHeader";
import { tokens } from "./styles/tokens.stylex";

const styles = stylex.create({
  navSeparator: {
    color: tokens.textMuted,
  },
  authAction: {
    marginTop: "0.25rem",
  },
});

const DefaultHeader = () => {
  return (
    <SiteHeader>
      <Link variant="navigation" to={{ name: "Home" }}>
        Home
      </Link>
      <span {...stylex.attrs(styles.navSeparator)} aria-hidden="true">
        |
      </span>
      <Link variant="navigation" to={{ name: "Settings" }}>
        Settings
      </Link>
      <span {...stylex.attrs(styles.navSeparator)} aria-hidden="true">
        |
      </span>
      <Link
        variant="navigation"
        to={{ name: "PullRequest", repo: "kestrel", id: "42", view: "overview" }}
      >
        Sample PR
      </Link>
      <span {...stylex.attrs(styles.navSeparator)} aria-hidden="true">
        |
      </span>
      <AuthNav />
    </SiteHeader>
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
      <span {...stylex.attrs(styles.authAction)}>
        <Button onClick={onLogout} size="small">
          Sign out
        </Button>
      </span>
    </>
  );
};

export default DefaultHeader;
