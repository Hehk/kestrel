import { afterEach, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import * as Session from "./session";
import { documentClass, mountClass } from "./styles/base.stylex";

vi.mock("solid-js/web", () => ({ render: vi.fn() }));
vi.mock("./session", () => ({ start: vi.fn() }));
vi.mock("./App", () => ({ default: () => null }));

const originalClass = document.documentElement.className;

afterEach(() => {
  document.getElementById("root")?.remove();
  document.documentElement.className = originalClass;
});

it("starts with multiple StyleX classes without replacing existing document classes", async () => {
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  document.documentElement.classList.add("existing-theme");

  await import("./main");

  expect(document.documentElement).toHaveClass("existing-theme", ...documentClass.split(/\s+/));
  expect(root.className).toBe(mountClass);
  expect(Session.start).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledWith(expect.any(Function), root);
});
