import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("increments the counter", async () => {
    const user = userEvent.setup();

    render(<App />);

    const button = screen.getByRole("button", { name: /count is 0/i });

    await user.click(button);

    expect(button).toHaveTextContent("Count is 1");
  });
});
