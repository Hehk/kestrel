import { describe, expect, it } from "vitest";
import * as Router from "./router";

describe("router", () => {
  it("encodes link routes", () => {
    expect(Router.fromRoute({ name: "Home" })).toBe("/");
    expect(Router.fromRoute({ name: "Login" })).toBe("/login");
    expect(Router.fromRoute({ name: "Settings" })).toBe("/settings");
    expect(
      Router.fromRoute({ name: "PullRequest", repo: "kestrel/app", id: "123", view: "overview" }),
    ).toBe("/pull/kestrel%2Fapp/123");
    expect(
      Router.fromRoute({ name: "PullRequest", repo: "kestrel/app", id: "123", view: "diff" }),
    ).toBe("/pull/kestrel%2Fapp/123/diff");
  });

  it("decodes paths", () => {
    expect(Router.toRoute("/")).toEqual({ name: "Home" });
    expect(Router.toRoute("/login")).toEqual({ name: "Login" });
    expect(Router.toRoute("/settings")).toEqual({ name: "Settings" });
    expect(Router.toRoute("/pull/kestrel/123")).toEqual({
      name: "PullRequest",
      repo: "kestrel",
      id: "123",
      view: "overview",
    });
    expect(Router.toRoute("/pull/kestrel%2Fapp/123/diff")).toEqual({
      name: "PullRequest",
      repo: "kestrel/app",
      id: "123",
      view: "diff",
    });
  });

  it("decodes unknown paths as not found", () => {
    expect(Router.toRoute("/missing")).toEqual({ name: "NotFound", path: "/missing" });
    expect(Router.toRoute("/pull/kestrel")).toEqual({
      name: "NotFound",
      path: "/pull/kestrel",
    });
    expect(Router.toRoute("/pull/kestrel/123/extra")).toEqual({
      name: "NotFound",
      path: "/pull/kestrel/123/extra",
    });
    expect(Router.toRoute("/pull/kestrel/123/diff/extra")).toEqual({
      name: "NotFound",
      path: "/pull/kestrel/123/diff/extra",
    });
    expect(Router.toRoute("/pull/kestrel/123/diff/")).toEqual({
      name: "NotFound",
      path: "/pull/kestrel/123/diff/",
    });
    expect(Router.toRoute("/pull/%/123")).toEqual({
      name: "NotFound",
      path: "/pull/%/123",
    });
  });

  it("roundtrips link routes", () => {
    const routes: Router.LinkRoute[] = [
      { name: "Home" },
      { name: "Login" },
      { name: "Settings" },
      { name: "PullRequest", repo: "kestrel/app", id: "123", view: "overview" },
      { name: "PullRequest", repo: "kestrel/app", id: "123", view: "diff" },
    ];

    for (const route of routes) {
      expect(Router.toRoute(Router.fromRoute(route))).toEqual(route);
    }
  });

  it("includes pull request view in route equality", () => {
    const overview: Router.Route = {
      name: "PullRequest",
      repo: "kestrel/app",
      id: "123",
      view: "overview",
    };
    expect(Router.equal(overview, { ...overview })).toBe(true);
    expect(Router.equal(overview, { ...overview, view: "diff" })).toBe(false);
    expect(Router.equal(overview, { ...overview, id: "124" })).toBe(false);
  });
});
