export type CopyOutcome = { kind: "failure" | "success"; message: string };
export type PendingResultNavigation = { move: number; query: string };

export type State = {
  activeFileIndex: number;
  activeResultIndex: number;
  copyOutcome: CopyOutcome | null;
  copyPending: boolean;
  horizontalOffset: number;
  pendingResultNavigation: PendingResultNavigation | null;
  railLeft: number;
  railWidth: number;
  scrollMargin: number;
  searchQuery: string;
  stickyHeight: number;
};

export type Msg =
  | { kind: "ActiveFileChanged"; index: number }
  | { kind: "CopyFinished"; outcome: CopyOutcome | null }
  | { kind: "CopyStarted" }
  | { kind: "DiffChanged" }
  | {
      kind: "GeometryChanged";
      railLeft: number;
      railWidth: number;
      scrollMargin: number;
      stickyHeight: number;
    }
  | { kind: "HorizontalOffsetChanged"; offset: number }
  | { kind: "SearchNavigationQueued"; direction: 1 | -1 }
  | { kind: "SearchQueryChanged"; query: string }
  | { kind: "SearchResultMoved"; count: number; direction: 1 | -1 }
  | { kind: "SearchResultsChanged"; count: number; query: string };

export const initialState = (): State => ({
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

export const update = (msg: Msg, state: State): State => {
  switch (msg.kind) {
    case "ActiveFileChanged":
      return state.activeFileIndex === msg.index ? state : { ...state, activeFileIndex: msg.index };
    case "CopyFinished":
      return { ...state, copyOutcome: msg.outcome, copyPending: false };
    case "CopyStarted":
      return state.copyPending ? state : { ...state, copyOutcome: null, copyPending: true };
    case "DiffChanged":
      return state.copyOutcome === null ? state : { ...state, copyOutcome: null };
    case "GeometryChanged":
      return state.railLeft === msg.railLeft &&
        state.railWidth === msg.railWidth &&
        state.scrollMargin === msg.scrollMargin &&
        state.stickyHeight === msg.stickyHeight
        ? state
        : {
            ...state,
            railLeft: msg.railLeft,
            railWidth: msg.railWidth,
            scrollMargin: msg.scrollMargin,
            stickyHeight: msg.stickyHeight,
          };
    case "HorizontalOffsetChanged":
      return state.horizontalOffset === msg.offset
        ? state
        : { ...state, horizontalOffset: msg.offset };
    case "SearchNavigationQueued": {
      const pending = state.pendingResultNavigation;
      return {
        ...state,
        pendingResultNavigation: {
          move: pending?.query === state.searchQuery ? pending.move + msg.direction : msg.direction,
          query: state.searchQuery,
        },
      };
    }
    case "SearchQueryChanged":
      return state.searchQuery === msg.query ? state : { ...state, searchQuery: msg.query };
    case "SearchResultMoved":
      return msg.count === 0
        ? state
        : {
            ...state,
            activeResultIndex: (state.activeResultIndex + msg.direction + msg.count) % msg.count,
          };
    case "SearchResultsChanged": {
      if (msg.query !== state.searchQuery) return state;
      const pending = state.pendingResultNavigation;
      const requestedMove = pending?.query === msg.query ? pending.move : 0;
      return {
        ...state,
        activeResultIndex:
          msg.count === 0 ? -1 : ((requestedMove % msg.count) + msg.count) % msg.count,
        pendingResultNavigation: null,
      };
    }
  }
};
