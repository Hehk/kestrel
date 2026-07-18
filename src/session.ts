import { batch, createMemo } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { api } from "./api/client";
import * as Cache from "./cache";
import * as Model from "./model";
import type { User } from "./model";
import * as Router from "./router";

// This is a separate model for handling the session state.
// The goal of this is to separate the logged in flow from the
// main model. In theory they should be combined but it would add
// more complexity for little benefit.

export type SessionState =
  | {
      checking: boolean;
      route: Router.PublicRoute;
      status: "loggedOut";
    }
  | {
      checking: boolean;
      user: User;
      status: "loggedIn";
    };

export type SessionCmd =
  | { kind: "AuthCheck" }
  | { kind: "AuthLogout" }
  | { kind: "CacheUser"; user: User }
  | { kind: "EndAuthenticatedSession"; userId: string }
  | { kind: "ModelStart"; user: User; route: Router.AuthenticatedRoute }
  | { kind: "ModelUserRefresh"; user: User }
  | { kind: "Navigate"; route: Router.LinkRoute; replace: boolean };

type UpdateContext = {
  runCmd: (cmd: SessionCmd) => void;
};

export type SessionMsg =
  | { kind: "Started"; cachedUser: User | null; route: Router.Route }
  | { kind: "AuthChecked"; user: User | null }
  | { kind: "AuthCheckFailed" }
  | { kind: "LogoutRequested" }
  | { kind: "RouteChanged"; route: Router.Route }
  | { kind: "RouteRequested"; route: Router.LoginRoute; replace: boolean };

const initialState = (): SessionState => {
  return { checking: false, route: { name: "Login" }, status: "loggedOut" };
};

const startLoggedOut = (ctx: UpdateContext, route: Router.Route): SessionState => {
  const publicRoute = Router.toPublicRoute(route);
  if (Router.isProtectedRoute(route) && publicRoute.name === "Login") {
    ctx.runCmd({ kind: "Navigate", route: publicRoute, replace: true });
  }

  ctx.runCmd({ kind: "AuthCheck" });
  return { checking: true, route: publicRoute, status: "loggedOut" };
};

const startLoggedIn = (ctx: UpdateContext, user: User, route: Router.Route): SessionState => {
  const authenticatedRoute = Router.toAuthenticatedRoute(route);
  ctx.runCmd({ kind: "ModelStart", user, route: authenticatedRoute });
  if (route.name === "Login" && authenticatedRoute.name !== "NotFound") {
    ctx.runCmd({ kind: "Navigate", route: authenticatedRoute, replace: true });
  }

  ctx.runCmd({ kind: "AuthCheck" });
  return { checking: true, status: "loggedIn", user };
};

export const update = (ctx: UpdateContext, msg: SessionMsg, state: SessionState): SessionState => {
  switch (msg.kind) {
    case "Started": {
      if (msg.cachedUser !== null) {
        return startLoggedIn(ctx, msg.cachedUser, msg.route);
      }

      return startLoggedOut(ctx, msg.route);
    }
    case "AuthChecked": {
      if (msg.user === null) {
        if (state.status === "loggedIn") {
          ctx.runCmd({ kind: "EndAuthenticatedSession", userId: state.user.id });
          return { checking: false, route: { name: "Login" }, status: "loggedOut" };
        }

        return { ...state, checking: false };
      }

      ctx.runCmd({ kind: "CacheUser", user: msg.user });

      if (state.status === "loggedIn") {
        ctx.runCmd({ kind: "ModelUserRefresh", user: msg.user });
        return { checking: false, status: "loggedIn", user: msg.user };
      }

      ctx.runCmd({ kind: "ModelStart", user: msg.user, route: { name: "Home" } });
      ctx.runCmd({ kind: "Navigate", route: { name: "Home" }, replace: true });
      return { checking: false, status: "loggedIn", user: msg.user };
    }
    case "AuthCheckFailed": {
      if (state.status === "loggedIn") {
        return { ...state, checking: false };
      }

      return { ...state, checking: false };
    }
    case "LogoutRequested": {
      if (state.status === "loggedOut") {
        return state;
      }

      ctx.runCmd({ kind: "EndAuthenticatedSession", userId: state.user.id });
      ctx.runCmd({ kind: "AuthLogout" });
      return { checking: false, route: { name: "Login" }, status: "loggedOut" };
    }
    case "RouteChanged": {
      if (state.status === "loggedIn") {
        return state;
      }

      const publicRoute = Router.toPublicRoute(msg.route);
      if (Router.isProtectedRoute(msg.route) && publicRoute.name === "Login") {
        ctx.runCmd({ kind: "Navigate", route: publicRoute, replace: true });
      }

      if (Router.equal(state.route, publicRoute)) {
        return state;
      }

      return { ...state, route: publicRoute };
    }
    case "RouteRequested": {
      if (state.status === "loggedIn" || Router.equal(state.route, msg.route)) {
        return state;
      }

      ctx.runCmd({ kind: "Navigate", route: msg.route, replace: msg.replace });
      return { ...state, route: msg.route };
    }
  }
};

const [sessionStore, setSessionStore] = createStore<{ value: SessionState | null }>({
  value: initialState(),
});
let started = false;
let authCheckController: AbortController | null = null;

const defaultRunCmd = (cmd: SessionCmd) => {
  switch (cmd.kind) {
    case "AuthCheck": {
      authCheckController?.abort();
      authCheckController = new AbortController();
      void checkAuth(authCheckController);
      return;
    }
    case "AuthLogout": {
      void api.POST("/api/auth/logout");
      return;
    }
    case "CacheUser": {
      Cache.writeCachedUser(cmd.user);
      return;
    }
    case "EndAuthenticatedSession": {
      Cache.clearCachedSettings(cmd.userId);
      Cache.clearCachedUser();
      Model.stop();
      Router.navigate({ name: "Login" }, { replace: true });
      send({ kind: "RouteChanged", route: { name: "Login" } });
      return;
    }
    case "ModelStart": {
      Model.start(cmd.user, cmd.route);
      return;
    }
    case "ModelUserRefresh": {
      Model.send({ kind: "UserRefreshed", user: cmd.user });
      return;
    }
    case "Navigate": {
      Router.navigate(cmd.route, { replace: cmd.replace });
      send({ kind: "RouteChanged", route: cmd.route });
      return;
    }
  }
};

const checkAuth = async (controller: AbortController) => {
  const { data, error } = await api.GET("/api/auth/me", { signal: controller.signal });
  if (controller.signal.aborted) {
    return;
  }

  if (error || data === undefined) {
    send({ kind: "AuthCheckFailed" });
    return;
  }

  send({ kind: "AuthChecked", user: data.user ?? null });
};

let runCmd = defaultRunCmd;

const sessionState = (): SessionState => {
  if (sessionStore.value === null) {
    throw new Error("Session state is unavailable");
  }

  return sessionStore.value;
};

const replaceSessionState = (nextState: SessionState) => {
  batch(() => {
    setSessionStore("value", null);
    setSessionStore("value", nextState);
  });
};

export const send = (msg: SessionMsg) => {
  const cmds: SessionCmd[] = [];
  const ctx: UpdateContext = {
    runCmd: (cmd) => {
      cmds.push(cmd);
    },
  };

  const previousState = sessionState();
  const nextState = update(ctx, msg, unwrap(previousState));
  if (previousState.status === "loggedOut" && nextState.status === "loggedIn") {
    cmds.filter((cmd) => cmd.kind === "ModelStart").forEach((cmd) => runCmd(cmd));
    replaceSessionState(nextState);
    cmds.filter((cmd) => cmd.kind !== "ModelStart").forEach((cmd) => runCmd(cmd));
    return;
  }

  replaceSessionState(nextState);
  cmds.forEach((cmd) => runCmd(cmd));
};

Router.onStateChange((route) => {
  if (started) {
    send({ kind: "RouteChanged", route });
  }
});

export const start = () => {
  if (started) {
    return;
  }

  started = true;
  send({ kind: "Started", cachedUser: Cache.readCachedUser(), route: Router.getRoute() });
};

export const useSession = <A>(selector: (state: SessionState) => A) => {
  return createMemo(() => selector(sessionState()));
};

export const get = (): SessionState => {
  return sessionState();
};

export const setRunCmdForTest = (nextRunCmd: (cmd: SessionCmd) => void) => {
  runCmd = nextRunCmd;
  return () => {
    runCmd = defaultRunCmd;
  };
};

export const resetForTest = () => {
  authCheckController?.abort();
  authCheckController = null;
  replaceSessionState(initialState());
  started = false;
  runCmd = defaultRunCmd;
};
