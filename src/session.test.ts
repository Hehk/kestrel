import { describe, expect, it } from "vitest";
import * as Session from "./session";

const user = {
  displayName: "User One",
  id: "user_1",
};

const update = (state: Session.SessionState, msg: Session.SessionMsg) => {
  const cmds: Session.SessionCmd[] = [];
  const nextState = Session.update(
    {
      runCmd: (cmd) => cmds.push(cmd),
    },
    msg,
    state,
  );

  return { cmds, state: nextState };
};

describe("session", () => {
  it("starts cached users in the authenticated app immediately", () => {
    const result = update(
      { checking: false, route: { name: "Login" }, status: "loggedOut" },
      { cachedUser: user, kind: "Started", route: { name: "Settings" } },
    );

    expect(result.state).toEqual({ checking: true, status: "loggedIn", user });
    expect(result.cmds).toEqual([
      { kind: "ModelStart", route: { name: "Settings" }, user },
      { kind: "AuthCheck" },
    ]);
  });

  it("starts uncached users in the logged out app", () => {
    const result = update(
      { checking: false, route: { name: "Login" }, status: "loggedOut" },
      { cachedUser: null, kind: "Started", route: { name: "Home" } },
    );

    expect(result.state).toEqual({ checking: true, route: { name: "Login" }, status: "loggedOut" });
    expect(result.cmds).toEqual([
      { kind: "Navigate", replace: true, route: { name: "Login" } },
      { kind: "AuthCheck" },
    ]);
  });

  it("recovers cookie-only sessions into home", () => {
    const result = update(
      { checking: true, route: { name: "Login" }, status: "loggedOut" },
      { kind: "AuthChecked", user },
    );

    expect(result.state).toEqual({ checking: false, status: "loggedIn", user });
    expect(result.cmds).toEqual([
      { kind: "CacheUser", user },
      { kind: "ModelStart", route: { name: "Home" }, user },
      { kind: "Navigate", replace: true, route: { name: "Home" } },
    ]);
  });

  it("boots stale cached sessions", () => {
    const result = update(
      { checking: true, status: "loggedIn", user },
      { kind: "AuthChecked", user: null },
    );

    expect(result.state).toEqual({
      checking: false,
      route: { name: "Login" },
      status: "loggedOut",
    });
    expect(result.cmds).toEqual([{ kind: "EndAuthenticatedSession", userId: "user_1" }]);
  });

  it("keeps logged out public routes after auth checks complete", () => {
    const result = update(
      { checking: true, route: { name: "NotFound", path: "/missing" }, status: "loggedOut" },
      { kind: "AuthChecked", user: null },
    );

    expect(result.state).toEqual({
      checking: false,
      route: { name: "NotFound", path: "/missing" },
      status: "loggedOut",
    });
    expect(result.cmds).toEqual([]);
  });

  it("logs out optimistically", () => {
    const result = update(
      { checking: false, status: "loggedIn", user },
      { kind: "LogoutRequested" },
    );

    expect(result.state).toEqual({
      checking: false,
      route: { name: "Login" },
      status: "loggedOut",
    });
    expect(result.cmds).toEqual([
      { kind: "EndAuthenticatedSession", userId: "user_1" },
      { kind: "AuthLogout" },
    ]);
  });

  it("normalizes logged out protected routes to login", () => {
    const result = update(
      { checking: false, route: { name: "Login" }, status: "loggedOut" },
      { kind: "RouteChanged", route: { name: "Settings" } },
    );

    expect(result.state).toEqual({
      checking: false,
      route: { name: "Login" },
      status: "loggedOut",
    });
    expect(result.cmds).toEqual([{ kind: "Navigate", replace: true, route: { name: "Login" } }]);
  });
});
