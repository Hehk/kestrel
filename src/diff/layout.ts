import type { components } from "../api/schema";

export type PullRequestDiff = components["schemas"]["PullRequestDiffResponse"];
export type PullRequestDiffFile = components["schemas"]["PullRequestDiffFileDto"];
export type PullRequestDiffHunk = components["schemas"]["PullRequestDiffHunkDto"];
export type PullRequestDiffLine = components["schemas"]["PullRequestDiffLineDto"];

export const DIFF_ROW_HEIGHT = {
  file: 40,
  hunk: 32,
  notice: 32,
  source: 24,
} as const;

export const DIFF_TAB_SIZE = 4;
const NONE = 0xffff_ffff;
const MAX_INDEX = NONE - 1;
const MARK = /\p{Mark}/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;

const ROW_FILE = 0;
const ROW_HUNK = 1;
const ROW_CONTEXT = 2;
const ROW_ADDITION = 3;
const ROW_DELETION = 4;
const ROW_NOTICE = 5;

export type DiffRow =
  | { kind: "file"; fileIndex: number; file: PullRequestDiffFile }
  | {
      kind: "hunk";
      fileIndex: number;
      hunkIndex: number;
      file: PullRequestDiffFile;
      hunk: PullRequestDiffHunk;
    }
  | {
      kind: "context" | "addition" | "deletion";
      fileIndex: number;
      hunkIndex: number;
      lineIndex: number;
      file: PullRequestDiffFile;
      hunk: PullRequestDiffHunk;
      line: PullRequestDiffLine;
    }
  | {
      kind: "notice";
      notice: "binary" | "hunkless";
      fileIndex: number;
      file: PullRequestDiffFile;
    };

export type DiffLayout = {
  readonly diff: PullRequestDiff;
  readonly rowCount: number;
  readonly maxSourceColumns: number;
  readonly metadataByteLength: number;
  readonly kinds: Uint8Array;
  readonly fileIndexes: Uint32Array;
  readonly hunkIndexes: Uint32Array;
  readonly lineIndexes: Uint32Array;
  readonly fileStartRows: Uint32Array;
  readonly hunkStartRows: Uint32Array;
  readonly fileHunkOffsets: Uint32Array;
};

export const buildDiffLayout = (diff: PullRequestDiff): DiffLayout => {
  if (diff.files.length > MAX_INDEX) {
    throw new RangeError("Diff has too many files");
  }

  let rowCount = 0;
  let hunkCount = 0;
  const fileHunkOffsets = new Uint32Array(diff.files.length + 1);
  for (let fileIndex = 0; fileIndex < diff.files.length; fileIndex += 1) {
    const file = diff.files[fileIndex];
    if (file === undefined || file.hunks.length > MAX_INDEX) {
      throw new RangeError("Diff has too many hunks");
    }
    fileHunkOffsets[fileIndex] = hunkCount;
    hunkCount = checkedAdd(hunkCount, file.hunks.length, "Diff has too many hunks");
    rowCount = checkedAdd(rowCount, 1, "Diff has too many rows");
    if (file.binary || file.hunks.length === 0) {
      rowCount = checkedAdd(rowCount, 1, "Diff has too many rows");
    }
    for (const hunk of file.hunks) {
      if (hunk.lines.length > MAX_INDEX) {
        throw new RangeError("Diff hunk has too many lines");
      }
      rowCount = checkedAdd(rowCount, 1 + hunk.lines.length, "Diff has too many rows");
    }
  }
  fileHunkOffsets[diff.files.length] = hunkCount;

  const kinds = new Uint8Array(rowCount);
  const fileIndexes = new Uint32Array(rowCount);
  const hunkIndexes = new Uint32Array(rowCount);
  const lineIndexes = new Uint32Array(rowCount);
  hunkIndexes.fill(NONE);
  lineIndexes.fill(NONE);
  const fileStartRows = new Uint32Array(diff.files.length);
  const hunkStartRows = new Uint32Array(hunkCount);

  let rowIndex = 0;
  let flatHunkIndex = 0;
  let maxSourceColumns = 0;
  for (let fileIndex = 0; fileIndex < diff.files.length; fileIndex += 1) {
    const file = diff.files[fileIndex] as PullRequestDiffFile;
    fileStartRows[fileIndex] = rowIndex;
    kinds[rowIndex] = ROW_FILE;
    fileIndexes[rowIndex] = fileIndex;
    rowIndex += 1;

    if (file.binary || file.hunks.length === 0) {
      kinds[rowIndex] = ROW_NOTICE;
      fileIndexes[rowIndex] = fileIndex;
      rowIndex += 1;
    }

    for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex += 1) {
      const hunk = file.hunks[hunkIndex] as PullRequestDiffHunk;
      hunkStartRows[flatHunkIndex] = rowIndex;
      flatHunkIndex += 1;
      kinds[rowIndex] = ROW_HUNK;
      fileIndexes[rowIndex] = fileIndex;
      hunkIndexes[rowIndex] = hunkIndex;
      rowIndex += 1;

      for (let lineIndex = 0; lineIndex < hunk.lines.length; lineIndex += 1) {
        const line = hunk.lines[lineIndex] as PullRequestDiffLine;
        kinds[rowIndex] = sourceRowKind(line.kind);
        fileIndexes[rowIndex] = fileIndex;
        hunkIndexes[rowIndex] = hunkIndex;
        lineIndexes[rowIndex] = lineIndex;
        let sourceColumns = sourceVisualColumns(line.content);
        if (line.missingNewline) {
          sourceColumns = sourceVisualColumns(" No newline at end of file", sourceColumns);
        }
        maxSourceColumns = Math.max(maxSourceColumns, sourceColumns);
        rowIndex += 1;
      }
    }
  }

  const metadataByteLength =
    kinds.byteLength +
    fileIndexes.byteLength +
    hunkIndexes.byteLength +
    lineIndexes.byteLength +
    fileStartRows.byteLength +
    hunkStartRows.byteLength +
    fileHunkOffsets.byteLength;

  return {
    diff,
    fileHunkOffsets,
    fileIndexes,
    fileStartRows,
    hunkIndexes,
    hunkStartRows,
    kinds,
    lineIndexes,
    maxSourceColumns,
    metadataByteLength,
    rowCount,
  };
};

export const rowAt = (layout: DiffLayout, index: number): DiffRow => {
  assertArrayIndex(index, layout.rowCount, "row");
  const fileIndex = layout.fileIndexes[index] as number;
  const file = layout.diff.files[fileIndex] as PullRequestDiffFile;
  const kind = layout.kinds[index];
  if (kind === ROW_FILE) {
    return { file, fileIndex, kind: "file" };
  }
  if (kind === ROW_NOTICE) {
    return { file, fileIndex, kind: "notice", notice: file.binary ? "binary" : "hunkless" };
  }

  const hunkIndex = layout.hunkIndexes[index] as number;
  const hunk = file.hunks[hunkIndex] as PullRequestDiffHunk;
  if (kind === ROW_HUNK) {
    return { file, fileIndex, hunk, hunkIndex, kind: "hunk" };
  }

  const lineIndex = layout.lineIndexes[index] as number;
  const line = hunk.lines[lineIndex] as PullRequestDiffLine;
  if (kind === ROW_CONTEXT || kind === ROW_ADDITION || kind === ROW_DELETION) {
    return { file, fileIndex, hunk, hunkIndex, kind: line.kind, line, lineIndex };
  }
  throw new RangeError("Diff row kind is invalid");
};

export const rowKey = (layout: DiffLayout, index: number): string => {
  const row = rowAt(layout, index);
  switch (row.kind) {
    case "file":
      return `file:${row.fileIndex}`;
    case "notice":
      return `file:${row.fileIndex}:notice:${row.notice}`;
    case "hunk":
      return `file:${row.fileIndex}:hunk:${row.hunkIndex}`;
    case "context":
    case "addition":
    case "deletion":
      return `file:${row.fileIndex}:hunk:${row.hunkIndex}:line:${row.lineIndex}`;
  }
};

export const rowHeight = (layout: DiffLayout, index: number): number => {
  assertArrayIndex(index, layout.rowCount, "row");
  switch (layout.kinds[index]) {
    case ROW_FILE:
      return DIFF_ROW_HEIGHT.file;
    case ROW_HUNK:
      return DIFF_ROW_HEIGHT.hunk;
    case ROW_NOTICE:
      return DIFF_ROW_HEIGHT.notice;
    case ROW_CONTEXT:
    case ROW_ADDITION:
    case ROW_DELETION:
      return DIFF_ROW_HEIGHT.source;
    default:
      throw new RangeError("Diff row kind is invalid");
  }
};

export const hunkStartRow = (layout: DiffLayout, fileIndex: number, hunkIndex: number): number => {
  assertArrayIndex(fileIndex, layout.diff.files.length, "file");
  const start = layout.fileHunkOffsets[fileIndex] as number;
  const end = layout.fileHunkOffsets[fileIndex + 1] as number;
  assertArrayIndex(hunkIndex, end - start, "hunk");
  return layout.hunkStartRows[start + hunkIndex] as number;
};

export const sourceVisualColumns = (
  content: string,
  prefixColumns = 1,
  tabSize = DIFF_TAB_SIZE,
): number => {
  if (!Number.isInteger(prefixColumns) || prefixColumns < 0) {
    throw new RangeError("Prefix columns must be a non-negative integer");
  }
  if (!Number.isInteger(tabSize) || tabSize <= 0) {
    throw new RangeError("Tab size must be a positive integer");
  }

  let columns = prefixColumns;
  let previousGlyphColumns = 0;
  for (let offset = 0; offset < content.length; ) {
    const codePoint = content.codePointAt(offset) as number;
    offset += codePoint > 0xffff ? 2 : 1;
    if (codePoint === 0x09) {
      columns += tabSize - (columns % tabSize);
      previousGlyphColumns = 0;
    } else if (codePoint === 0xfe0f) {
      if (previousGlyphColumns === 1) {
        columns += 1;
        previousGlyphColumns = 2;
      }
    } else if (!isZeroWidth(codePoint)) {
      previousGlyphColumns = isWide(codePoint) ? 2 : 1;
      columns += previousGlyphColumns;
    }
  }
  return columns;
};

const checkedAdd = (left: number, right: number, message: string): number => {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > MAX_INDEX) {
    throw new RangeError(message);
  }
  return result;
};

const assertArrayIndex = (index: number, length: number, name: string) => {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new RangeError(`Diff ${name} index is out of range`);
  }
};

const sourceRowKind = (kind: PullRequestDiffLine["kind"]): number => {
  switch (kind) {
    case "context":
      return ROW_CONTEXT;
    case "addition":
      return ROW_ADDITION;
    case "deletion":
      return ROW_DELETION;
  }
};

const isZeroWidth = (codePoint: number): boolean => {
  return (
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0e) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
    (codePoint > 0x7f && MARK.test(String.fromCodePoint(codePoint)))
  );
};

const isWide = (codePoint: number): boolean => {
  return (
    (codePoint > 0x7f && EMOJI_PRESENTATION.test(String.fromCodePoint(codePoint))) ||
    (codePoint >= 0x1100 &&
      (codePoint <= 0x115f ||
        codePoint === 0x2329 ||
        codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
        (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xd7b0 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
        (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x16fe0 && codePoint <= 0x18dff) ||
        (codePoint >= 0x1aff0 && codePoint <= 0x1b2ff) ||
        (codePoint >= 0x1f200 && codePoint <= 0x1f2ff) ||
        (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
        (codePoint >= 0x20000 && codePoint <= 0x3fffd)))
  );
};
