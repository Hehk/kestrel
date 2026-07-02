import { useEffect, useState } from "react";
import { apiUrl } from "./api/client";
import * as Router from "./router";

const PublicLink = ({ children, to }: { children: React.ReactNode; to: Router.LoginRoute }) => {
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
        Router.navigate(to, { replace: false });
      }}
    >
      {children}
    </a>
  );
};

const LoginPage = () => {
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

const NotFoundPage = ({ path }: { path: string }) => {
  return (
    <section className="page-card">
      <p className="eyebrow">Not Found</p>
      <h1>Route not found</h1>
      <p>No page exists for {path}.</p>
    </section>
  );
};

const Page = ({ route }: { route: Router.PublicRoute }) => {
  switch (route.name) {
    case "Login":
      return <LoginPage />;
    case "NotFound":
      return <NotFoundPage path={route.path} />;
  }
};

const getPublicRoute = () => Router.toPublicRoute(Router.getRoute());
export const LoggedOut = () => {
  const [route, setRoute] = useState(getPublicRoute);

  useEffect(() => {
    const publicRoute = getPublicRoute();
    if (publicRoute.name === "Login" && Router.getRoute().name !== publicRoute.name) {
      Router.navigate(publicRoute, { replace: true });
    }

    const unsubscribe = Router.onStateChange((nextRoute) => {
      const nextPublicRoute = Router.toPublicRoute(nextRoute);
      if (Router.isProtectedRoute(nextRoute) && nextPublicRoute.name === "Login") {
        Router.navigate(nextPublicRoute, { replace: true });
      }

      setRoute(nextPublicRoute);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <p className="site-title">Kestrel</p>
        <nav className="app-nav" aria-label="Primary">
          <PublicLink to={{ name: "Login" }}>Login</PublicLink>
        </nav>
      </header>
      <main>
        <Page route={route} />
      </main>
    </div>
  );
};
