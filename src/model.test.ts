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
});
