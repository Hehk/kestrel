import { Record } from "immutable";
import { useSyncExternalStore } from "react";
import * as Router from "./router";
import * as Settings from "./settingsSlice";

export type User = {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
};

export type Model = Record<{
  count: number;
  route: Router.AuthenticatedRoute;
  settings: Settings.State;
  user: User;
}>;

export type Cmd =
  | {
      kind: "Navigate";
      route: Router.ProtectedRoute;
      replace: boolean;
    }
  | {
      kind: "Settings";
      cmd: Settings.Cmd;
    };

type UpdateContext = {
  runCmd: (cmd: Cmd) => void;
};

export type Msg =
  | { kind: "CountIncrement" }
  | { kind: "CountDecrement" }
  | { kind: "RouteRequested"; route: Router.ProtectedRoute; replace: boolean }
  | { kind: "RouteChanged"; route: Router.Route }
  | { kind: "Settings"; msg: Settings.Msg }
  | { kind: "UserRefreshed"; user: User };

const createModel = (user: User, route: Router.AuthenticatedRoute): Model => {
  return Record({
    count: 0,
    route,
    settings: Settings.fromCache(user.id),
    user,
  })();
};

export const update = (ctx: UpdateContext, msg: Msg, model: Model): Model => {
  switch (msg.kind) {
    case "CountIncrement": {
      const oldCount = model.get("count");
      return model.set("count", oldCount + 1);
    }
    case "CountDecrement": {
      const oldCount = model.get("count");
      return model.set("count", oldCount - 1);
    }
    case "RouteRequested": {
      if (Router.equal(model.get("route"), msg.route)) {
        return model;
      }

      ctx.runCmd({ kind: "Navigate", route: msg.route, replace: msg.replace });
      return model;
    }
    case "RouteChanged": {
      const route = Router.toAuthenticatedRoute(msg.route);
      if (msg.route.name === "Login") {
        ctx.runCmd({ kind: "Navigate", route: { name: "Home" }, replace: true });
      }

      if (Router.equal(model.get("route"), route)) {
        return model;
      }

      return model.set("route", route);
    }
    case "Settings": {
      const user = model.get("user");
      const settings = Settings.update(
        {
          runCmd: (cmd) => ctx.runCmd({ kind: "Settings", cmd }),
          userId: user.id,
        },
        msg.msg,
        model.get("settings"),
      );

      return model.set("settings", settings);
    }
    case "UserRefreshed": {
      if (model.get("user").id === msg.user.id) {
        return model.set("user", msg.user);
      }

      return createModel(msg.user, model.get("route"));
    }
  }
};

let model: Model | null = null;
let subs: Set<() => void> = new Set();

const defaultRunCmd = (cmd: Cmd) => {
  switch (cmd.kind) {
    case "Navigate": {
      Router.navigate(cmd.route, { replace: cmd.replace });
      send({ kind: "RouteChanged", route: cmd.route });
      return;
    }
    case "Settings": {
      Settings.runCmd(cmd.cmd, (msg) => send({ kind: "Settings", msg }));
      return;
    }
  }
};

let runCmd = defaultRunCmd;

export const start = (
  user: User,
  route: Router.AuthenticatedRoute = Router.toAuthenticatedRoute(Router.getRoute()),
) => {
  model = createModel(user, route);
  subs.forEach((sub) => sub());

  const settings = model.get("settings");
  if (settings.status === "loaded") {
    runCmd({ kind: "Settings", cmd: { kind: "ApplyTheme", theme: settings.theme } });
  }

  runCmd({ kind: "Settings", cmd: { kind: "Load" } });
};

export const stop = () => {
  Settings.applyTheme("system");
  model = null;
  subs.forEach((sub) => sub());
};

export const send = (msg: Msg) => {
  if (model === null) {
    throw new Error("Authenticated model was updated before a user was available");
  }

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
  if (model !== null) {
    send({ kind: "RouteChanged", route });
  }
});

const subscribe = (onStoreChange: () => void) => {
  subs.add(onStoreChange);
  return () => subs.delete(onStoreChange);
};

export const useModel = <A>(selector: (model: Model) => A) => {
  return useSyncExternalStore(subscribe, () => {
    if (model === null) {
      throw new Error("Authenticated model was read before a user was available");
    }

    return selector(model);
  });
};

export const get = (): Model => {
  if (model === null) {
    throw new Error("Authenticated model was read before a user was available");
  }

  return model;
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
  model = null;
  subs = new Set();
  runCmd = defaultRunCmd;
};
