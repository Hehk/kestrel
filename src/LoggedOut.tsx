import * as stylex from "@stylexjs/stylex";
import { apiUrl } from "./api/client";
import { createMemo, splitProps } from "solid-js";
import type { ComponentProps, ParentProps } from "solid-js";
import * as Router from "./router";
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
  pageCard: {
    textAlign: "left",
  },
  pageCardHeading: {
    marginTop: 0,
  },
  eyebrow: {
    margin: "0 0 0.35rem",
    color: tokens.textMuted,
    fontFamily: tokens.mono,
    fontSize: "0.78rem",
  },
  counter: {
    display: "inline-block",
    marginTop: "0.25rem",
    padding: "0.25rem 0.55rem",
    fontFamily: tokens.mono,
    fontSize: "0.88rem",
  },
});

type LoggedOutProps = {
  route: Router.PublicRoute;
};

const PublicLink = (
  props: ParentProps<{ to: Router.LoginRoute }> & Omit<ComponentProps<"a">, "href">,
) => {
  const [local, anchorProps] = splitProps(props, ["children", "to"]);
  const href = Router.fromRoute(local.to);

  return (
    <a
      {...anchorProps}
      href={href}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.altKey ||
          event.ctrlKey ||
          event.shiftKey
        ) {
          return;
        }

        event.preventDefault();
        Session.send({ kind: "RouteRequested", route: local.to, replace: false });
      }}
    >
      {local.children}
    </a>
  );
};

const LoginPage = () => {
  return (
    <section {...stylex.attrs(styles.pageCard)}>
      <p {...stylex.attrs(baseStyles.paragraph, styles.eyebrow)}>Login</p>
      <h1 {...stylex.attrs(baseStyles.heading, baseStyles.heading1, styles.pageCardHeading)}>
        Sign in to Kestrel
      </h1>
      <p {...stylex.attrs(baseStyles.paragraph)}>
        Use your GitHub account to create or continue your Kestrel session.
      </p>
      <a {...stylex.attrs(baseStyles.link, styles.counter)} href={apiUrl("/api/auth/github/start")}>
        Sign in with GitHub
      </a>
    </section>
  );
};

const NotFoundPage = ({ path }: { path: string }) => {
  return (
    <section {...stylex.attrs(styles.pageCard)}>
      <p {...stylex.attrs(baseStyles.paragraph, styles.eyebrow)}>Not Found</p>
      <h1 {...stylex.attrs(baseStyles.heading, baseStyles.heading1, styles.pageCardHeading)}>
        Route not found
      </h1>
      <p {...stylex.attrs(baseStyles.paragraph)}>No page exists for {path}.</p>
    </section>
  );
};

const Page = (props: { route: Router.PublicRoute }) => {
  const view = createMemo(() => {
    switch (props.route.name) {
      case "Login":
        return <LoginPage />;
      case "NotFound":
        return <NotFoundPage path={props.route.path} />;
    }
  });
  return <>{view}</>;
};

export const LoggedOut = ({ route }: LoggedOutProps) => {
  return (
    <div>
      <header {...stylex.attrs(styles.header)}>
        <p {...stylex.attrs(baseStyles.paragraph, styles.siteTitle)}>Kestrel</p>
        <nav {...stylex.attrs(styles.nav)} aria-label="Primary">
          <PublicLink {...stylex.attrs(baseStyles.link, styles.navLink)} to={{ name: "Login" }}>
            Login
          </PublicLink>
        </nav>
      </header>
      <main>
        <Page route={route} />
      </main>
    </div>
  );
};
