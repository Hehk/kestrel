import { Record } from "immutable";
import { useSyncExternalStore } from "react";
import * as Router from "./router";

type Model = Record<{
  count: number;
  route: Router.Route;
}>;

export type Cmd = {
  kind: "Navigate";
  route: Router.LinkRoute;
  replace: boolean;
};

type UpdateContext = {
  runCmd: (cmd: Cmd) => void;
};

const init = (): Model => {
  const route = Router.getRoute();
  return Record({ count: 0, route })();
};

export type Msg =
  | { kind: "CountIncrement" }
  | { kind: "CountDecrement" }
  | { kind: "RouteRequested"; route: Router.LinkRoute; replace: boolean }
  | { kind: "RouteChanged"; route: Router.Route };

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
      return model.set("route", msg.route);
    }
  }
};

let model = init();
let subs: Set<() => void> = new Set();

const defaultRunCmd = (cmd: Cmd) => {
  switch (cmd.kind) {
    case "Navigate": {
      Router.navigate(cmd.route, { replace: cmd.replace });
      send({ kind: "RouteChanged", route: cmd.route });
      return;
    }
  }
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
