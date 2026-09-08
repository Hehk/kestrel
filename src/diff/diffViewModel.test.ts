import { describe, expect, it } from "vitest";
import type { PullRequestDiff } from "./layout";
import { searchDiff } from "./search";
import type { Geometry, Model, Msg } from "./diffViewModel";
import { init, update } from "./diffViewModel";

const geometry = (changes: Partial<Geometry> = {}): Geometry => ({
  horizontalMaximum: 600,
  horizontalOffset: 0,
  railLeft: 10,
  railWidth: 300,
  scrollMargin: 100,
  stickyHeight: 72,
  ...changes,
});
const step = (model: Model, msg: Msg) => update(msg, model);
const observeGeometry = (model: Model, value = geometry()) =>
  step(model, {
    kind: "GeometryObserved",
    geometry: value,
    revision: model.revision,
    configuration: model.configuration,
  });
const completeSearch = (model: Model) =>
  step(model, {
    kind: "SearchCompleted",
    requestId: model.searchRequestId,
    revision: model.revision,
    results: searchDiff(model.layout, model.search.kind === "idle" ? "" : model.search.query),
  });

const readySearch = (content = "needle needle") => {
  let model = init(makeDiff(content));
  [model] = observeGeometry(model);
  [model] = step(model, { kind: "SearchQueryChanged", query: "needle" });
  [model] = completeSearch(model);
  return model;
};

const snapshot = (model: Model, index = 2): Msg => ({
  kind: "VirtualWindowChanged",
  revision: model.revision,
  configuration: model.configuration,
  firstVisibleRowIndex: index,
  rows: [{ index, key: `row:${index}`, size: 24, start: 172 }],
  totalSize: 196,
});

const measurement = (model: Model): Msg => ({
  kind: "MatchMeasured",
  id: model.revealId,
  revision: model.revision,
  bounds: { left: 400, right: 450, viewportLeft: 0, viewportRight: 200, horizontalOffset: 0 },
});

describe("diffViewModel", () => {
  it("initializes one document and plain interaction state", () => {
    const diff = makeDiff("needle");
    const model = init(diff);
    expect(model.layout.diff).toBe(diff);
    expect(model.layout.rowCount).toBe(3);
    expect(model.virtualWindow).toEqual({ rows: [], totalSize: 0 });
    expect(model.search).toEqual({ kind: "idle" });
    expect(model.copy).toEqual({ kind: "idle", outcome: null });
    expect(model.pointer).toBeNull();
    expect(model.reveal).toBeNull();
    expect(model).not.toHaveProperty("mounted");
    expect(model).not.toHaveProperty("diff");
  });

  it("runs searches through effects and ignores stale requests and revisions", () => {
    let model = init(makeDiff("old old target target"));
    let effects;
    [model, effects] = step(model, { kind: "SearchQueryChanged", query: "old" });
    expect(model.search).toEqual({ kind: "searching", query: "old", requestId: 1, pendingMove: 0 });
    expect(effects).toContainEqual(
      expect.objectContaining({ kind: "Search", query: "old", requestId: 1, revision: 0 }),
    );
    [model] = step(model, { direction: 1, kind: "SearchMoveRequested" });
    [model] = step(model, { direction: 1, kind: "SearchMoveRequested" });
    expect(model.search).toMatchObject({ pendingMove: 2 });
    for (const identity of [
      { requestId: 0, revision: 0 },
      { requestId: 1, revision: -1 },
    ]) {
      expect(
        step(model, {
          kind: "SearchCompleted",
          ...identity,
          results: searchDiff(model.layout, "old"),
        }),
      ).toEqual([model, []]);
    }
    [model, effects] = completeSearch(model);
    expect(model.search).toMatchObject({ activeIndex: 0, kind: "ready" });
    expect(effects).toContainEqual({ kind: "ScrollToRow", align: "center", rowIndex: 2 });
    expect(effects).toContainEqual({ kind: "MeasureMatch", target: model.reveal });
  });

  it("cancels a cleared query and never reuses request IDs", () => {
    let model = readySearch();
    let effects;
    [model, effects] = step(model, { kind: "SearchQueryChanged", query: "" });
    expect(model.search).toEqual({ kind: "idle" });
    expect(model.reveal).toBeNull();
    expect(effects).toEqual([{ kind: "CancelReveal" }, { kind: "CancelSearch" }]);
    [model] = step(model, { kind: "SearchQueryChanged", query: "needle" });
    expect(model.search).toMatchObject({ requestId: 3, pendingMove: 0 });
    [model] = step(model, { direction: -1, kind: "SearchMoveRequested" });
    [model] = step(model, { kind: "SearchQueryChanged", query: "other" });
    expect(model.search).toMatchObject({ requestId: 4, pendingMove: 0 });
    [model, effects] = completeSearch(model);
    expect(model.search).toMatchObject({ kind: "ready", activeIndex: -1, results: { count: 0 } });
    expect(effects).toEqual([]);
  });

  it("preserves pending navigation on refresh but invalidates old observations", () => {
    let model = init(makeDiff("old"));
    [model] = step(model, { kind: "SearchQueryChanged", query: "new" });
    [model] = step(model, { direction: 1, kind: "SearchMoveRequested" });
    [model] = step(model, { direction: 1, kind: "SearchMoveRequested" });
    const oldSnapshot = snapshot(model);
    const oldGeometry: Msg = {
      kind: "GeometryObserved",
      revision: model.revision,
      configuration: model.configuration,
      geometry: geometry(),
    };
    const replacement = makeDiff("new new new");
    let effects;
    [model, effects] = step(model, { diff: replacement, kind: "DiffChanged" });
    expect(model.search).toEqual({ kind: "searching", pendingMove: 2, query: "new", requestId: 2 });
    expect(model.virtualWindow.rows).toEqual([]);
    expect(effects).toContainEqual(
      expect.objectContaining({ kind: "ConfigureVirtualizer", revision: 1, configuration: 1 }),
    );
    expect(step(model, oldSnapshot)[0]).toBe(model);
    expect(step(model, oldGeometry)[0]).toBe(model);
    [model] = completeSearch(model);
    expect(model.search).toMatchObject({ activeIndex: 2 });
    expect(step(model, { kind: "DiffChanged", diff: replacement })[0]).toBe(model);
  });

  it("wraps result navigation and replaces pending reveal identity", () => {
    let model = readySearch();
    const oldMeasurement = measurement(model);
    [model] = step(model, { direction: -1, kind: "SearchMoveRequested" });
    expect(model.search).toMatchObject({ activeIndex: 1 });
    expect(step(model, oldMeasurement)[0]).toBe(model);
    [model] = step(model, { direction: 1, kind: "SearchMoveRequested" });
    expect(model.search).toMatchObject({ activeIndex: 0 });
  });

  it("waits for the target to mount, then finishes one measured reveal", () => {
    let model = readySearch();
    expect(
      step(model, {
        kind: "MatchMeasured",
        id: model.revealId,
        revision: model.revision,
        bounds: null,
      })[0],
    ).toBe(model);
    let effects;
    [model, effects] = step(model, snapshot(model));
    expect(effects).toEqual([{ kind: "MeasureMatch", target: model.reveal }]);
    [model, effects] = step(model, measurement(model));
    expect(model.reveal).toBeNull();
    expect(model.geometry.horizontalOffset).toBe(250);
    expect(effects).toEqual([{ kind: "SetHorizontalOffset", offset: 250 }]);
    [model, effects] = step(model, snapshot(model, 1));
    expect(effects).toEqual([]);
    expect(model.geometry.horizontalOffset).toBe(250);
  });

  it("rounds measured movement outward so browser rounding does not clip a match", () => {
    const model = readySearch();
    const [next, effects] = step(model, {
      kind: "MatchMeasured",
      id: model.revealId,
      revision: model.revision,
      bounds: {
        left: 400.25,
        right: 450.25,
        viewportLeft: 0,
        viewportRight: 200,
        horizontalOffset: 0,
      },
    });
    expect(next.geometry.horizontalOffset).toBe(251);
    expect(effects).toEqual([{ kind: "SetHorizontalOffset", offset: 251 }]);
  });

  it.each<Msg>([
    { kind: "ViewportInteraction" },
    { kind: "HorizontalMoveRequested", delta: 0 },
    { kind: "HorizontalOffsetObserved", offset: 50, revision: 0 },
    { kind: "JumpToFileRequested", fileIndex: 0 },
    { kind: "SearchQueryChanged", query: "other" },
    { kind: "DiffChanged", diff: makeDiff("replacement") },
  ])("cancels reveal on $kind and ignores its delayed measurement", (msg) => {
    const model = readySearch();
    const [next, effects] = step(model, msg);
    expect(next.reveal).toBeNull();
    expect(effects).toContainEqual({ kind: "CancelReveal" });
    expect(step(next, measurement(model))[0]).toBe(next);
  });

  it("does not mistake our own scroll observation for manual navigation", () => {
    const model = readySearch();
    expect(
      step(model, {
        kind: "HorizontalOffsetObserved",
        revision: model.revision,
        offset: model.geometry.horizontalOffset,
      })[0],
    ).toBe(model);
    const [next] = step(model, snapshot(model));
    expect(next.reveal).toBe(model.reveal);
  });

  it("owns pointer history, ignores unrelated pointers, and clamps movement", () => {
    let model = readySearch();
    let effects;
    [model, effects] = step(model, { kind: "PointerStarted", id: 3, x: 200 });
    expect(effects).toContainEqual({ kind: "CapturePointer", id: 3 });
    expect(model.reveal).toBeNull();
    expect(step(model, { kind: "PointerStarted", id: 4, x: 100 })[0]).toBe(model);
    expect(step(model, { kind: "PointerMoved", id: 4, x: 0 })[0]).toBe(model);
    [model, effects] = step(model, { kind: "PointerMoved", id: 3, x: 150 });
    expect(model.pointer).toEqual({ id: 3, x: 150 });
    expect(effects).toEqual([{ kind: "SetHorizontalOffset", offset: 50 }]);
    [model] = step(model, { kind: "HorizontalMoveRequested", delta: 1_000 });
    expect(model.geometry.horizontalOffset).toBe(600);
    expect(step(model, { kind: "HorizontalMoveRequested", delta: 1 })[0]).toBe(model);
    [model] = step(model, { kind: "HorizontalMoveRequested", delta: -1_000 });
    expect(model.geometry.horizontalOffset).toBe(0);
    expect(step(model, { kind: "PointerEnded", id: 4 })[0]).toBe(model);
    [model, effects] = step(model, { kind: "PointerEnded", id: 3 });
    expect(model.pointer).toBeNull();
    expect(effects).toEqual([{ kind: "ReleasePointer", id: 3 }]);
  });

  it("serializes clipboard writes across refresh and suppresses stale outcomes", () => {
    let model = init(makeDiff("line"));
    let effects;
    [model, effects] = step(model, { fileIndex: 0, kind: "CopyFileRequested" });
    expect(model.copy).toMatchObject({ kind: "writing", requestId: 1, revision: 0 });
    expect(effects[0]).toMatchObject({ kind: "WriteClipboard", requestId: 1, revision: 0 });
    [model] = step(model, { diff: makeDiff("replacement"), kind: "DiffChanged" });
    expect(step(model, { kind: "CopyHunkRequested", fileIndex: 0, hunkIndex: 0 })[0]).toBe(model);
    expect(
      step(model, { kind: "ClipboardWriteFinished", ok: true, requestId: 1, revision: 1 })[0],
    ).toBe(model);
    [model] = step(model, { kind: "ClipboardWriteFinished", ok: true, requestId: 1, revision: 0 });
    expect(model.copy).toEqual({ kind: "idle", outcome: null });
    [model] = step(model, { kind: "CopyHunkRequested", fileIndex: 0, hunkIndex: 0 });
    [model] = step(model, { kind: "ClipboardWriteFinished", ok: false, requestId: 2, revision: 1 });
    expect(model.copy).toEqual({
      kind: "idle",
      outcome: { kind: "failure", message: "Could not copy hunk from file.txt." },
    });
    [model] = step(model, { kind: "CopyFileRequested", fileIndex: 0 });
    expect(model.copy).toMatchObject({ kind: "writing", requestId: 3 });
  });

  it("invalidates only vertical configuration and clamps resized horizontal geometry", () => {
    let model = init(makeDiff("line"));
    let effects;
    [model, effects] = observeGeometry(model);
    expect(effects.map((effect) => effect.kind)).toEqual([
      "ConfigureVirtualizer",
      "MeasureGeometry",
    ]);
    const oldSnapshot = snapshot(model);
    [model, effects] = observeGeometry(
      model,
      geometry({ horizontalMaximum: 50, horizontalOffset: 80 }),
    );
    expect(model.geometry.horizontalOffset).toBe(50);
    expect(effects).toEqual([{ kind: "SetHorizontalOffset", offset: 50 }]);
    [model, effects] = observeGeometry(model, geometry({ scrollMargin: 200 }));
    expect(effects.map((effect) => effect.kind)).toEqual(["ConfigureVirtualizer"]);
    expect(step(model, oldSnapshot)[0]).toBe(model);
    [model] = step(model, snapshot(model));
    expect(step(model, snapshot(model))[0]).toBe(model);
  });

  it("handles empty documents, invalid targets, binary copy, and first visible rather than overscan rows", () => {
    const diff: PullRequestDiff = { files: [], syncedAt: "now" };
    let model = init(diff);
    expect(step(model, { kind: "CopyFileRequested", fileIndex: 0 })[0]).toBe(model);
    expect(step(model, { kind: "JumpToFileRequested", fileIndex: 0 })[0]).toBe(model);
    [model] = step(model, {
      kind: "DiffChanged",
      diff: {
        ...diff,
        files: [0, 1].map((index) => ({
          additions: 0,
          deletions: 0,
          content: { kind: "binary" },
          operation: { kind: "modified", path: `${index}.bin`, modeChange: { kind: "unchanged" } },
        })),
      },
    });
    expect(step(model, { kind: "CopyFileRequested", fileIndex: 0 })[0]).toBe(model);
    const msg = snapshot(model, 0);
    if (msg.kind !== "VirtualWindowChanged") throw new Error("Expected snapshot");
    [model] = step(model, { ...msg, firstVisibleRowIndex: 2 });
    expect(model.activeFileIndex).toBe(1);
    [model] = step(model, { kind: "DiffChanged", diff });
    expect(model.activeFileIndex).toBe(0);
    expect(model.layout.rowCount).toBe(0);
  });
});

const makeDiff = (content: string): PullRequestDiff => ({
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
            oldCount: 1,
            oldStart: 1,
            newCount: 1,
            newStart: 1,
            lines: [{ content, kind: "context", missingNewline: false, newLine: 1, oldLine: 1 }],
          },
        ],
      },
    },
  ],
  syncedAt: "2026-01-04T00:00:00Z",
});
