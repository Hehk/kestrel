import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
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
});

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
