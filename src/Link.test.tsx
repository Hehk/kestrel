import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { Link } from "./Link";
import type { ProtectedRoute } from "./router";
import * as Store from "./store";

const testUser = {
  displayName: "User One",
  id: "user_1",
};

const resetLocation = (path: string) => {
  window.history.replaceState({}, "", path);
  window.localStorage.clear();
  Store.resetForTest();
  const restoreRunCmd = Store.setRunCmdForTest(() => {});
  Store.start(testUser);
  restoreRunCmd();
};

// NOTE: I am not 100% about these, testing patterns but once we are using the commands
// more, I will probably want to refactor them.
const collectCommands = () => {
  const cmds: Store.Cmd[] = [];
  Store.setRunCmdForTest((cmd) => {
    cmds.push(cmd);
  });
  return cmds;
};

const runCommandsAsNavigation = () => {
  const cmds: Store.Cmd[] = [];
  Store.setRunCmdForTest((cmd) => {
    cmds.push(cmd);
    switch (cmd.kind) {
      case "Navigate":
        Store.send({ kind: "RouteChanged", route: cmd.route });
        return;
    }
  });
  return cmds;
};

const clickWithoutNativeNavigation = (element: HTMLElement, eventInit?: MouseEventInit) => {
  const preventNavigation = (event: MouseEvent) => {
    event.preventDefault();
  };

  document.addEventListener("click", preventNavigation);
  try {
    fireEvent.click(element, eventInit);
  } finally {
    document.removeEventListener("click", preventNavigation);
  }
};

const CurrentRoute = () => {
  const route = Store.appStore((state) => state.route);
  return <div>Route is {route().name}</div>;
};

describe("Link", () => {
  beforeEach(() => {
    resetLocation("/");
  });

  afterEach(() => {
    cleanup();
    resetLocation("/");
  });

  it("renders a typed route href", () => {
    render(() => <Link to={{ name: "Settings" }}>Settings</Link>);

    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  it("forwards refs and keeps href and navigation reactive through Anchor", async () => {
    const user = userEvent.setup();
    const cmds = collectCommands();
    const [route, setRoute] = createSignal<ProtectedRoute>({ name: "Home" });
    let ref: HTMLAnchorElement | undefined;
    render(() => (
      <Link
        ref={(element) => {
          ref = element;
        }}
        to={route()}
        variant="navigation"
      >
        Destination
      </Link>
    ));

    const anchor = screen.getByRole("link", { name: "Destination" });
    expect(ref).toBe(anchor);
    expect(anchor).toHaveAttribute("href", "/");
    setRoute({ name: "Settings" });
    expect(anchor).toHaveAttribute("href", "/settings");
    expect(anchor).not.toHaveAttribute("variant");
    await user.click(anchor);
    expect(cmds).toEqual([{ kind: "Navigate", route: { name: "Settings" }, replace: false }]);
  });

  it("emits a navigation command on normal clicks", async () => {
    const user = userEvent.setup();
    const cmds = collectCommands();

    render(() => <Link to={{ name: "Settings" }}>Settings</Link>);

    await user.click(screen.getByRole("link", { name: "Settings" }));

    expect(cmds).toEqual([{ kind: "Navigate", route: { name: "Settings" }, replace: false }]);
  });

  it("marks replace navigations in the emitted command", async () => {
    const user = userEvent.setup();
    const cmds = collectCommands();

    render(() => (
      <Link replace to={{ name: "Settings" }}>
        Settings
      </Link>
    ));

    await user.click(screen.getByRole("link", { name: "Settings" }));

    expect(cmds).toEqual([{ kind: "Navigate", route: { name: "Settings" }, replace: true }]);
  });

  it("can update subscribers when the command runner completes navigation", async () => {
    const user = userEvent.setup();
    const cmds = runCommandsAsNavigation();

    render(() => (
      <>
        <Link to={{ name: "Settings" }}>Settings</Link>
        <CurrentRoute />
      </>
    ));

    expect(screen.getByText("Route is Home")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Settings" }));

    expect(cmds).toEqual([{ kind: "Navigate", route: { name: "Settings" }, replace: false }]);
    expect(screen.getByText("Route is Settings")).toBeInTheDocument();
  });

  it("does not emit a command for the current route", async () => {
    const user = userEvent.setup();
    resetLocation("/settings");
    const cmds = collectCommands();

    render(() => <Link to={{ name: "Settings" }}>Settings</Link>);

    await user.click(screen.getByRole("link", { name: "Settings" }));

    expect(cmds).toEqual([]);
  });

  it("lets modified clicks use normal browser behavior", () => {
    const cmds = collectCommands();

    render(() => <Link to={{ name: "Settings" }}>Settings</Link>);

    clickWithoutNativeNavigation(screen.getByRole("link", { name: "Settings" }), { metaKey: true });

    expect(cmds).toEqual([]);
  });

  it("lets target and download links use normal browser behavior", () => {
    const cmds = collectCommands();

    render(() => (
      <>
        <Link target="_blank" to={{ name: "Settings" }}>
          New tab
        </Link>
        <Link download to={{ name: "PullRequest", repo: "kestrel", id: "123", view: "overview" }}>
          Download
        </Link>
      </>
    ));

    clickWithoutNativeNavigation(screen.getByRole("link", { name: "New tab" }));
    clickWithoutNativeNavigation(screen.getByRole("link", { name: "Download" }));

    expect(cmds).toEqual([]);
  });

  it("lets onClick prevent routing", async () => {
    const user = userEvent.setup();
    const cmds = collectCommands();

    render(() => (
      <Link onClick={(event) => event.preventDefault()} to={{ name: "Settings" }}>
        Settings
      </Link>
    ));

    await user.click(screen.getByRole("link", { name: "Settings" }));

    expect(cmds).toEqual([]);
  });
});
