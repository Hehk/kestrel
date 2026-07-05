import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetForTest } from "./model";
import * as Session from "./session";

const signedInResponse = {
  user: {
    avatarUrl: "https://avatars.example.test/user_1",
    displayName: "User One",
    id: "user_1",
  },
};

const jsonResponse = (body: unknown) => {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
};

type SaveSettings = (theme: string) => Response | Promise<Response>;

const mockAuth = (
  body: unknown = signedInResponse,
  initialTheme = "system",
  saveSettings?: SaveSettings,
) => {
  let theme = initialTheme;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = input instanceof Request ? input.method : "GET";

      if (url.endsWith("/api/auth/me")) {
        return jsonResponse(body);
      }

      if (url.endsWith("/api/auth/logout")) {
        return new Response(null, { status: 204 });
      }

      if (url.endsWith("/api/settings") && method === "GET") {
        return jsonResponse({ theme });
      }

      if (url.endsWith("/api/settings") && method === "PUT" && input instanceof Request) {
        const request = (await input.clone().json()) as { theme: string };
        if (saveSettings !== undefined) {
          return saveSettings(request.theme);
        }

        theme = request.theme;
        return jsonResponse({ theme });
      }

      return new Response(null, { status: 404 });
    }),
  );
};

const renderApp = () => {
  Session.start();
  return render(<App />);
};

const clearCache = () => {
  window.localStorage.clear();
};

const writeCachedUser = (user: typeof signedInResponse.user) => {
  window.localStorage.setItem("kestrel.session", JSON.stringify({ version: 1, user }));
};

const readCachedUser = () => {
  return JSON.parse(window.localStorage.getItem("kestrel.session") ?? "null") as unknown;
};

const selectTheme = async (user: ReturnType<typeof userEvent.setup>, theme: string) => {
  await user.click(screen.getByRole("combobox", { name: "Theme" }));
  await user.click(await screen.findByRole("option", { name: theme }));
};

const deferredResponse = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
};

const writeCachedSettings = (userId: string, theme: string) => {
  window.localStorage.setItem(
    `kestrel.settings.${userId}`,
    JSON.stringify({ version: 1, userId, theme }),
  );
};

describe("App", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    clearCache();
    mockAuth();
    writeCachedUser(signedInResponse.user);
    writeCachedSettings(signedInResponse.user.id, "system");
    resetForTest();
    Session.resetForTest();
  });

  afterEach(() => {
    cleanup();
    Session.resetForTest();
    clearCache();
    document.documentElement.removeAttribute("data-theme");
    vi.unstubAllGlobals();
  });

  it("renders cached authenticated state before the session check resolves", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    clearCache();
    writeCachedUser(signedInResponse.user);
    writeCachedSettings(signedInResponse.user.id, "dark");
    resetForTest();
    Session.resetForTest();

    renderApp();

    expect(screen.getByRole("heading", { name: "Kestrel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /count is 0/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("increments the counter", async () => {
    const user = userEvent.setup();

    renderApp();

    const button = screen.getByRole("button", { name: /count is 0/i });

    await user.click(button);

    expect(button).toHaveTextContent("Count is 1");
  });

  it("navigates between the basic pages", async () => {
    const user = userEvent.setup();

    renderApp();

    expect(screen.getByRole("heading", { name: "Kestrel" })).toBeInTheDocument();
    await screen.findByRole("button", { name: "Sign out" });

    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Theme" })).toHaveTextContent("System");

    await user.click(screen.getByRole("link", { name: "Sample PR" }));
    expect(screen.getByRole("heading", { name: "kestrel" })).toBeInTheDocument();
    expect(screen.getByText("Viewing pull request #42.")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Home" }));
    expect(screen.getByRole("heading", { name: "Kestrel" })).toBeInTheDocument();
  });

  it("shows the login page when signed out", async () => {
    const user = userEvent.setup();
    clearCache();
    mockAuth({ user: null });
    resetForTest();
    Session.resetForTest();

    renderApp();

    await screen.findByRole("link", { name: "Login" });

    await user.click(screen.getByRole("link", { name: "Login" }));

    expect(screen.getByRole("heading", { name: "Sign in to Kestrel" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute(
      "href",
      "http://localhost/api/auth/github/start",
    );
  });

  it("protects settings when signed out", async () => {
    window.history.replaceState({}, "", "/settings");
    clearCache();
    mockAuth({ user: null });
    resetForTest();
    Session.resetForTest();

    renderApp();

    expect(await screen.findByRole("heading", { name: "Sign in to Kestrel" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toBeInTheDocument();
  });

  it("boots a stale cached session after validation", async () => {
    mockAuth({ user: null });

    renderApp();

    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Login" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sign in to Kestrel" })).toBeInTheDocument();
  });

  it("stores the loaded user for future optimistic boots", async () => {
    clearCache();
    resetForTest();
    Session.resetForTest();

    renderApp();

    await screen.findByRole("button", { name: "Sign out" });
    expect(readCachedUser()).toEqual({ version: 1, user: signedInResponse.user });
  });

  it("logs out", async () => {
    const user = userEvent.setup();

    renderApp();

    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("link", { name: "Login" })).toBeInTheDocument();
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => {
        return (
          input instanceof Request &&
          input.method === "POST" &&
          input.url === "http://localhost/api/auth/logout"
        );
      }),
    ).toBe(true);
  });

  it("saves theme when the selection changes", async () => {
    const user = userEvent.setup();

    renderApp();

    await screen.findByRole("button", { name: "Sign out" });

    await user.click(screen.getByRole("link", { name: "Settings" }));
    await selectTheme(user, "Dark");

    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("Dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) => {
          return (
            input instanceof Request &&
            input.method === "PUT" &&
            input.url === "http://localhost/api/settings"
          );
        }),
      ).toBe(true),
    );
  });

  it("rolls back theme when saving fails", async () => {
    const user = userEvent.setup();
    const save = deferredResponse();
    mockAuth(signedInResponse, "system", () => save.promise);

    renderApp();

    await screen.findByRole("button", { name: "Sign out" });

    await user.click(screen.getByRole("link", { name: "Settings" }));
    await selectTheme(user, "Dark");

    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("Dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    save.resolve(new Response(null, { status: 500 }));
    await save.promise;

    expect(
      await screen.findByText("Theme could not be saved. Reverted to last saved theme."),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("System");
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });

  it("ignores stale theme save failures", async () => {
    const user = userEvent.setup();
    const firstSave = deferredResponse();
    const secondSave = deferredResponse();
    const savedThemes: string[] = [];

    mockAuth(signedInResponse, "system", (theme) => {
      savedThemes.push(theme);
      return savedThemes.length === 1 ? firstSave.promise : secondSave.promise;
    });

    renderApp();

    await screen.findByRole("button", { name: "Sign out" });

    await user.click(screen.getByRole("link", { name: "Settings" }));
    await selectTheme(user, "Dark");

    await waitFor(() => expect(savedThemes).toEqual(["dark"]));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    await selectTheme(user, "Light");

    await waitFor(() => expect(savedThemes).toEqual(["dark", "light"]));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    secondSave.resolve(jsonResponse({ theme: "light" }));
    await secondSave.promise;
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("Light"),
    );

    firstSave.resolve(new Response(null, { status: 500 }));
    await firstSave.promise;

    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("Light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(
      screen.queryByText("Theme could not be saved. Reverted to last saved theme."),
    ).not.toBeInTheDocument();
  });

  it("applies the loaded and saved theme", async () => {
    const user = userEvent.setup();
    mockAuth(signedInResponse, "dark");

    renderApp();

    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "dark"));

    await user.click(screen.getByRole("link", { name: "Settings" }));
    await selectTheme(user, "Light");

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) => {
          return (
            input instanceof Request &&
            input.method === "PUT" &&
            input.url === "http://localhost/api/settings"
          );
        }),
      ).toBe(true),
    );
  });
});
