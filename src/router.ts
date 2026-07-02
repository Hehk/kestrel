export type ProtectedRoute =
  | {
      name: "Home";
    }
  | {
      name: "Settings";
    }
  | {
      name: "PullRequest";
      repo: string;
      id: string;
    };

export type LoginRoute = {
  name: "Login";
};

export type LinkRoute = ProtectedRoute | LoginRoute;

export type NotFoundRoute = {
  name: "NotFound";
  path: string;
};

export type AuthenticatedRoute = ProtectedRoute | NotFoundRoute;

export type PublicRoute = LoginRoute | NotFoundRoute;

export type Route = LinkRoute | NotFoundRoute;

export const fromRoute = (route: LinkRoute): string => {
  switch (route.name) {
    case "Home":
      return "/";
    case "Settings":
      return "/settings";
    case "Login":
      return "/login";
    case "PullRequest":
      return `/pull/${encodeURIComponent(route.repo)}/${encodeURIComponent(route.id)}`;
  }
};

export const toRoute = (path: string): Route => {
  const parts = path.split("?", 2);
  const pathname = parts[0] ?? "";

  if (pathname === "/") {
    return { name: "Home" };
  } else if (pathname === "/settings") {
    return { name: "Settings" };
  } else if (pathname === "/login") {
    return { name: "Login" };
  } else if (pathname.startsWith("/pull/")) {
    const [, kind, repo, id, ...rest] = pathname.split("/");
    if (kind !== "pull" || !repo || !id || rest.length > 0) {
      return { name: "NotFound", path };
    }
    return { name: "PullRequest", repo: decodeURIComponent(repo), id: decodeURIComponent(id) };
  }

  return { name: "NotFound", path };
};

export const isProtectedRoute = (route: Route): route is ProtectedRoute => {
  return route.name === "Home" || route.name === "Settings" || route.name === "PullRequest";
};

export const toAuthenticatedRoute = (route: Route): AuthenticatedRoute => {
  if (route.name === "Login") {
    return { name: "Home" };
  }

  return route;
};

export const toPublicRoute = (route: Route): PublicRoute => {
  if (isProtectedRoute(route)) {
    return { name: "Login" };
  }

  return route;
};

// TODO: Eventually find a good structural equality checking algorithm
export const equal = (a: Route, b: Route): boolean => {
  if (a.name !== b.name) return false;
  if (a.name === "PullRequest" && b.name === "PullRequest") {
    return a.repo === b.repo && a.id === b.id;
  }
  if (a.name === "NotFound" && b.name === "NotFound") {
    return a.path === b.path;
  }
  return true;
};

export const getRoute = (): Route => {
  const path = `${window.location.pathname}${window.location.search}`;
  return toRoute(path);
};

export const getCurrentPath = (): string => {
  return `${window.location.pathname}${window.location.search}`;
};

export const navigate = (route: LinkRoute, options: { replace: boolean }) => {
  if (options.replace) {
    window.history.replaceState({}, "", fromRoute(route));
  } else {
    window.history.pushState({}, "", fromRoute(route));
  }
};

export const onStateChange = (callback: (route: Route) => void) => {
  const listener = () => {
    const route = getRoute();
    callback(route);
  };
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};
