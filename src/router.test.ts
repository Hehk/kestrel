import { describe, expect, it } from "vitest";
import * as Router from "./router";

describe("router", () => {
  it("encodes link routes", () => {
    expect(Router.fromRoute({ name: "Home" })).toBe("/");
    expect(Router.fromRoute({ name: "Settings" })).toBe("/settings");
    expect(Router.fromRoute({ name: "PullRequest", repo: "kestrel", id: "123" })).toBe(
      "/pull/kestrel/123",
    );
  });

  it("decodes paths", () => {
    expect(Router.toRoute("/")).toEqual({ name: "Home" });
    expect(Router.toRoute("/settings")).toEqual({ name: "Settings" });
    expect(Router.toRoute("/pull/kestrel/123")).toEqual({
      name: "PullRequest",
      repo: "kestrel",
      id: "123",
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
  });

  it("roundtrips link routes", () => {
    const routes: Router.LinkRoute[] = [
      { name: "Home" },
      { name: "Settings" },
      { name: "PullRequest", repo: "kestrel", id: "123" },
    ];

    for (const route of routes) {
      expect(Router.toRoute(Router.fromRoute(route))).toEqual(route);
    }
  });
});
