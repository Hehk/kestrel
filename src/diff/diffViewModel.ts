import type { Transition } from "../mvu";
import { buildFileCopyText, buildHunkCopyText } from "./copy";
import { fileLabel } from "./labels";
import type { DiffLayout, PullRequestDiff } from "./layout";
import { buildDiffLayout, diffFileHunks } from "./layout";
import type { DiffSearchResults } from "./search";
import { firstMatchAtOrAfterRow } from "./search";

export type MountedSearchMatch = { active: boolean; length: number; offset: number };
type VirtualRow = { index: number; key: string; size: number; start: number };
export type VirtualWindow = { rows: VirtualRow[]; totalSize: number };
export type Configuration = { revision: number; configuration: number };
export type Geometry = {
  horizontalMaximum: number;
  horizontalOffset: number;
  railLeft: number;
  railWidth: number;
  scrollMargin: number;
  stickyHeight: number;
};

export type Search =
  | { kind: "idle" }
  | { kind: "searching"; query: string; requestId: number; pendingMove: number }
  | { kind: "ready"; query: string; results: DiffSearchResults; activeIndex: number };

type Copy =
  | { kind: "idle"; outcome: { kind: "failure" | "success"; message: string } | null }
  | { kind: "writing"; requestId: number; revision: number; subject: string };

type Reveal = {
  id: number;
  revision: number;
  rowIndex: number;
  offset: number;
  length: number;
};

export type Model = Configuration & {
  activeFileIndex: number;
  copy: Copy;
  copyRequestId: number;
  geometry: Geometry;
  layout: DiffLayout;
  pointer: { id: number; x: number } | null;
  reveal: Reveal | null;
  revealId: number;
  search: Search;
  searchRequestId: number;
  virtualWindow: VirtualWindow;
};

export type Msg =
  | { kind: "ClipboardWriteFinished"; ok: boolean; requestId: number; revision: number }
  | { kind: "CopyFileRequested"; fileIndex: number }
  | { kind: "CopyHunkRequested"; fileIndex: number; hunkIndex: number }
  | { kind: "DiffChanged"; diff: PullRequestDiff }
  | { kind: "FindRequested" }
  | ({ kind: "GeometryObserved"; geometry: Geometry } & Configuration)
  | { kind: "HorizontalOffsetObserved"; offset: number; revision: number }
  | { kind: "HorizontalMoveRequested"; delta: number }
  | { kind: "JumpToFileRequested"; fileIndex: number }
  | {
      kind: "MatchMeasured";
      id: number;
      revision: number;
      bounds: {
        left: number;
        right: number;
        viewportLeft: number;
        viewportRight: number;
        horizontalOffset: number;
      } | null;
    }
  | { kind: "PointerStarted"; id: number; x: number }
  | { kind: "PointerMoved"; id: number; x: number }
  | { kind: "PointerEnded"; id: number }
  | { kind: "SearchCompleted"; revision: number; requestId: number; results: DiffSearchResults }
  | { kind: "SearchDismissRequested" }
  | { kind: "SearchMoveRequested"; direction: 1 | -1 }
  | { kind: "SearchQueryChanged"; query: string }
  | { kind: "ViewportInteraction" }
  | ({ kind: "VirtualWindowChanged"; firstVisibleRowIndex: number | null } & VirtualWindow &
      Configuration);

export type Effect =
  | { kind: "CancelReveal" }
  | { kind: "CancelSearch" }
  | { kind: "CapturePointer"; id: number }
  | ({ kind: "ConfigureVirtualizer"; geometry: Geometry; layout: DiffLayout } & Configuration)
  | { kind: "FocusSearch" }
  | ({ kind: "MeasureGeometry" } & Configuration)
  | { kind: "MeasureMatch"; target: Reveal }
  | { kind: "ReleasePointer"; id: number }
  | { kind: "RestoreSearchFocus" }
  | { kind: "Search"; layout: DiffLayout; query: string; requestId: number; revision: number }
  | { kind: "ScrollToRow"; align: "center" | "start"; rowIndex: number }
  | { kind: "SetHorizontalOffset"; offset: number }
  | { kind: "WriteClipboard"; requestId: number; revision: number; text: string };

type Change = Transition<Model, Effect>;
const NONE: readonly Effect[] = [];
const MAX_MOUNTED_MATCHES_PER_ROW = 200;

export const init = (diff: PullRequestDiff): Model => ({
  activeFileIndex: 0,
  configuration: 0,
  copy: { kind: "idle", outcome: null },
  copyRequestId: 0,
  geometry: {
    horizontalMaximum: 0,
    horizontalOffset: 0,
    railLeft: 0,
    railWidth: 0,
    scrollMargin: 0,
    stickyHeight: 0,
  },
  layout: buildDiffLayout(diff),
  pointer: null,
  reveal: null,
  revealId: 0,
  revision: 0,
  search: { kind: "idle" },
  searchRequestId: 0,
  virtualWindow: { rows: [], totalSize: 0 },
});

export const update = (msg: Msg, model: Model): Change => {
  switch (msg.kind) {
    case "DiffChanged": {
      if (model.layout.diff === msg.diff) return [model, NONE];
      const revision = model.revision + 1;
      const configuration = model.configuration + 1;
      const layout = buildDiffLayout(msg.diff);
      const searchRequestId = model.searchRequestId + 1;
      const search: Search =
        model.search.kind === "idle"
          ? model.search
          : {
              kind: "searching",
              query: model.search.query,
              pendingMove: model.search.kind === "searching" ? model.search.pendingMove : 0,
              requestId: searchRequestId,
            };
      const next: Model = {
        ...model,
        activeFileIndex: 0,
        configuration,
        copy: model.copy.kind === "writing" ? model.copy : { kind: "idle", outcome: null },
        layout,
        pointer: null,
        reveal: null,
        revision,
        search,
        searchRequestId,
        virtualWindow: { rows: [], totalSize: 0 },
      };
      const effects: Effect[] = [
        { kind: "CancelReveal" },
        { kind: "CancelSearch" },
        { kind: "ConfigureVirtualizer", configuration, geometry: model.geometry, layout, revision },
        { kind: "MeasureGeometry", configuration, revision },
      ];
      if (model.pointer !== null) effects.push({ kind: "ReleasePointer", id: model.pointer.id });
      if (search.kind === "searching") {
        effects.push({
          kind: "Search",
          layout,
          query: search.query,
          requestId: searchRequestId,
          revision,
        });
      }
      return [next, effects];
    }
    case "GeometryObserved": {
      if (!currentConfiguration(msg, model) || geometryEqual(model.geometry, msg.geometry))
        return [model, NONE];
      const geometry = {
        ...msg.geometry,
        horizontalOffset: clampOffset(msg.geometry.horizontalOffset, msg.geometry),
      };
      const verticalChanged =
        geometry.scrollMargin !== model.geometry.scrollMargin ||
        geometry.stickyHeight !== model.geometry.stickyHeight;
      const configuration = model.configuration + (verticalChanged ? 1 : 0);
      const effects: Effect[] = [];
      if (verticalChanged)
        effects.push({
          kind: "ConfigureVirtualizer",
          configuration,
          geometry,
          layout: model.layout,
          revision: model.revision,
        });
      if (geometry.railWidth !== model.geometry.railWidth)
        effects.push({ kind: "MeasureGeometry", configuration, revision: model.revision });
      if (geometry.horizontalOffset !== msg.geometry.horizontalOffset)
        effects.push({ kind: "SetHorizontalOffset", offset: geometry.horizontalOffset });
      if (model.reveal !== null) effects.push({ kind: "MeasureMatch", target: model.reveal });
      return [{ ...model, configuration, geometry }, effects];
    }
    case "VirtualWindowChanged": {
      if (!currentConfiguration(msg, model)) return [model, NONE];
      const activeFileIndex =
        (msg.firstVisibleRowIndex === null
          ? undefined
          : model.layout.fileIndexes[msg.firstVisibleRowIndex]) ?? model.activeFileIndex;
      const sameWindow =
        model.virtualWindow.totalSize === msg.totalSize &&
        rowsEqual(model.virtualWindow.rows, msg.rows);
      if (sameWindow && activeFileIndex === model.activeFileIndex) return [model, NONE];
      const effects: Effect[] =
        model.reveal !== null && msg.rows.some((row) => row.index === model.reveal?.rowIndex)
          ? [{ kind: "MeasureMatch", target: model.reveal }]
          : [];
      return [
        {
          ...model,
          activeFileIndex,
          virtualWindow: sameWindow
            ? model.virtualWindow
            : { rows: msg.rows, totalSize: msg.totalSize },
        },
        effects,
      ];
    }
    case "HorizontalOffsetObserved": {
      if (msg.revision !== model.revision) return [model, NONE];
      const offset = clampOffset(msg.offset, model.geometry);
      if (offset === model.geometry.horizontalOffset) return [model, NONE];
      const [next, effects] = cancelReveal(model);
      return [{ ...next, geometry: { ...model.geometry, horizontalOffset: offset } }, effects];
    }
    case "HorizontalMoveRequested":
      return moveHorizontally(msg.delta, model);
    case "PointerStarted": {
      if (model.pointer !== null) return [model, NONE];
      const [next, effects] = cancelReveal(model);
      return [
        { ...next, pointer: { id: msg.id, x: msg.x } },
        [...effects, { kind: "CapturePointer", id: msg.id }],
      ];
    }
    case "PointerMoved": {
      if (model.pointer?.id !== msg.id) return [model, NONE];
      return moveHorizontally(model.pointer.x - msg.x, {
        ...model,
        pointer: { id: msg.id, x: msg.x },
      });
    }
    case "PointerEnded":
      return model.pointer?.id !== msg.id
        ? [model, NONE]
        : [{ ...model, pointer: null }, [{ kind: "ReleasePointer", id: msg.id }]];
    case "ViewportInteraction":
      return cancelReveal(model);
    case "SearchQueryChanged":
      return changeQuery(msg.query, model);
    case "SearchDismissRequested": {
      const [next, effects] = changeQuery("", model);
      return [next, [...effects, { kind: "RestoreSearchFocus" }]];
    }
    case "FindRequested":
      return [model, [{ kind: "FocusSearch" }]];
    case "SearchMoveRequested": {
      if (model.search.kind === "searching") {
        return [
          {
            ...model,
            search: { ...model.search, pendingMove: model.search.pendingMove + msg.direction },
          },
          NONE,
        ];
      }
      if (model.search.kind !== "ready" || model.search.results.count === 0) return [model, NONE];
      return revealResult({
        ...model,
        search: {
          ...model.search,
          activeIndex: wrap(model.search.activeIndex + msg.direction, model.search.results.count),
        },
      });
    }
    case "SearchCompleted": {
      if (
        msg.revision !== model.revision ||
        model.search.kind !== "searching" ||
        model.search.requestId !== msg.requestId
      )
        return [model, NONE];
      const next: Model = {
        ...model,
        search: {
          kind: "ready",
          query: model.search.query,
          results: msg.results,
          activeIndex:
            msg.results.count === 0 ? -1 : wrap(model.search.pendingMove, msg.results.count),
        },
      };
      return revealResult(next);
    }
    case "MatchMeasured": {
      if (model.reveal?.id !== msg.id || msg.revision !== model.revision || msg.bounds === null)
        return [model, NONE];
      const { left, right, viewportLeft, viewportRight, horizontalOffset } = msg.bounds;
      const delta =
        left < viewportLeft
          ? left - viewportLeft
          : right > viewportRight
            ? right - viewportRight
            : 0;
      const offset = clampOffset(
        horizontalOffset + (delta < 0 ? Math.floor(delta) : Math.ceil(delta)),
        model.geometry,
      );
      return [
        { ...model, reveal: null, geometry: { ...model.geometry, horizontalOffset: offset } },
        offset === horizontalOffset ? NONE : [{ kind: "SetHorizontalOffset", offset }],
      ];
    }
    case "JumpToFileRequested": {
      const rowIndex = model.layout.fileStartRows[msg.fileIndex];
      if (rowIndex === undefined) return [model, NONE];
      const [next, effects] = cancelReveal(model);
      return [next, [...effects, { align: "start", kind: "ScrollToRow", rowIndex }]];
    }
    case "CopyFileRequested": {
      if (model.copy.kind === "writing") return [model, NONE];
      const file = model.layout.diff.files[msg.fileIndex];
      if (file === undefined) return [model, NONE];
      const text = buildFileCopyText(file);
      return text === null ? [model, NONE] : beginCopy(text, `file ${fileLabel(file)}`, model);
    }
    case "CopyHunkRequested": {
      if (model.copy.kind === "writing") return [model, NONE];
      const file = model.layout.diff.files[msg.fileIndex];
      const hunk = file === undefined ? undefined : diffFileHunks(file)[msg.hunkIndex];
      if (file === undefined || hunk === undefined) return [model, NONE];
      const text = buildHunkCopyText(file, hunk);
      return text === null ? [model, NONE] : beginCopy(text, `hunk from ${fileLabel(file)}`, model);
    }
    case "ClipboardWriteFinished": {
      if (
        model.copy.kind !== "writing" ||
        model.copy.requestId !== msg.requestId ||
        model.copy.revision !== msg.revision
      )
        return [model, NONE];
      const outcome =
        msg.revision !== model.revision
          ? null
          : msg.ok
            ? { kind: "success" as const, message: `Copied ${model.copy.subject}.` }
            : { kind: "failure" as const, message: `Could not copy ${model.copy.subject}.` };
      return [{ ...model, copy: { kind: "idle", outcome } }, NONE];
    }
  }
};

const changeQuery = (query: string, model: Model): Change => {
  if (query === searchQuery(model.search)) return [model, NONE];
  const searchRequestId = model.searchRequestId + 1;
  const search: Search =
    query.length === 0
      ? { kind: "idle" }
      : { kind: "searching", query, requestId: searchRequestId, pendingMove: 0 };
  return [
    { ...model, reveal: null, search, searchRequestId },
    [
      { kind: "CancelReveal" },
      query.length === 0
        ? { kind: "CancelSearch" }
        : {
            kind: "Search",
            layout: model.layout,
            query,
            requestId: searchRequestId,
            revision: model.revision,
          },
    ],
  ];
};

const revealResult = (model: Model): Change => {
  if (model.search.kind !== "ready" || model.search.activeIndex === -1) return [model, NONE];
  const { results, activeIndex } = model.search;
  const reveal: Reveal = {
    id: model.revealId + 1,
    revision: model.revision,
    rowIndex: results.rowIndexes[activeIndex] as number,
    offset: results.matchOffsets[activeIndex] as number,
    length: results.matchLengths[activeIndex] as number,
  };
  return [
    { ...model, reveal, revealId: reveal.id },
    [
      { kind: "CancelReveal" },
      { kind: "ScrollToRow", align: "center", rowIndex: reveal.rowIndex },
      { kind: "MeasureMatch", target: reveal },
    ],
  ];
};

const cancelReveal = (model: Model): Change =>
  model.reveal === null ? [model, NONE] : [{ ...model, reveal: null }, [{ kind: "CancelReveal" }]];

const moveHorizontally = (delta: number, model: Model): Change => {
  const [next, effects] = cancelReveal(model);
  const offset = clampOffset(model.geometry.horizontalOffset + delta, model.geometry);
  return offset === model.geometry.horizontalOffset
    ? [next, effects]
    : [
        { ...next, geometry: { ...model.geometry, horizontalOffset: offset } },
        [...effects, { kind: "SetHorizontalOffset", offset }],
      ];
};

const beginCopy = (text: string, subject: string, model: Model): Change => {
  const requestId = model.copyRequestId + 1;
  return [
    {
      ...model,
      copyRequestId: requestId,
      copy: { kind: "writing", requestId, revision: model.revision, subject },
    },
    [{ kind: "WriteClipboard", requestId, revision: model.revision, text }],
  ];
};

const wrap = (index: number, count: number) => ((index % count) + count) % count;
const clampOffset = (offset: number, geometry: Geometry) =>
  Math.min(Math.max(offset, 0), geometry.horizontalMaximum);
const currentConfiguration = (left: Configuration, right: Configuration) =>
  left.revision === right.revision && left.configuration === right.configuration;
const geometryEqual = (left: Geometry, right: Geometry) =>
  left.horizontalMaximum === right.horizontalMaximum &&
  left.horizontalOffset === right.horizontalOffset &&
  left.railLeft === right.railLeft &&
  left.railWidth === right.railWidth &&
  left.scrollMargin === right.scrollMargin &&
  left.stickyHeight === right.stickyHeight;
const rowsEqual = (left: VirtualRow[], right: VirtualRow[]) =>
  left.length === right.length &&
  left.every((row, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      row.index === other.index &&
      row.key === other.key &&
      row.size === other.size &&
      row.start === other.start
    );
  });

export const searchQuery = (search: Search): string => (search.kind === "idle" ? "" : search.query);
export const searchStatus = (search: Search): string => {
  switch (search.kind) {
    case "idle":
      return "";
    case "searching":
      return "Searching...";
    case "ready":
      return search.results.count === 0
        ? "No results"
        : `${search.activeIndex + 1} of ${search.results.count}${search.results.truncated ? "+ (results limited)" : ""}`;
  }
};

export const matchesForRow = (search: Search, rowIndex: number): MountedSearchMatch[] => {
  if (search.kind !== "ready") return [];
  const results = search.results;
  const firstResultIndex = firstMatchAtOrAfterRow(results, rowIndex);
  const endResultIndex = firstMatchAtOrAfterRow(results, rowIndex + 1);
  const rowResultCount = endResultIndex - firstResultIndex;
  let renderedStartIndex = firstResultIndex;
  const activeIndex = search.activeIndex;
  if (
    rowResultCount > MAX_MOUNTED_MATCHES_PER_ROW &&
    activeIndex >= firstResultIndex &&
    activeIndex < endResultIndex
  ) {
    renderedStartIndex = Math.min(
      Math.max(activeIndex - Math.floor(MAX_MOUNTED_MATCHES_PER_ROW / 2), firstResultIndex),
      endResultIndex - MAX_MOUNTED_MATCHES_PER_ROW,
    );
  }
  const renderedEndIndex = Math.min(
    renderedStartIndex + MAX_MOUNTED_MATCHES_PER_ROW,
    endResultIndex,
  );
  const matches: MountedSearchMatch[] = [];
  for (let resultIndex = renderedStartIndex; resultIndex < renderedEndIndex; resultIndex += 1) {
    matches.push({
      active: resultIndex === activeIndex,
      length: results.matchLengths[resultIndex] as number,
      offset: results.matchOffsets[resultIndex] as number,
    });
  }
  return matches;
};
