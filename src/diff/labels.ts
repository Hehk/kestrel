import type { DiffRow, PullRequestDiffFile } from "./layout";
import { diffFilePaths } from "./layout";

export const filePath = (row: Extract<DiffRow, { kind: "file" }>): string => fileLabel(row.file);

export const fileLabel = (file: PullRequestDiffFile): string => {
  const { oldPath, newPath } = diffFilePaths(file);
  if (oldPath !== null && newPath !== null && oldPath !== newPath) {
    return `${oldPath} -> ${newPath}`;
  }
  return newPath ?? oldPath ?? "Unknown file";
};

export const hunkLabel = (row: Extract<DiffRow, { kind: "hunk" }>): string => {
  const context = row.hunk.context === null ? "" : ` ${row.hunk.context}`;
  return `@@ -${row.hunk.oldStart},${row.hunk.oldCount} +${row.hunk.newStart},${row.hunk.newCount} @@${context}`;
};
