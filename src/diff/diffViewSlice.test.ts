import { describe, expect, it } from "vitest";
import { initialState, update } from "./diffViewSlice";

describe("diffViewSlice", () => {
  it("initializes transient view state", () => {
    expect(initialState()).toEqual({
      activeFileIndex: 0,
      activeResultIndex: -1,
      copyOutcome: null,
      copyPending: false,
      horizontalOffset: 0,
      pendingResultNavigation: null,
      railLeft: 0,
      railWidth: 0,
      scrollMargin: 0,
      searchQuery: "",
      stickyHeight: 0,
    });
  });

  it("wraps resolved search result navigation", () => {
    let state = update({ kind: "SearchQueryChanged", query: "needle" }, initialState());
    state = update({ kind: "SearchResultsChanged", count: 3, query: "needle" }, state);
    expect(state.activeResultIndex).toBe(0);

    state = update({ kind: "SearchResultMoved", count: 3, direction: -1 }, state);
    expect(state.activeResultIndex).toBe(2);

    state = update({ kind: "SearchResultMoved", count: 3, direction: 1 }, state);
    expect(state.activeResultIndex).toBe(0);
  });

  it("accumulates navigation while search is pending", () => {
    let state = update({ kind: "SearchQueryChanged", query: "old" }, initialState());
    state = update({ kind: "SearchResultsChanged", count: 4, query: "old" }, state);
    state = update({ kind: "SearchQueryChanged", query: "new" }, state);
    state = update({ kind: "SearchNavigationQueued", direction: 1 }, state);
    state = update({ kind: "SearchNavigationQueued", direction: 1 }, state);

    const staleState = update({ kind: "SearchResultsChanged", count: 4, query: "old" }, state);
    expect(staleState).toBe(state);
    expect(staleState.pendingResultNavigation).toEqual({ move: 2, query: "new" });

    state = update({ kind: "SearchResultsChanged", count: 3, query: "new" }, state);
    expect(state.activeResultIndex).toBe(2);
    expect(state.pendingResultNavigation).toBeNull();
  });

  it("discards navigation queued for a skipped query", () => {
    let state = update({ kind: "SearchQueryChanged", query: "old" }, initialState());
    state = update({ kind: "SearchNavigationQueued", direction: 1 }, state);
    state = update({ kind: "SearchQueryChanged", query: "target" }, state);
    state = update({ kind: "SearchResultsChanged", count: 2, query: "target" }, state);

    expect(state.activeResultIndex).toBe(0);
    expect(state.pendingResultNavigation).toBeNull();
  });

  it("tracks copy lifecycle independently from diff changes", () => {
    let state = update({ kind: "CopyStarted" }, initialState());
    expect(state.copyPending).toBe(true);

    state = update(
      { kind: "CopyFinished", outcome: { kind: "success", message: "Copied file." } },
      state,
    );
    expect(state.copyOutcome).toEqual({ kind: "success", message: "Copied file." });
    expect(state.copyPending).toBe(false);

    state = update({ kind: "DiffChanged" }, state);
    expect(state.copyOutcome).toBeNull();
  });
});
