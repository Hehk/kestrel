import * as stylex from "@stylexjs/stylex";
import { apiUrl } from "./api/client";
import { createMemo, splitProps } from "solid-js";
import type { ParentProps } from "solid-js";
import { Anchor } from "./components/Anchor";
import type { AnchorProps } from "./components/Anchor";
import { SiteHeader } from "./components/SiteHeader";
import * as Router from "./router";
import * as Session from "./session";
import { styles as baseStyles } from "./styles/base";
import { tokens } from "./styles/tokens.stylex";

const styles = stylex.create({
  pageCard: {
    textAlign: "left",
  },
  pageCardHeading: {
    marginTop: 0,
  },
  eyebrow: {
    marginTop: "0",
    marginRight: "0",
    marginBottom: "0.35rem",
    marginLeft: "0",
    color: tokens.textMuted,
    fontFamily: tokens.mono,
    fontSize: "0.78rem",
  },
  counter: {
    display: "inline-block",
    marginTop: "0.25rem",
    paddingBlock: "0.25rem",
    paddingInline: "0.55rem",
    fontFamily: tokens.mono,
    fontSize: "0.88rem",
  },
});

type LoggedOutProps = {
  route: Router.PublicRoute;
};

const PublicLink = (props: ParentProps<{ to: Router.LoginRoute }> & Omit<AnchorProps, "href">) => {
  const [local, anchorProps] = splitProps(props, ["children", "to"]);
  const href = Router.fromRoute(local.to);

  return (
    <Anchor
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
    </Anchor>
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
      <Anchor xstyle={styles.counter} href={apiUrl("/api/auth/github/start")}>
        Sign in with GitHub
      </Anchor>
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
      <SiteHeader>
        <PublicLink variant="navigation" to={{ name: "Login" }}>
          Login
        </PublicLink>
      </SiteHeader>
      <main>
        <Page route={route} />
      </main>
    </div>
  );
};
