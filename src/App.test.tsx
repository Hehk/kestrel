import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { appSetup, resetForTest } from "./model";

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

const mockAuth = (body: unknown = signedInResponse) => {
  let theme = "system";

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
        theme = request.theme;
        return jsonResponse({ theme });
      }

      return new Response(null, { status: 404 });
    }),
  );
};

const renderApp = () => {
  const view = render(<App />);
  appSetup();
  return view;
};

describe("App", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    mockAuth();
    resetForTest();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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
    expect(await screen.findByLabelText("System")).toBeChecked();

    await user.click(screen.getByRole("link", { name: "Sample PR" }));
    expect(screen.getByRole("heading", { name: "kestrel" })).toBeInTheDocument();
    expect(screen.getByText("Viewing pull request #42.")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Home" }));
    expect(screen.getByRole("heading", { name: "Kestrel" })).toBeInTheDocument();
  });

  it("shows the login page when signed out", async () => {
    const user = userEvent.setup();
    mockAuth({ user: null });

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
    const user = userEvent.setup();
    mockAuth({ user: null });

    renderApp();

    await screen.findByRole("link", { name: "Login" });

    await user.click(screen.getByRole("link", { name: "Settings" }));

    expect(screen.getByRole("heading", { name: "Sign in required" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to login" })).toBeInTheDocument();
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

  it("saves settings", async () => {
    const user = userEvent.setup();

    renderApp();

    await screen.findByRole("button", { name: "Sign out" });

    await user.click(screen.getByRole("link", { name: "Settings" }));
    await user.click(await screen.findByLabelText("Dark"));
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByText("Settings saved.")).toBeInTheDocument();
    expect(screen.getByLabelText("Dark")).toBeChecked();
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => {
        return (
          input instanceof Request &&
          input.method === "PUT" &&
          input.url === "http://localhost/api/settings"
        );
      }),
    ).toBe(true);
  });
});
