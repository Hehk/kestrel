import type { DiffLayout } from "./layout";
import { hunkStartRow } from "./layout";

export type DiffSearchResults = {
  readonly rowIndexes: Uint32Array;
  readonly matchOffsets: Uint32Array;
  readonly matchLengths: Uint32Array;
  readonly count: number;
};

const EMPTY_RESULTS: DiffSearchResults = {
  count: 0,
  matchLengths: new Uint32Array(0),
  matchOffsets: new Uint32Array(0),
  rowIndexes: new Uint32Array(0),
};

export const searchDiff = (layout: DiffLayout, query: string): DiffSearchResults => {
  if (query.length === 0) return EMPTY_RESULTS;
  const matcher = new RegExp(escapeRegExp(query), "giu");
  let count = 0;
  visitMatches(layout, matcher, () => {
    count += 1;
  });
  const rowIndexes = new Uint32Array(count);
  const matchOffsets = new Uint32Array(count);
  const matchLengths = new Uint32Array(count);
  let resultIndex = 0;
  visitMatches(layout, matcher, (rowIndex, offset, length) => {
    rowIndexes[resultIndex] = rowIndex;
    matchOffsets[resultIndex] = offset;
    matchLengths[resultIndex] = length;
    resultIndex += 1;
  });

  return { count, matchLengths, matchOffsets, rowIndexes };
};

const visitMatches = (
  layout: DiffLayout,
  matcher: RegExp,
  visit: (rowIndex: number, offset: number, length: number) => void,
) => {
  for (let fileIndex = 0; fileIndex < layout.diff.files.length; fileIndex += 1) {
    const file = layout.diff.files[fileIndex];
    if (file === undefined) continue;
    for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex += 1) {
      const hunk = file.hunks[hunkIndex];
      if (hunk === undefined) continue;
      const firstSourceRow = hunkStartRow(layout, fileIndex, hunkIndex) + 1;
      for (let lineIndex = 0; lineIndex < hunk.lines.length; lineIndex += 1) {
        const content = hunk.lines[lineIndex]?.content;
        if (content === undefined) continue;
        matcher.lastIndex = 0;
        let match = matcher.exec(content);
        while (match !== null) {
          visit(firstSourceRow + lineIndex, match.index, match[0].length);
          match = matcher.exec(content);
        }
      }
    }
  }
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const firstMatchAtOrAfterRow = (results: DiffSearchResults, rowIndex: number): number => {
  let low = 0;
  let high = results.count;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((results.rowIndexes[middle] as number) < rowIndex) low = middle + 1;
    else high = middle;
  }
  return low;
};
