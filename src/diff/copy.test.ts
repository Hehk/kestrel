import { describe, expect, it } from "vitest";
import { buildFileCopyText, buildHunkCopyText } from "./copy";
import type { PullRequestDiffFile, PullRequestDiffHunk, PullRequestDiffLine } from "./layout";

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
      operation: {
        kind: "modified",
        modeChange: { kind: "changed", newMode: "100755", oldMode: "100644" },
        path: "src/file.ts",
      },
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
          operation: {
            kind: "renamed",
            modeChange: { kind: "changed", newMode: "100755", oldMode: "100644" },
            newPath: "scripts/new.sh",
            oldPath: "scripts/old.sh",
          },
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
          operation: { kind: "added", mode: "100644", path: "new.txt" },
        }),
      ),
    ).toBe("diff --git a/new.txt b/new.txt\nnew file mode 100644\n");
    expect(
      buildFileCopyText(
        diffFile({
          hunks: [],
          operation: { kind: "deleted", mode: "100644", path: "old.txt" },
        }),
      ),
    ).toBe("diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n");
    expect(
      buildFileCopyText(
        diffFile({
          hunks: [],
          operation: {
            kind: "copied",
            modeChange: { kind: "unchanged" },
            newPath: "copy.txt",
            oldPath: "source.txt",
          },
        }),
      ),
    ).toBe("diff --git a/source.txt b/copy.txt\ncopy from source.txt\ncopy to copy.txt\n");
  });

  it("quotes decoded control-heavy paths deterministically", () => {
    const path = 'quote"-backslash\\-tab\t.txt';
    const file = diffFile({
      operation: { kind: "modified", modeChange: { kind: "unchanged" }, path },
    });

    expect(buildFileCopyText(file)).toMatch(
      /^diff --git "a\/quote\\"-backslash\\\\-tab\\t\.txt" "b\/quote.*\n--- "a\/quote/,
    );
  });

  it("uses Git C-style escapes for control-heavy paths", () => {
    const path = 'control\u0001\u0007\b\t\n\v\f\r\u001b\u007f"\\-cafe.txt';
    const file = diffFile({
      operation: { kind: "modified", modeChange: { kind: "unchanged" }, path },
    });

    expect(buildFileCopyText(file)).toContain(
      '"a/control\\001\\a\\b\\t\\n\\v\\f\\r\\033\\177\\"\\\\-cafe.txt"',
    );
  });

  it("makes binary copy behavior explicitly unavailable", () => {
    const file = diffFile({ binary: true });
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
): PullRequestDiffLine => {
  switch (kind) {
    case "context":
      return { content, kind, missingNewline, newLine: 1, oldLine: 1 };
    case "addition":
      return { content, kind, missingNewline, newLine: 1 };
    case "deletion":
      return { content, kind, missingNewline, oldLine: 1 };
  }
};

const hunk = (overrides: Partial<PullRequestDiffHunk> = {}): PullRequestDiffHunk => ({
  context: null,
  lines: [line("context", "content")],
  newCount: 3,
  newStart: 1,
  oldCount: 3,
  oldStart: 1,
  ...overrides,
});

type DiffFileOverrides = Omit<Partial<PullRequestDiffFile>, "content"> & {
  binary?: boolean;
  hunks?: PullRequestDiffHunk[];
};

const diffFile = (overrides: DiffFileOverrides = {}): PullRequestDiffFile => {
  const { binary = false, hunks = [hunk()], ...fields } = overrides;
  return {
    additions: 1,
    content: binary ? { kind: "binary" } : { hunks, kind: "text" },
    deletions: 1,
    operation: { kind: "modified", modeChange: { kind: "unchanged" }, path: "src/file.ts" },
    ...fields,
  };
};
