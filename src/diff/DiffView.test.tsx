import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffView } from "./DiffView";
import type { PullRequestDiff, PullRequestDiffLine } from "./layout";

describe("DiffView", () => {
  beforeEach(() => {
    vi.stubGlobal("innerHeight", 480);
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal("scrollY", 0);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders semantic fixed-height rows and source text", async () => {
    const diff = smallDiff();
    const { container } = render(() => <DiffView diff={diff} />);
    const table = await screen.findByRole("table", { name: "Pull request diff contents" });

    expect(table).toHaveAttribute("aria-colcount", "3");
    expect(table).toHaveAttribute("aria-rowcount", "9");
    expect(within(table).getAllByRole("row")).toHaveLength(9);
    expect(
      within(table).getByRole("cell", { name: "src/old.ts -> src/new.ts" }),
    ).toBeInTheDocument();
    expect(within(table).getByText("@@ -1,3 +1,3 @@ function example")).toBeInTheDocument();
    expect(within(table).getByText("Binary file changed.")).toBeInTheDocument();
    expect(within(table).getByText("File changed without textual hunks.")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();

    const sourceRow = container.querySelector<HTMLElement>('[data-diff-row="3"]');
    expect(sourceRow).toHaveAttribute("aria-rowindex", "4");
    expect(sourceRow).toHaveStyle({ height: "24px" });
    expect(
      within(sourceRow as HTMLElement).getByRole("cell", { name: "Old line none" }),
    ).toBeEmptyDOMElement();
    expect(
      within(sourceRow as HTMLElement).getByRole("cell", { name: "New line 2" }),
    ).toHaveTextContent("2");
    expect(within(sourceRow as HTMLElement).getAllByRole("cell")[2]?.textContent).toBe(
      "Added line: +\tconst value = '<script>';  ",
    );

    const deletionRow = container.querySelector<HTMLElement>('[data-diff-row="2"]');
    expect(
      within(deletionRow as HTMLElement).getByRole("cell", { name: "Old line 1" }),
    ).toHaveTextContent("1");
    expect(
      within(deletionRow as HTMLElement).getByRole("cell", { name: "New line none" }),
    ).toBeEmptyDOMElement();
    expect(deletionRow).toHaveTextContent(
      "Deleted line: -const value = 'old'; No newline at end of file",
    );

    const contextRow = container.querySelector<HTMLElement>('[data-diff-row="4"]');
    expect(
      within(contextRow as HTMLElement).getByRole("cell", { name: "Old line 3" }),
    ).toHaveTextContent("3");
    expect(
      within(contextRow as HTMLElement).getByRole("cell", { name: "New line 3" }),
    ).toHaveTextContent("3");
    expect(within(contextRow as HTMLElement).getAllByRole("cell")[2]?.textContent).toBe(
      "Context line:  unchanged",
    );
    expect(container.querySelector('[data-diff-row="0"]')).toHaveStyle({ height: "40px" });
    expect(container.querySelector('[data-diff-row="1"]')).toHaveStyle({ height: "32px" });
    expect(container.querySelector('[data-diff-row="6"]')).toHaveStyle({ height: "32px" });
  });

  it("copies files and hunks from semantic data and disables binary copying", async () => {
    const user = userEvent.setup();
    render(() => <DiffView diff={smallDiff()} />);
    await screen.findByRole("table", { name: "Pull request diff contents" });
    const fileButtons = screen.getAllByRole("button", {
      name: "Copy file src/old.ts -> src/new.ts",
    });
    expect(fileButtons).toHaveLength(2);

    await user.click(fileButtons[0] as HTMLButtonElement);
    expect(await navigator.clipboard.readText()).toBe(
      "diff --git a/src/old.ts b/src/new.ts\n" +
        "rename from src/old.ts\n" +
        "rename to src/new.ts\n" +
        "--- a/src/old.ts\n" +
        "+++ b/src/new.ts\n" +
        "@@ -1,3 +1,3 @@ function example\n" +
        "-const value = 'old';\n" +
        "\\ No newline at end of file\n" +
        "+\tconst value = '<script>';  \n" +
        " unchanged\n",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Copied file src/old.ts -> src/new.ts.");

    const hunkButton = screen.getByRole("button", {
      name: "Copy hunk from src/old.ts -> src/new.ts, @@ -1,3 +1,3 @@ function example",
    });
    hunkButton.focus();
    await user.keyboard("{Enter}");
    expect(await navigator.clipboard.readText()).toMatch(
      /^--- a\/src\/old\.ts\n\+\+\+ b\/src\/new\.ts\n@@ -1,3 \+1,3 @@/,
    );
    expect(await navigator.clipboard.readText()).not.toContain("rename from");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Copied hunk from src/old.ts -> src/new.ts.",
    );
    const binaryCopy = screen.getByRole("button", {
      name: "Copy unavailable for binary file asset.bin",
    });
    expect(binaryCopy).toBeDisabled();
    expect(binaryCopy).toHaveTextContent("Copy unavailable");
    expect(binaryCopy).toHaveAttribute("title", "Binary patch content is unavailable");
  });

  it("announces clipboard rejection without losing search or diff state", async () => {
    const user = userEvent.setup();
    render(() => <DiffView diff={smallDiff()} />);
    const input = await screen.findByRole("searchbox", { name: "Search diff" });
    await user.type(input, "old");
    await screen.findByText("1 of 1");
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new DOMException("Denied"));

    await user.click(
      screen.getByRole("button", {
        name: "Copy hunk from src/old.ts -> src/new.ts, @@ -1,3 +1,3 @@ function example",
      }),
    );

    expect(
      await screen.findByText("Could not copy hunk from src/old.ts -> src/new.ts."),
    ).toHaveClass("pr-diff-copyStatus--failure");
    expect(input).toHaveValue("old");
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Pull request diff contents" })).toHaveAttribute(
      "aria-rowcount",
      "9",
    );
  });

  it("serializes copy writes, repeats announcements, and clears stale diff outcomes", async () => {
    const user = userEvent.setup();
    const [diff, setDiff] = createSignal(smallDiff());
    render(() => <DiffView diff={diff()} />);
    const copyButton = (name = "Copy file src/old.ts -> src/new.ts") =>
      screen.getAllByRole("button", { name })[0] as HTMLButtonElement;
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    writeText.mockResolvedValueOnce(undefined);

    await user.click(copyButton());
    expect(await screen.findByText("Copied file src/old.ts -> src/new.ts.")).toBeInTheDocument();

    const repeatedWrite = deferred<void>();
    writeText.mockReturnValueOnce(repeatedWrite.promise);
    copyButton().focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status").textContent).toBe("");
    expect(copyButton()).toHaveFocus();
    expect(copyButton()).toHaveAttribute("aria-busy", "true");
    expect(copyButton()).toHaveAttribute("aria-disabled", "true");
    await user.click(
      screen.getByRole("button", {
        name: "Copy hunk from src/old.ts -> src/new.ts, @@ -1,3 +1,3 @@ function example",
      }),
    );
    expect(writeText).toHaveBeenCalledTimes(2);
    repeatedWrite.resolve(undefined);
    expect(await screen.findByText("Copied file src/old.ts -> src/new.ts.")).toBeInTheDocument();

    const staleWrite = deferred<void>();
    writeText.mockReturnValueOnce(staleWrite.promise);
    await user.click(copyButton());
    const replacement = smallDiff();
    const replacementFile = replacement.files[0];
    if (replacementFile !== undefined) {
      replacementFile.oldPath = "src/before.ts";
      replacementFile.newPath = "src/after.ts";
    }
    setDiff(replacement);
    expect(screen.getByRole("status").textContent).toBe("");
    staleWrite.resolve(undefined);
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Copy file src/before.ts -> src/after.ts" })[0],
      ).toBeEnabled(),
    );
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("ignores clipboard rejection after the Diff view unmounts", async () => {
    const user = userEvent.setup();
    const pendingWrite = deferred<void>();
    vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(pendingWrite.promise);
    const { container, unmount } = render(() => <DiffView diff={smallDiff()} />);

    await user.click(
      screen.getAllByRole("button", { name: "Copy file src/old.ts -> src/new.ts" })[0] as Element,
    );
    unmount();
    pendingWrite.reject(new DOMException("Denied"));
    await Promise.resolve();
    await Promise.resolve();

    expect(container).toBeEmptyDOMElement();
  });

  it("rebuilds virtual geometry when a same-count Diff changes row heights", async () => {
    const [diff, setDiff] = createSignal(sameCountDiff("source"));
    const { container } = render(() => <DiffView diff={diff()} />);
    const spacer = container.querySelector<HTMLElement>(".pr-diff-spacer");

    await waitFor(() => expect(spacer).toHaveStyle({ height: "120px" }));
    setDiff(sameCountDiff("notices"));
    await waitFor(() => expect(spacer).toHaveStyle({ height: "144px" }));
  });

  it("updates the virtual window when preceding content changes the table offset", async () => {
    let documentTop = 200;
    let notifyResize = () => {};
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.stubGlobal("scrollY", 1_000);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          bottom: 0,
          height: 0,
          left: 0,
          right: 0,
          top: documentTop - window.scrollY,
          width: 0,
          x: 0,
          y: documentTop - window.scrollY,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    const { container } = render(() => <DiffView diff={largeDiff(1_000)} />);
    await screen.findByRole("table", { name: "Pull request diff contents" });

    const firstMountedIndex = () =>
      Number(container.querySelector<HTMLElement>("[data-diff-row]")?.dataset["diffRow"]);
    await waitFor(() => expect(firstMountedIndex()).toBeGreaterThan(0));
    const before = firstMountedIndex();

    documentTop = 500;
    notifyResize();

    await waitFor(() => expect(firstMountedIndex()).toBeLessThan(before));
    expect(container.querySelector<HTMLElement>(".pr-diff-virtualRows")?.style.transform).toMatch(
      /^translateY\(/,
    );
  });

  it("keeps the mounted DOM bounded and renders distant rows after window scrolling", async () => {
    const lineCount = 50_000;
    render(() => <DiffView diff={largeDiff(lineCount)} />);
    const table = await screen.findByRole("table", { name: "Pull request diff contents" });

    await waitFor(() => expect(within(table).getAllByRole("row").length).toBeGreaterThan(0));
    expect(table).toHaveAttribute("aria-rowcount", String(lineCount + 2));
    expect(within(table).getAllByRole("row").length).toBeLessThan(200);

    vi.stubGlobal("scrollY", (lineCount + 1) * 24);
    window.dispatchEvent(new Event("scroll"));

    expect(await within(table).findByText(`line ${lineCount - 1}`)).toBeInTheDocument();
    expect(within(table).getAllByRole("row").length).toBeLessThan(200);
  });

  it("jumps to file starts and tracks the first visible file", async () => {
    const user = userEvent.setup();
    const diff = multiFileDiff();
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(5_000);
    render(() => <DiffView diff={diff} />);
    const picker = await screen.findByRole("combobox", { name: "Jump to file" });

    expect(screen.getByLabelText("Active file: file-0.txt")).toBeInTheDocument();
    await user.selectOptions(picker, "1");
    expect(vi.mocked(scrollTo)).toHaveBeenLastCalledWith({ behavior: "auto", top: 312 });
    expect(screen.getByLabelText("Active file: file-0.txt")).toBeInTheDocument();

    vi.stubGlobal("scrollY", 313);
    window.dispatchEvent(new Event("scroll"));
    await waitFor(() =>
      expect(screen.getByLabelText("Active file: file-1.txt")).toBeInTheDocument(),
    );

    vi.stubGlobal("scrollY", 625);
    window.dispatchEvent(new Event("scroll"));
    await waitFor(() =>
      expect(screen.getByLabelText("Active file: file-2.txt")).toBeInTheDocument(),
    );
  });

  it("synchronizes rail, wheel, remounted rows, and resize clamping", async () => {
    let railScrollWidth = 900;
    let notifyResize = () => {};
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("pr-diff-horizontalRail") ? 300 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("pr-diff-horizontalRail") ? railScrollWidth : 0;
      },
    );
    const [diff, setDiff] = createSignal(largeDiff(1_000));
    const { container } = render(() => <DiffView diff={diff()} />);
    const table = await screen.findByRole("table", { name: "Pull request diff contents" });
    const rail = screen.getByRole("region", { name: "Scroll diff horizontally" });

    rail.scrollLeft = 120;
    rail.dispatchEvent(new Event("scroll"));
    expect(table.style.getPropertyValue("--pr-diff-horizontal-offset")).toBe("120px");

    const source = container.querySelector<HTMLElement>(".pr-diff-source");
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 80 });
    source?.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(rail.scrollLeft).toBe(200);
    expect(table.style.getPropertyValue("--pr-diff-horizontal-offset")).toBe("200px");

    source?.dispatchEvent(pointerEvent("pointerdown", 200));
    const pointerMove = pointerEvent("pointermove", 150);
    source?.dispatchEvent(pointerMove);
    expect(pointerMove.defaultPrevented).toBe(true);
    expect(rail.scrollLeft).toBe(250);
    expect(table.style.getPropertyValue("--pr-diff-horizontal-offset")).toBe("250px");
    source?.dispatchEvent(pointerEvent("pointerup", 150));

    rail.scrollLeft = 600;
    rail.dispatchEvent(new Event("scroll"));
    const edgeWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 80 });
    source?.dispatchEvent(edgeWheel);
    expect(edgeWheel.defaultPrevented).toBe(false);
    expect(rail.scrollLeft).toBe(600);

    rail.scrollLeft = 200;
    rail.dispatchEvent(new Event("scroll"));

    vi.stubGlobal("scrollY", 10_000);
    window.dispatchEvent(new Event("scroll"));
    await waitFor(() =>
      expect(container.querySelector<HTMLElement>("[data-diff-row]")?.dataset["diffRow"]).not.toBe(
        "0",
      ),
    );
    expect(table.style.getPropertyValue("--pr-diff-horizontal-offset")).toBe("200px");

    railScrollWidth = 350;
    setDiff(smallDiff());
    await waitFor(() => expect(rail.scrollLeft).toBe(50));
    expect(table.style.getPropertyValue("--pr-diff-horizontal-offset")).toBe("50px");

    railScrollWidth = 320;
    notifyResize();
    expect(rail.scrollLeft).toBe(20);
    expect(table.style.getPropertyValue("--pr-diff-horizontal-offset")).toBe("20px");
  });

  it("scopes find shortcuts and wraps highlighted result navigation", async () => {
    const user = userEvent.setup();
    const diff = smallDiff();
    const sourceLine = diff.files[0]?.hunks[0]?.lines[1];
    if (sourceLine !== undefined) sourceLine.content = "needle and NEEDLE";
    const { container, unmount } = render(() => (
      <>
        <button type="button">Before diff</button>
        <DiffView diff={diff} />
      </>
    ));
    const input = await screen.findByRole("searchbox", { name: "Search diff" });
    const previousFocus = screen.getByRole("button", { name: "Before diff" });
    previousFocus.focus();

    const findEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "f",
    });
    window.dispatchEvent(findEvent);
    expect(findEvent.defaultPrevented).toBe(true);
    expect(input).toHaveFocus();

    await user.type(input, "needle");
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toHaveAttribute("aria-atomic", "true");
    expect(container.querySelectorAll("mark")).toHaveLength(2);
    expect(container.querySelectorAll(".pr-diff-searchMatch--active")).toHaveLength(1);
    expect(container.querySelector(".pr-diff-searchMatch--active")).toHaveTextContent("needle");

    await user.click(screen.getByRole("button", { name: "Next search result" }));
    expect(await screen.findByText("2 of 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous search result" }));
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(await screen.findByText("2 of 2")).toBeInTheDocument();
    expect(container.querySelector(".pr-diff-searchMatch--active")).toHaveTextContent("NEEDLE");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(await screen.findByText("2 of 2")).toBeInTheDocument();

    previousFocus.focus();
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "f",
        metaKey: true,
      }),
    );
    expect(input).toHaveFocus();
    expect(input).toHaveProperty("selectionStart", 0);
    expect(input).toHaveProperty("selectionEnd", 6);

    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    expect(previousFocus).toHaveFocus();
    unmount();
    const afterUnmount = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
      key: "f",
    });
    window.dispatchEvent(afterUnmount);
    expect(afterUnmount.defaultPrevented).toBe(false);
  });

  it("leaves modified find shortcuts and composing input to the browser", async () => {
    const diff = smallDiff();
    const sourceLine = diff.files[0]?.hunks[0]?.lines[1];
    if (sourceLine !== undefined) sourceLine.content = "needle then needle";
    render(() => <DiffView diff={diff} />);
    const input = await screen.findByRole("searchbox", { name: "Search diff" });

    for (const modifiers of [
      { ctrlKey: true, shiftKey: true },
      { altKey: true, ctrlKey: true },
      { ctrlKey: true, metaKey: true },
    ]) {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "f",
        ...modifiers,
      });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(input).not.toHaveFocus();
    }

    fireEvent.input(input, { target: { value: "needle" } });
    input.focus();
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();
    for (const key of ["Enter", "Escape"]) {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        isComposing: true,
        key,
      });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(input).toHaveValue("needle");
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("reveals a match near the final source column through the shared rail", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("pr-diff-horizontalRail") ? 200 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("pr-diff-horizontalRail") ? 1_000 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const rail = document.querySelector<HTMLElement>(".pr-diff-horizontalRail");
        const offset = rail?.scrollLeft ?? 0;
        if (this.classList.contains("pr-diff-searchMatch--active")) {
          return domRect(400 - offset, 450 - offset);
        }
        if (this.classList.contains("pr-diff-source")) return domRect(0, 200);
        return domRect(0, 0);
      },
    );
    const diff = smallDiff();
    const sourceLine = diff.files[0]?.hunks[0]?.lines[1];
    if (sourceLine !== undefined) sourceLine.content = `${"x".repeat(1_000)}rare`;
    render(() => <DiffView diff={diff} />);
    const input = await screen.findByRole("searchbox", { name: "Search diff" });
    const rail = screen.getByRole("region", { name: "Scroll diff horizontally" });

    await user.type(input, "rare");
    expect(await screen.findByText("1 of 1")).toBeInTheDocument();
    await waitFor(() => expect(rail.scrollLeft).toBeGreaterThan(0));
    const activeMatch = document.querySelector<HTMLElement>(".pr-diff-searchMatch--active");
    const source = activeMatch?.closest<HTMLElement>(".pr-diff-source");
    expect(activeMatch?.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      source?.getBoundingClientRect().left ?? 0,
    );
    expect(activeMatch?.getBoundingClientRect().right).toBeLessThanOrEqual(
      source?.getBoundingClientRect().right ?? 0,
    );
    expect(rail.scrollLeft).toBe(400);
  });

  it("bounds dense mounted highlights while keeping the active result rendered", async () => {
    const diff = smallDiff();
    const sourceLine = diff.files[0]?.hunks[0]?.lines[1];
    if (sourceLine !== undefined) sourceLine.content = "x ".repeat(500);
    const { container } = render(() => <DiffView diff={diff} />);
    const input = await screen.findByRole("searchbox", { name: "Search diff" });

    fireEvent.input(input, { target: { value: "x" } });
    expect(await screen.findByText("1 of 500")).toBeInTheDocument();
    let marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(200);
    expect(container.querySelector(".pr-diff-searchMatch--active")).toBe(marks[0]);
    expect(
      marks[0]?.closest(".pr-diff-sourceContent")?.textContent?.endsWith(sourceLine?.content ?? ""),
    ).toBe(true);

    input.focus();
    await userEvent.setup().keyboard("{Shift>}{Enter}{/Shift}");
    expect(await screen.findByText("500 of 500")).toBeInTheDocument();
    marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(200);
    expect(container.querySelectorAll(".pr-diff-searchMatch--active")).toHaveLength(1);
    expect(container.querySelector(".pr-diff-searchMatch--active")).toBe(marks[199]);

    await userEvent.setup().click(screen.getByRole("button", { name: "Next search result" }));
    expect(await screen.findByText("1 of 500")).toBeInTheDocument();
    expect(container.querySelector(".pr-diff-searchMatch--active")).toBe(
      container.querySelectorAll("mark")[0],
    );
  });

  it("announces when dense full-Diff search results are limited", async () => {
    const diff = smallDiff();
    const hunk = diff.files[0]?.hunks[0];
    if (hunk !== undefined) {
      hunk.lines = Array.from({ length: 5 }, (_, index) =>
        diffLine(index, "context", "a".repeat(400_001)),
      );
      hunk.oldCount = 5;
      hunk.newCount = 5;
    }
    const { container } = render(() => <DiffView diff={diff} />);
    const input = await screen.findByRole("searchbox", { name: "Search diff" });

    fireEvent.input(input, { target: { value: "a" } });

    const status = await screen.findByText("1 of 2000000+ (results limited)");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(container.querySelectorAll("mark")).toHaveLength(1_000);
  }, 20_000);

  it("centers and mounts a distant search result", async () => {
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(30_000);
    const { container } = render(() => <DiffView diff={largeDiff(1_000)} />);
    const input = await screen.findByRole("searchbox", { name: "Search diff" });
    expect(container).not.toHaveTextContent("line 900");
    const initialScrollCallCount = vi.mocked(scrollTo).mock.calls.length;

    fireEvent.input(input, { target: { value: "line 900" } });

    expect(await screen.findByText("1 of 1")).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(scrollTo).mock.calls.length).toBeGreaterThan(initialScrollCallCount),
    );
    const scrollOptions = vi
      .mocked(scrollTo)
      .mock.calls.map(([options]) => options as ScrollToOptions)
      .sort((left, right) => (right.top ?? 0) - (left.top ?? 0))[0];
    expect(scrollOptions).toMatchObject({ behavior: "auto", top: expect.any(Number) });
    expect(scrollOptions?.top).toBeCloseTo(21_444, 0);

    vi.stubGlobal("scrollY", scrollOptions?.top ?? 0);
    window.dispatchEvent(new Event("scroll"));
    const activeMatch = await screen.findByText("line 900", { selector: "mark" });
    expect(activeMatch).toHaveClass("pr-diff-searchMatch--active");
  });

  it("applies navigation requested while a new query is deferred", async () => {
    const diff = smallDiff();
    const sourceLine = diff.files[0]?.hunks[0]?.lines[1];
    if (sourceLine !== undefined) sourceLine.content = "needle then needle";
    render(() => <DiffView diff={diff} />);
    const input = await screen.findByRole("searchbox", { name: "Search diff" });

    fireEvent.input(input, { target: { value: "needle" } });
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        shiftKey: true,
      }),
    );

    expect(await screen.findByText("2 of 2")).toBeInTheDocument();
  });

  it("accumulates pending navigation and does not consume it on layout refresh", async () => {
    const first = smallDiff();
    const firstSource = first.files[0]?.hunks[0]?.lines[1];
    if (firstSource !== undefined) firstSource.content = "old old old";
    const [diff, setDiff] = createSignal(first);
    render(() => <DiffView diff={diff()} />);
    const input = await screen.findByRole("searchbox", { name: "Search diff" });
    await userEvent.setup().type(input, "old");
    await screen.findByText("1 of 4");

    fireEvent.input(input, { target: { value: "new" } });
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    const refreshed = smallDiff();
    const refreshedSource = refreshed.files[0]?.hunks[0]?.lines[1];
    if (refreshedSource !== undefined) refreshedSource.content = "new new new";
    setDiff(refreshed);

    expect(await screen.findByText("3 of 3")).toBeInTheDocument();
  });

  it("discards pending navigation when deferral skips to another query", async () => {
    const diff = smallDiff();
    const sourceLine = diff.files[0]?.hunks[0]?.lines[1];
    if (sourceLine !== undefined) sourceLine.content = "old old target target";
    render(() => <DiffView diff={diff} />);
    const input = await screen.findByRole("searchbox", { name: "Search diff" });
    await userEvent.setup().type(input, "old");
    await screen.findByText("1 of 3");
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await screen.findByText("2 of 3");

    fireEvent.input(input, { target: { value: "new" } });
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    fireEvent.input(input, { target: { value: "target" } });

    expect(await screen.findByText("1 of 2")).toBeInTheDocument();
  });
});

const domRect = (left: number, right: number): DOMRect =>
  ({
    bottom: 0,
    height: 0,
    left,
    right,
    top: 0,
    width: right - left,
    x: left,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const pointerEvent = (type: string, clientX: number): PointerEvent => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    pointerId: { value: 1 },
    pointerType: { value: "touch" },
  });
  return event as PointerEvent;
};

const diffLine = (
  index: number,
  kind: PullRequestDiffLine["kind"],
  content = `line ${index}`,
): PullRequestDiffLine => ({
  content,
  kind,
  missingNewline: false,
  newLine: kind === "deletion" ? null : index + 1,
  oldLine: kind === "addition" ? null : index + 1,
});

const smallDiff = (): PullRequestDiff => ({
  files: [
    {
      additions: 1,
      binary: false,
      deletions: 1,
      hunks: [
        {
          context: "function example",
          lines: [
            { ...diffLine(0, "deletion", "const value = 'old';"), missingNewline: true },
            diffLine(1, "addition", "\tconst value = '<script>';  "),
            diffLine(2, "context", "unchanged"),
          ],
          newCount: 3,
          newStart: 1,
          oldCount: 3,
          oldStart: 1,
        },
      ],
      newMode: "100644",
      newPath: "src/new.ts",
      oldMode: "100644",
      oldPath: "src/old.ts",
      operation: "renamed",
    },
    {
      additions: 0,
      binary: true,
      deletions: 0,
      hunks: [],
      newMode: "100644",
      newPath: "asset.bin",
      oldMode: "100644",
      oldPath: "asset.bin",
      operation: "modified",
    },
    {
      additions: 0,
      binary: false,
      deletions: 0,
      hunks: [],
      newMode: "100755",
      newPath: "script.sh",
      oldMode: "100644",
      oldPath: "script.sh",
      operation: "modified",
    },
  ],
  syncedAt: "2026-01-04T00:00:00Z",
});

const sameCountDiff = (shape: "source" | "notices"): PullRequestDiff => ({
  files:
    shape === "source"
      ? [
          {
            additions: 0,
            binary: false,
            deletions: 0,
            hunks: [
              {
                context: null,
                lines: [diffLine(0, "context"), diffLine(1, "context")],
                newCount: 2,
                newStart: 1,
                oldCount: 2,
                oldStart: 1,
              },
            ],
            newMode: "100644",
            newPath: "source.txt",
            oldMode: "100644",
            oldPath: "source.txt",
            operation: "modified",
          },
        ]
      : [
          {
            additions: 0,
            binary: true,
            deletions: 0,
            hunks: [],
            newMode: "100644",
            newPath: "one.bin",
            oldMode: "100644",
            oldPath: "one.bin",
            operation: "modified",
          },
          {
            additions: 0,
            binary: true,
            deletions: 0,
            hunks: [],
            newMode: "100644",
            newPath: "two.bin",
            oldMode: "100644",
            oldPath: "two.bin",
            operation: "modified",
          },
        ],
  syncedAt: "2026-01-04T00:00:00Z",
});

const largeDiff = (lineCount: number): PullRequestDiff => ({
  files: [
    {
      additions: 0,
      binary: false,
      deletions: 0,
      hunks: [
        {
          context: null,
          lines: Array.from({ length: lineCount }, (_, index) => diffLine(index, "context")),
          newCount: lineCount,
          newStart: 1,
          oldCount: lineCount,
          oldStart: 1,
        },
      ],
      newMode: "100644",
      newPath: "large.txt",
      oldMode: "100644",
      oldPath: "large.txt",
      operation: "modified",
    },
  ],
  syncedAt: "2026-01-04T00:00:00Z",
});

const multiFileDiff = (): PullRequestDiff => ({
  files: Array.from({ length: 3 }, (_, fileIndex) => ({
    additions: 0,
    binary: false,
    deletions: 0,
    hunks: [
      {
        context: null,
        lines: Array.from({ length: 10 }, (_, lineIndex) =>
          diffLine(fileIndex * 10 + lineIndex, "context"),
        ),
        newCount: 10,
        newStart: fileIndex * 10 + 1,
        oldCount: 10,
        oldStart: fileIndex * 10 + 1,
      },
    ],
    newMode: "100644" as const,
    newPath: `file-${fileIndex}.txt`,
    oldMode: "100644" as const,
    oldPath: `file-${fileIndex}.txt`,
    operation: "modified" as const,
  })),
  syncedAt: "2026-01-04T00:00:00Z",
});
