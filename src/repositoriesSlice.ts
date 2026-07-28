import type { components } from "./api/schema";
import { api } from "./api/client";

export type Repository = components["schemas"]["RepositoryDto"];
export type PullRequest = components["schemas"]["PullRequestDto"];
export type PullRequestDetail = components["schemas"]["PullRequestDetailDto"];
export type PullRequestDiff = components["schemas"]["PullRequestDiffResponse"];
export type AddError = "duplicate" | "invalid" | "saveFailed";
export type PullRequestsError =
  | "authorizationRequired"
  | "pullRequestNotFound"
  | "repositoryNotTracked"
  | "syncFailed";

export type PullRequestsState =
  | {
      complete: false;
      error: null;
      nextPage: null;
      pullRequests: PullRequest[];
      status: "loading" | "syncing";
    }
  | {
      complete: boolean;
      error: null;
      nextPage: number | null;
      pullRequests: PullRequest[];
      status: "loaded";
    }
  | {
      complete: false;
      error: PullRequestsError;
      nextPage: null;
      pullRequests: PullRequest[];
      status: "error";
    };
export type PullRequestsByRepository = Record<string, PullRequestsState>;

export type PullRequestDetailState =
  | {
      detail: PullRequestDetail | null;
      error: null;
      status: "loading" | "syncing";
    }
  | {
      detail: PullRequestDetail;
      error: null;
      status: "loaded" | "loadingTimeline";
    }
  | {
      detail: PullRequestDetail | null;
      error: PullRequestsError;
      status: "error";
    }
  | {
      detail: PullRequestDetail;
      error: PullRequestsError;
      status: "timelineError";
    };
export type PullRequestDetailsByKey = Record<string, PullRequestDetailState>;

export type PullRequestDiffError =
  | "authenticationRequired"
  | "authorizationRequired"
  | "diffParseFailed"
  | "diffResourceLimitExceeded"
  | "diffUnavailable"
  | "invalidPullRequest"
  | "invalidRepository"
  | "pullRequestNotFound"
  | "repositoryNotTracked"
  | "loadFailed";
export type PullRequestDiffState =
  | { status: "loading"; diff: PullRequestDiff | null }
  | { status: "loaded"; diff: PullRequestDiff }
  | { status: "error"; diff: PullRequestDiff | null; error: PullRequestDiffError };
export type CurrentPullRequestDiff = {
  key: string;
  requestId: number;
  state: PullRequestDiffState;
};

export type State =
  | {
      status: "loading";
      currentPullRequestDiff: CurrentPullRequestDiff | null;
      pullRequestDiffRequestId: number;
      repositories: Repository[];
      pullRequestDetails: PullRequestDetailsByKey;
      pullRequests: PullRequestsByRepository;
    }
  | {
      status: "loaded";
      currentPullRequestDiff: CurrentPullRequestDiff | null;
      pullRequestDiffRequestId: number;
      repositories: Repository[];
      addStatus: "idle" | "saving" | "error";
      addError: AddError | null;
      pullRequestDetails: PullRequestDetailsByKey;
      pullRequests: PullRequestsByRepository;
    }
  | {
      status: "error";
      currentPullRequestDiff: CurrentPullRequestDiff | null;
      pullRequestDiffRequestId: number;
      repositories: Repository[];
      pullRequestDetails: PullRequestDetailsByKey;
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
    }
  | {
      kind: "LoadPullRequestDetail";
      number: number;
      repository: Repository;
    }
  | {
      kind: "LoadPullRequestDiff";
      number: number;
      repository: Repository;
      requestId: number;
    }
  | {
      kind: "SyncPullRequestDetail";
      number: number;
      repository: Repository;
    }
  | {
      kind: "LoadOlderPullRequestTimeline";
      number: number;
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
  | { kind: "PullRequestsSyncFailed"; error: PullRequestsError; repository: Repository }
  | { kind: "PullRequestDetailLoadRequested"; number: number; repository: Repository }
  | { kind: "PullRequestDiffDiscarded" }
  | { kind: "PullRequestDiffLoadRequested"; number: number; repository: Repository }
  | {
      diff: PullRequestDiff;
      kind: "PullRequestDiffLoaded";
      number: number;
      repository: Repository;
      requestId: number;
    }
  | {
      error: PullRequestDiffError;
      kind: "PullRequestDiffLoadFailed";
      number: number;
      repository: Repository;
      requestId: number;
    }
  | {
      detail: PullRequestDetail;
      kind: "PullRequestDetailLoaded";
      number: number;
      repository: Repository;
    }
  | {
      error: PullRequestsError;
      kind: "PullRequestDetailLoadFailed";
      number: number;
      repository: Repository;
    }
  | { kind: "PullRequestDetailSyncRequested"; number: number; repository: Repository }
  | {
      detail: PullRequestDetail;
      kind: "PullRequestDetailSynced";
      number: number;
      pullRequest: PullRequest;
      repository: Repository;
    }
  | {
      error: PullRequestsError;
      kind: "PullRequestDetailSyncFailed";
      number: number;
      repository: Repository;
    }
  | { kind: "PullRequestTimelineOlderRequested"; number: number; repository: Repository }
  | {
      detail: PullRequestDetail;
      kind: "PullRequestTimelineOlderLoaded";
      number: number;
      repository: Repository;
    }
  | {
      error: PullRequestsError;
      kind: "PullRequestTimelineOlderLoadFailed";
      number: number;
      repository: Repository;
    };

type UpdateContext = {
  runCmd: (cmd: Cmd) => void;
};

export const initialState = (pullRequestDiffRequestId = 0): State => {
  return {
    status: "loading",
    currentPullRequestDiff: null,
    pullRequestDiffRequestId,
    repositories: [],
    pullRequestDetails: {},
    pullRequests: {},
  };
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
        currentPullRequestDiff: state.currentPullRequestDiff,
        pullRequestDiffRequestId: state.pullRequestDiffRequestId,
        repositories: msg.repositories,
        addStatus: "idle",
        addError: null,
        pullRequestDetails: state.pullRequestDetails,
        pullRequests: state.pullRequests,
      };
    }
    case "LoadFailed": {
      return state.status === "loaded"
        ? state
        : {
            status: "error",
            currentPullRequestDiff: state.currentPullRequestDiff,
            pullRequestDiffRequestId: state.pullRequestDiffRequestId,
            repositories: state.repositories,
            pullRequestDetails: state.pullRequestDetails,
            pullRequests: state.pullRequests,
          };
    }
    case "AddRequested": {
      if (state.status !== "loaded" || state.addStatus === "saving") {
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
        pullRequests: msg.pullRequests,
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
    case "PullRequestDetailLoadRequested": {
      ctx.runCmd({ kind: "LoadPullRequestDetail", number: msg.number, repository: msg.repository });
      return setPullRequestDetailState(state, msg.repository, msg.number, {
        detail: currentPullRequestDetail(state, msg.repository, msg.number)?.detail ?? null,
        error: null,
        status: "loading",
      });
    }
    case "PullRequestDiffDiscarded": {
      return {
        ...state,
        currentPullRequestDiff: null,
        pullRequestDiffRequestId: state.pullRequestDiffRequestId + 1,
      };
    }
    case "PullRequestDiffLoadRequested": {
      const key = pullRequestDiffKey(msg.repository, msg.number);
      const current = state.currentPullRequestDiff;
      const requestId = state.pullRequestDiffRequestId + 1;
      const diff = current?.key === key ? current.state.diff : null;
      ctx.runCmd({
        kind: "LoadPullRequestDiff",
        number: msg.number,
        repository: msg.repository,
        requestId,
      });
      return {
        ...state,
        currentPullRequestDiff: { key, requestId, state: { diff, status: "loading" } },
        pullRequestDiffRequestId: requestId,
      };
    }
    case "PullRequestDiffLoaded": {
      const key = pullRequestDiffKey(msg.repository, msg.number);
      if (
        state.currentPullRequestDiff?.key !== key ||
        state.currentPullRequestDiff.requestId !== msg.requestId
      ) {
        return state;
      }
      return {
        ...state,
        currentPullRequestDiff: {
          key,
          requestId: msg.requestId,
          state: { diff: msg.diff, status: "loaded" },
        },
      };
    }
    case "PullRequestDiffLoadFailed": {
      const key = pullRequestDiffKey(msg.repository, msg.number);
      const current = state.currentPullRequestDiff;
      if (current?.key !== key || current.requestId !== msg.requestId) {
        return state;
      }
      return {
        ...state,
        currentPullRequestDiff: {
          key,
          requestId: msg.requestId,
          state: { diff: current.state.diff, error: msg.error, status: "error" },
        },
      };
    }
    case "PullRequestDetailLoaded": {
      return setPullRequestDetailState(state, msg.repository, msg.number, {
        detail: msg.detail,
        error: null,
        status: "loaded",
      });
    }
    case "PullRequestDetailLoadFailed": {
      return setPullRequestDetailState(state, msg.repository, msg.number, {
        detail: currentPullRequestDetail(state, msg.repository, msg.number)?.detail ?? null,
        error: msg.error,
        status: "error",
      });
    }
    case "PullRequestDetailSyncRequested": {
      ctx.runCmd({ kind: "SyncPullRequestDetail", number: msg.number, repository: msg.repository });
      return setPullRequestDetailState(state, msg.repository, msg.number, {
        detail: currentPullRequestDetail(state, msg.repository, msg.number)?.detail ?? null,
        error: null,
        status: "syncing",
      });
    }
    case "PullRequestDetailSynced": {
      const nextState = setPullRequestDetailState(state, msg.repository, msg.number, {
        detail: msg.detail,
        error: null,
        status: "loaded",
      });
      const pullRequests = nextState.pullRequests[msg.repository.fullName];
      if (pullRequests === undefined) {
        return nextState;
      }

      return setPullRequestsState(nextState, msg.repository, {
        ...pullRequests,
        pullRequests: upsertPullRequests(pullRequests.pullRequests, [msg.pullRequest]),
      });
    }
    case "PullRequestDetailSyncFailed": {
      return setPullRequestDetailState(state, msg.repository, msg.number, {
        detail: currentPullRequestDetail(state, msg.repository, msg.number)?.detail ?? null,
        error: msg.error,
        status: "error",
      });
    }
    case "PullRequestTimelineOlderRequested": {
      const current = currentPullRequestDetail(state, msg.repository, msg.number);
      if (
        current?.detail === null ||
        current?.detail === undefined ||
        !current.detail.timelineHasOlder ||
        current.status === "loadingTimeline"
      ) {
        return state;
      }

      ctx.runCmd({
        kind: "LoadOlderPullRequestTimeline",
        number: msg.number,
        repository: msg.repository,
      });
      return setPullRequestDetailState(state, msg.repository, msg.number, {
        detail: current.detail,
        error: null,
        status: "loadingTimeline",
      });
    }
    case "PullRequestTimelineOlderLoaded": {
      return setPullRequestDetailState(state, msg.repository, msg.number, {
        detail: msg.detail,
        error: null,
        status: "loaded",
      });
    }
    case "PullRequestTimelineOlderLoadFailed": {
      const detail = currentPullRequestDetail(state, msg.repository, msg.number)?.detail;
      if (detail === null || detail === undefined) {
        return state;
      }
      return setPullRequestDetailState(state, msg.repository, msg.number, {
        detail,
        error: msg.error,
        status: "timelineError",
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
    case "LoadPullRequestDetail": {
      void loadPullRequestDetail(cmd.repository, cmd.number, send);
      return;
    }
    case "LoadPullRequestDiff": {
      void loadPullRequestDiff(cmd.repository, cmd.number, cmd.requestId, send);
      return;
    }
    case "SyncPullRequestDetail": {
      void syncPullRequestDetail(cmd.repository, cmd.number, send);
      return;
    }
    case "LoadOlderPullRequestTimeline": {
      void loadOlderPullRequestTimeline(cmd.repository, cmd.number, send);
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

const loadPullRequestDetail = async (
  repository: Repository,
  number: number,
  send: (msg: Msg) => void,
) => {
  const { data, error } = await api.GET("/api/repositories/{owner}/{name}/pull-requests/{number}", {
    params: { path: { name: repository.name, number, owner: repository.owner } },
  });
  if (error || data === undefined) {
    send({
      error: pullRequestsError(error),
      kind: "PullRequestDetailLoadFailed",
      number,
      repository,
    });
    return;
  }

  send({ detail: data.pullRequestDetail, kind: "PullRequestDetailLoaded", number, repository });
};

const loadPullRequestDiff = async (
  repository: Repository,
  number: number,
  requestId: number,
  send: (msg: Msg) => void,
) => {
  try {
    const { data, error } = await api.GET(
      "/api/repositories/{owner}/{name}/pull-requests/{number}/diff",
      { params: { path: { name: repository.name, number, owner: repository.owner } } },
    );
    if (error || data === undefined) {
      send({
        error: pullRequestDiffError(error),
        kind: "PullRequestDiffLoadFailed",
        number,
        repository,
        requestId,
      });
      return;
    }

    send({ diff: data, kind: "PullRequestDiffLoaded", number, repository, requestId });
  } catch {
    send({
      error: "loadFailed",
      kind: "PullRequestDiffLoadFailed",
      number,
      repository,
      requestId,
    });
  }
};

const syncPullRequestDetail = async (
  repository: Repository,
  number: number,
  send: (msg: Msg) => void,
) => {
  try {
    const { data, error } = await api.POST(
      "/api/repositories/{owner}/{name}/pull-requests/{number}/sync",
      {
        params: { path: { name: repository.name, number, owner: repository.owner } },
      },
    );
    if (error || data === undefined) {
      send({
        error: pullRequestsError(error),
        kind: "PullRequestDetailSyncFailed",
        number,
        repository,
      });
      return;
    }

    send({
      detail: data.pullRequestDetail,
      kind: "PullRequestDetailSynced",
      number,
      pullRequest: data.pullRequest,
      repository,
    });
  } catch {
    send({ error: "syncFailed", kind: "PullRequestDetailSyncFailed", number, repository });
  }
};

const loadOlderPullRequestTimeline = async (
  repository: Repository,
  number: number,
  send: (msg: Msg) => void,
) => {
  const { data, error } = await api.POST(
    "/api/repositories/{owner}/{name}/pull-requests/{number}/timeline/older",
    {
      params: { path: { name: repository.name, number, owner: repository.owner } },
    },
  );
  if (error || data === undefined) {
    send({
      error: pullRequestsError(error),
      kind: "PullRequestTimelineOlderLoadFailed",
      number,
      repository,
    });
    return;
  }

  send({
    detail: data.pullRequestDetail,
    kind: "PullRequestTimelineOlderLoaded",
    number,
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
  if (error?.error === "pull_request_not_found") {
    return "pullRequestNotFound";
  }

  return "syncFailed";
};

const pullRequestDiffError = (error: { error?: unknown } | undefined): PullRequestDiffError => {
  switch (error?.error) {
    case "authentication_required":
      return "authenticationRequired";
    case "authorization_required":
      return "authorizationRequired";
    case "diff_parse_failed":
      return "diffParseFailed";
    case "diff_resource_limit_exceeded":
      return "diffResourceLimitExceeded";
    case "diff_unavailable":
      return "diffUnavailable";
    case "invalid_pull_request":
      return "invalidPullRequest";
    case "invalid_repository":
      return "invalidRepository";
    case "pull_request_not_found":
      return "pullRequestNotFound";
    case "repository_not_tracked":
      return "repositoryNotTracked";
    default:
      return "loadFailed";
  }
};

export const pullRequestDetailKey = (repository: Repository, number: number): string => {
  return `${repository.fullName}#${number}`;
};

export const pullRequestDiffKey = (repository: Repository, number: number): string => {
  return `${repository.fullName}#${number}`;
};

const currentPullRequestDetail = (
  state: State,
  repository: Repository,
  number: number,
): PullRequestDetailState | undefined => {
  return state.pullRequestDetails[pullRequestDetailKey(repository, number)];
};

const setPullRequestDetailState = (
  state: State,
  repository: Repository,
  number: number,
  detailState: PullRequestDetailState,
): State => {
  return {
    ...state,
    pullRequestDetails: {
      ...state.pullRequestDetails,
      [pullRequestDetailKey(repository, number)]: detailState,
    },
  };
};

const currentPullRequests = (state: State, repository: Repository): PullRequest[] => {
  return state.pullRequests[repository.fullName]?.pullRequests ?? [];
};

const setPullRequestsState = (
  state: State,
  repository: Repository,
  pullRequestsState: PullRequestsState,
): State => {
  return {
    ...state,
    pullRequests: {
      ...state.pullRequests,
      [repository.fullName]: pullRequestsState,
    },
  };
};

const upsertRepository = (repositories: Repository[], repository: Repository): Repository[] => {
  const index = repositories.findIndex((existing) => existing.fullName === repository.fullName);
  if (index === -1) {
    return [...repositories, repository];
  }

  return repositories.map((existing, currentIndex) =>
    currentIndex === index ? repository : existing,
  );
};

const upsertPullRequests = (existing: PullRequest[], incoming: PullRequest[]): PullRequest[] => {
  const byNumber = new globalThis.Map(
    existing.map((pullRequest) => [pullRequest.number, pullRequest]),
  );
  incoming.forEach((pullRequest) => byNumber.set(pullRequest.number, pullRequest));

  return Array.from(byNumber.values()).sort((a, b) => {
    const createdAtOrder = b.createdAt.localeCompare(a.createdAt);
    return createdAtOrder === 0 ? b.number - a.number : createdAtOrder;
  });
};
