import { describe, expect, it } from "vitest";
import { buildDiffLayout } from "./layout";
import type { PullRequestDiff } from "./layout";
import { firstMatchAtOrAfterRow, searchDiff } from "./search";

describe("diff search", () => {
  it("finds case-insensitive repeated matches in semantic row order", () => {
    const layout = buildDiffLayout(diffWithLines(["Needle needle", "none", "a NEEDLE"]));
    const results = searchDiff(layout, "needle");

    expect(results.count).toBe(3);
    expect(Array.from(results.rowIndexes)).toEqual([2, 2, 4]);
    expect(Array.from(results.matchOffsets)).toEqual([0, 7, 2]);
    expect(Array.from(results.matchLengths)).toEqual([6, 6, 6]);
    expect(results.rowIndexes).toBeInstanceOf(Uint32Array);
    expect(firstMatchAtOrAfterRow(results, 0)).toBe(0);
    expect(firstMatchAtOrAfterRow(results, 3)).toBe(2);
    expect(firstMatchAtOrAfterRow(results, 5)).toBe(3);
  });

  it("returns compact empty results for empty and missing queries", () => {
    const layout = buildDiffLayout(diffWithLines(["content"]));
    expect(searchDiff(layout, "").count).toBe(0);
    expect(searchDiff(layout, "missing").count).toBe(0);
  });

  it("preserves UTF-16 offsets for escaped literals and non-overlapping matches", () => {
    const unicode = searchDiff(buildDiffLayout(diffWithLines(["😀 [X] e\u0301 [x]"])), "[x]");
    const overlapping = searchDiff(buildDiffLayout(diffWithLines(["aaa"])), "aa");

    expect(Array.from(unicode.matchOffsets)).toEqual([3, 10]);
    expect(Array.from(unicode.matchLengths)).toEqual([3, 3]);
    expect(Array.from(overlapping.matchOffsets)).toEqual([0]);
  });

  it.each([50_000, 100_000])(
    "searches %i lines for common and first, middle, and final rare matches",
    (lineCount) => {
      const middleLine = Math.floor(lineCount / 2);
      const contents = Array.from({ length: lineCount }, (_, index) => {
        const marker =
          index === 0 || index === middleLine || index === lineCount - 1 ? " rare" : "";
        return `aaaaaaaaaa${marker}`;
      });
      const layout = buildDiffLayout(diffWithLines(contents));

      const common = searchDiff(layout, "a");
      const rare = searchDiff(layout, "RARE");

      expect(common.count).toBe(lineCount * 10 + 3);
      expect(
        common.rowIndexes.byteLength +
          common.matchOffsets.byteLength +
          common.matchLengths.byteLength,
      ).toBe((lineCount * 10 + 3) * 12);
      expect(Array.from(rare.rowIndexes)).toEqual([2, middleLine + 2, lineCount + 1]);
      expect(Array.from(rare.matchOffsets)).toEqual([11, 11, 11]);
    },
    20_000,
  );
});

const diffWithLines = (contents: string[]): PullRequestDiff => ({
  files: [
    {
      additions: 0,
      binary: false,
      deletions: 0,
      hunks: [
        {
          context: null,
          lines: contents.map((content, index) => ({
            content,
            kind: "context" as const,
            missingNewline: false,
            newLine: index + 1,
            oldLine: index + 1,
          })),
          newCount: contents.length,
          newStart: 1,
          oldCount: contents.length,
          oldStart: 1,
        },
      ],
      newMode: "100644",
      newPath: "file.txt",
      oldMode: "100644",
      oldPath: "file.txt",
      operation: "modified",
    },
  ],
  syncedAt: "2026-01-04T00:00:00Z",
});
