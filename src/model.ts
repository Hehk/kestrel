import { batch, createMemo } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import * as Mvu from "./mvu";
import * as Repositories from "./repositoriesSlice";
import * as Router from "./router";
import * as Settings from "./settingsSlice";

export type User = {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
};

export type Model = {
  count: number;
  repositories: Repositories.State;
  route: Router.AuthenticatedRoute;
  settings: Settings.State;
  user: User;
};

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
  return {
    count: 0,
    repositories: Repositories.initialState(),
    route,
    settings: Settings.fromCache(user.id),
    user,
  };
};

const settingsCmd = (cmd: Settings.Cmd): Cmd => ({ kind: "Settings", cmd });
const repositoriesCmd = (cmd: Repositories.Cmd): Cmd => ({ kind: "Repositories", cmd });

export const update = (msg: Msg, model: Model): Mvu.Transition<Model, Cmd> => {
  switch (msg.kind) {
    case "Started": {
      return [
        model,
        Mvu.Cmd.batch(
          Mvu.Cmd.map(settingsCmd, Settings.initialCommands(model.settings)),
          Mvu.Cmd.of(repositoriesCmd({ kind: "Load" })),
        ),
      ];
    }
    case "CountIncrement": {
      return [{ ...model, count: model.count + 1 }, Mvu.Cmd.none()];
    }
    case "CountDecrement": {
      return [{ ...model, count: model.count - 1 }, Mvu.Cmd.none()];
    }
    case "RouteRequested": {
      if (Router.equal(model.route, msg.route)) {
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

      if (Router.equal(model.route, route)) {
        return [model, commands];
      }

      return [queuePullRequestRouteWork(ctx, { ...model, route }, { syncMissing: true }), commands];
    }
    case "Settings": {
      const [settings, commands] = Settings.update(msg.msg, model.settings);

      return [{ ...model, settings }, Mvu.Cmd.map(settingsCmd, commands)];
    }
    case "Repositories": {
      const commands: Cmd[] = [];
      const ctx: RepositoryUpdateContext = { runCmd: (cmd) => commands.push(cmd) };
      const repositories = Repositories.update(
        {
          runCmd: (cmd) => ctx.runCmd(repositoriesCmd(cmd)),
        },
        msg.msg,
        model.repositories,
      );

      return [
        queuePullRequestRouteWork(
          ctx,
          { ...model, repositories },
          {
            syncMissing: msg.msg.kind === "PullRequestsLoaded",
          },
        ),
        commands,
      ];
    }
    case "UserRefreshed": {
      if (model.user.id === msg.user.id) {
        return [{ ...model, user: msg.user }, Mvu.Cmd.none()];
      }

      const nextModel = createModel(msg.user, model.route);
      return [
        nextModel,
        Mvu.Cmd.batch(
          Mvu.Cmd.map(settingsCmd, Settings.initialCommands(nextModel.settings)),
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
  const route = model.route;
  if (route.name !== "PullRequest") {
    return model;
  }

  const repositories = model.repositories;
  if (repositories.status !== "loaded") {
    return model;
  }

  const repository = repositories.repositories.find(
    (candidate) => candidate.fullName === route.repo.toLowerCase(),
  );
  if (repository === undefined) {
    return model;
  }

  const pullRequests = repositories.pullRequests[repository.fullName];
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

  if (Repositories.pullRequestDetailKey(repository, number) in repositories.pullRequestDetails) {
    return model;
  }

  ctx.runCmd({ kind: "Repositories", cmd: { kind: "LoadPullRequestDetail", number, repository } });
  return model;
};

const [modelStore, setModelStore] = createStore<{ value: Model | null }>({ value: null });
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

const replaceModel = (nextModel: Model) => {
  batch(() => {
    setModelStore("value", null);
    setModelStore("value", nextModel);
  });
};

export const start = (
  user: User,
  route: Router.AuthenticatedRoute = Router.toAuthenticatedRoute(Router.getRoute()),
) => {
  replaceModel(createModel(user, route));
  send({ kind: "Started" });
};

export const stop = () => {
  Settings.applyTheme("system");
  setModelStore("value", null);
  messageQueue = [];
  processingMessages = false;
};

export const send = (msg: Msg) => {
  if (modelStore.value === null) {
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
      if (nextMsg === undefined || modelStore.value === null) {
        continue;
      }

      const model = unwrap(modelStore.value);
      const [nextModel, commands] = update(nextMsg, model);
      if (nextModel !== model) {
        replaceModel(nextModel);
      }
      commands.forEach((cmd) => runCmd(cmd));
    }
  } finally {
    processingMessages = false;
  }
};

Router.onStateChange((route) => {
  if (modelStore.value !== null) {
    send({ kind: "RouteChanged", route });
  }
});

export const useModel = <A>(selector: (model: Model) => A) => {
  return createMemo(() => {
    if (modelStore.value === null) {
      throw new Error("Authenticated model was read before a user was available");
    }

    return selector(modelStore.value);
  });
};

export const get = (): Model => {
  if (modelStore.value === null) {
    throw new Error("Authenticated model was read before a user was available");
  }

  return modelStore.value;
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
  setModelStore("value", null);
  messageQueue = [];
  processingMessages = false;
  runCmd = defaultRunCmd;
};
