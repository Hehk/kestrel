import { waitFor } from "@testing-library/react";
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

describe("repositoriesSlice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads repositories", () => {
    const repositories = [repository("kestrel/app")];

    const result = update(Repositories.initialState(), { kind: "Loaded", repositories });

    expect(result.state).toEqual({
      addStatus: "idle",
      repositories,
      status: "loaded",
    });
    expect(result.cmds).toEqual([]);
  });

  it("requests repository loading", () => {
    const result = update({ repositories: [], status: "error" }, { kind: "LoadRequested" });

    expect(result.state).toEqual({ repositories: [], status: "loading" });
    expect(result.cmds).toEqual([{ kind: "Load" }]);
  });

  it("requests adding repositories", () => {
    const state: Repositories.State = {
      addError: "duplicate",
      addStatus: "error",
      repositories: [],
      status: "loaded",
    };

    const result = update(state, { kind: "AddRequested", repository: "Kestrel/App" });

    expect(result.state).toEqual({
      addStatus: "saving",
      repositories: [],
      status: "loaded",
    });
    expect(result.cmds).toEqual([{ kind: "Add", repository: "Kestrel/App" }]);
  });

  it("adds returned repositories", () => {
    const existing = repository("kestrel/old");
    const added = repository("kestrel/app");
    const state: Repositories.State = {
      addStatus: "saving",
      repositories: [existing],
      status: "loaded",
    };

    const result = update(state, { kind: "Added", repository: added });

    expect(result.state).toEqual({
      addStatus: "idle",
      repositories: [existing, added],
      status: "loaded",
    });
  });

  it("stores add failures without dropping repositories", () => {
    const repositories = [repository("kestrel/app")];
    const state: Repositories.State = {
      addStatus: "saving",
      repositories,
      status: "loaded",
    };

    const result = update(state, { error: "duplicate", kind: "AddFailed" });

    expect(result.state).toEqual({
      addError: "duplicate",
      addStatus: "error",
      repositories,
      status: "loaded",
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
