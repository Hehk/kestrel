import * as stylex from "@stylexjs/stylex";
import { Button } from "../components/Button";
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
  untrack,
} from "solid-js";
import { init, matchesForRow, searchQuery, searchStatus, update } from "./diffViewModel";
import type { MountedSearchMatch, Msg } from "./diffViewModel";
import { createDiffViewRuntime } from "./diffViewRuntime";
import type { DiffViewElements } from "./diffViewRuntime";
import { fileLabel, filePath, hunkLabel } from "./labels";
import type { DiffRow, PullRequestDiff } from "./layout";
import { diffLineNumbers, rowAt, rowHeight } from "./layout";
import { DIFF_ROW_HEIGHT, metrics } from "./metrics.stylex";
import { styles as baseStyles } from "../styles/base";
import { tokens } from "../styles/tokens.stylex";

import { media } from "../styles/media.stylex";

const mobile = media.mobile;
const forcedColors = media.forcedColors;

const styles = stylex.create({
  root: {
    position: "relative",
    paddingBottom: "calc(2rem + env(safe-area-inset-bottom))",
  },
  stickyStack: {
    position: "sticky",
    zIndex: 4,
    top: 0,
    minWidth: 0,
    color: tokens.text,
    backgroundColor: tokens.background,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.rule,
  },
  toolbar: {
    minHeight: "40px",
    height: { default: "40px", [mobile]: "auto" },
    display: "flex",
    alignItems: "center",
    flexWrap: { default: "nowrap", [mobile]: "wrap" },
    gap: { default: "0.6rem", [mobile]: "0.35rem" },
    boxSizing: "border-box",
    padding: { default: "0 0.75rem", [mobile]: "0.35rem 0.5rem" },
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.rule,
  },
  filePickerLabel: {
    flexGrow: "0",
    flexShrink: "0",
    flexBasis: "auto",
    fontFamily: tokens.mono,
    fontSize: "0.8rem",
    fontWeight: 700,
    position: { default: "static", [mobile]: "absolute" },
    width: { default: "auto", [mobile]: "1px" },
    height: { default: "auto", [mobile]: "1px" },
    overflow: { default: "visible", [mobile]: "hidden" },
    clip: { default: "auto", [mobile]: "rect(0, 0, 0, 0)" },
  },
  filePicker: {
    minWidth: 0,
    maxWidth: "100%",
    flex: { default: "2 1 12rem", [mobile]: "2 1 11rem" },
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  searchInput: {
    minWidth: "5rem",
    maxWidth: { default: "16rem", [mobile]: "none" },
    flex: { default: "1 1 9rem", [mobile]: "1 1 8rem" },
  },
  searchNav: {
    display: "flex",
    minHeight: { default: "24px", [mobile]: "36px", [media.coarsePointer]: "44px" },
    flexGrow: "0",
    flexShrink: "0",
    flexBasis: "auto",
    gap: "0.25rem",
  },
  searchCount: {
    minWidth: { default: "4.5rem", [mobile]: "3.5rem" },
    flexGrow: "0",
    flexShrink: "0",
    flexBasis: "auto",
    color: tokens.textMuted,
    fontFamily: tokens.mono,
    fontSize: tokens.fontSizeExtraSmall,
    textAlign: "right",
    whiteSpace: "nowrap",
  },
  activeFile: {
    height: "40px",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    padding: { default: "0 0.75rem", [mobile]: "0 0.5rem" },
    gap: { default: "0.6rem", [mobile]: "0.35rem" },
    backgroundColor: `color-mix(in srgb, ${tokens.text} 7%, ${tokens.background})`,
    fontFamily: tokens.mono,
    fontSize: metrics.fontSize,
    fontWeight: 700,
  },
  truncate: {
    minWidth: 0,
    flexGrow: 1,
    flexBasis: "0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  copyStatus: {
    maxWidth: { default: "min(32vw, 22rem)", [mobile]: "7rem" },
    overflow: "hidden",
    color: tokens.statusSuccess,
    fontSize: tokens.fontSizeExtraSmall,
    fontWeight: 400,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  copyFailure: { color: tokens.statusFailure },
  table: {
    minWidth: 0,
    overflow: "clip",
    color: tokens.text,
    backgroundColor: tokens.background,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: tokens.rule,
    fontFamily: tokens.mono,
    fontSize: metrics.fontSize,
  },
  spacer: { position: "relative", minWidth: "100%" },
  virtualRows: { position: "absolute", top: 0, left: 0, minWidth: "100%" },
  columns: {
    display: "grid",
    gridTemplateColumns: {
      default: `${metrics.gutter} ${metrics.gutter} minmax(0, 1fr)`,
      [mobile]: `${metrics.mobileGutter} ${metrics.mobileGutter} minmax(0, 1fr)`,
    },
  },
  row: {
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.rule,
  },
  fullCell: {
    gridColumnEnd: "-1",
    gridColumnStart: "1",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    paddingBlock: "0",
    paddingInline: "0.75rem",
    gap: "0.6rem",
    whiteSpace: "pre",
  },
  headerCell: {
    minWidth: 0,
    height: DIFF_ROW_HEIGHT.file,
    overflow: "hidden",
    backgroundColor: `color-mix(in srgb, ${tokens.text} 7%, ${tokens.background})`,
    fontWeight: 700,
    textOverflow: "ellipsis",
  },
  hunkCell: {
    minWidth: 0,
    height: DIFF_ROW_HEIGHT.hunk,
    overflow: "hidden",
    color: tokens.textMuted,
    backgroundColor: `color-mix(in srgb, ${tokens.link} 7%, ${tokens.background})`,
    textOverflow: "ellipsis",
  },
  noticeCell: { height: DIFF_ROW_HEIGHT.notice },
  lineCell: {
    height: DIFF_ROW_HEIGHT.source,
    boxSizing: "border-box",
    lineHeight: `${DIFF_ROW_HEIGHT.source}px`,
    whiteSpace: "pre",
  },
  lineNumber: {
    paddingBlock: "0",
    paddingInline: "0.6rem",
    color: tokens.textMuted,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: tokens.rule,
    textAlign: "right",
    userSelect: "none",
  },
  source: {
    minWidth: 0,
    overflow: "hidden",
    tabSize: metrics.tabSize,
    touchAction: "pan-y pinch-zoom",
  },
  sourceContent: {
    width: "max-content",
    paddingRight: "1rem",
    transform: "translateX(calc(-1 * var(--pr-diff-horizontal-offset, 0px)))",
  },
  addition: {
    backgroundColor: `color-mix(in srgb, #2da44e 12%, ${tokens.background})`,
    boxShadow: { default: `inset 3px 0 ${tokens.statusSuccess}`, [forcedColors]: "none" },
    borderLeftWidth: { default: null, [forcedColors]: 3 },
    borderLeftStyle: { default: null, [forcedColors]: "solid" },
    borderLeftColor: { default: null, [forcedColors]: "CanvasText" },
  },
  deletion: {
    backgroundColor: `color-mix(in srgb, #cf222e 12%, ${tokens.background})`,
    boxShadow: { default: `inset 3px 0 ${tokens.statusFailure}`, [forcedColors]: "none" },
    borderLeftWidth: { default: null, [forcedColors]: 3 },
    borderLeftStyle: { default: null, [forcedColors]: "solid" },
    borderLeftColor: { default: null, [forcedColors]: "CanvasText" },
  },
  lineKind: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    borderWidth: 0,
  },
  prefix: { display: "inline-block", width: "1ch", userSelect: "none" },
  changedPrefix: { fontWeight: 700 },
  missingNewline: { color: tokens.textMuted, fontStyle: "italic" },
  mark: {
    color: { default: "inherit", [forcedColors]: "HighlightText" },
    backgroundColor: {
      default: `color-mix(in srgb, #f0b429 48%, ${tokens.background})`,
      [forcedColors]: "Highlight",
    },
    forcedColorAdjust: { default: "auto", [forcedColors]: "none" },
  },
  activeMark: {
    color: { default: tokens.background, [forcedColors]: "HighlightText" },
    backgroundColor: { default: tokens.text, [forcedColors]: "Highlight" },
    outline: { default: `1px solid ${tokens.text}`, [forcedColors]: "2px solid CanvasText" },
  },
  railFrame: {
    position: "fixed",
    zIndex: 6,
    bottom: "env(safe-area-inset-bottom)",
    height: "28px",
    boxSizing: "border-box",
    overflow: "hidden",
    backgroundColor: tokens.background,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.rule,
  },
  railGutter: {
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: tokens.rule,
  },
  rail: {
    minWidth: 0,
    overflowX: "auto",
    overflowY: "hidden",
    direction: "ltr",
    scrollBehavior: { default: null, [media.reducedMotion]: "auto" },
  },
  railContent: {
    minWidth: "100%",
    height: "1px",
    fontFamily: tokens.mono,
    fontSize: metrics.fontSize,
  },
});

export const createDiffViewProgram = (
  diff: PullRequestDiff,
  createRuntime = createDiffViewRuntime,
) => {
  const [model, setModel] = createSignal(init(diff));
  const messages: Msg[] = [];
  let processing = false;
  let disposed = false;

  const send = (msg: Msg) => {
    if (disposed) return;
    messages.push(msg);
    if (processing) return;
    processing = true;
    try {
      for (let index = 0; index < messages.length && !disposed; index += 1) {
        const next = messages[index];
        if (next === undefined) continue;
        const [nextModel, effects] = update(next, untrack(model));
        setModel(nextModel);
        for (const effect of effects) {
          if (disposed) break;
          runtime.run(effect);
        }
      }
    } finally {
      messages.length = 0;
      processing = false;
    }
  };
  const runtime = createRuntime(send);
  return {
    model,
    send,
    attach: (elements: DiffViewElements) => {
      if (!disposed) runtime.attach(elements, untrack(model));
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      messages.length = 0;
      runtime.dispose();
    },
  };
};

export const DiffView = (props: { diff: PullRequestDiff }) => {
  const program = createDiffViewProgram(props.diff);
  const { model, send } = program;
  let horizontalRail!: HTMLDivElement;
  let searchInput!: HTMLInputElement;
  let stickyStack!: HTMLDivElement;
  let table!: HTMLDivElement;
  onMount(() => program.attach({ horizontalRail, searchInput, stickyStack, table }));
  createEffect(
    on(
      () => props.diff,
      (diff) => send({ kind: "DiffChanged", diff }),
      { defer: true },
    ),
  );
  onCleanup(program.dispose);

  const layout = createMemo(() => model().layout);
  const search = createMemo(() => model().search);
  const copy = createMemo(() => model().copy);
  const outcome = () => {
    const value = copy();
    return value.kind === "idle" ? value.outcome : null;
  };
  const activeFile = createMemo(() => layout().diff.files[model().activeFileIndex]);
  const activeLabel = () => {
    const file = activeFile();
    return file === undefined ? "Unknown file" : fileLabel(file);
  };
  const navigationDisabled = () => {
    const value = search();
    return value.kind !== "ready" || value.results.count === 0;
  };

  return (
    <div {...stylex.attrs(styles.root)}>
      <div
        {...stylex.attrs(styles.stickyStack)}
        ref={(element) => {
          stickyStack = element;
        }}
      >
        <div {...stylex.attrs(styles.toolbar)}>
          <label {...stylex.attrs(styles.filePickerLabel)} for="pr-diff-file-picker">
            File
          </label>
          <select
            aria-label="Jump to file"
            {...stylex.attrs(baseStyles.focusable, styles.filePicker)}
            id="pr-diff-file-picker"
            onChange={(event) =>
              send({ fileIndex: Number(event.currentTarget.value), kind: "JumpToFileRequested" })
            }
            value={model().activeFileIndex}
          >
            <For each={layout().diff.files}>
              {(file, index) => <option value={index()}>{fileLabel(file)}</option>}
            </For>
          </select>
          <input
            aria-label="Search diff"
            {...stylex.attrs(baseStyles.focusable, styles.searchInput)}
            onInput={(event) =>
              send({ kind: "SearchQueryChanged", query: event.currentTarget.value })
            }
            placeholder="Search"
            ref={(element) => {
              searchInput = element;
            }}
            type="search"
            value={searchQuery(search())}
          />
          <div
            aria-label="Search result navigation"
            {...stylex.attrs(styles.searchNav)}
            role="group"
          >
            <Button
              aria-label="Previous search result"
              size="compact"
              disabled={navigationDisabled()}
              onClick={() => send({ direction: -1, kind: "SearchMoveRequested" })}
              type="button"
            >
              Prev
            </Button>
            <Button
              aria-label="Next search result"
              size="compact"
              disabled={navigationDisabled()}
              onClick={() => send({ direction: 1, kind: "SearchMoveRequested" })}
              type="button"
            >
              Next
            </Button>
          </div>
          <span aria-atomic="true" aria-live="polite" {...stylex.attrs(styles.searchCount)}>
            {searchStatus(search())}
          </span>
        </div>
        <div
          aria-label={`Active file: ${activeLabel()}`}
          {...stylex.attrs(styles.activeFile)}
          title={activeLabel()}
        >
          <span {...stylex.attrs(styles.truncate)}>{activeLabel()}</span>
          <span
            aria-atomic="true"
            aria-live="polite"
            {...stylex.attrs(
              styles.copyStatus,
              outcome()?.kind === "failure" && styles.copyFailure,
            )}
            data-copy-outcome={outcome()?.kind}
            role="status"
          >
            {outcome()?.message ?? ""}
          </span>
          <Button
            aria-label={
              activeFile()?.content.kind === "binary"
                ? `Copy unavailable for binary file ${activeLabel()}`
                : `Copy file ${activeLabel()}`
            }
            aria-busy={copy().kind === "writing"}
            aria-disabled={copy().kind === "writing" ? "true" : undefined}
            size="compact"
            disabled={activeFile()?.content.kind !== "text"}
            onClick={() => send({ fileIndex: model().activeFileIndex, kind: "CopyFileRequested" })}
            title={
              activeFile()?.content.kind === "binary"
                ? "Binary patch content is unavailable"
                : `Copy file ${activeLabel()}`
            }
            type="button"
          >
            {activeFile()?.content.kind === "binary" ? "Copy unavailable" : "Copy file"}
          </Button>
        </div>
      </div>
      <div
        aria-colcount="3"
        aria-label="Pull request diff contents"
        aria-rowcount={layout().rowCount}
        {...stylex.attrs(styles.table)}
        data-diff-table=""
        ref={(element) => {
          table = element;
        }}
        role="table"
        style={{ "--pr-diff-horizontal-offset": `${model().geometry.horizontalOffset}px` }}
      >
        <div
          {...stylex.attrs(styles.spacer)}
          data-diff-spacer=""
          style={{ height: `${model().virtualWindow.totalSize}px` }}
        >
          <div
            {...stylex.attrs(styles.virtualRows)}
            data-diff-virtual-rows=""
            style={{
              transform: `translateY(${(model().virtualWindow.rows[0]?.start ?? 0) - model().geometry.scrollMargin}px)`,
            }}
          >
            <For each={model().virtualWindow.rows.map((row) => row.index)}>
              {(index) => {
                const row = createMemo(() => rowAt(layout(), index));
                const matches = createMemo(() => matchesForRow(search(), index));
                return (
                  <DiffRowView
                    copyPending={copy().kind === "writing"}
                    index={index}
                    matches={matches()}
                    send={send}
                    row={row()}
                    size={rowHeight(layout(), index)}
                  />
                );
              }}
            </For>
          </div>
        </div>
      </div>
      <div
        {...stylex.attrs(styles.columns, styles.railFrame)}
        style={{ left: `${model().geometry.railLeft}px`, width: `${model().geometry.railWidth}px` }}
      >
        <div aria-hidden="true" {...stylex.attrs(styles.railGutter)} />
        <div aria-hidden="true" {...stylex.attrs(styles.railGutter)} />
        <div
          aria-label="Scroll diff horizontally"
          {...stylex.attrs(baseStyles.focusable, baseStyles.focusInset, styles.rail)}
          data-diff-horizontal-rail=""
          ref={(element) => {
            horizontalRail = element;
          }}
          role="region"
          tabIndex={0}
        >
          <div
            {...stylex.attrs(styles.railContent)}
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
  send: (msg: Msg) => void;
  row: DiffRow;
  size: number;
}) => (
  <div
    aria-rowindex={props.index + 1}
    {...stylex.attrs(styles.columns, styles.row)}
    data-diff-row={props.index}
    role="row"
    style={{ height: `${props.size}px` }}
  >
    <DiffRowCells
      copyPending={props.copyPending}
      matches={props.matches}
      send={props.send}
      row={props.row}
    />
  </div>
);

const DiffRowCells = (props: {
  copyPending: boolean;
  matches: MountedSearchMatch[];
  send: (msg: Msg) => void;
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
          <div
            aria-colspan="3"
            aria-label={filePath(row())}
            {...stylex.attrs(styles.fullCell, styles.headerCell)}
            role="cell"
          >
            <span {...stylex.attrs(styles.truncate)}>{filePath(row())}</span>
            <Button
              aria-label={
                row().file.content.kind === "binary"
                  ? `Copy unavailable for binary file ${fileLabel(row().file)}`
                  : `Copy file ${fileLabel(row().file)}`
              }
              aria-busy={props.copyPending}
              aria-disabled={props.copyPending ? "true" : undefined}
              size="compact"
              disabled={row().file.content.kind === "binary"}
              onClick={() => props.send({ kind: "CopyFileRequested", fileIndex: row().fileIndex })}
              title={
                row().file.content.kind === "binary"
                  ? "Binary patch content is unavailable"
                  : `Copy file ${fileLabel(row().file)}`
              }
              type="button"
            >
              {row().file.content.kind === "binary" ? "Copy unavailable" : "Copy file"}
            </Button>
          </div>
        )}
      </Match>
      <Match when={hunkRow()}>
        {(row) => (
          <div
            aria-colspan="3"
            aria-label={hunkLabel(row())}
            {...stylex.attrs(styles.fullCell, styles.hunkCell)}
            role="cell"
          >
            <span {...stylex.attrs(styles.truncate)}>{hunkLabel(row())}</span>
            <Button
              aria-label={`Copy hunk from ${fileLabel(row().file)}, ${hunkLabel(row())}`}
              aria-busy={props.copyPending}
              aria-disabled={props.copyPending ? "true" : undefined}
              size="compact"
              onClick={() =>
                props.send({
                  kind: "CopyHunkRequested",
                  fileIndex: row().fileIndex,
                  hunkIndex: row().hunkIndex,
                })
              }
              type="button"
            >
              Copy hunk
            </Button>
          </div>
        )}
      </Match>
      <Match when={noticeRow()}>
        {(row) => (
          <div
            aria-colspan="3"
            {...stylex.attrs(styles.fullCell, styles.hunkCell, styles.noticeCell)}
            role="cell"
          >
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
              aria-label={`Old line ${diffLineNumbers(row().line).oldLine ?? "none"}`}
              {...stylex.attrs(styles.lineCell, styles.lineNumber)}
              role="cell"
            >
              {diffLineNumbers(row().line).oldLine ?? ""}
            </div>
            <div
              aria-label={`New line ${diffLineNumbers(row().line).newLine ?? "none"}`}
              {...stylex.attrs(styles.lineCell, styles.lineNumber)}
              role="cell"
            >
              {diffLineNumbers(row().line).newLine ?? ""}
            </div>
            <div
              {...stylex.attrs(styles.lineCell, styles.source, sourceKindStyle(row().kind))}
              data-diff-source=""
              role="cell"
            >
              <div {...stylex.attrs(styles.sourceContent)} data-diff-source-content="">
                <span {...stylex.attrs(styles.lineKind)}>{sourceKindLabel(row().kind)}</span>
                <span
                  aria-hidden="true"
                  {...stylex.attrs(styles.prefix, row().kind !== "context" && styles.changedPrefix)}
                >
                  {sourcePrefix(row().kind)}
                </span>
                <HighlightedSource content={row().line.content} matches={props.matches} />
                <Show when={row().line.missingNewline}>
                  <span {...stylex.attrs(styles.missingNewline)}> No newline at end of file</span>
                </Show>
              </div>
            </div>
          </>
        )}
      </Match>
    </Switch>
  );
};

const HighlightedSource = (props: { content: string; matches: MountedSearchMatch[] }) => (
  <For each={highlightedSegments(props.content, props.matches)}>
    {(segment) =>
      segment.match ? (
        <mark
          {...stylex.attrs(styles.mark, segment.match.active && styles.activeMark)}
          data-search-match={segment.match.active ? "active" : undefined}
          data-match-offset={segment.match.offset}
          data-match-length={segment.match.length}
        >
          {segment.text}
        </mark>
      ) : (
        segment.text
      )
    }
  </For>
);

const highlightedSegments = (content: string, matches: MountedSearchMatch[]) => {
  const result: Array<{ match: MountedSearchMatch | null; text: string }> = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.offset > cursor)
      result.push({ match: null, text: content.slice(cursor, match.offset) });
    result.push({ match, text: content.slice(match.offset, match.offset + match.length) });
    cursor = match.offset + match.length;
  }
  if (cursor < content.length) result.push({ match: null, text: content.slice(cursor) });
  return result;
};

const sourceKindStyle = (kind: "context" | "addition" | "deletion") => {
  switch (kind) {
    case "context":
      return null;
    case "addition":
      return styles.addition;
    case "deletion":
      return styles.deletion;
  }
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
