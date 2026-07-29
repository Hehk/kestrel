import { describe, expect, it } from "vitest";
import { buildFileCopyText, buildHunkCopyText } from "./copy";
import type { PullRequestDiffFile, PullRequestDiffHunk } from "./layout";

describe("diff copy text", () => {
  it("reconstructs file headers, hunks, prefixes, whitespace, and missing-newline markers", () => {
    const file = diffFile({
      hunks: [
        hunk({
          context: "function example",
          lines: [
            line("deletion", "old  "),
            line("addition", "\tnew", true),
            line("context", "unchanged"),
          ],
        }),
        hunk({ newStart: 20, oldStart: 19, lines: [line("addition", "later")] }),
      ],
    });

    expect(buildFileCopyText(file)).toBe(
      "diff --git a/src/file.ts b/src/file.ts\n" +
        "--- a/src/file.ts\n" +
        "+++ b/src/file.ts\n" +
        "@@ -1,3 +1,3 @@ function example\n" +
        "-old  \n" +
        "+\tnew\n" +
        "\\ No newline at end of file\n" +
        " unchanged\n" +
        "@@ -19,3 +20,3 @@\n" +
        "+later\n",
    );
  });

  it("copies one hunk with enough file context but without unrelated metadata", () => {
    const selected = hunk({ lines: [line("addition", "selected")] });
    const file = diffFile({
      hunks: [selected, hunk({ lines: [line("deletion", "other")] })],
      newMode: "100755",
      oldMode: "100644",
    });

    expect(buildHunkCopyText(file, selected)).toBe(
      "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,3 +1,3 @@\n+selected\n",
    );
  });

  it("preserves reconstructible file operations and modes", () => {
    expect(
      buildFileCopyText(
        diffFile({
          hunks: [],
          newMode: "100755",
          newPath: "scripts/new.sh",
          oldMode: "100644",
          oldPath: "scripts/old.sh",
          operation: "renamed",
        }),
      ),
    ).toBe(
      "diff --git a/scripts/old.sh b/scripts/new.sh\n" +
        "rename from scripts/old.sh\n" +
        "rename to scripts/new.sh\n" +
        "old mode 100644\n" +
        "new mode 100755\n",
    );
    expect(
      buildFileCopyText(
        diffFile({
          hunks: [],
          newPath: "new.txt",
          oldMode: null,
          oldPath: null,
          operation: "added",
        }),
      ),
    ).toBe("diff --git a/new.txt b/new.txt\nnew file mode 100644\n");
    expect(
      buildFileCopyText(
        diffFile({
          hunks: [],
          newMode: null,
          newPath: null,
          oldPath: "old.txt",
          operation: "deleted",
        }),
      ),
    ).toBe("diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n");
    expect(
      buildFileCopyText(
        diffFile({
          hunks: [],
          newPath: "copy.txt",
          oldPath: "source.txt",
          operation: "copied",
        }),
      ),
    ).toBe("diff --git a/source.txt b/copy.txt\ncopy from source.txt\ncopy to copy.txt\n");
  });

  it("quotes decoded control-heavy paths deterministically", () => {
    const file = diffFile({
      newPath: 'quote"-backslash\\-tab\t.txt',
      oldPath: 'quote"-backslash\\-tab\t.txt',
    });

    expect(buildFileCopyText(file)).toMatch(
      /^diff --git "a\/quote\\"-backslash\\\\-tab\\t\.txt" "b\/quote.*\n--- "a\/quote/,
    );
  });

  it("uses Git C-style escapes for control-heavy paths", () => {
    const path = 'control\u0001\u0007\b\t\n\v\f\r\u001b\u007f"\\-cafe.txt';
    const file = diffFile({ newPath: path, oldPath: path });

    expect(buildFileCopyText(file)).toContain(
      '"a/control\\001\\a\\b\\t\\n\\v\\f\\r\\033\\177\\"\\\\-cafe.txt"',
    );
  });

  it("makes binary copy behavior explicitly unavailable", () => {
    const file = diffFile({ binary: true, hunks: [] });
    expect(buildFileCopyText(file)).toBeNull();
    expect(buildHunkCopyText(file, hunk())).toBeNull();
  });

  it("reconstructs file and hunk text for 100,000 lines within bounded time and heap growth", () => {
    const lineCount = 100_000;
    const targetHunk = hunk({
      lines: Array.from({ length: lineCount }, (_, index) =>
        line(index % 2 === 0 ? "addition" : "deletion", `line ${index}`),
      ),
      newCount: lineCount / 2,
      oldCount: lineCount / 2,
    });
    const file = diffFile({
      additions: lineCount / 2,
      deletions: lineCount / 2,
      hunks: [targetHunk],
    });
    const heapBefore = process.memoryUsage().heapUsed;
    const fileStart = performance.now();
    const fileText = buildFileCopyText(file);
    const fileDuration = performance.now() - fileStart;
    const heapAfterFile = process.memoryUsage().heapUsed;
    const hunkStart = performance.now();
    const hunkText = buildHunkCopyText(file, targetHunk);
    const hunkDuration = performance.now() - hunkStart;
    const observedHeapGrowth = Math.max(heapAfterFile, process.memoryUsage().heapUsed) - heapBefore;

    expect(
      fileText?.startsWith("diff --git a/src/file.ts b/src/file.ts\n--- a/src/file.ts\n"),
    ).toBe(true);
    expect(fileText?.endsWith("-line 99999\n")).toBe(true);
    expect(fileText?.endsWith(hunkText ?? "missing")).toBe(true);
    expect(fileDuration).toBeLessThan(5_000);
    expect(hunkDuration).toBeLessThan(5_000);
    expect(observedHeapGrowth).toBeLessThan(128 * 1024 * 1024);
  }, 20_000);
});

const line = (
  kind: "context" | "addition" | "deletion",
  content: string,
  missingNewline = false,
) => ({ content, kind, missingNewline, newLine: 1, oldLine: 1 });

const hunk = (overrides: Partial<PullRequestDiffHunk> = {}): PullRequestDiffHunk => ({
  context: null,
  lines: [line("context", "content")],
  newCount: 3,
  newStart: 1,
  oldCount: 3,
  oldStart: 1,
  ...overrides,
});

const diffFile = (overrides: Partial<PullRequestDiffFile> = {}): PullRequestDiffFile => ({
  additions: 1,
  binary: false,
  deletions: 1,
  hunks: [hunk()],
  newMode: "100644",
  newPath: "src/file.ts",
  oldMode: "100644",
  oldPath: "src/file.ts",
  operation: "modified",
  ...overrides,
});
