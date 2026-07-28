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

export type State = {
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

const createInitialState = (
  user: User,
  route: Router.AuthenticatedRoute,
  pullRequestDiffRequestId = 0,
): State => {
  return {
    count: 0,
    repositories: Repositories.initialState(pullRequestDiffRequestId),
    route,
    settings: Settings.fromCache(user.id),
    user,
  };
};

const settingsCmd = (cmd: Settings.Cmd): Cmd => ({ kind: "Settings", cmd });
const repositoriesCmd = (cmd: Repositories.Cmd): Cmd => ({ kind: "Repositories", cmd });

export const update = (msg: Msg, state: State): Mvu.Transition<State, Cmd> => {
  switch (msg.kind) {
    case "Started": {
      return [
        state,
        Mvu.Cmd.batch(
          Mvu.Cmd.map(settingsCmd, Settings.initialCommands(state.settings)),
          Mvu.Cmd.of(repositoriesCmd({ kind: "Load" })),
        ),
      ];
    }
    case "CountIncrement": {
      return [{ ...state, count: state.count + 1 }, Mvu.Cmd.none()];
    }
    case "CountDecrement": {
      return [{ ...state, count: state.count - 1 }, Mvu.Cmd.none()];
    }
    case "RouteRequested": {
      if (Router.equal(state.route, msg.route)) {
        return [state, Mvu.Cmd.none()];
      }

      return [state, Mvu.Cmd.of({ kind: "Navigate", route: msg.route, replace: msg.replace })];
    }
    case "RouteChanged": {
      const commands: Cmd[] = [];
      const ctx: RepositoryUpdateContext = { runCmd: (cmd) => commands.push(cmd) };
      const route = Router.toAuthenticatedRoute(msg.route);
      if (msg.route.name === "Login") {
        ctx.runCmd({ kind: "Navigate", route: { name: "Home" }, replace: true });
      }

      if (Router.equal(state.route, route)) {
        return [state, commands];
      }

      return [
        queuePullRequestRouteWork(
          ctx,
          { ...state, route },
          {
            retryDiffError: true,
            syncMissing: true,
          },
        ),
        commands,
      ];
    }
    case "Settings": {
      const [settings, commands] = Settings.update(msg.msg, state.settings);

      return [{ ...state, settings }, Mvu.Cmd.map(settingsCmd, commands)];
    }
    case "Repositories": {
      const commands: Cmd[] = [];
      const ctx: RepositoryUpdateContext = { runCmd: (cmd) => commands.push(cmd) };
      let repositories = Repositories.update(
        {
          runCmd: (cmd) => ctx.runCmd(repositoriesCmd(cmd)),
        },
        msg.msg,
        state.repositories,
      );
      if (msg.msg.kind === "PullRequestDetailSynced") {
        const key = Repositories.pullRequestDiffKey(msg.msg.repository, msg.msg.number);
        if (repositories.currentPullRequestDiff?.key === key) {
          repositories = Repositories.update(
            { runCmd: (cmd) => ctx.runCmd(repositoriesCmd(cmd)) },
            {
              kind: "PullRequestDiffLoadRequested",
              number: msg.msg.number,
              repository: msg.msg.repository,
            },
            repositories,
          );
        }
      }

      return [
        queuePullRequestRouteWork(
          ctx,
          { ...state, repositories },
          {
            retryDiffError: false,
            syncMissing: msg.msg.kind === "PullRequestsLoaded",
          },
        ),
        commands,
      ];
    }
    case "UserRefreshed": {
      if (state.user.id === msg.user.id) {
        return [{ ...state, user: msg.user }, Mvu.Cmd.none()];
      }

      const nextState = createInitialState(
        msg.user,
        state.route,
        state.repositories.pullRequestDiffRequestId,
      );
      return [
        nextState,
        Mvu.Cmd.batch(
          Mvu.Cmd.map(settingsCmd, Settings.initialCommands(nextState.settings)),
          Mvu.Cmd.of(repositoriesCmd({ kind: "Load" })),
        ),
      ];
    }
  }
};

const queuePullRequestRouteWork = (
  ctx: RepositoryUpdateContext,
  state: State,
  options: { retryDiffError: boolean; syncMissing: boolean },
): State => {
  const route = state.route;
  if (route.name !== "PullRequest") {
    return state;
  }

  const number = Number(route.id);
  const routeKey =
    Number.isInteger(number) && number > 0 ? `${route.repo.toLowerCase()}#${number}` : null;
  let repositories = state.repositories;
  let nextState = state;
  if (
    repositories.currentPullRequestDiff !== null &&
    repositories.currentPullRequestDiff.key !== routeKey
  ) {
    repositories = Repositories.update(
      { runCmd: (cmd) => ctx.runCmd(repositoriesCmd(cmd)) },
      { kind: "PullRequestDiffDiscarded" },
      repositories,
    );
    nextState = { ...state, repositories };
  }

  if (repositories.status !== "loaded") {
    return nextState;
  }

  const repository = repositories.repositories.find(
    (candidate) => candidate.fullName === route.repo.toLowerCase(),
  );
  if (repository === undefined) {
    return nextState;
  }

  const pullRequests = repositories.pullRequests[repository.fullName];
  if (pullRequests === undefined) {
    ctx.runCmd({ kind: "Repositories", cmd: { kind: "LoadPullRequests", repository } });
    return nextState;
  }

  if (!Number.isInteger(number) || number <= 0 || pullRequests.status !== "loaded") {
    return nextState;
  }

  const hasPullRequest = pullRequests.pullRequests.some(
    (pullRequest) => pullRequest.number === number,
  );
  if (!hasPullRequest) {
    if (!options.syncMissing || pullRequests.complete) {
      return nextState;
    }

    ctx.runCmd({ kind: "Repositories", cmd: { kind: "SyncPullRequests", repository } });
    return nextState;
  }

  if (route.view === "diff") {
    const key = Repositories.pullRequestDiffKey(repository, number);
    if (
      repositories.currentPullRequestDiff?.key === key &&
      !(options.retryDiffError && repositories.currentPullRequestDiff.state.status === "error")
    ) {
      return nextState;
    }

    const nextRepositories = Repositories.update(
      { runCmd: (cmd) => ctx.runCmd(repositoriesCmd(cmd)) },
      { kind: "PullRequestDiffLoadRequested", number, repository },
      repositories,
    );
    return { ...nextState, repositories: nextRepositories };
  }

  if (Repositories.pullRequestDetailKey(repository, number) in repositories.pullRequestDetails) {
    return nextState;
  }

  const nextRepositories = Repositories.update(
    { runCmd: (cmd) => ctx.runCmd(repositoriesCmd(cmd)) },
    { kind: "PullRequestDetailLoadRequested", number, repository },
    nextState.repositories,
  );
  return { ...nextState, repositories: nextRepositories };
};

const [store, setStore] = createStore<{ value: State | null }>({ value: null });
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

const replaceState = (nextState: State) => {
  batch(() => {
    setStore("value", null);
    setStore("value", nextState);
  });
};

export const start = (
  user: User,
  route: Router.AuthenticatedRoute = Router.toAuthenticatedRoute(Router.getRoute()),
) => {
  replaceState(createInitialState(user, route));
  send({ kind: "Started" });
};

export const stop = () => {
  Settings.applyTheme("system");
  setStore("value", null);
  messageQueue = [];
  processingMessages = false;
};

export const send = (msg: Msg) => {
  if (store.value === null) {
    throw new Error("Authenticated store was updated before a user was available");
  }

  messageQueue.push(msg);
  if (processingMessages) {
    return;
  }

  processingMessages = true;
  try {
    while (messageQueue.length > 0) {
      const nextMsg = messageQueue.shift();
      if (nextMsg === undefined || store.value === null) {
        continue;
      }

      const state = unwrap(store.value);
      const [nextState, commands] = update(nextMsg, state);
      if (nextState !== state) {
        replaceState(nextState);
      }
      commands.forEach((cmd) => runCmd(cmd));
    }
  } finally {
    processingMessages = false;
  }
};

Router.onStateChange((route) => {
  if (store.value !== null) {
    send({ kind: "RouteChanged", route });
  }
});

export const appStore = <A>(selector: (state: State) => A) => {
  return createMemo(() => {
    if (store.value === null) {
      throw new Error("Authenticated store was read before a user was available");
    }

    return selector(store.value);
  });
};

export const get = (): State => {
  if (store.value === null) {
    throw new Error("Authenticated store was read before a user was available");
  }

  return store.value;
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
  setStore("value", null);
  messageQueue = [];
  processingMessages = false;
  runCmd = defaultRunCmd;
};
