import type { PullRequestDiffFile, PullRequestDiffHunk } from "./layout";
import { diffFilePaths } from "./layout";

const MISSING_NEWLINE = "\\ No newline at end of file";

export const buildHunkCopyText = (
  file: PullRequestDiffFile,
  hunk: PullRequestDiffHunk,
): string | null => {
  if (file.content.kind === "binary") return null;
  const chunks: string[] = [];
  for (const line of fileHeaders(file)) appendLine(chunks, line);
  appendHunk(chunks, hunk);
  return chunks.join("");
};

export const buildFileCopyText = (file: PullRequestDiffFile): string | null => {
  if (file.content.kind === "binary") return null;
  const chunks: string[] = [];
  appendLine(chunks, diffHeader(file));
  for (const line of fileMetadata(file)) appendLine(chunks, line);
  if (file.content.hunks.length > 0) {
    for (const line of fileHeaders(file)) appendLine(chunks, line);
  }
  for (const hunk of file.content.hunks) appendHunk(chunks, hunk);
  return chunks.join("");
};

const diffHeader = (file: PullRequestDiffFile): string => {
  const { oldPath, newPath } = diffFilePaths(file);
  return `diff --git ${quotePath(`a/${oldPath ?? newPath ?? "unknown"}`)} ${quotePath(`b/${newPath ?? oldPath ?? "unknown"}`)}`;
};

const fileMetadata = (file: PullRequestDiffFile): string[] => {
  const lines: string[] = [];
  const operation = file.operation;
  switch (operation.kind) {
    case "added":
      lines.push(`new file mode ${operation.mode}`);
      break;
    case "deleted":
      lines.push(`deleted file mode ${operation.mode}`);
      break;
    case "renamed":
      lines.push(`rename from ${quotePath(operation.oldPath)}`);
      lines.push(`rename to ${quotePath(operation.newPath)}`);
      break;
    case "copied":
      lines.push(`copy from ${quotePath(operation.oldPath)}`);
      lines.push(`copy to ${quotePath(operation.newPath)}`);
      break;
    case "modified":
      break;
  }
  if ("modeChange" in operation && operation.modeChange.kind === "changed") {
    const { oldMode, newMode } = operation.modeChange;
    lines.push(`old mode ${oldMode}`, `new mode ${newMode}`);
  }
  return lines;
};

const fileHeaders = (file: PullRequestDiffFile): string[] => {
  const { oldPath, newPath } = diffFilePaths(file);
  return [
    `--- ${oldPath === null ? "/dev/null" : quotePath(`a/${oldPath}`)}`,
    `+++ ${newPath === null ? "/dev/null" : quotePath(`b/${newPath}`)}`,
  ];
};

const appendHunk = (chunks: string[], hunk: PullRequestDiffHunk) => {
  const context = hunk.context === null ? "" : ` ${hunk.context}`;
  appendLine(
    chunks,
    `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${context}`,
  );
  for (const line of hunk.lines) {
    chunks.push(linePrefix(line.kind), line.content, "\n");
    if (line.missingNewline) appendLine(chunks, MISSING_NEWLINE);
  }
};

const linePrefix = (kind: "context" | "addition" | "deletion"): string => {
  switch (kind) {
    case "context":
      return " ";
    case "addition":
      return "+";
    case "deletion":
      return "-";
  }
};

const quotePath = (path: string): string => {
  if (![...path].some(needsPathQuoting)) return path;
  let quoted = '"';
  for (const character of path) quoted += quotePathCharacter(character);
  return `${quoted}"`;
};

const needsPathQuoting = (character: string): boolean => {
  const codePoint = character.codePointAt(0) as number;
  return codePoint <= 0x1f || codePoint === 0x7f || character === '"' || character === "\\";
};

const quotePathCharacter = (character: string): string => {
  switch (character) {
    case "\u0007":
      return "\\a";
    case "\b":
      return "\\b";
    case "\t":
      return "\\t";
    case "\n":
      return "\\n";
    case "\v":
      return "\\v";
    case "\f":
      return "\\f";
    case "\r":
      return "\\r";
    case '"':
      return '\\"';
    case "\\":
      return "\\\\";
    default: {
      const codePoint = character.codePointAt(0) as number;
      return codePoint <= 0x1f || codePoint === 0x7f
        ? `\\${codePoint.toString(8).padStart(3, "0")}`
        : character;
    }
  }
};

const appendLine = (chunks: string[], line: string) => chunks.push(line, "\n");
