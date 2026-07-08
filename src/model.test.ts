import { afterEach, describe, expect, it } from "vitest";
import * as Model from "./model";
import type * as Repositories from "./repositoriesSlice";

const user: Model.User = {
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

describe("model", () => {
  afterEach(() => {
    Model.resetForTest();
  });

  it("loads stored pull requests after repositories load on a pull request route", () => {
    const commands: Model.Cmd[] = [];
    Model.setRunCmdForTest((cmd) => commands.push(cmd));
    const repo = repository("kestrel/app");
    Model.start(user, { name: "PullRequest", repo: "Kestrel/App", id: "42" });
    commands.length = 0;

    Model.send({ kind: "Repositories", msg: { kind: "Loaded", repositories: [repo] } });

    expect(commands).toEqual([
      { kind: "Repositories", cmd: { kind: "LoadPullRequests", repository: repo } },
    ]);
  });

  it("syncs once after stored pull requests load without the routed pull request", () => {
    const commands: Model.Cmd[] = [];
    Model.setRunCmdForTest((cmd) => commands.push(cmd));
    const repo = repository("kestrel/app");
    Model.start(user, { name: "PullRequest", repo: "kestrel/app", id: "42" });
    Model.send({ kind: "Repositories", msg: { kind: "Loaded", repositories: [repo] } });
    commands.length = 0;

    Model.send({
      kind: "Repositories",
      msg: { kind: "PullRequestsLoaded", pullRequests: [], repository: repo },
    });

    expect(commands).toEqual([
      { kind: "Repositories", cmd: { kind: "SyncPullRequests", repository: repo } },
    ]);

    commands.length = 0;
    Model.send({
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

  it("does not sync when stored pull requests include the routed pull request", () => {
    const commands: Model.Cmd[] = [];
    Model.setRunCmdForTest((cmd) => commands.push(cmd));
    const repo = repository("kestrel/app");
    Model.start(user, { name: "PullRequest", repo: "kestrel/app", id: "42" });
    Model.send({ kind: "Repositories", msg: { kind: "Loaded", repositories: [repo] } });
    commands.length = 0;

    Model.send({
      kind: "Repositories",
      msg: { kind: "PullRequestsLoaded", pullRequests: [pullRequest(42)], repository: repo },
    });

    expect(commands).toEqual([]);
  });
});
