import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Msg } from "./diffViewModel";
import { init } from "./diffViewModel";
import type { DiffViewElements, RuntimeEnvironment } from "./diffViewRuntime";
import { createDiffViewRuntime } from "./diffViewRuntime";
import type { PullRequestDiff } from "./layout";
import * as Search from "./search";

beforeEach(() => {
  vi.stubGlobal("innerHeight", 480);
  vi.stubGlobal("innerWidth", 1_280);
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("scrollY", 0);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const scheduler = () => {
  const tasks: Array<{ run: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
  return {
    tasks,
    schedule: (run: () => void) => {
      const cancel = vi.fn();
      tasks.push({ run, cancel });
      return cancel;
    },
    flush: () => {
      for (const task of tasks.splice(0)) task.run();
    },
  };
};

const harness = (changes: Partial<RuntimeEnvironment> = {}) => {
  const scheduled = scheduler();
  const frames = scheduler();
  const messages: Msg[] = [];
  const env: RuntimeEnvironment = {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    createResizeObserver: undefined,
    schedule: scheduled.schedule,
    afterRender: frames.schedule,
    window,
    ...changes,
  };
  const runtime = createDiffViewRuntime((msg) => messages.push(msg), env);
  return { runtime, env, messages, scheduled, frames };
};

const snapshots = (messages: Msg[]) =>
  messages.filter((msg) => msg.kind === "VirtualWindowChanged");

describe("diffViewRuntime", () => {
  it("attaches subscriptions once, publishes plain snapshots, and disposes once", () => {
    let resize: ResizeObserverCallback | undefined;
    const observer = {
      disconnect: vi.fn(),
      observe: vi.fn(),
      unobserve: vi.fn(),
    } as unknown as ResizeObserver;
    const { runtime, messages } = harness({
      createResizeObserver: (callback) => {
        resize = callback;
        return observer;
      },
    });
    const model = init(makeDiff());
    const elements = makeElements();
    runtime.attach(elements, model);
    runtime.attach(elements, model);
    expect(observer.observe).toHaveBeenCalledTimes(3);
    expect(messages.some((msg) => msg.kind === "GeometryObserved")).toBe(true);
    expect(snapshots(messages).at(-1)).toMatchObject({
      revision: 0,
      configuration: 0,
      totalSize: 96,
    });

    const find = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "f",
    });
    window.dispatchEvent(find);
    expect(find.defaultPrevented).toBe(true);
    expect(messages.at(-1)).toEqual({ kind: "FindRequested" });
    elements.searchInput.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    expect(messages.at(-1)).toEqual({ direction: 1, kind: "SearchMoveRequested" });
    resize?.([], observer);
    expect(messages.at(-1)?.kind).toBe("GeometryObserved");

    runtime.dispose();
    runtime.dispose();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    const count = messages.length;
    resize?.([], observer);
    window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, key: "f" }));
    window.dispatchEvent(new Event("scroll"));
    runtime.attach(elements, model);
    expect(messages).toHaveLength(count);
  });

  it("owns virtual-core geometry, revision-tagged replacement, and one-shot scrolling", () => {
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(30_000);
    const { runtime, messages } = harness();
    const model = init(makeDiff(1_000));
    runtime.attach(makeElements(), model);
    const first = snapshots(messages).at(-1);
    expect(first?.rows.length).toBeGreaterThan(0);
    expect(first?.rows.length).toBeLessThan(200);
    expect(first?.totalSize).toBe(24_072);
    runtime.run({ kind: "ScrollToRow", align: "center", rowIndex: 902 });
    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "auto", top: 21_444 });
    const replacement = init(makeDiff(2));
    runtime.run({
      kind: "ConfigureVirtualizer",
      layout: replacement.layout,
      geometry: replacement.geometry,
      revision: 1,
      configuration: 1,
    });
    expect(snapshots(messages).at(-1)).toMatchObject({
      revision: 1,
      configuration: 1,
      totalSize: 120,
    });
    runtime.dispose();
  });

  it("remeasures a same-count replacement whose row heights change", () => {
    const { runtime, messages } = harness();
    runtime.attach(makeElements(), init(makeDiff(2)));
    expect(snapshots(messages).at(-1)?.totalSize).toBe(120);
    const replacement = init({
      files: ["one.bin", "two.bin"].map((path) => ({
        additions: 0,
        deletions: 0,
        content: { kind: "binary" },
        operation: { kind: "modified", path, modeChange: { kind: "unchanged" } },
      })),
      syncedAt: "now",
    });
    runtime.run({
      kind: "ConfigureVirtualizer",
      layout: replacement.layout,
      geometry: replacement.geometry,
      revision: 1,
      configuration: 1,
    });
    expect(snapshots(messages).at(-1)?.totalSize).toBe(144);
    runtime.dispose();
  });

  it("cancels queued searches before scanning, even if cancelled callbacks run", () => {
    const { runtime, messages, scheduled } = harness();
    const search = vi.spyOn(Search, "searchDiff");
    const model = init(makeDiff());
    runtime.run({ kind: "Search", layout: model.layout, query: "old", requestId: 3, revision: 0 });
    runtime.run({
      kind: "Search",
      layout: model.layout,
      query: "needle",
      requestId: 4,
      revision: 0,
    });
    expect(scheduled.tasks[0]?.cancel).toHaveBeenCalledOnce();
    expect(messages).toEqual([]);
    scheduled.flush();
    expect(search).toHaveBeenCalledOnce();
    expect(messages[0]).toMatchObject({
      kind: "SearchCompleted",
      requestId: 4,
      revision: 0,
      results: { count: 1 },
    });
    runtime.run({
      kind: "Search",
      layout: model.layout,
      query: "needle",
      requestId: 5,
      revision: 0,
    });
    runtime.run({ kind: "CancelSearch" });
    scheduled.flush();
    expect(search).toHaveBeenCalledOnce();
    runtime.run({
      kind: "Search",
      layout: model.layout,
      query: "needle",
      requestId: 6,
      revision: 0,
    });
    runtime.dispose();
    scheduled.flush();
    expect(search).toHaveBeenCalledOnce();
  });

  it("reports clipboard completion, synchronous failure, and missing clipboard", async () => {
    const { runtime, env, messages } = harness();
    runtime.run({ kind: "WriteClipboard", requestId: 8, revision: 2, text: "patch" });
    await Promise.resolve();
    expect(env.clipboard?.writeText).toHaveBeenCalledWith("patch");
    expect(messages[0]).toEqual({
      kind: "ClipboardWriteFinished",
      ok: true,
      requestId: 8,
      revision: 2,
    });
    vi.mocked(env.clipboard!.writeText).mockImplementationOnce(() => {
      throw new DOMException("Denied");
    });
    runtime.run({ kind: "WriteClipboard", requestId: 9, revision: 2, text: "patch" });
    expect(messages[1]).toMatchObject({ kind: "ClipboardWriteFinished", ok: false, requestId: 9 });
    const unavailable = harness({ clipboard: undefined });
    unavailable.runtime.run({ kind: "WriteClipboard", requestId: 1, revision: 0, text: "patch" });
    expect(unavailable.messages[0]).toMatchObject({ kind: "ClipboardWriteFinished", ok: false });
    runtime.dispose();
    unavailable.runtime.dispose();
  });

  it("ignores clipboard rejection after disposal", async () => {
    let reject!: (error: Error) => void;
    const { runtime, messages } = harness({
      clipboard: {
        writeText: () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
      },
    });
    runtime.run({ kind: "WriteClipboard", requestId: 1, revision: 0, text: "patch" });
    runtime.dispose();
    reject(new Error("Denied"));
    await Promise.resolve();
    expect(messages).toEqual([]);
  });

  it("measures the specified match after rendering without choosing a scroll offset", () => {
    const { runtime, messages, frames } = harness();
    const elements = makeElements();
    const model = init(makeDiff());
    runtime.attach(elements, model);
    messages.length = 0;
    const target = { id: 1, revision: 0, rowIndex: 2, offset: 0, length: 6 };
    runtime.run({ kind: "MeasureMatch", target });
    expect(messages).toEqual([]);
    frames.flush();
    expect(messages.at(-1)).toEqual({ kind: "MatchMeasured", id: 1, revision: 0, bounds: null });

    const row = document.createElement("div");
    row.dataset["diffRow"] = "2";
    const source = document.createElement("div");
    source.className = "pr-diff-source";
    const mark = document.createElement("mark");
    mark.dataset["matchOffset"] = "0";
    mark.dataset["matchLength"] = "6";
    source.append(mark);
    row.append(source);
    runtime.run({ kind: "MeasureMatch", target });
    elements.table.append(row);
    frames.flush();
    expect(messages.at(-1)).toMatchObject({
      kind: "MatchMeasured",
      bounds: { left: 0, right: 0, viewportLeft: 0, viewportRight: 0, horizontalOffset: 0 },
    });
    expect(elements.horizontalRail.scrollLeft).toBe(0);
    runtime.dispose();
  });

  it("cancels superseded post-render work and rejects old geometry configurations", () => {
    const { runtime, messages, frames } = harness();
    const model = init(makeDiff());
    runtime.attach(makeElements(), model);
    const target = { id: 1, revision: 0, rowIndex: 2, offset: 0, length: 6 };
    runtime.run({ kind: "MeasureMatch", target });
    runtime.run({ kind: "CancelReveal" });
    runtime.run({ kind: "MeasureGeometry", configuration: 0, revision: 0 });
    runtime.run({
      kind: "ConfigureVirtualizer",
      layout: model.layout,
      geometry: model.geometry,
      configuration: 1,
      revision: 0,
    });
    messages.length = 0;
    frames.flush();
    expect(messages).toEqual([]);
    runtime.run({ kind: "MeasureMatch", target });
    runtime.run({
      kind: "ConfigureVirtualizer",
      layout: model.layout,
      geometry: model.geometry,
      configuration: 2,
      revision: 1,
    });
    messages.length = 0;
    frames.flush();
    expect(messages).toEqual([]);
    runtime.run({ kind: "MeasureGeometry", configuration: 2, revision: 1 });
    runtime.dispose();
    frames.flush();
    expect(messages).toEqual([]);
  });

  it("normalizes input but does not move the rail without a model effect", () => {
    const { runtime, messages } = harness();
    const elements = makeElements();
    const source = document.createElement("div");
    source.className = "pr-diff-source";
    elements.table.append(source);
    runtime.attach(elements, init(makeDiff()));
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 2,
      deltaMode: 1,
    });
    source.dispatchEvent(wheel);
    expect(messages.at(-1)).toEqual({ kind: "HorizontalMoveRequested", delta: 48 });
    expect(elements.horizontalRail.scrollLeft).toBe(0);
    expect(wheel.defaultPrevented).toBe(false);
    runtime.run({ kind: "SetHorizontalOffset", offset: 50 });
    expect(elements.horizontalRail.scrollLeft).toBe(50);
    expect(messages.at(-1)).toEqual({ kind: "HorizontalOffsetObserved", offset: 50, revision: 0 });
    runtime.dispose();
  });

  it("releases captured pointers and restores focus safely when the old element is gone", () => {
    const { runtime } = harness();
    const elements = makeElements();
    elements.table.setPointerCapture = vi.fn();
    elements.table.hasPointerCapture = vi.fn(() => true);
    elements.table.releasePointerCapture = vi.fn();
    runtime.attach(elements, init(makeDiff()));
    runtime.run({ kind: "CapturePointer", id: 3 });
    expect(elements.table.setPointerCapture).toHaveBeenCalledWith(3);
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    runtime.run({ kind: "FocusSearch" });
    expect(elements.searchInput).toHaveFocus();
    button.remove();
    runtime.run({ kind: "RestoreSearchFocus" });
    expect(elements.searchInput).not.toHaveFocus();
    runtime.dispose();
    expect(elements.table.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(3);
  });
});

const makeElements = (): DiffViewElements => {
  const root = document.createElement("div");
  const stickyStack = document.createElement("div");
  const searchInput = document.createElement("input");
  const table = document.createElement("div");
  const horizontalRail = document.createElement("div");
  root.append(stickyStack, searchInput, table, horizontalRail);
  document.body.append(root);
  return { horizontalRail, searchInput, stickyStack, table };
};

const makeDiff = (lineCount = 1): PullRequestDiff => ({
  files: [
    {
      additions: 0,
      deletions: 0,
      operation: { kind: "modified", modeChange: { kind: "unchanged" }, path: "file.txt" },
      content: {
        kind: "text",
        hunks: [
          {
            context: null,
            oldCount: lineCount,
            oldStart: 1,
            newCount: lineCount,
            newStart: 1,
            lines: Array.from({ length: lineCount }, (_, index) => ({
              content: "needle",
              kind: "context",
              missingNewline: false,
              newLine: index + 1,
              oldLine: index + 1,
            })),
          },
        ],
      },
    },
  ],
  syncedAt: "2026-01-04T00:00:00Z",
});
