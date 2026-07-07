import { List, Map } from "immutable";
import type { components } from "./api/schema";
import { api } from "./api/client";

export type Repository = components["schemas"]["RepositoryDto"];
export type PullRequest = components["schemas"]["PullRequestDto"];
export type AddError = "duplicate" | "invalid" | "saveFailed";
export type PullRequestsError = "authorizationRequired" | "repositoryNotTracked" | "syncFailed";

export type PullRequestsState =
  | {
      complete: false;
      error: null;
      nextPage: null;
      pullRequests: List<PullRequest>;
      status: "loading" | "syncing";
    }
  | {
      complete: boolean;
      error: null;
      nextPage: number | null;
      pullRequests: List<PullRequest>;
      status: "loaded";
    }
  | {
      complete: false;
      error: PullRequestsError;
      nextPage: null;
      pullRequests: List<PullRequest>;
      status: "error";
    };
export type PullRequestsByRepository = Map<string, PullRequestsState>;

export type State =
  | {
      status: "loading";
      repositories: List<Repository>;
      pullRequests: PullRequestsByRepository;
    }
  | {
      status: "loaded";
      repositories: List<Repository>;
      addStatus: "idle" | "saving" | "error";
      addError: AddError | null;
      pullRequests: PullRequestsByRepository;
    }
  | {
      status: "error";
      repositories: List<Repository>;
      pullRequests: PullRequestsByRepository;
    };

export type Cmd =
  | {
      kind: "Load";
    }
  | {
      kind: "Add";
      repository: string;
    }
  | {
      kind: "LoadPullRequests";
      repository: Repository;
    }
  | {
      kind: "SyncPullRequests";
      repository: Repository;
    };

export type Msg =
  | { kind: "LoadRequested" }
  | { kind: "Loaded"; repositories: Repository[] }
  | { kind: "LoadFailed" }
  | { kind: "AddRequested"; repository: string }
  | { kind: "Added"; repository: Repository }
  | { kind: "AddFailed"; error: AddError }
  | { kind: "PullRequestsLoadRequested"; repository: Repository }
  | { kind: "PullRequestsLoaded"; pullRequests: PullRequest[]; repository: Repository }
  | { kind: "PullRequestsLoadFailed"; error: PullRequestsError; repository: Repository }
  | { kind: "PullRequestsSyncRequested"; repository: Repository }
  | {
      complete: boolean;
      kind: "PullRequestsSynced";
      nextPage?: number | null | undefined;
      pullRequests: PullRequest[];
      repository: Repository;
    }
  | { kind: "PullRequestsSyncFailed"; error: PullRequestsError; repository: Repository };

type UpdateContext = {
  runCmd: (cmd: Cmd) => void;
};

export const initialState = (): State => {
  return { status: "loading", repositories: List(), pullRequests: Map() };
};

export const update = (ctx: UpdateContext, msg: Msg, state: State): State => {
  switch (msg.kind) {
    case "LoadRequested": {
      ctx.runCmd({ kind: "Load" });
      return state.status === "loaded"
        ? state
        : { ...state, status: "loading", repositories: state.repositories };
    }
    case "Loaded": {
      return {
        status: "loaded",
        repositories: List(msg.repositories),
        addStatus: "idle",
        addError: null,
        pullRequests: state.pullRequests,
      };
    }
    case "LoadFailed": {
      return state.status === "loaded"
        ? state
        : { status: "error", repositories: state.repositories, pullRequests: state.pullRequests };
    }
    case "AddRequested": {
      if (state.status !== "loaded") {
        return state;
      }

      ctx.runCmd({ kind: "Add", repository: msg.repository });
      return {
        ...state,
        addStatus: "saving",
        addError: null,
      };
    }
    case "Added": {
      if (state.status !== "loaded") {
        return state;
      }

      return {
        ...state,
        addStatus: "idle",
        addError: null,
        repositories: upsertRepository(state.repositories, msg.repository),
      };
    }
    case "AddFailed": {
      if (state.status !== "loaded") {
        return state;
      }

      return {
        ...state,
        addError: msg.error,
        addStatus: "error",
      };
    }
    case "PullRequestsLoadRequested": {
      ctx.runCmd({ kind: "LoadPullRequests", repository: msg.repository });
      return setPullRequestsState(state, msg.repository, {
        complete: false,
        error: null,
        nextPage: null,
        pullRequests: currentPullRequests(state, msg.repository),
        status: "loading",
      });
    }
    case "PullRequestsLoaded": {
      return setPullRequestsState(state, msg.repository, {
        complete: false,
        error: null,
        nextPage: null,
        pullRequests: List(msg.pullRequests),
        status: "loaded",
      });
    }
    case "PullRequestsLoadFailed": {
      return setPullRequestsState(state, msg.repository, {
        complete: false,
        error: msg.error,
        nextPage: null,
        pullRequests: currentPullRequests(state, msg.repository),
        status: "error",
      });
    }
    case "PullRequestsSyncRequested": {
      ctx.runCmd({ kind: "SyncPullRequests", repository: msg.repository });
      return setPullRequestsState(state, msg.repository, {
        complete: false,
        error: null,
        nextPage: null,
        pullRequests: currentPullRequests(state, msg.repository),
        status: "syncing",
      });
    }
    case "PullRequestsSynced": {
      return setPullRequestsState(state, msg.repository, {
        complete: msg.complete,
        error: null,
        nextPage: msg.nextPage ?? null,
        pullRequests: upsertPullRequests(
          currentPullRequests(state, msg.repository),
          msg.pullRequests,
        ),
        status: "loaded",
      });
    }
    case "PullRequestsSyncFailed": {
      return setPullRequestsState(state, msg.repository, {
        complete: false,
        error: msg.error,
        nextPage: null,
        pullRequests: currentPullRequests(state, msg.repository),
        status: "error",
      });
    }
  }
};

export const runCmd = (cmd: Cmd, send: (msg: Msg) => void) => {
  switch (cmd.kind) {
    case "Load": {
      void loadRepositories(send);
      return;
    }
    case "Add": {
      void addRepository(cmd.repository, send);
      return;
    }
    case "LoadPullRequests": {
      void loadPullRequests(cmd.repository, send);
      return;
    }
    case "SyncPullRequests": {
      void syncPullRequests(cmd.repository, send);
      return;
    }
  }
};

const loadRepositories = async (send: (msg: Msg) => void) => {
  const { data, error } = await api.GET("/api/repositories");
  if (error || data === undefined) {
    send({ kind: "LoadFailed" });
    return;
  }

  send({ kind: "Loaded", repositories: data.repositories });
};

const addRepository = async (repository: string, send: (msg: Msg) => void) => {
  const { data, error } = await api.POST("/api/repositories", { body: { repository } });
  if (error || data === undefined) {
    send({ kind: "AddFailed", error: addError(error) });
    return;
  }

  send({ kind: "Added", repository: data.repository });
};

const loadPullRequests = async (repository: Repository, send: (msg: Msg) => void) => {
  const { data, error } = await api.GET("/api/repositories/{owner}/{name}/pull-requests", {
    params: { path: { name: repository.name, owner: repository.owner } },
  });
  if (error || data === undefined) {
    send({ error: pullRequestsError(error), kind: "PullRequestsLoadFailed", repository });
    return;
  }

  send({ kind: "PullRequestsLoaded", pullRequests: data.pullRequests, repository });
};

const syncPullRequests = async (repository: Repository, send: (msg: Msg) => void) => {
  const { data, error } = await api.POST("/api/repositories/{owner}/{name}/pull-requests/sync", {
    params: { path: { name: repository.name, owner: repository.owner } },
  });
  if (error || data === undefined) {
    send({ error: pullRequestsError(error), kind: "PullRequestsSyncFailed", repository });
    return;
  }

  send({
    complete: data.complete,
    kind: "PullRequestsSynced",
    nextPage: data.nextPage,
    pullRequests: data.pullRequests,
    repository,
  });
};

const addError = (error: { error?: unknown } | undefined): AddError => {
  if (error?.error === "duplicate_repository") {
    return "duplicate";
  }
  if (error?.error === "invalid_repository") {
    return "invalid";
  }

  return "saveFailed";
};

const pullRequestsError = (error: { error?: unknown } | undefined): PullRequestsError => {
  if (error?.error === "authorization_required") {
    return "authorizationRequired";
  }
  if (error?.error === "repository_not_tracked") {
    return "repositoryNotTracked";
  }

  return "syncFailed";
};

const currentPullRequests = (state: State, repository: Repository): List<PullRequest> => {
  return state.pullRequests.get(repository.fullName)?.pullRequests ?? List();
};

const setPullRequestsState = (
  state: State,
  repository: Repository,
  pullRequestsState: PullRequestsState,
): State => {
  return {
    ...state,
    pullRequests: state.pullRequests.set(repository.fullName, pullRequestsState),
  };
};

const upsertRepository = (
  repositories: List<Repository>,
  repository: Repository,
): List<Repository> => {
  const index = repositories.findIndex((existing) => existing.fullName === repository.fullName);
  if (index === -1) {
    return repositories.push(repository);
  }

  return repositories.set(index, repository);
};

const upsertPullRequests = (
  existing: List<PullRequest>,
  incoming: PullRequest[],
): List<PullRequest> => {
  const byNumber = new globalThis.Map(
    existing.map((pullRequest) => [pullRequest.number, pullRequest]),
  );
  incoming.forEach((pullRequest) => byNumber.set(pullRequest.number, pullRequest));

  return List(
    Array.from(byNumber.values()).sort((a, b) => {
      const createdAtOrder = b.createdAt.localeCompare(a.createdAt);
      return createdAtOrder === 0 ? b.number - a.number : createdAtOrder;
    }),
  );
};
