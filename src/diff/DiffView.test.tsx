import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
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
      within(table).getByRole("columnheader", { name: "src/old.ts -> src/new.ts" }),
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
});

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
