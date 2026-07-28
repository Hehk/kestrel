import { afterEach, describe, expect, it } from "vitest";
import * as Store from "./store";
import * as Repositories from "./repositoriesSlice";

const user: Store.User = {
  displayName: "User One",
  id: "user_1",
};

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

const pullRequest = (number: number): Repositories.PullRequest => {
  return {
    authorLogin: "octocat",
    closedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
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
  body: "Stored detail",
  checkRuns: [],
  commits: [],
  files: [],
  issueComments: [],
  reviewComments: [],
  reviewDecision: null,
  reviews: [],
  statuses: [],
  syncedAt: "2026-01-04T00:00:00Z",
  timeline: [],
  timelineHasOlder: false,
});

const pullRequestDiff = (): Repositories.PullRequestDiff => ({
  files: [],
  syncedAt: "2026-01-04T00:00:00Z",
});

describe("store", () => {
  afterEach(() => {
    Store.resetForTest();
    window.localStorage.clear();
  });

  it("queues synchronous command messages until the current command batch is handed off", () => {
    const commands: Store.Cmd[] = [];
    window.localStorage.clear();
    Store.setRunCmdForTest((cmd) => {
      commands.push(cmd);
      if (cmd.kind === "Settings" && cmd.cmd.kind === "ApplyTheme") {
        Store.send({ kind: "RouteRequested", route: { name: "Settings" }, replace: false });
      }
    });

    Store.start(user, { name: "Home" });

    expect(commands.map((cmd) => (cmd.kind === "Settings" ? cmd.cmd.kind : cmd.kind))).toEqual([
      "ApplyTheme",
      "SaveSettings",
      "LoadRemote",
      "Repositories",
      "Navigate",
    ]);
  });

  it("loads stored pull requests after repositories load on a pull request route", () => {
    const commands: Store.Cmd[] = [];
    Store.setRunCmdForTest((cmd) => commands.push(cmd));
    const repo = repository("kestrel/app");
    Store.start(user, { name: "PullRequest", repo: "Kestrel/App", id: "42", view: "overview" });
    commands.length = 0;

    Store.send({ kind: "Repositories", msg: { kind: "Loaded", repositories: [repo] } });

    expect(commands).toEqual([
      { kind: "Repositories", cmd: { kind: "LoadPullRequests", repository: repo } },
    ]);
  });

  it("syncs once after stored pull requests load without the routed pull request", () => {
    const commands: Store.Cmd[] = [];
    Store.setRunCmdForTest((cmd) => commands.push(cmd));
    const repo = repository("kestrel/app");
    Store.start(user, { name: "PullRequest", repo: "kestrel/app", id: "42", view: "overview" });
    Store.send({ kind: "Repositories", msg: { kind: "Loaded", repositories: [repo] } });
    commands.length = 0;

    Store.send({
      kind: "Repositories",
      msg: { kind: "PullRequestsLoaded", pullRequests: [], repository: repo },
    });

    expect(commands).toEqual([
      { kind: "Repositories", cmd: { kind: "SyncPullRequests", repository: repo } },
    ]);

    commands.length = 0;
    Store.send({
      kind: "Repositories",
      msg: {
        complete: false,
        kind: "PullRequestsSynced",
        nextPage: 2,
        pullRequests: [],
        repository: repo,
      },
    });
    expect(commands).toEqual([]);
  });

  it("loads stored pull request detail when stored pull requests include the routed pull request", () => {
    const commands: Store.Cmd[] = [];
    Store.setRunCmdForTest((cmd) => commands.push(cmd));
    const repo = repository("kestrel/app");
    Store.start(user, { name: "PullRequest", repo: "kestrel/app", id: "42", view: "overview" });
    Store.send({ kind: "Repositories", msg: { kind: "Loaded", repositories: [repo] } });
    commands.length = 0;

    Store.send({
      kind: "Repositories",
      msg: { kind: "PullRequestsLoaded", pullRequests: [pullRequest(42)], repository: repo },
    });

    expect(commands).toEqual([
      {
        kind: "Repositories",
        cmd: { kind: "LoadPullRequestDetail", number: 42, repository: repo },
      },
    ]);
  });

  it("loads stored pull request detail after sync returns the routed pull request", () => {
    const commands: Store.Cmd[] = [];
    Store.setRunCmdForTest((cmd) => commands.push(cmd));
    const repo = repository("kestrel/app");
    Store.start(user, { name: "PullRequest", repo: "kestrel/app", id: "42", view: "overview" });
    Store.send({ kind: "Repositories", msg: { kind: "Loaded", repositories: [repo] } });
    commands.length = 0;

    Store.send({
      kind: "Repositories",
      msg: {
        complete: false,
        kind: "PullRequestsSynced",
        nextPage: 2,
        pullRequests: [pullRequest(42)],
        repository: repo,
      },
    });

    expect(commands).toEqual([
      {
        kind: "Repositories",
        cmd: { kind: "LoadPullRequestDetail", number: 42, repository: repo },
      },
    ]);
  });

  it("loads only the Diff resource on a direct Diff route and reuses it between views", () => {
    const commands: Store.Cmd[] = [];
    Store.setRunCmdForTest((cmd) => commands.push(cmd));
    const repo = repository("kestrel/app");
    Store.start(user, { name: "PullRequest", repo: "kestrel/app", id: "42", view: "diff" });
    Store.send({ kind: "Repositories", msg: { kind: "Loaded", repositories: [repo] } });
    commands.length = 0;

    Store.send({
      kind: "Repositories",
      msg: { kind: "PullRequestsLoaded", pullRequests: [pullRequest(42)], repository: repo },
    });

    expect(commands).toEqual([
      {
        kind: "Repositories",
        cmd: { kind: "LoadPullRequestDiff", number: 42, repository: repo, requestId: 1 },
      },
    ]);
    expect(Store.get().repositories.pullRequestDetails).toEqual({});
    expect(Store.get().repositories.currentPullRequestDiff).toEqual({
      key: "kestrel/app#42",
      requestId: 1,
      state: { diff: null, status: "loading" },
    });

    commands.length = 0;
    Store.send({
      kind: "RouteChanged",
      route: { name: "PullRequest", repo: "kestrel/app", id: "42", view: "overview" },
    });
    expect(commands).toEqual([
      {
        kind: "Repositories",
        cmd: { kind: "LoadPullRequestDetail", number: 42, repository: repo },
      },
    ]);

    commands.length = 0;
    Store.send({
      kind: "RouteChanged",
      route: { name: "PullRequest", repo: "kestrel/app", id: "42", view: "diff" },
    });
    expect(commands).toEqual([]);
  });

  it("replaces the one-entry Diff resource when visiting another pull request", () => {
    const commands: Store.Cmd[] = [];
    Store.setRunCmdForTest((cmd) => commands.push(cmd));
    const repo = repository("kestrel/app");
    Store.start(user, { name: "PullRequest", repo: "kestrel/app", id: "42", view: "diff" });
    Store.send({ kind: "Repositories", msg: { kind: "Loaded", repositories: [repo] } });
    commands.length = 0;
    Store.send({
      kind: "Repositories",
      msg: {
        kind: "PullRequestsLoaded",
        pullRequests: [pullRequest(42), pullRequest(43)],
        repository: repo,
      },
    });
    Store.send({
      kind: "Repositories",
      msg: {
        diff: pullRequestDiff(),
        kind: "PullRequestDiffLoaded",
        number: 42,
        repository: repo,
        requestId: 1,
      },
    });

    commands.length = 0;
    Store.send({
      kind: "RouteChanged",
      route: { name: "PullRequest", repo: "kestrel/app", id: "43", view: "diff" },
    });

    expect(commands).toEqual([
      {
        kind: "Repositories",
        cmd: { kind: "LoadPullRequestDiff", number: 43, repository: repo, requestId: 3 },
      },
    ]);
    expect(Store.get().repositories.currentPullRequestDiff).toEqual({
      key: "kestrel/app#43",
      requestId: 3,
      state: { diff: null, status: "loading" },
    });
  });

  it("discards the current Diff when visiting another pull request Overview", () => {
    const commands: Store.Cmd[] = [];
    Store.setRunCmdForTest((cmd) => commands.push(cmd));
    const repo = repository("kestrel/app");
    Store.start(user, { name: "PullRequest", repo: "kestrel/app", id: "42", view: "diff" });
    Store.send({ kind: "Repositories", msg: { kind: "Loaded", repositories: [repo] } });
    Store.send({
      kind: "Repositories",
      msg: {
        kind: "PullRequestsLoaded",
        pullRequests: [pullRequest(42), pullRequest(43)],
        repository: repo,
      },
    });
    Store.send({
      kind: "Repositories",
      msg: {
        diff: pullRequestDiff(),
        kind: "PullRequestDiffLoaded",
        number: 42,
        repository: repo,
        requestId: 1,
      },
    });

    commands.length = 0;
    Store.send({
      kind: "RouteChanged",
      route: { name: "PullRequest", repo: "kestrel/app", id: "43", view: "overview" },
    });

    expect(commands).toEqual([
      {
        kind: "Repositories",
        cmd: { kind: "LoadPullRequestDetail", number: 43, repository: repo },
      },
    ]);
    expect(Store.get().repositories.currentPullRequestDiff).toBeNull();
    expect(Store.get().repositories.pullRequestDiffRequestId).toBe(2);

    Store.send({
      kind: "Repositories",
      msg: {
        diff: pullRequestDiff(),
        kind: "PullRequestDiffLoaded",
        number: 42,
        repository: repo,
        requestId: 1,
      },
    });
    expect(Store.get().repositories.currentPullRequestDiff).toBeNull();
  });

  it("retries a failed Diff when its route is entered again", () => {
    const commands: Store.Cmd[] = [];
    Store.setRunCmdForTest((cmd) => commands.push(cmd));
    const repo = repository("kestrel/app");
    Store.start(user, { name: "PullRequest", repo: "kestrel/app", id: "42", view: "diff" });
    Store.send({ kind: "Repositories", msg: { kind: "Loaded", repositories: [repo] } });
    Store.send({
      kind: "Repositories",
      msg: { kind: "PullRequestsLoaded", pullRequests: [pullRequest(42)], repository: repo },
    });
    Store.send({
      kind: "Repositories",
      msg: {
        error: "loadFailed",
        kind: "PullRequestDiffLoadFailed",
        number: 42,
        repository: repo,
        requestId: 1,
      },
    });

    Store.send({ kind: "RouteChanged", route: { name: "Home" } });
    commands.length = 0;
    Store.send({
      kind: "RouteChanged",
      route: { name: "PullRequest", repo: "kestrel/app", id: "42", view: "diff" },
    });

    expect(commands).toEqual([
      {
        kind: "Repositories",
        cmd: { kind: "LoadPullRequestDiff", number: 42, repository: repo, requestId: 2 },
      },
    ]);
    expect(Store.get().repositories.currentPullRequestDiff?.state).toEqual({
      diff: null,
      status: "loading",
    });
  });

  it("keeps Diff request generations unique across user refresh", () => {
    const commands: Store.Cmd[] = [];
    Store.setRunCmdForTest((cmd) => commands.push(cmd));
    const repo = repository("kestrel/app");
    Store.start(user, { name: "PullRequest", repo: "kestrel/app", id: "42", view: "diff" });
    Store.send({ kind: "Repositories", msg: { kind: "Loaded", repositories: [repo] } });
    Store.send({
      kind: "Repositories",
      msg: { kind: "PullRequestsLoaded", pullRequests: [pullRequest(42)], repository: repo },
    });

    Store.send({ kind: "UserRefreshed", user: { displayName: "User Two", id: "user_2" } });
    expect(Store.get().repositories.currentPullRequestDiff).toBeNull();
    expect(Store.get().repositories.pullRequestDiffRequestId).toBe(1);

    commands.length = 0;
    Store.send({ kind: "Repositories", msg: { kind: "Loaded", repositories: [repo] } });
    Store.send({
      kind: "Repositories",
      msg: { kind: "PullRequestsLoaded", pullRequests: [pullRequest(42)], repository: repo },
    });
    expect(commands).toContainEqual({
      kind: "Repositories",
      cmd: { kind: "LoadPullRequestDiff", number: 42, repository: repo, requestId: 2 },
    });

    Store.send({
      kind: "Repositories",
      msg: {
        diff: pullRequestDiff(),
        kind: "PullRequestDiffLoaded",
        number: 42,
        repository: repo,
        requestId: 1,
      },
    });
    expect(Store.get().repositories.currentPullRequestDiff).toEqual({
      key: "kestrel/app#42",
      requestId: 2,
      state: { diff: null, status: "loading" },
    });
  });

  it("refreshes a matching stale Diff after pull request sync succeeds", () => {
    const commands: Store.Cmd[] = [];
    Store.setRunCmdForTest((cmd) => commands.push(cmd));
    const repo = repository("kestrel/app");
    const diff = pullRequestDiff();
    Store.start(user, { name: "PullRequest", repo: "kestrel/app", id: "42", view: "diff" });
    Store.send({ kind: "Repositories", msg: { kind: "Loaded", repositories: [repo] } });
    Store.send({
      kind: "Repositories",
      msg: { kind: "PullRequestsLoaded", pullRequests: [pullRequest(42)], repository: repo },
    });
    Store.send({
      kind: "Repositories",
      msg: {
        diff,
        kind: "PullRequestDiffLoaded",
        number: 42,
        repository: repo,
        requestId: 1,
      },
    });

    commands.length = 0;
    Store.send({
      kind: "Repositories",
      msg: {
        detail: pullRequestDetail(),
        kind: "PullRequestDetailSynced",
        number: 42,
        pullRequest: pullRequest(42),
        repository: repo,
      },
    });

    expect(commands).toEqual([
      {
        kind: "Repositories",
        cmd: { kind: "LoadPullRequestDiff", number: 42, repository: repo, requestId: 2 },
      },
    ]);
    expect(Store.get().repositories.currentPullRequestDiff?.state).toEqual({
      diff,
      status: "loading",
    });
  });
});
