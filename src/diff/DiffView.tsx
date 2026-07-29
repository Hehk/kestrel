import { createWindowVirtualizer } from "@tanstack/solid-virtual";
import {
  createEffect,
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
import type { DiffRow, PullRequestDiff, PullRequestDiffFile } from "./layout";
import { DIFF_ROW_HEIGHT } from "./layout";
import { buildDiffLayout, rowAt, rowHeight, rowKey } from "./layout";

export const DiffView = (props: { diff: PullRequestDiff }) => {
  let table: HTMLDivElement | undefined;
  let stickyStack: HTMLDivElement | undefined;
  let horizontalRail: HTMLDivElement | undefined;
  const layout = createMemo(() => buildDiffLayout(props.diff));
  const [scrollMargin, setScrollMargin] = createSignal(0);
  const [stickyHeight, setStickyHeight] = createSignal(0);
  const [activeFileIndex, setActiveFileIndex] = createSignal(0);
  const [horizontalOffset, setHorizontalOffset] = createSignal(0);
  const [railLeft, setRailLeft] = createSignal(0);
  const [railWidth, setRailWidth] = createSignal(0);
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
    const setRailOffset = (nextOffset: number, event?: Event) => {
      if (horizontalRail === undefined) return false;
      const maximum = Math.max(0, horizontalRail.scrollWidth - horizontalRail.clientWidth);
      const next = Math.min(Math.max(nextOffset, 0), maximum);
      if (next === horizontalRail.scrollLeft) return false;
      horizontalRail.scrollLeft = next;
      setHorizontalOffset(next);
      event?.preventDefault();
      return true;
    };
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
      setRailOffset(next, event);
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
      setRailOffset(horizontalRail.scrollLeft + delta, event);
    };
    const handlePointerEnd = (event: PointerEvent) => {
      if (event.pointerId !== activePointerId) return;
      table?.releasePointerCapture?.(event.pointerId);
      activePointerId = null;
    };
    table?.addEventListener("wheel", handleWheel, { passive: false });
    table?.addEventListener("pointerdown", handlePointerDown);
    table?.addEventListener("pointermove", handlePointerMove, { passive: false });
    table?.addEventListener("pointerup", handlePointerEnd);
    table?.addEventListener("pointercancel", handlePointerEnd);
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", updateGeometry);
    onCleanup(() => {
      resizeObserver?.disconnect();
      table?.removeEventListener("wheel", handleWheel);
      table?.removeEventListener("pointerdown", handlePointerDown);
      table?.removeEventListener("pointermove", handlePointerMove);
      table?.removeEventListener("pointerup", handlePointerEnd);
      table?.removeEventListener("pointercancel", handlePointerEnd);
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", updateGeometry);
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
        </div>
        <div
          aria-label={`Active file: ${activeFileLabel()}`}
          class="pr-diff-activeFile"
          title={activeFileLabel()}
        >
          {activeFileLabel()}
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
                  index={virtualRow.index}
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

const DiffRowView = (props: { index: number; row: DiffRow; size: number }) => (
  <div
    aria-rowindex={props.index + 1}
    class={`pr-diff-row pr-diff-row--${props.row.kind}`}
    data-diff-row={props.index}
    role="row"
    style={{ height: `${props.size}px` }}
  >
    <DiffRowCells row={props.row} />
  </div>
);

const DiffRowCells = (props: { row: DiffRow }) => {
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
          <div aria-colspan="3" class="pr-diff-headerCell" role="columnheader">
            {filePath(row())}
          </div>
        )}
      </Match>
      <Match when={hunkRow()}>
        {(row) => (
          <div aria-colspan="3" class="pr-diff-hunkCell" role="cell">
            {hunkLabel(row())}
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
                {row().line.content}
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
