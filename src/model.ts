import { Record } from "immutable";
import { useSyncExternalStore } from "react";
import { api } from "./api/client";
import * as Router from "./router";

export type User = {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
};

export type AuthState =
  | {
      status: "loading";
    }
  | {
      status: "signedOut";
    }
  | {
      status: "signedIn";
      user: User;
    };

type Model = Record<{
  auth: AuthState;
  count: number;
  route: Router.Route;
}>;

export type Cmd =
  | {
      kind: "AuthLoad";
    }
  | {
      kind: "Logout";
    }
  | {
      kind: "Navigate";
      route: Router.LinkRoute;
      replace: boolean;
    };

type UpdateContext = {
  runCmd: (cmd: Cmd) => void;
};

const init = (): Model => {
  const route = Router.getRoute();
  return Record({ auth: { status: "loading" } satisfies AuthState, count: 0, route })();
};

export type Msg =
  | { kind: "AuthLoadRequested" }
  | { kind: "AuthLoaded"; user: User | null }
  | { kind: "AuthLoadFailed" }
  | { kind: "CountIncrement" }
  | { kind: "CountDecrement" }
  | { kind: "LogoutRequested" }
  | { kind: "LogoutFinished" }
  | { kind: "RouteRequested"; route: Router.LinkRoute; replace: boolean }
  | { kind: "RouteChanged"; route: Router.Route };

export const update = (ctx: UpdateContext, msg: Msg, model: Model): Model => {
  switch (msg.kind) {
    case "AuthLoadRequested": {
      ctx.runCmd({ kind: "AuthLoad" });
      return model.set("auth", { status: "loading" });
    }
    case "AuthLoaded": {
      if (msg.user === null) {
        return model.set("auth", { status: "signedOut" });
      }
      return model.set("auth", { status: "signedIn", user: msg.user });
    }
    case "AuthLoadFailed": {
      return model.set("auth", { status: "signedOut" });
    }
    case "CountIncrement": {
      const oldCount = model.get("count");
      return model.set("count", oldCount + 1);
    }
    case "CountDecrement": {
      const oldCount = model.get("count");
      return model.set("count", oldCount - 1);
    }
    case "LogoutRequested": {
      ctx.runCmd({ kind: "Logout" });
      return model;
    }
    case "LogoutFinished": {
      return model.set("auth", { status: "signedOut" });
    }
    case "RouteRequested": {
      if (Router.equal(model.get("route"), msg.route)) {
        return model;
      }

      ctx.runCmd({ kind: "Navigate", route: msg.route, replace: msg.replace });
      return model;
    }
    case "RouteChanged": {
      return model.set("route", msg.route);
    }
  }
};

let model = init();
let subs: Set<() => void> = new Set();

const defaultRunCmd = (cmd: Cmd) => {
  switch (cmd.kind) {
    case "AuthLoad": {
      void loadAuth();
      return;
    }
    case "Logout": {
      void logout();
      return;
    }
    case "Navigate": {
      Router.navigate(cmd.route, { replace: cmd.replace });
      send({ kind: "RouteChanged", route: cmd.route });
      return;
    }
  }
};

const loadAuth = async () => {
  const { data, error } = await api.GET("/api/auth/me");
  if (error || data === undefined) {
    send({ kind: "AuthLoadFailed" });
    return;
  }

  send({ kind: "AuthLoaded", user: data.user ?? null });
};

const logout = async () => {
  await api.POST("/api/auth/logout");
  send({ kind: "LogoutFinished" });
};

let runCmd = defaultRunCmd;

export const send = (msg: Msg) => {
  const cmds: Cmd[] = [];
  const ctx: UpdateContext = {
    runCmd: (cmd) => {
      cmds.push(cmd);
    },
  };

  model = update(ctx, msg, model);
  subs.forEach((sub) => sub());
  cmds.forEach((cmd) => runCmd(cmd));
};

Router.onStateChange((route) => {
  send({ kind: "RouteChanged", route });
});

export const useModel = <A>(selector: (model: Model) => A) => {
  const value = useSyncExternalStore(
    (onStoreChange) => {
      subs.add(onStoreChange);
      return () => subs.delete(onStoreChange);
    },
    () => selector(model),
  );
  return value;
};

export const get = (): Model => {
  return model;
};

export const appSetup = () => {
  send({ kind: "AuthLoadRequested" });
};

// NOTE: I am not 100% about these, testing patterns but once we are using the commands
// more, I will probably want to refactor them.
export const setRunCmdForTest = (nextRunCmd: (cmd: Cmd) => void) => {
  runCmd = nextRunCmd;
  return () => {
    runCmd = defaultRunCmd;
  };
};

// NOTE: I am not 100% about these, testing patterns but once we are using the commands
// more, I will probably want to refactor them.
export const resetForTest = () => {
  model = init();
  subs = new Set();
  runCmd = defaultRunCmd;
};
