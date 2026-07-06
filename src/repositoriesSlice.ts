import type { components } from "./api/schema";
import { api } from "./api/client";

export type Repository = components["schemas"]["RepositoryDto"];
export type AddError = "duplicate" | "invalid" | "saveFailed";

export type State =
  | {
      status: "loading";
      repositories: Repository[];
    }
  | {
      status: "loaded";
      repositories: Repository[];
      addStatus: "idle" | "saving" | "error";
      addError?: AddError;
    }
  | {
      status: "error";
      repositories: Repository[];
    };

export type Cmd =
  | {
      kind: "Load";
    }
  | {
      kind: "Add";
      repository: string;
    };

export type Msg =
  | { kind: "LoadRequested" }
  | { kind: "Loaded"; repositories: Repository[] }
  | { kind: "LoadFailed" }
  | { kind: "AddRequested"; repository: string }
  | { kind: "Added"; repository: Repository }
  | { kind: "AddFailed"; error: AddError };

type UpdateContext = {
  runCmd: (cmd: Cmd) => void;
};

export const initialState = (): State => {
  return { status: "loading", repositories: [] };
};

export const update = (ctx: UpdateContext, msg: Msg, state: State): State => {
  switch (msg.kind) {
    case "LoadRequested": {
      ctx.runCmd({ kind: "Load" });
      return state.status === "loaded"
        ? state
        : { status: "loading", repositories: state.repositories };
    }
    case "Loaded": {
      return {
        status: "loaded",
        repositories: msg.repositories,
        addStatus: "idle",
      };
    }
    case "LoadFailed": {
      return state.status === "loaded"
        ? state
        : { status: "error", repositories: state.repositories };
    }
    case "AddRequested": {
      if (state.status !== "loaded") {
        return state;
      }

      ctx.runCmd({ kind: "Add", repository: msg.repository });
      return {
        addStatus: "saving",
        repositories: state.repositories,
        status: "loaded",
      };
    }
    case "Added": {
      if (state.status !== "loaded") {
        return state;
      }

      return {
        addStatus: "idle",
        repositories: upsertRepository(state.repositories, msg.repository),
        status: "loaded",
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

const addError = (error: { error?: unknown } | undefined): AddError => {
  if (error?.error === "duplicate_repository") {
    return "duplicate";
  }
  if (error?.error === "invalid_repository") {
    return "invalid";
  }

  return "saveFailed";
};

const upsertRepository = (repositories: Repository[], repository: Repository): Repository[] => {
  const index = repositories.findIndex((existing) => existing.fullName === repository.fullName);
  if (index === -1) {
    return [...repositories, repository];
  }

  return repositories.map((existing, existingIndex) => {
    return existingIndex === index ? repository : existing;
  });
};
