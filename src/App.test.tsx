import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { resetForTest } from "./model";

describe("App", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    resetForTest();
  });

  afterEach(() => {
    cleanup();
  });

  it("increments the counter", async () => {
    const user = userEvent.setup();

    render(<App />);

    const button = screen.getByRole("button", { name: /count is 0/i });

    await user.click(button);

    expect(button).toHaveTextContent("Count is 1");
  });

  it("navigates between the basic pages", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(screen.getByRole("heading", { name: "Kestrel" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Sample PR" }));
    expect(screen.getByRole("heading", { name: "kestrel" })).toBeInTheDocument();
    expect(screen.getByText("Viewing pull request #42.")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Home" }));
    expect(screen.getByRole("heading", { name: "Kestrel" })).toBeInTheDocument();
  });
});
