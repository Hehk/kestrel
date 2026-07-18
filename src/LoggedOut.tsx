import { apiUrl } from "./api/client";
import { createMemo } from "solid-js";
import type { ParentProps } from "solid-js";
import * as Router from "./router";
import * as Session from "./session";

type LoggedOutProps = {
  route: Router.PublicRoute;
};

const PublicLink = ({ children, to }: ParentProps<{ to: Router.LoginRoute }>) => {
  const href = Router.fromRoute(to);

  return (
    <a
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
        Session.send({ kind: "RouteRequested", route: to, replace: false });
      }}
    >
      {children}
    </a>
  );
};

const LoginPage = () => {
  return (
    <section class="page-card">
      <p class="eyebrow">Login</p>
      <h1>Sign in to Kestrel</h1>
      <p>Use your GitHub account to create or continue your Kestrel session.</p>
      <a class="counter" href={apiUrl("/api/auth/github/start")}>
        Sign in with GitHub
      </a>
    </section>
  );
};

const NotFoundPage = ({ path }: { path: string }) => {
  return (
    <section class="page-card">
      <p class="eyebrow">Not Found</p>
      <h1>Route not found</h1>
      <p>No page exists for {path}.</p>
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
    <div class="app-shell">
      <header class="app-header">
        <p class="site-title">Kestrel</p>
        <nav class="app-nav" aria-label="Primary">
          <PublicLink to={{ name: "Login" }}>Login</PublicLink>
        </nav>
      </header>
      <main>
        <Page route={route} />
      </main>
    </div>
  );
};
