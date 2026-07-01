export type LinkRoute =
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

export type Route =
  | LinkRoute
  | {
      name: "NotFound";
      path: string;
    };

export const fromRoute = (route: LinkRoute): string => {
  switch (route.name) {
    case "Home":
      return "/";
    case "Settings":
      return "/settings";
    case "PullRequest":
      return `/pull/${encodeURIComponent(route.repo)}/${encodeURIComponent(route.id)}`;
  }
};

export const toRoute = (path: string): Route => {
  if (path === "/") {
    return { name: "Home" };
  } else if (path === "/settings") {
    return { name: "Settings" };
  } else if (path.startsWith("/pull/")) {
    const [, kind, repo, id, ...rest] = path.split("/");
    if (kind !== "pull" || !repo || !id || rest.length > 0) {
      return { name: "NotFound", path };
    }
    return { name: "PullRequest", repo: decodeURIComponent(repo), id: decodeURIComponent(id) };
  }

  return { name: "NotFound", path };
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
  const path = window.location.pathname;
  return toRoute(path);
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
