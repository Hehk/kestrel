import { afterEach, describe, expect, it } from "vitest";
import * as Store from "./store";
import type * as Repositories from "./repositoriesSlice";

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
    Store.start(user, { name: "PullRequest", repo: "Kestrel/App", id: "42" });
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
    Store.start(user, { name: "PullRequest", repo: "kestrel/app", id: "42" });
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
    Store.start(user, { name: "PullRequest", repo: "kestrel/app", id: "42" });
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
    Store.start(user, { name: "PullRequest", repo: "kestrel/app", id: "42" });
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
});
