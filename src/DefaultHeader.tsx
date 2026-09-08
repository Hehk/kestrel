import * as stylex from "@stylexjs/stylex";
import { Link } from "./Link";
import { appStore } from "./store";
import * as Session from "./session";
import { styles as baseStyles } from "./styles/base.stylex";
import { tokens } from "./styles/tokens.stylex";

const styles = stylex.create({
  header: {
    marginBottom: "2rem",
    paddingBottom: "1rem",
    borderBottom: `1px solid ${tokens.rule}`,
  },
  siteTitle: {
    margin: "0 0 0.5rem",
    fontSize: "1.15rem",
    fontWeight: 700,
  },
  nav: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.35rem 0.5rem",
    fontSize: "0.95rem",
  },
  navLink: {
    color: { default: tokens.link, ":visited": tokens.link },
  },
  navSeparator: {
    color: tokens.textMuted,
  },
  counter: {
    display: "inline-block",
    marginTop: "0.25rem",
    padding: "0.25rem 0.55rem",
    fontFamily: tokens.mono,
    fontSize: "0.88rem",
  },
});

const DefaultHeader = () => {
  return (
    <header {...stylex.attrs(styles.header)}>
      <p {...stylex.attrs(baseStyles.paragraph, styles.siteTitle)}>Kestrel</p>
      <nav {...stylex.attrs(styles.nav)} aria-label="Primary">
        <Link {...stylex.attrs(baseStyles.link, styles.navLink)} to={{ name: "Home" }}>
          Home
        </Link>
        <span {...stylex.attrs(styles.navSeparator)} aria-hidden="true">
          |
        </span>
        <Link {...stylex.attrs(baseStyles.link, styles.navLink)} to={{ name: "Settings" }}>
          Settings
        </Link>
        <span {...stylex.attrs(styles.navSeparator)} aria-hidden="true">
          |
        </span>
        <Link
          {...stylex.attrs(baseStyles.link, styles.navLink)}
          to={{ name: "PullRequest", repo: "kestrel", id: "42", view: "overview" }}
        >
          Sample PR
        </Link>
        <span {...stylex.attrs(styles.navSeparator)} aria-hidden="true">
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
      <button type="button" onClick={onLogout} {...stylex.attrs(baseStyles.button, styles.counter)}>
        Sign out
      </button>
    </>
  );
};

export default DefaultHeader;
