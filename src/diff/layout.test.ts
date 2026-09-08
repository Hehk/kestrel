import { describe, expect, it } from "vitest";
import type {
  PullRequestDiff,
  PullRequestDiffFile,
  PullRequestDiffHunk,
  PullRequestDiffLine,
} from "./layout";
import {
  buildDiffLayout,
  DIFF_ROW_HEIGHT,
  diffFileHunks,
  hunkStartRow,
  rowAt,
  rowHeight,
  rowKey,
  sourceVisualColumns,
} from "./layout";

const line = (index: number, kind: PullRequestDiffLine["kind"]): PullRequestDiffLine => {
  const fields = { content: `line ${index}`, missingNewline: false };
  switch (kind) {
    case "context":
      return { ...fields, kind, newLine: index + 1, oldLine: index + 1 };
    case "addition":
      return { ...fields, kind, newLine: index + 1 };
    case "deletion":
      return { ...fields, kind, oldLine: index + 1 };
  }
};

type FileOverrides = Omit<Partial<PullRequestDiffFile>, "content"> & {
  binary?: boolean;
  hunks?: PullRequestDiffHunk[];
};

const file = (overrides: FileOverrides = {}): PullRequestDiffFile => {
  const { binary = false, hunks = [], ...fields } = overrides;
  return {
    additions: 0,
    content: binary ? { kind: "binary" } : { hunks, kind: "text" },
    deletions: 0,
    operation: { kind: "modified", modeChange: { kind: "unchanged" }, path: "src/file.ts" },
    ...fields,
  };
};

const canonicalDiff = (): PullRequestDiff => ({
  files: [
    file({
      hunks: [
        {
          context: "first",
          lines: [line(0, "context"), line(1, "addition")],
          newCount: 2,
          newStart: 1,
          oldCount: 1,
          oldStart: 1,
        },
        {
          context: null,
          lines: [line(2, "deletion")],
          newCount: 0,
          newStart: 4,
          oldCount: 1,
          oldStart: 4,
        },
      ],
    }),
    file({
      binary: true,
      operation: {
        kind: "modified",
        modeChange: { kind: "unchanged" },
        path: "asset.bin",
      },
    }),
    file({
      operation: {
        kind: "modified",
        modeChange: { kind: "changed", newMode: "100755", oldMode: "100644" },
        path: "script.sh",
      },
    }),
  ],
  syncedAt: "2026-01-04T00:00:00Z",
});

describe("diff layout", () => {
  it("maps canonical files, hunks, lines, and notices to stable rows", () => {
    const diff = canonicalDiff();
    const layout = buildDiffLayout(diff);

    expect(layout.diff).toBe(diff);
    expect(layout.rowCount).toBe(10);
    expect(Array.from(layout.fileStartRows)).toEqual([0, 6, 8]);
    expect(Array.from(layout.hunkStartRows)).toEqual([1, 4]);
    expect(Array.from(layout.fileHunkOffsets)).toEqual([0, 2, 2, 2]);
    expect(
      Array.from({ length: layout.rowCount }, (_, index) => rowAt(layout, index).kind),
    ).toEqual([
      "file",
      "hunk",
      "context",
      "addition",
      "hunk",
      "deletion",
      "file",
      "notice",
      "file",
      "notice",
    ]);
    expect(rowAt(layout, 2)).toMatchObject({ fileIndex: 0, hunkIndex: 0, lineIndex: 0 });
    expect(rowAt(layout, 2).file).toBe(diff.files[0]);
    const firstSourceRow = rowAt(layout, 2);
    if (firstSourceRow.kind !== "context") {
      throw new Error("expected a context row");
    }
    expect(firstSourceRow.line).toBe(
      diff.files[0] === undefined ? undefined : diffFileHunks(diff.files[0])[0]?.lines[0],
    );
    expect(rowAt(layout, 7)).toMatchObject({ kind: "notice", notice: "binary" });
    expect(rowAt(layout, 9)).toMatchObject({ kind: "notice", notice: "hunkless" });
    expect(hunkStartRow(layout, 0, 1)).toBe(4);

    expect(Array.from({ length: layout.rowCount }, (_, index) => rowKey(layout, index))).toEqual([
      "file:0",
      "file:0:hunk:0",
      "file:0:hunk:0:line:0",
      "file:0:hunk:0:line:1",
      "file:0:hunk:1",
      "file:0:hunk:1:line:0",
      "file:1",
      "file:1:notice:binary",
      "file:2",
      "file:2:notice:hunkless",
    ]);
    expect(Array.from({ length: layout.rowCount }, (_, index) => rowHeight(layout, index))).toEqual(
      [
        DIFF_ROW_HEIGHT.file,
        DIFF_ROW_HEIGHT.hunk,
        DIFF_ROW_HEIGHT.source,
        DIFF_ROW_HEIGHT.source,
        DIFF_ROW_HEIGHT.hunk,
        DIFF_ROW_HEIGHT.source,
        DIFF_ROW_HEIGHT.file,
        DIFF_ROW_HEIGHT.notice,
        DIFF_ROW_HEIGHT.file,
        DIFF_ROW_HEIGHT.notice,
      ],
    );
  });

  it("handles empty layouts and rejects invalid lookups", () => {
    const layout = buildDiffLayout({ files: [], syncedAt: "2026-01-04T00:00:00Z" });

    expect(layout.rowCount).toBe(0);
    expect(layout.maxSourceColumns).toBe(0);
    expect(layout.metadataByteLength).toBe(4);
    expect(() => rowAt(layout, 0)).toThrow(RangeError);
    expect(() => rowAt(buildDiffLayout(canonicalDiff()), 1.5)).toThrow(RangeError);
    expect(() => hunkStartRow(buildDiffLayout(canonicalDiff()), 1, 0)).toThrow(RangeError);
  });

  it("calculates conservative visual columns without dropping whitespace", () => {
    expect(sourceVisualColumns("abc")).toBe(4);
    expect(sourceVisualColumns("\tX")).toBe(5);
    expect(sourceVisualColumns("a\t")).toBe(4);
    expect(sourceVisualColumns("x  ")).toBe(4);
    expect(sourceVisualColumns("界")).toBe(3);
    expect(sourceVisualColumns("e\u0301")).toBe(2);
    expect(sourceVisualColumns("👩‍💻")).toBe(5);
    expect(sourceVisualColumns("❤️")).toBe(3);
    expect(sourceVisualColumns("1️⃣")).toBe(3);
    expect(sourceVisualColumns("☕⌚☔")).toBe(7);
    expect(sourceVisualColumns("𛀀𗀀")).toBe(5);
    expect(sourceVisualColumns("ꥠힰ")).toBe(5);
    const missingNewlineDiff = canonicalDiff();
    const firstFile = missingNewlineDiff.files[0];
    const sourceLine = firstFile === undefined ? undefined : diffFileHunks(firstFile)[0]?.lines[0];
    if (sourceLine !== undefined) sourceLine.missingNewline = true;
    expect(buildDiffLayout(missingNewlineDiff).maxSourceColumns).toBeGreaterThan(
      sourceVisualColumns(sourceLine?.content ?? ""),
    );
  });

  it("scans exact 64 KiB and 1 MiB source lines including their final columns", () => {
    const makeLongLine = (bytes: number) => {
      const suffix = "\t界e\u0301 RARE_NEEDLE   ";
      const fixedBytes = new TextEncoder().encode(`\t${suffix}`).length;
      return `\t${"a".repeat(bytes - fixedBytes)}${suffix}`;
    };
    const short = makeLongLine(64 * 1024);
    const long = makeLongLine(1024 * 1024);
    const shortLine = { ...line(0, "context"), content: short };
    const longLine = { ...line(1, "addition"), content: long };
    const diff: PullRequestDiff = {
      files: [
        file({
          hunks: [
            {
              context: null,
              lines: [shortLine, longLine],
              newCount: 2,
              newStart: 1,
              oldCount: 1,
              oldStart: 1,
            },
          ],
        }),
      ],
      syncedAt: "2026-01-04T00:00:00Z",
    };

    expect(new TextEncoder().encode(short)).toHaveLength(64 * 1024);
    expect(new TextEncoder().encode(long)).toHaveLength(1024 * 1024);
    expect(long.indexOf("RARE_NEEDLE")).toBeGreaterThan(long.length - 32);
    const beforeSuffix = 4 + (1024 * 1024 - 23);
    const expectedColumns = beforeSuffix + (4 - (beforeSuffix % 4)) + 18;
    const layout = buildDiffLayout(diff);
    expect(layout.maxSourceColumns).toBe(expectedColumns);
    const longSourceRow = rowAt(layout, 3);
    if (longSourceRow.kind !== "addition") {
      throw new Error("expected an addition row");
    }
    expect(longSourceRow.line).toBe(longLine);
  });

  it.each([
    ["one large hunk", 1, 1, 50_000, 50_002, 650_042],
    ["many files", 1_000, 2, 50, 103_000, 1_355_004],
    ["many hunks", 1, 2_000, 50, 102_001, 1_334_025],
    ["header heavy", 10_000, 1, 5, 70_000, 1_030_004],
  ])(
    "builds compact generated scenario: %s",
    (_name, fileCount, hunksPerFile, linesPerHunk, expectedRows, expectedBytes) => {
      const diff = generatedDiff(fileCount, hunksPerFile, linesPerHunk);
      const layout = buildDiffLayout(diff);

      expect(layout.rowCount).toBe(expectedRows);
      expect(layout.metadataByteLength).toBe(expectedBytes);
      expect(layout.kinds).toBeInstanceOf(Uint8Array);
      expect(layout.fileIndexes).toBeInstanceOf(Uint32Array);
      expect(layout.hunkIndexes).toBeInstanceOf(Uint32Array);
      expect(layout.lineIndexes).toBeInstanceOf(Uint32Array);
      expect("rows" in layout).toBe(false);
      expect(layout.diff).toBe(diff);
      expect(layout.fileStartRows).toHaveLength(fileCount);
      expect(layout.hunkStartRows).toHaveLength(fileCount * hunksPerFile);
      expect(layout.fileHunkOffsets.at(-1)).toBe(fileCount * hunksPerFile);
      const rowKinds = { addition: 0, context: 0, deletion: 0, file: 0, hunk: 0, notice: 0 };
      for (let rowIndex = 0; rowIndex < layout.rowCount; rowIndex += 1) {
        rowKinds[rowAt(layout, rowIndex).kind] += 1;
      }
      const sourceLines = fileCount * hunksPerFile * linesPerHunk;
      expect(rowKinds).toEqual({
        addition: Math.floor((sourceLines + 1) / 3),
        context: Math.ceil(sourceLines / 3),
        deletion: Math.floor(sourceLines / 3),
        file: fileCount,
        hunk: fileCount * hunksPerFile,
        notice: 0,
      });
      expect(rowAt(layout, layout.rowCount - 1).kind).toMatch(/context|addition|deletion/);
      expect(rowKey(layout, layout.rowCount - 1)).toBe(
        `file:${fileCount - 1}:hunk:${hunksPerFile - 1}:line:${linesPerHunk - 1}`,
      );
    },
    20_000,
  );
});

const generatedDiff = (
  fileCount: number,
  hunksPerFile: number,
  linesPerHunk: number,
): PullRequestDiff => {
  let globalLine = 0;
  return {
    files: Array.from({ length: fileCount }, (_, fileIndex) =>
      file({
        hunks: Array.from({ length: hunksPerFile }, (_, hunkIndex) => {
          const lines = Array.from({ length: linesPerHunk }, () => {
            const kinds = ["context", "addition", "deletion"] as const;
            const nextLine = line(
              globalLine,
              kinds[globalLine % kinds.length] as (typeof kinds)[number],
            );
            globalLine += 1;
            return nextLine;
          });
          return {
            context: `file ${fileIndex} hunk ${hunkIndex}`,
            lines,
            newCount: linesPerHunk,
            newStart: hunkIndex * linesPerHunk + 1,
            oldCount: linesPerHunk,
            oldStart: hunkIndex * linesPerHunk + 1,
          };
        }),
        operation: {
          kind: "modified",
          modeChange: { kind: "unchanged" },
          path: `src/file-${fileIndex}.ts`,
        },
      }),
    ),
    syncedAt: "2026-01-04T00:00:00Z",
  };
};
