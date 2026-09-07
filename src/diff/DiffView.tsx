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
    <div class="pr-diff-root">
      <div
        class="pr-diff-stickyStack"
        ref={(element) => {
          stickyStack = element;
        }}
      >
        <div class="pr-diff-toolbar">
          <label class="pr-diff-filePickerLabel" for="pr-diff-file-picker">
            File
          </label>
          <select
            aria-label="Jump to file"
            class="pr-diff-filePicker"
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
            class="pr-diff-searchInput"
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
          <div aria-label="Search result navigation" class="pr-diff-searchNav" role="group">
            <button
              aria-label="Previous search result"
              class="pr-diff-compactButton"
              disabled={navigationDisabled()}
              onClick={() => send({ direction: -1, kind: "SearchMoveRequested" })}
              type="button"
            >
              Prev
            </button>
            <button
              aria-label="Next search result"
              class="pr-diff-compactButton"
              disabled={navigationDisabled()}
              onClick={() => send({ direction: 1, kind: "SearchMoveRequested" })}
              type="button"
            >
              Next
            </button>
          </div>
          <span aria-atomic="true" aria-live="polite" class="pr-diff-searchCount">
            {searchStatus(search())}
          </span>
        </div>
        <div
          aria-label={`Active file: ${activeLabel()}`}
          class="pr-diff-activeFile"
          title={activeLabel()}
        >
          <span class="pr-diff-activeFilePath">{activeLabel()}</span>
          <span
            aria-atomic="true"
            aria-live="polite"
            class="pr-diff-copyStatus"
            classList={{ "pr-diff-copyStatus--failure": outcome()?.kind === "failure" }}
            role="status"
          >
            {outcome()?.message ?? ""}
          </span>
          <button
            aria-label={
              activeFile()?.content.kind === "binary"
                ? `Copy unavailable for binary file ${activeLabel()}`
                : `Copy file ${activeLabel()}`
            }
            aria-busy={copy().kind === "writing"}
            aria-disabled={copy().kind === "writing" ? "true" : undefined}
            class="pr-diff-compactButton"
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
          </button>
        </div>
      </div>
      <div
        aria-colcount="3"
        aria-label="Pull request diff contents"
        aria-rowcount={layout().rowCount}
        class="pr-diff-table"
        ref={(element) => {
          table = element;
        }}
        role="table"
        style={{ "--pr-diff-horizontal-offset": `${model().geometry.horizontalOffset}px` }}
      >
        <div class="pr-diff-spacer" style={{ height: `${model().virtualWindow.totalSize}px` }}>
          <div
            class="pr-diff-virtualRows"
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
        class="pr-diff-horizontalRailFrame"
        style={{ left: `${model().geometry.railLeft}px`, width: `${model().geometry.railWidth}px` }}
      >
        <div aria-hidden="true" class="pr-diff-railGutter" />
        <div aria-hidden="true" class="pr-diff-railGutter" />
        <div
          aria-label="Scroll diff horizontally"
          class="pr-diff-horizontalRail"
          ref={(element) => {
            horizontalRail = element;
          }}
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
  send: (msg: Msg) => void;
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
          <div aria-colspan="3" aria-label={filePath(row())} class="pr-diff-headerCell" role="cell">
            <span class="pr-diff-headerText">{filePath(row())}</span>
            <button
              aria-label={
                row().file.content.kind === "binary"
                  ? `Copy unavailable for binary file ${fileLabel(row().file)}`
                  : `Copy file ${fileLabel(row().file)}`
              }
              aria-busy={props.copyPending}
              aria-disabled={props.copyPending ? "true" : undefined}
              class="pr-diff-compactButton"
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
              aria-label={`Old line ${diffLineNumbers(row().line).oldLine ?? "none"}`}
              class="pr-diff-lineNumber"
              role="cell"
            >
              {diffLineNumbers(row().line).oldLine ?? ""}
            </div>
            <div
              aria-label={`New line ${diffLineNumbers(row().line).newLine ?? "none"}`}
              class="pr-diff-lineNumber"
              role="cell"
            >
              {diffLineNumbers(row().line).newLine ?? ""}
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

const HighlightedSource = (props: { content: string; matches: MountedSearchMatch[] }) => (
  <For each={highlightedSegments(props.content, props.matches)}>
    {(segment) =>
      segment.match ? (
        <mark
          classList={{ "pr-diff-searchMatch--active": segment.match.active }}
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
