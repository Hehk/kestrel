import { waitFor } from "@solidjs/testing-library";
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

const pullRequestDetail = (): Repositories.PullRequestDetail => ({
  body: "Adds syncing.",
  checkRuns: [],
  commits: [],
  files: [],
  issueComments: [],
  reviewComments: [],
  reviewDecision: "APPROVED",
  reviews: [],
  statuses: [],
  syncedAt: "2026-01-04T00:00:00Z",
  timeline: [],
  timelineHasOlder: false,
});

const pullRequestDiff = (): Repositories.PullRequestDiff => ({
  files: [
    {
      additions: 2,
      binary: false,
      deletions: 1,
      hunks: [
        {
          context: "fn main()",
          lines: [
            {
              content: "old line",
              kind: "deletion",
              missingNewline: false,
              newLine: null,
              oldLine: 1,
            },
            {
              content: "new line",
              kind: "addition",
              missingNewline: false,
              newLine: 1,
              oldLine: null,
            },
          ],
          newCount: 1,
          newStart: 1,
          oldCount: 1,
          oldStart: 1,
        },
      ],
      newMode: "100644",
      newPath: "src/main.rs",
      oldMode: "100644",
      oldPath: "src/main.rs",
      operation: "modified",
    },
  ],
  syncedAt: "2026-01-04T00:00:00Z",
});

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
    currentPullRequestDiff: null,
    pullRequestDiffRequestId: 0,
    pullRequestDetails: Repositories.initialState().pullRequestDetails,
    pullRequests: Repositories.initialState().pullRequests,
    repositories,
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
      expect(result.state.repositories).toEqual(repositories);
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

    expect(result.state.repositories).toEqual([]);
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
      expect(result.state.repositories).toEqual([]);
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
      expect(result.state.repositories).toEqual([existing, added]);
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
      expect(result.state.repositories).toEqual(repositories);
    }
  });

  it("requests pull request loading", () => {
    const repo = repository("kestrel/app");
    const state = loadedState([repo]);

    const result = update(state, { kind: "PullRequestsLoadRequested", repository: repo });
    const pullRequests = result.state.pullRequests["kestrel/app"];

    expect(result.state.status).toBe("loaded");
    if (result.state.status === "loaded") {
      expect(result.state.addStatus).toBe("idle");
      expect(result.state.repositories).toEqual([repo]);
    }
    expect(pullRequests?.pullRequests).toEqual([]);
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

    const pullRequests = result.state.pullRequests["kestrel/app"];

    expect(pullRequests?.complete).toBe(false);
    expect(pullRequests?.nextPage).toBe(2);
    expect(pullRequests?.pullRequests).toEqual([newPullRequest, updatedPullRequest]);
    expect(pullRequests?.status).toBe("loaded");
    expect(result.cmds).toEqual([]);
  });

  it("updates the current pull request summary and detail together", () => {
    const repo = repository("kestrel/app");
    const oldPullRequest = pullRequest(42);
    const updatedPullRequest = { ...oldPullRequest, state: "closed", title: "Updated PR" };
    const state = update(loadedState([repo]), {
      kind: "PullRequestsLoaded",
      pullRequests: [oldPullRequest],
      repository: repo,
    }).state;

    const result = update(state, {
      detail: pullRequestDetail(),
      kind: "PullRequestDetailSynced",
      number: 42,
      pullRequest: updatedPullRequest,
      repository: repo,
    });

    expect(result.state.pullRequests[repo.fullName]?.pullRequests).toEqual([updatedPullRequest]);
    expect(result.state.pullRequestDetails[Repositories.pullRequestDetailKey(repo, 42)]).toEqual({
      detail: pullRequestDetail(),
      error: null,
      status: "loaded",
    });
  });

  it("loads one current pull request diff and preserves stale data while refreshing", () => {
    const repo = repository("kestrel/app");
    const diff = pullRequestDiff();
    const requested = update(loadedState([repo]), {
      kind: "PullRequestDiffLoadRequested",
      number: 42,
      repository: repo,
    });

    expect(requested.cmds).toEqual([
      { kind: "LoadPullRequestDiff", number: 42, repository: repo, requestId: 1 },
    ]);
    expect(requested.state.currentPullRequestDiff).toEqual({
      key: "kestrel/app#42",
      requestId: 1,
      state: { diff: null, status: "loading" },
    });

    const loaded = update(requested.state, {
      diff,
      kind: "PullRequestDiffLoaded",
      number: 42,
      repository: repo,
      requestId: 1,
    });
    const refreshing = update(loaded.state, {
      kind: "PullRequestDiffLoadRequested",
      number: 42,
      repository: repo,
    });

    expect(refreshing.state.currentPullRequestDiff).toEqual({
      key: "kestrel/app#42",
      requestId: 2,
      state: { diff, status: "loading" },
    });
    expect(refreshing.cmds).toEqual([
      { kind: "LoadPullRequestDiff", number: 42, repository: repo, requestId: 2 },
    ]);

    const failed = update(refreshing.state, {
      error: "loadFailed",
      kind: "PullRequestDiffLoadFailed",
      number: 42,
      repository: repo,
      requestId: 2,
    });
    expect(failed.state.currentPullRequestDiff?.state).toEqual({
      diff,
      error: "loadFailed",
      status: "error",
    });
  });

  it("replaces the current diff and ignores superseded responses", () => {
    const repo = repository("kestrel/app");
    const first = update(loadedState([repo]), {
      kind: "PullRequestDiffLoadRequested",
      number: 42,
      repository: repo,
    });
    const second = update(first.state, {
      kind: "PullRequestDiffLoadRequested",
      number: 43,
      repository: repo,
    });

    expect(second.state.currentPullRequestDiff).toEqual({
      key: "kestrel/app#43",
      requestId: 2,
      state: { diff: null, status: "loading" },
    });

    const staleLoaded = update(second.state, {
      diff: pullRequestDiff(),
      kind: "PullRequestDiffLoaded",
      number: 42,
      repository: repo,
      requestId: 1,
    });
    const staleFailed = update(staleLoaded.state, {
      error: "diffParseFailed",
      kind: "PullRequestDiffLoadFailed",
      number: 43,
      repository: repo,
      requestId: 1,
    });

    expect(staleLoaded.state).toBe(second.state);
    expect(staleFailed.state).toBe(second.state);
  });

  it("loads older timeline activity without discarding the current detail", () => {
    const repo = repository("kestrel/app");
    const detail = { ...pullRequestDetail(), timelineHasOlder: true };
    const loaded = update(loadedState([repo]), {
      detail,
      kind: "PullRequestDetailLoaded",
      number: 42,
      repository: repo,
    }).state;

    const requested = update(loaded, {
      kind: "PullRequestTimelineOlderRequested",
      number: 42,
      repository: repo,
    });

    expect(requested.cmds).toEqual([
      { kind: "LoadOlderPullRequestTimeline", number: 42, repository: repo },
    ]);
    expect(requested.state.pullRequestDetails[Repositories.pullRequestDetailKey(repo, 42)]).toEqual(
      {
        detail,
        error: null,
        status: "loadingTimeline",
      },
    );

    const failed = update(requested.state, {
      error: "syncFailed",
      kind: "PullRequestTimelineOlderLoadFailed",
      number: 42,
      repository: repo,
    });
    expect(failed.state.pullRequestDetails[Repositories.pullRequestDetailKey(repo, 42)]).toEqual({
      detail,
      error: "syncFailed",
      status: "timelineError",
    });
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

  it("loads a parsed pull request diff from the dedicated endpoint", async () => {
    const repo = repository("kestrel/app");
    const diff = pullRequestDiff();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(diff)),
    );
    const messages: Repositories.Msg[] = [];

    Repositories.runCmd(
      { kind: "LoadPullRequestDiff", number: 42, repository: repo, requestId: 7 },
      (msg) => messages.push(msg),
    );

    await waitFor(() =>
      expect(messages).toEqual([
        {
          diff,
          kind: "PullRequestDiffLoaded",
          number: 42,
          repository: repo,
          requestId: 7,
        },
      ]),
    );
    const request = vi.mocked(fetch).mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect((request as Request).method).toBe("GET");
    expect((request as Request).url).toContain(
      "/api/repositories/kestrel/app/pull-requests/42/diff",
    );
  });

  it.each([
    ["authenticationRequired", "authenticationRequired"],
    ["authorizationRequired", "authorizationRequired"],
    ["diffParseFailed", "diffParseFailed"],
    ["diffResourceLimitExceeded", "diffResourceLimitExceeded"],
    ["diffUnavailable", "diffUnavailable"],
    ["invalidPullRequest", "invalidPullRequest"],
    ["invalidRepository", "invalidRepository"],
    ["pullRequestNotFound", "pullRequestNotFound"],
    ["repositoryNotTracked", "repositoryNotTracked"],
    ["syncFailed", "loadFailed"],
  ] as const)("maps Diff endpoint error %s", async (apiError, expectedError) => {
    const repo = repository("kestrel/app");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: apiError }, 500)),
    );
    const messages: Repositories.Msg[] = [];

    Repositories.runCmd(
      { kind: "LoadPullRequestDiff", number: 42, repository: repo, requestId: 3 },
      (msg) => messages.push(msg),
    );

    await waitFor(() =>
      expect(messages).toEqual([
        {
          error: expectedError,
          kind: "PullRequestDiffLoadFailed",
          number: 42,
          repository: repo,
          requestId: 3,
        },
      ]),
    );
  });

  it.each([
    ["network rejection", () => Promise.reject(new Error("network failed"))],
    [
      "invalid JSON",
      () =>
        Promise.resolve(
          new Response("{", { headers: { "content-type": "application/json" }, status: 200 }),
        ),
    ],
  ])("maps thrown Diff %s to a terminal failure", async (_name, response) => {
    const repo = repository("kestrel/app");
    vi.stubGlobal("fetch", vi.fn(response));
    const messages: Repositories.Msg[] = [];

    Repositories.runCmd(
      { kind: "LoadPullRequestDiff", number: 42, repository: repo, requestId: 4 },
      (msg) => messages.push(msg),
    );

    await waitFor(() =>
      expect(messages).toEqual([
        {
          error: "loadFailed",
          kind: "PullRequestDiffLoadFailed",
          number: 42,
          repository: repo,
          requestId: 4,
        },
      ]),
    );
  });

  it("maps authorization failures when syncing pull requests", async () => {
    const repo = repository("kestrel/app");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "authorizationRequired" }, 403)),
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

  it("returns summary and detail data when syncing one pull request", async () => {
    const repo = repository("kestrel/app");
    const syncedPullRequest = pullRequest(42);
    const detail = pullRequestDetail();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ pullRequest: syncedPullRequest, pullRequestDetail: detail }),
      ),
    );
    const messages: Repositories.Msg[] = [];

    Repositories.runCmd({ kind: "SyncPullRequestDetail", number: 42, repository: repo }, (msg) =>
      messages.push(msg),
    );

    await waitFor(() =>
      expect(messages).toEqual([
        {
          detail,
          kind: "PullRequestDetailSynced",
          number: 42,
          pullRequest: syncedPullRequest,
          repository: repo,
        },
      ]),
    );
  });

  it("loads older pull request timeline data from the backend", async () => {
    const repo = repository("kestrel/app");
    const detail = pullRequestDetail();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ pullRequestDetail: detail })),
    );
    const messages: Repositories.Msg[] = [];

    Repositories.runCmd(
      { kind: "LoadOlderPullRequestTimeline", number: 42, repository: repo },
      (msg) => messages.push(msg),
    );

    await waitFor(() =>
      expect(messages).toEqual([
        {
          detail,
          kind: "PullRequestTimelineOlderLoaded",
          number: 42,
          repository: repo,
        },
      ]),
    );
    const request = vi.mocked(fetch).mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect((request as Request).method).toBe("POST");
    expect((request as Request).url).toContain(
      "/api/repositories/kestrel/app/pull-requests/42/timeline/older",
    );
  });

  it("maps duplicate add failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "duplicateRepository" }, 409)),
    );
    const messages: Repositories.Msg[] = [];

    Repositories.runCmd({ kind: "Add", repository: "Kestrel/App" }, (msg) => messages.push(msg));

    await waitFor(() => expect(messages).toEqual([{ error: "duplicate", kind: "AddFailed" }]));
  });
});
