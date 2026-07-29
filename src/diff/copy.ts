import type { PullRequestDiffFile, PullRequestDiffHunk } from "./layout";

const MISSING_NEWLINE = "\\ No newline at end of file";

export const buildHunkCopyText = (
  file: PullRequestDiffFile,
  hunk: PullRequestDiffHunk,
): string | null => {
  if (file.binary) return null;
  const chunks: string[] = [];
  appendLines(chunks, fileHeaders(file));
  appendHunk(chunks, hunk);
  return chunks.join("");
};

export const buildFileCopyText = (file: PullRequestDiffFile): string | null => {
  if (file.binary) return null;
  const chunks: string[] = [];
  appendLine(chunks, diffHeader(file));
  appendLines(chunks, fileMetadata(file));
  if (file.hunks.length > 0) appendLines(chunks, fileHeaders(file));
  for (const hunk of file.hunks) appendHunk(chunks, hunk);
  return chunks.join("");
};

const diffHeader = (file: PullRequestDiffFile): string => {
  const oldPath = file.oldPath ?? file.newPath ?? "unknown";
  const newPath = file.newPath ?? file.oldPath ?? "unknown";
  return `diff --git ${quotePath(`a/${oldPath}`)} ${quotePath(`b/${newPath}`)}`;
};

const fileMetadata = (file: PullRequestDiffFile): string[] => {
  const lines: string[] = [];
  switch (file.operation) {
    case "added":
      if (file.newMode !== null) lines.push(`new file mode ${file.newMode}`);
      break;
    case "deleted":
      if (file.oldMode !== null) lines.push(`deleted file mode ${file.oldMode}`);
      break;
    case "renamed":
      if (file.oldPath !== null) lines.push(`rename from ${quotePath(file.oldPath)}`);
      if (file.newPath !== null) lines.push(`rename to ${quotePath(file.newPath)}`);
      break;
    case "copied":
      if (file.oldPath !== null) lines.push(`copy from ${quotePath(file.oldPath)}`);
      if (file.newPath !== null) lines.push(`copy to ${quotePath(file.newPath)}`);
      break;
    case "modified":
      break;
  }
  if (
    file.operation !== "added" &&
    file.operation !== "deleted" &&
    file.oldMode !== null &&
    file.newMode !== null &&
    file.oldMode !== file.newMode
  ) {
    lines.push(`old mode ${file.oldMode}`, `new mode ${file.newMode}`);
  }
  return lines;
};

const fileHeaders = (file: PullRequestDiffFile): string[] => [
  `--- ${file.oldPath === null ? "/dev/null" : quotePath(`a/${file.oldPath}`)}`,
  `+++ ${file.newPath === null ? "/dev/null" : quotePath(`b/${file.newPath}`)}`,
];

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

const appendLines = (chunks: string[], lines: string[]) => {
  for (const line of lines) appendLine(chunks, line);
};

const appendLine = (chunks: string[], line: string) => chunks.push(line, "\n");
