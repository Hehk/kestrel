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
import type { DiffRow, PullRequestDiff } from "./layout";
import { buildDiffLayout, rowAt, rowHeight, rowKey } from "./layout";

export const DiffView = (props: { diff: PullRequestDiff }) => {
  let table: HTMLDivElement | undefined;
  const layout = createMemo(() => buildDiffLayout(props.diff));
  const [scrollMargin, setScrollMargin] = createSignal(0);
  const virtualizer = createWindowVirtualizer<HTMLDivElement>({
    get count() {
      return layout().rowCount;
    },
    estimateSize: (index) => rowHeight(layout(), index),
    getItemKey: (index) => rowKey(layout(), index),
    get scrollMargin() {
      return scrollMargin();
    },
    overscan: 20,
  });
  const virtualRows = () => virtualizer.getVirtualItems();
  const translateY = () => (virtualRows()[0]?.start ?? 0) - scrollMargin();

  createEffect(
    on(
      layout,
      () => {
        virtualizer.measure();
      },
      { defer: true },
    ),
  );

  onMount(() => {
    const updateScrollMargin = () => {
      if (table !== undefined) {
        const nextScrollMargin = table.getBoundingClientRect().top + window.scrollY;
        setScrollMargin((current) => (current === nextScrollMargin ? current : nextScrollMargin));
      }
    };
    updateScrollMargin();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateScrollMargin);
    const observedElements = new Set([
      table?.parentElement,
      table?.closest(".PullRequestPage-diffContent"),
      table?.closest(".PullRequestPage"),
    ]);
    for (const observedElement of observedElements) {
      if (observedElement !== null && observedElement !== undefined) {
        resizeObserver?.observe(observedElement);
      }
    }
    window.addEventListener("resize", updateScrollMargin);
    onCleanup(() => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateScrollMargin);
    });
  });

  return (
    <div
      aria-colcount="3"
      aria-label="Pull request diff contents"
      aria-rowcount={layout().rowCount}
      class="pr-diff-table"
      ref={(element) => (table = element)}
      role="table"
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
              <span class="pr-diff-lineKind">{sourceKindLabel(row().kind)}</span>
              <span aria-hidden="true" class="pr-diff-prefix">
                {sourcePrefix(row().kind)}
              </span>
              {row().line.content}
              <Show when={row().line.missingNewline}>
                <span class="pr-diff-missingNewline"> No newline at end of file</span>
              </Show>
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
