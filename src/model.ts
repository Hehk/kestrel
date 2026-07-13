import { Record } from "immutable";
import { useSyncExternalStore } from "react";
import * as Mvu from "./mvu";
import * as Repositories from "./repositoriesSlice";
import * as Router from "./router";
import * as Settings from "./settingsSlice";

export type User = {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
};

export type Model = Record<{
  count: number;
  repositories: Repositories.State;
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
    }
  | {
      kind: "Repositories";
      cmd: Repositories.Cmd;
    };

type RepositoryUpdateContext = {
  runCmd: (cmd: Cmd) => void;
};

export type Msg =
  | { kind: "Started" }
  | { kind: "CountIncrement" }
  | { kind: "CountDecrement" }
  | { kind: "RouteRequested"; route: Router.ProtectedRoute; replace: boolean }
  | { kind: "RouteChanged"; route: Router.Route }
  | { kind: "Repositories"; msg: Repositories.Msg }
  | { kind: "Settings"; msg: Settings.Msg }
  | { kind: "UserRefreshed"; user: User };

const createModel = (user: User, route: Router.AuthenticatedRoute): Model => {
  return Record({
    count: 0,
    repositories: Repositories.initialState(),
    route,
    settings: Settings.fromCache(user.id),
    user,
  })();
};

const settingsCmd = (cmd: Settings.Cmd): Cmd => ({ kind: "Settings", cmd });
const repositoriesCmd = (cmd: Repositories.Cmd): Cmd => ({ kind: "Repositories", cmd });

export const update = (msg: Msg, model: Model): Mvu.Transition<Model, Cmd> => {
  switch (msg.kind) {
    case "Started": {
      return [
        model,
        Mvu.Cmd.batch(
          Mvu.Cmd.map(settingsCmd, Settings.initialCommands(model.get("settings"))),
          Mvu.Cmd.of(repositoriesCmd({ kind: "Load" })),
        ),
      ];
    }
    case "CountIncrement": {
      const oldCount = model.get("count");
      return [model.set("count", oldCount + 1), Mvu.Cmd.none()];
    }
    case "CountDecrement": {
      const oldCount = model.get("count");
      return [model.set("count", oldCount - 1), Mvu.Cmd.none()];
    }
    case "RouteRequested": {
      if (Router.equal(model.get("route"), msg.route)) {
        return [model, Mvu.Cmd.none()];
      }

      return [model, Mvu.Cmd.of({ kind: "Navigate", route: msg.route, replace: msg.replace })];
    }
    case "RouteChanged": {
      const commands: Cmd[] = [];
      const ctx: RepositoryUpdateContext = { runCmd: (cmd) => commands.push(cmd) };
      const route = Router.toAuthenticatedRoute(msg.route);
      if (msg.route.name === "Login") {
        ctx.runCmd({ kind: "Navigate", route: { name: "Home" }, replace: true });
      }

      if (Router.equal(model.get("route"), route)) {
        return [model, commands];
      }

      return [
        queuePullRequestRouteWork(ctx, model.set("route", route), { syncMissing: true }),
        commands,
      ];
    }
    case "Settings": {
      const [settings, commands] = Settings.update(msg.msg, model.get("settings"));

      return [model.set("settings", settings), Mvu.Cmd.map(settingsCmd, commands)];
    }
    case "Repositories": {
      const commands: Cmd[] = [];
      const ctx: RepositoryUpdateContext = { runCmd: (cmd) => commands.push(cmd) };
      const repositories = Repositories.update(
        {
          runCmd: (cmd) => ctx.runCmd(repositoriesCmd(cmd)),
        },
        msg.msg,
        model.get("repositories"),
      );

      return [
        queuePullRequestRouteWork(ctx, model.set("repositories", repositories), {
          syncMissing: msg.msg.kind === "PullRequestsLoaded",
        }),
        commands,
      ];
    }
    case "UserRefreshed": {
      if (model.get("user").id === msg.user.id) {
        return [model.set("user", msg.user), Mvu.Cmd.none()];
      }

      const nextModel = createModel(msg.user, model.get("route"));
      return [
        nextModel,
        Mvu.Cmd.batch(
          Mvu.Cmd.map(settingsCmd, Settings.initialCommands(nextModel.get("settings"))),
          Mvu.Cmd.of(repositoriesCmd({ kind: "Load" })),
        ),
      ];
    }
  }
};

const queuePullRequestRouteWork = (
  ctx: RepositoryUpdateContext,
  model: Model,
  options: { syncMissing: boolean },
): Model => {
  const route = model.get("route");
  if (route.name !== "PullRequest") {
    return model;
  }

  const repositories = model.get("repositories");
  if (repositories.status !== "loaded") {
    return model;
  }

  const repository = repositories.repositories.find(
    (candidate) => candidate.fullName === route.repo.toLowerCase(),
  );
  if (repository === undefined) {
    return model;
  }

  const pullRequests = repositories.pullRequests.get(repository.fullName);
  if (pullRequests === undefined) {
    ctx.runCmd({ kind: "Repositories", cmd: { kind: "LoadPullRequests", repository } });
    return model;
  }

  const number = Number(route.id);
  if (!Number.isInteger(number) || number <= 0 || pullRequests.status !== "loaded") {
    return model;
  }

  const hasPullRequest = pullRequests.pullRequests.some(
    (pullRequest) => pullRequest.number === number,
  );
  if (!hasPullRequest) {
    if (!options.syncMissing || pullRequests.complete) {
      return model;
    }

    ctx.runCmd({ kind: "Repositories", cmd: { kind: "SyncPullRequests", repository } });
    return model;
  }

  if (repositories.pullRequestDetails.has(Repositories.pullRequestDetailKey(repository, number))) {
    return model;
  }

  ctx.runCmd({ kind: "Repositories", cmd: { kind: "LoadPullRequestDetail", number, repository } });
  return model;
};

let model: Model | null = null;
let subs: Set<() => void> = new Set();
let messageQueue: Msg[] = [];
let processingMessages = false;

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
    case "Repositories": {
      Repositories.runCmd(cmd.cmd, (msg) => send({ kind: "Repositories", msg }));
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
  send({ kind: "Started" });
};

export const stop = () => {
  Settings.applyTheme("system");
  model = null;
  messageQueue = [];
  processingMessages = false;
  subs.forEach((sub) => sub());
};

export const send = (msg: Msg) => {
  if (model === null) {
    throw new Error("Authenticated model was updated before a user was available");
  }

  messageQueue.push(msg);
  if (processingMessages) {
    return;
  }

  processingMessages = true;
  try {
    while (messageQueue.length > 0) {
      const nextMsg = messageQueue.shift();
      if (nextMsg === undefined || model === null) {
        continue;
      }

      const [nextModel, commands] = update(nextMsg, model);
      model = nextModel;
      subs.forEach((sub) => sub());
      commands.forEach((cmd) => runCmd(cmd));
    }
  } finally {
    processingMessages = false;
  }
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
  messageQueue = [];
  processingMessages = false;
  runCmd = defaultRunCmd;
};
