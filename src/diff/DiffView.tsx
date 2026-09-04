import { createWindowVirtualizer } from "@tanstack/solid-virtual";
import {
  createEffect,
  createDeferred,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { buildFileCopyText, buildHunkCopyText } from "./copy";
import type { DiffRow, PullRequestDiff, PullRequestDiffFile } from "./layout";
import { DIFF_ROW_HEIGHT } from "./layout";
import { buildDiffLayout, rowAt, rowHeight, rowKey, sourceVisualColumns } from "./layout";
import { firstMatchAtOrAfterRow, searchDiff } from "./search";

type MountedSearchMatch = { active: boolean; length: number; offset: number };
type PendingResultNavigation = { move: number; query: string };
type CopyOutcome = { kind: "failure" | "success"; message: string };
const MAX_MOUNTED_MATCHES_PER_ROW = 200;

export const DiffView = (props: { diff: PullRequestDiff }) => {
  let table: HTMLDivElement | undefined;
  let stickyStack: HTMLDivElement | undefined;
  let horizontalRail: HTMLDivElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let searchReturnFocus: HTMLElement | null = null;
  let copyGeneration = 0;
  const layout = createMemo(() => buildDiffLayout(props.diff));
  const [scrollMargin, setScrollMargin] = createSignal(0);
  const [stickyHeight, setStickyHeight] = createSignal(0);
  const [activeFileIndex, setActiveFileIndex] = createSignal(0);
  const [horizontalOffset, setHorizontalOffset] = createSignal(0);
  const [railLeft, setRailLeft] = createSignal(0);
  const [railWidth, setRailWidth] = createSignal(0);
  const [searchQuery, setSearchQuery] = createSignal("");
  const deferredSearchQuery = createDeferred(searchQuery);
  const [activeResultIndex, setActiveResultIndex] = createSignal(-1);
  const [pendingResultNavigation, setPendingResultNavigation] =
    createSignal<PendingResultNavigation | null>(null);
  const [copyOutcome, setCopyOutcome] = createSignal<CopyOutcome | null>(null);
  const [copyPending, setCopyPending] = createSignal(false);
  const virtualizer = createWindowVirtualizer<HTMLDivElement>({
    get count() {
      return layout().rowCount;
    },
    estimateSize: (index) => rowHeight(layout(), index),
    getItemKey: (index) => rowKey(layout(), index),
    get scrollMargin() {
      return scrollMargin();
    },
    get scrollPaddingStart() {
      return stickyHeight();
    },
    overscan: 20,
  });
  const virtualRows = () => virtualizer.getVirtualItems();
  const translateY = () => (virtualRows()[0]?.start ?? 0) - scrollMargin();
  const fileOptions = createMemo(() =>
    props.diff.files.map((file, fileIndex) => ({ fileIndex, label: fileLabel(file) })),
  );
  const activeFileLabel = () => fileOptions()[activeFileIndex()]?.label ?? "Unknown file";
  const searchResults = createMemo(() => searchDiff(layout(), deferredSearchQuery()));
  const searchPending = () => deferredSearchQuery() !== searchQuery();

  const writeClipboard = async (text: string, subject: string) => {
    if (copyPending()) return;
    const generation = ++copyGeneration;
    const sourceDiff = layout().diff;
    setCopyOutcome(null);
    setCopyPending(true);
    try {
      if (navigator.clipboard === undefined) throw new Error("Clipboard is unavailable");
      await navigator.clipboard.writeText(text);
      if (generation === copyGeneration && layout().diff === sourceDiff) {
        setCopyOutcome({ kind: "success", message: `Copied ${subject}.` });
      }
    } catch {
      if (generation === copyGeneration && layout().diff === sourceDiff) {
        setCopyOutcome({ kind: "failure", message: `Could not copy ${subject}.` });
      }
    } finally {
      if (generation === copyGeneration) setCopyPending(false);
    }
  };

  const copyFile = (file: PullRequestDiffFile) => {
    if (copyPending()) return;
    const text = buildFileCopyText(file);
    if (text !== null) void writeClipboard(text, `file ${fileLabel(file)}`);
  };

  const copyHunk = (row: Extract<DiffRow, { kind: "hunk" }>) => {
    if (copyPending()) return;
    const text = buildHunkCopyText(row.file, row.hunk);
    if (text !== null) void writeClipboard(text, `hunk from ${fileLabel(row.file)}`);
  };

  const updateActiveFile = () => {
    if (layout().rowCount === 0) return;
    const firstVisibleOffset = Math.max(scrollMargin(), window.scrollY + stickyHeight());
    const visibleRow = virtualizer.getVirtualItemForOffset(firstVisibleOffset);
    if (visibleRow !== undefined) {
      setActiveFileIndex(layout().fileIndexes[visibleRow.index] as number);
    }
  };

  const clampHorizontalOffset = () => {
    if (horizontalRail === undefined) return;
    const maximum = Math.max(0, horizontalRail.scrollWidth - horizontalRail.clientWidth);
    const next = Math.min(Math.max(horizontalOffset(), 0), maximum);
    horizontalRail.scrollLeft = next;
    setHorizontalOffset(next);
  };

  const setHorizontalRailOffset = (nextOffset: number, event?: Event) => {
    if (horizontalRail === undefined) return false;
    const maximum = Math.max(0, horizontalRail.scrollWidth - horizontalRail.clientWidth);
    const next = Math.min(Math.max(nextOffset, 0), maximum);
    if (next === horizontalRail.scrollLeft) return false;
    horizontalRail.scrollLeft = next;
    setHorizontalOffset(next);
    event?.preventDefault();
    return true;
  };

  const updateGeometry = () => {
    if (table !== undefined) {
      const rect = table.getBoundingClientRect();
      const nextScrollMargin = rect.top + window.scrollY;
      setScrollMargin((current) => (current === nextScrollMargin ? current : nextScrollMargin));
      setRailLeft(rect.left);
      setRailWidth(rect.width);
    }
    if (stickyStack !== undefined) {
      setStickyHeight(stickyStack.getBoundingClientRect().height);
    }
    clampHorizontalOffset();
    updateActiveFile();
  };

  const revealResult = (resultIndex: number) => {
    const results = searchResults();
    if (resultIndex < 0 || resultIndex >= results.count) return;
    const rowIndex = results.rowIndexes[resultIndex] as number;
    virtualizer.scrollToIndex(rowIndex, { align: "center" });
    const row = rowAt(layout(), rowIndex);
    if (
      horizontalRail === undefined ||
      (row.kind !== "context" && row.kind !== "addition" && row.kind !== "deletion")
    ) {
      return;
    }
    const offset = results.matchOffsets[resultIndex] as number;
    const length = results.matchLengths[resultIndex] as number;
    const totalColumns = Math.max(layout().maxSourceColumns, 1);
    const contentWidth = Math.max(horizontalRail.scrollWidth - 16, 0);
    const start =
      (sourceVisualColumns(row.line.content.slice(0, offset)) / totalColumns) * contentWidth;
    const end =
      (sourceVisualColumns(row.line.content.slice(0, offset + length)) / totalColumns) *
      contentWidth;
    const current = horizontalRail.scrollLeft;
    if (start < current) setHorizontalRailOffset(start);
    else if (end > current + horizontalRail.clientWidth) {
      setHorizontalRailOffset(end - horizontalRail.clientWidth);
    }
    queueMicrotask(() => revealMountedActiveMatch());
  };

  const revealMountedActiveMatch = () => {
    if (table === undefined || horizontalRail === undefined) return;
    const activeMatch = table.querySelector<HTMLElement>(".pr-diff-searchMatch--active");
    const source = activeMatch?.closest<HTMLElement>(".pr-diff-source");
    if (
      activeMatch === null ||
      activeMatch === undefined ||
      source === null ||
      source === undefined
    ) {
      return;
    }
    const matchRect = activeMatch.getBoundingClientRect();
    const sourceRect = source.getBoundingClientRect();
    if (matchRect.left < sourceRect.left) {
      setHorizontalRailOffset(horizontalRail.scrollLeft - (sourceRect.left - matchRect.left));
    } else if (matchRect.right > sourceRect.right) {
      setHorizontalRailOffset(horizontalRail.scrollLeft + (matchRect.right - sourceRect.right));
    }
  };

  const moveResult = (direction: 1 | -1) => {
    if (searchPending()) {
      const query = searchQuery();
      setPendingResultNavigation((current) => ({
        move: current?.query === query ? current.move + direction : direction,
        query,
      }));
      return;
    }
    const count = searchResults().count;
    if (count === 0) return;
    const next = (activeResultIndex() + direction + count) % count;
    setActiveResultIndex(next);
    revealResult(next);
  };

  const matchesForRow = (rowIndex: number): MountedSearchMatch[] => {
    if (searchPending()) return [];
    const results = searchResults();
    const matches: MountedSearchMatch[] = [];
    const firstResultIndex = firstMatchAtOrAfterRow(results, rowIndex);
    const endResultIndex = firstMatchAtOrAfterRow(results, rowIndex + 1);
    const rowResultCount = endResultIndex - firstResultIndex;
    let renderedStartIndex = firstResultIndex;
    const activeIndex = activeResultIndex();
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
    for (let resultIndex = renderedStartIndex; resultIndex < renderedEndIndex; resultIndex += 1) {
      matches.push({
        active: resultIndex === activeResultIndex(),
        length: results.matchLengths[resultIndex] as number,
        offset: results.matchOffsets[resultIndex] as number,
      });
    }
    return matches;
  };

  createEffect(
    on(
      layout,
      () => {
        virtualizer.measure();
        queueMicrotask(() => {
          clampHorizontalOffset();
          updateActiveFile();
        });
      },
      { defer: true },
    ),
  );

  createEffect(on(layout, () => setCopyOutcome(null), { defer: true }));

  createEffect(
    on([searchResults, searchQuery, deferredSearchQuery], ([results, query, deferredQuery]) => {
      if (deferredQuery !== query) return;
      const pendingNavigation = pendingResultNavigation();
      const requestedMove = pendingNavigation?.query === query ? pendingNavigation.move : 0;
      const next =
        results.count === 0
          ? -1
          : ((requestedMove % results.count) + results.count) % results.count;
      setPendingResultNavigation(null);
      setActiveResultIndex(next);
      if (next !== -1) queueMicrotask(() => revealResult(next));
    }),
  );

  createEffect(() => {
    virtualRows();
    activeResultIndex();
    queueMicrotask(() => revealMountedActiveMatch());
  });

  onMount(() => {
    updateGeometry();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateGeometry);
    const observedElements = new Set([
      table?.parentElement,
      table?.closest(".PullRequestPage-diffContent"),
      table?.closest(".PullRequestPage"),
      stickyStack,
      horizontalRail,
    ]);
    for (const observedElement of observedElements) {
      if (observedElement !== null && observedElement !== undefined) {
        resizeObserver?.observe(observedElement);
      }
    }
    const handleScroll = () => updateActiveFile();
    let activePointerId: number | null = null;
    let lastPointerX = 0;
    const handleWheel = (event: WheelEvent) => {
      if (
        horizontalRail === undefined ||
        !(event.target instanceof Element) ||
        event.target.closest(".pr-diff-source") === null
      ) {
        return;
      }
      const rawDelta =
        Math.abs(event.deltaX) >= Math.abs(event.deltaY)
          ? event.deltaX
          : event.shiftKey
            ? event.deltaY
            : 0;
      if (rawDelta === 0) return;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? DIFF_ROW_HEIGHT.source
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? horizontalRail.clientWidth
            : 1;
      const maximum = Math.max(0, horizontalRail.scrollWidth - horizontalRail.clientWidth);
      const next = Math.min(Math.max(horizontalRail.scrollLeft + rawDelta * unit, 0), maximum);
      setHorizontalRailOffset(next, event);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest(".pr-diff-source") === null ||
        (event.pointerType !== "touch" && event.pointerType !== "pen")
      ) {
        return;
      }
      activePointerId = event.pointerId;
      lastPointerX = event.clientX;
      table?.setPointerCapture?.(event.pointerId);
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== activePointerId || horizontalRail === undefined) return;
      const delta = lastPointerX - event.clientX;
      lastPointerX = event.clientX;
      setHorizontalRailOffset(horizontalRail.scrollLeft + delta, event);
    };
    const handlePointerEnd = (event: PointerEvent) => {
      if (event.pointerId !== activePointerId) return;
      table?.releasePointerCapture?.(event.pointerId);
      activePointerId = null;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const isFindShortcut =
        event.metaKey !== event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f";
      if (isFindShortcut) {
        event.preventDefault();
        if (
          document.activeElement instanceof HTMLElement &&
          document.activeElement !== searchInput
        ) {
          searchReturnFocus = document.activeElement;
        }
        searchInput?.focus();
        searchInput?.select();
        return;
      }
      if (event.target !== searchInput) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setSearchQuery("");
        const returnFocus = searchReturnFocus;
        searchReturnFocus = null;
        if (returnFocus?.isConnected) returnFocus.focus();
        else searchInput?.blur();
      } else if (event.key === "Enter") {
        event.preventDefault();
        moveResult(event.shiftKey ? -1 : 1);
      }
    };
    table?.addEventListener("wheel", handleWheel, { passive: false });
    table?.addEventListener("pointerdown", handlePointerDown);
    table?.addEventListener("pointermove", handlePointerMove, { passive: false });
    table?.addEventListener("pointerup", handlePointerEnd);
    table?.addEventListener("pointercancel", handlePointerEnd);
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", updateGeometry);
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      copyGeneration += 1;
      resizeObserver?.disconnect();
      table?.removeEventListener("wheel", handleWheel);
      table?.removeEventListener("pointerdown", handlePointerDown);
      table?.removeEventListener("pointermove", handlePointerMove);
      table?.removeEventListener("pointerup", handlePointerEnd);
      table?.removeEventListener("pointercancel", handlePointerEnd);
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", updateGeometry);
      window.removeEventListener("keydown", handleKeyDown);
    });
  });

  const jumpToFile = (fileIndex: number) => {
    const rowIndex = layout().fileStartRows[fileIndex];
    if (rowIndex !== undefined) {
      virtualizer.scrollToIndex(rowIndex, { align: "start" });
    }
  };

  return (
    <div class="pr-diff-root">
      <div class="pr-diff-stickyStack" ref={(element) => (stickyStack = element)}>
        <div class="pr-diff-toolbar">
          <label class="pr-diff-filePickerLabel" for="pr-diff-file-picker">
            File
          </label>
          <select
            aria-label="Jump to file"
            class="pr-diff-filePicker"
            id="pr-diff-file-picker"
            onChange={(event) => jumpToFile(Number(event.currentTarget.value))}
            value={activeFileIndex()}
          >
            <For each={fileOptions()}>
              {(option) => <option value={option.fileIndex}>{option.label}</option>}
            </For>
          </select>
          <input
            aria-label="Search diff"
            class="pr-diff-searchInput"
            onInput={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder="Search"
            ref={(element) => (searchInput = element)}
            type="search"
            value={searchQuery()}
          />
          <div aria-label="Search result navigation" class="pr-diff-searchNav" role="group">
            <button
              aria-label="Previous search result"
              class="pr-diff-compactButton"
              disabled={searchPending() || searchResults().count === 0}
              onClick={() => moveResult(-1)}
              type="button"
            >
              Prev
            </button>
            <button
              aria-label="Next search result"
              class="pr-diff-compactButton"
              disabled={searchPending() || searchResults().count === 0}
              onClick={() => moveResult(1)}
              type="button"
            >
              Next
            </button>
          </div>
          <span aria-atomic="true" aria-live="polite" class="pr-diff-searchCount">
            {searchQuery().length === 0
              ? ""
              : searchPending()
                ? "Searching..."
                : searchResults().count === 0
                  ? "No results"
                  : `${activeResultIndex() + 1} of ${searchResults().count}${searchResults().truncated ? "+ (results limited)" : ""}`}
          </span>
        </div>
        <div
          aria-label={`Active file: ${activeFileLabel()}`}
          class="pr-diff-activeFile"
          title={activeFileLabel()}
        >
          <span class="pr-diff-activeFilePath">{activeFileLabel()}</span>
          <span
            aria-atomic="true"
            aria-live="polite"
            class="pr-diff-copyStatus"
            classList={{ "pr-diff-copyStatus--failure": copyOutcome()?.kind === "failure" }}
            role="status"
          >
            {copyOutcome()?.message ?? ""}
          </span>
          <button
            aria-label={
              props.diff.files[activeFileIndex()]?.binary
                ? `Copy unavailable for binary file ${activeFileLabel()}`
                : `Copy file ${activeFileLabel()}`
            }
            aria-busy={copyPending()}
            aria-disabled={copyPending() ? "true" : undefined}
            class="pr-diff-compactButton"
            disabled={props.diff.files[activeFileIndex()]?.binary ?? true}
            onClick={() => {
              const file = props.diff.files[activeFileIndex()];
              if (file !== undefined) copyFile(file);
            }}
            title={
              props.diff.files[activeFileIndex()]?.binary
                ? "Binary patch content is unavailable"
                : `Copy file ${activeFileLabel()}`
            }
            type="button"
          >
            {props.diff.files[activeFileIndex()]?.binary ? "Copy unavailable" : "Copy file"}
          </button>
        </div>
      </div>
      <div
        aria-colcount="3"
        aria-label="Pull request diff contents"
        aria-rowcount={layout().rowCount}
        class="pr-diff-table"
        ref={(element) => (table = element)}
        role="table"
        style={{ "--pr-diff-horizontal-offset": `${horizontalOffset()}px` }}
      >
        <div class="pr-diff-spacer" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          <div class="pr-diff-virtualRows" style={{ transform: `translateY(${translateY()}px)` }}>
            <For each={virtualRows()}>
              {(virtualRow) => (
                <DiffRowView
                  copyPending={copyPending()}
                  index={virtualRow.index}
                  matches={matchesForRow(virtualRow.index)}
                  onCopyFile={copyFile}
                  onCopyHunk={copyHunk}
                  row={rowAt(layout(), virtualRow.index)}
                  size={rowHeight(layout(), virtualRow.index)}
                />
              )}
            </For>
          </div>
        </div>
      </div>
      <div
        class="pr-diff-horizontalRailFrame"
        style={{ left: `${railLeft()}px`, width: `${railWidth()}px` }}
      >
        <div aria-hidden="true" class="pr-diff-railGutter" />
        <div aria-hidden="true" class="pr-diff-railGutter" />
        <div
          aria-label="Scroll diff horizontally"
          class="pr-diff-horizontalRail"
          onScroll={(event) => setHorizontalOffset(event.currentTarget.scrollLeft)}
          ref={(element) => (horizontalRail = element)}
          role="region"
          tabIndex={0}
        >
          <div
            class="pr-diff-horizontalRailContent"
            style={{ width: `calc(${layout().maxSourceColumns}ch + 1rem)` }}
          />
        </div>
      </div>
    </div>
  );
};

const DiffRowView = (props: {
  copyPending: boolean;
  index: number;
  matches: MountedSearchMatch[];
  onCopyFile: (file: PullRequestDiffFile) => void;
  onCopyHunk: (row: Extract<DiffRow, { kind: "hunk" }>) => void;
  row: DiffRow;
  size: number;
}) => (
  <div
    aria-rowindex={props.index + 1}
    class={`pr-diff-row pr-diff-row--${props.row.kind}`}
    data-diff-row={props.index}
    role="row"
    style={{ height: `${props.size}px` }}
  >
    <DiffRowCells
      copyPending={props.copyPending}
      matches={props.matches}
      onCopyFile={props.onCopyFile}
      onCopyHunk={props.onCopyHunk}
      row={props.row}
    />
  </div>
);

const DiffRowCells = (props: {
  copyPending: boolean;
  matches: MountedSearchMatch[];
  onCopyFile: (file: PullRequestDiffFile) => void;
  onCopyHunk: (row: Extract<DiffRow, { kind: "hunk" }>) => void;
  row: DiffRow;
}) => {
  const fileRow = () => (props.row.kind === "file" ? props.row : undefined);
  const hunkRow = () => (props.row.kind === "hunk" ? props.row : undefined);
  const noticeRow = () => (props.row.kind === "notice" ? props.row : undefined);
  const sourceRow = () =>
    props.row.kind === "context" || props.row.kind === "addition" || props.row.kind === "deletion"
      ? props.row
      : undefined;

  return (
    <Switch>
      <Match when={fileRow()}>
        {(row) => (
          <div aria-colspan="3" aria-label={filePath(row())} class="pr-diff-headerCell" role="cell">
            <span class="pr-diff-headerText">{filePath(row())}</span>
            <button
              aria-label={
                row().file.binary
                  ? `Copy unavailable for binary file ${fileLabel(row().file)}`
                  : `Copy file ${fileLabel(row().file)}`
              }
              aria-busy={props.copyPending}
              aria-disabled={props.copyPending ? "true" : undefined}
              class="pr-diff-compactButton"
              disabled={row().file.binary}
              onClick={() => props.onCopyFile(row().file)}
              title={
                row().file.binary
                  ? "Binary patch content is unavailable"
                  : `Copy file ${fileLabel(row().file)}`
              }
              type="button"
            >
              {row().file.binary ? "Copy unavailable" : "Copy file"}
            </button>
          </div>
        )}
      </Match>
      <Match when={hunkRow()}>
        {(row) => (
          <div aria-colspan="3" aria-label={hunkLabel(row())} class="pr-diff-hunkCell" role="cell">
            <span class="pr-diff-hunkText">{hunkLabel(row())}</span>
            <button
              aria-label={`Copy hunk from ${fileLabel(row().file)}, ${hunkLabel(row())}`}
              aria-busy={props.copyPending}
              aria-disabled={props.copyPending ? "true" : undefined}
              class="pr-diff-compactButton"
              onClick={() => props.onCopyHunk(row())}
              type="button"
            >
              Copy hunk
            </button>
          </div>
        )}
      </Match>
      <Match when={noticeRow()}>
        {(row) => (
          <div aria-colspan="3" class="pr-diff-noticeCell" role="cell">
            {row().notice === "binary"
              ? "Binary file changed."
              : "File changed without textual hunks."}
          </div>
        )}
      </Match>
      <Match when={sourceRow()}>
        {(row) => (
          <>
            <div
              aria-label={`Old line ${row().line.oldLine ?? "none"}`}
              class="pr-diff-lineNumber"
              role="cell"
            >
              {row().line.oldLine ?? ""}
            </div>
            <div
              aria-label={`New line ${row().line.newLine ?? "none"}`}
              class="pr-diff-lineNumber"
              role="cell"
            >
              {row().line.newLine ?? ""}
            </div>
            <div class="pr-diff-source" role="cell">
              <div class="pr-diff-sourceContent">
                <span class="pr-diff-lineKind">{sourceKindLabel(row().kind)}</span>
                <span aria-hidden="true" class="pr-diff-prefix">
                  {sourcePrefix(row().kind)}
                </span>
                <HighlightedSource content={row().line.content} matches={props.matches} />
                <Show when={row().line.missingNewline}>
                  <span class="pr-diff-missingNewline"> No newline at end of file</span>
                </Show>
              </div>
            </div>
          </>
        )}
      </Match>
    </Switch>
  );
};

const HighlightedSource = (props: { content: string; matches: MountedSearchMatch[] }) => {
  const segments = createMemo(() => {
    const result: Array<{ active: boolean; match: boolean; text: string }> = [];
    let cursor = 0;
    for (const match of props.matches) {
      if (match.offset > cursor) {
        result.push({
          active: false,
          match: false,
          text: props.content.slice(cursor, match.offset),
        });
      }
      result.push({
        active: match.active,
        match: true,
        text: props.content.slice(match.offset, match.offset + match.length),
      });
      cursor = match.offset + match.length;
    }
    if (cursor < props.content.length) {
      result.push({ active: false, match: false, text: props.content.slice(cursor) });
    }
    return result;
  });

  return (
    <For each={segments()}>
      {(segment) =>
        segment.match ? (
          <mark classList={{ "pr-diff-searchMatch--active": segment.active }}>{segment.text}</mark>
        ) : (
          segment.text
        )
      }
    </For>
  );
};

const filePath = (row: Extract<DiffRow, { kind: "file" }>): string => {
  if (
    row.file.oldPath !== null &&
    row.file.newPath !== null &&
    row.file.oldPath !== row.file.newPath
  ) {
    return `${row.file.oldPath} -> ${row.file.newPath}`;
  }
  return row.file.newPath ?? row.file.oldPath ?? "Unknown file";
};

const fileLabel = (file: PullRequestDiffFile): string => {
  if (file.oldPath !== null && file.newPath !== null && file.oldPath !== file.newPath) {
    return `${file.oldPath} -> ${file.newPath}`;
  }
  return file.newPath ?? file.oldPath ?? "Unknown file";
};

const hunkLabel = (row: Extract<DiffRow, { kind: "hunk" }>): string => {
  const context = row.hunk.context === null ? "" : ` ${row.hunk.context}`;
  return `@@ -${row.hunk.oldStart},${row.hunk.oldCount} +${row.hunk.newStart},${row.hunk.newCount} @@${context}`;
};

const sourcePrefix = (kind: "context" | "addition" | "deletion"): string => {
  switch (kind) {
    case "context":
      return " ";
    case "addition":
      return "+";
    case "deletion":
      return "-";
  }
};

const sourceKindLabel = (kind: "context" | "addition" | "deletion"): string => {
  switch (kind) {
    case "context":
      return "Context line: ";
    case "addition":
      return "Added line: ";
    case "deletion":
      return "Deleted line: ";
  }
};
