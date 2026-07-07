import { waitFor } from "@testing-library/react";
import { List } from "immutable";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Repositories from "./repositoriesSlice";

const repository = (fullName: string): Repositories.Repository => {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    createdAt: "2026-01-01T00:00:00Z",
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    name,
    owner,
  };
};

const pullRequest = (
  number: number,
  createdAt = "2026-01-01T00:00:00Z",
): Repositories.PullRequest => {
  return {
    authorLogin: "octocat",
    closedAt: null,
    createdAt,
    draft: false,
    githubId: 1000 + number,
    htmlUrl: `https://github.com/kestrel/app/pull/${number}`,
    mergedAt: null,
    number,
    state: "open",
    syncedAt: "2026-01-03T00:00:00Z",
    title: `PR ${number}`,
    updatedAt: "2026-01-02T00:00:00Z",
  };
};

const update = (state: Repositories.State, msg: Repositories.Msg) => {
  const cmds: Repositories.Cmd[] = [];
  const nextState = Repositories.update(
    {
      runCmd: (cmd) => cmds.push(cmd),
    },
    msg,
    state,
  );

  return { cmds, state: nextState };
};

const jsonResponse = (body: unknown, status = 200) => {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
};

type LoadedState = Extract<Repositories.State, { status: "loaded" }>;

const loadedState = (repositories: Repositories.Repository[] = []): LoadedState => {
  return {
    addError: null,
    addStatus: "idle",
    pullRequests: Repositories.initialState().pullRequests,
    repositories: List(repositories),
    status: "loaded",
  };
};

describe("repositoriesSlice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads repositories", () => {
    const repositories = [repository("kestrel/app")];

    const result = update(Repositories.initialState(), { kind: "Loaded", repositories });

    expect(result.state.status).toBe("loaded");
    if (result.state.status === "loaded") {
      expect(result.state.addStatus).toBe("idle");
      expect(result.state.repositories.toArray()).toEqual(repositories);
    }
    expect(result.cmds).toEqual([]);
  });

  it("requests repository loading", () => {
    const result = update(
      { ...Repositories.initialState(), status: "error" },
      {
        kind: "LoadRequested",
      },
    );

    expect(result.state.repositories.toArray()).toEqual([]);
    expect(result.state.status).toBe("loading");
    expect(result.cmds).toEqual([{ kind: "Load" }]);
  });

  it("requests adding repositories", () => {
    const state: Repositories.State = {
      ...loadedState(),
      addError: "duplicate",
      addStatus: "error",
    };

    const result = update(state, { kind: "AddRequested", repository: "Kestrel/App" });

    expect(result.state.status).toBe("loaded");
    if (result.state.status === "loaded") {
      expect(result.state.addError).toBe(null);
      expect(result.state.addStatus).toBe("saving");
      expect(result.state.repositories.toArray()).toEqual([]);
    }
    expect(result.cmds).toEqual([{ kind: "Add", repository: "Kestrel/App" }]);
  });

  it("ignores add requests while saving", () => {
    const state: Repositories.State = { ...loadedState(), addStatus: "saving" };

    const result = update(state, { kind: "AddRequested", repository: "Kestrel/App" });

    expect(result.state).toBe(state);
    expect(result.cmds).toEqual([]);
  });

  it("adds returned repositories", () => {
    const existing = repository("kestrel/old");
    const added = repository("kestrel/app");
    const state: Repositories.State = { ...loadedState([existing]), addStatus: "saving" };

    const result = update(state, { kind: "Added", repository: added });

    expect(result.state.status).toBe("loaded");
    if (result.state.status === "loaded") {
      expect(result.state.addStatus).toBe("idle");
      expect(result.state.repositories.toArray()).toEqual([existing, added]);
    }
  });

  it("stores add failures without dropping repositories", () => {
    const repositories = [repository("kestrel/app")];
    const state: Repositories.State = { ...loadedState(repositories), addStatus: "saving" };

    const result = update(state, { error: "duplicate", kind: "AddFailed" });

    expect(result.state.status).toBe("loaded");
    if (result.state.status === "loaded") {
      expect(result.state.addError).toBe("duplicate");
      expect(result.state.addStatus).toBe("error");
      expect(result.state.repositories.toArray()).toEqual(repositories);
    }
  });

  it("requests pull request loading", () => {
    const repo = repository("kestrel/app");
    const state = loadedState([repo]);

    const result = update(state, { kind: "PullRequestsLoadRequested", repository: repo });
    const pullRequests = result.state.pullRequests.get("kestrel/app");

    expect(result.state.status).toBe("loaded");
    if (result.state.status === "loaded") {
      expect(result.state.addStatus).toBe("idle");
      expect(result.state.repositories.toArray()).toEqual([repo]);
    }
    expect(pullRequests?.pullRequests.toArray()).toEqual([]);
    expect(pullRequests?.status).toBe("loading");
    expect(result.cmds).toEqual([{ kind: "LoadPullRequests", repository: repo }]);
  });

  it("merges synced pull requests by number", () => {
    const repo = repository("kestrel/app");
    const oldPullRequest = pullRequest(1, "2026-01-01T00:00:00Z");
    const updatedPullRequest = { ...oldPullRequest, title: "Updated PR 1" };
    const newPullRequest = pullRequest(2, "2026-01-02T00:00:00Z");
    const state = update(loadedState([repo]), {
      kind: "PullRequestsLoaded",
      pullRequests: [oldPullRequest],
      repository: repo,
    }).state;

    const result = update(state, {
      complete: false,
      kind: "PullRequestsSynced",
      nextPage: 2,
      pullRequests: [updatedPullRequest, newPullRequest],
      repository: repo,
    });

    const pullRequests = result.state.pullRequests.get("kestrel/app");

    expect(pullRequests?.complete).toBe(false);
    expect(pullRequests?.nextPage).toBe(2);
    expect(pullRequests?.pullRequests.toArray()).toEqual([newPullRequest, updatedPullRequest]);
    expect(pullRequests?.status).toBe("loaded");
    expect(result.cmds).toEqual([]);
  });

  it("loads repositories from the backend", async () => {
    const repositories = [repository("kestrel/app")];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ repositories })),
    );
    const messages: Repositories.Msg[] = [];

    Repositories.runCmd({ kind: "Load" }, (msg) => messages.push(msg));

    await waitFor(() => expect(messages).toEqual([{ kind: "Loaded", repositories }]));
  });

  it("loads pull requests from the backend", async () => {
    const repo = repository("kestrel/app");
    const pullRequests = [pullRequest(42)];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ pullRequests })),
    );
    const messages: Repositories.Msg[] = [];

    Repositories.runCmd({ kind: "LoadPullRequests", repository: repo }, (msg) =>
      messages.push(msg),
    );

    await waitFor(() =>
      expect(messages).toEqual([{ kind: "PullRequestsLoaded", pullRequests, repository: repo }]),
    );
  });

  it("maps authorization failures when syncing pull requests", async () => {
    const repo = repository("kestrel/app");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "authorization_required" }, 403)),
    );
    const messages: Repositories.Msg[] = [];

    Repositories.runCmd({ kind: "SyncPullRequests", repository: repo }, (msg) =>
      messages.push(msg),
    );

    await waitFor(() =>
      expect(messages).toEqual([
        { error: "authorizationRequired", kind: "PullRequestsSyncFailed", repository: repo },
      ]),
    );
  });

  it("maps duplicate add failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "duplicate_repository" }, 409)),
    );
    const messages: Repositories.Msg[] = [];

    Repositories.runCmd({ kind: "Add", repository: "Kestrel/App" }, (msg) => messages.push(msg));

    await waitFor(() => expect(messages).toEqual([{ error: "duplicate", kind: "AddFailed" }]));
  });
});
