import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import "../index.css";
import "../App.css";
import { buildFileCopyText, buildHunkCopyText } from "./copy";
import { DiffView } from "./DiffView";
import { buildDiffLayout, rowHeight } from "./layout";
import type { PullRequestDiff } from "./layout";
import { searchDiff } from "./search";

type DurationSummary = { max: number; median: number; p95: number };
type ProfileWindow = Window & {
  __DIFF_PROFILE_ERROR__?: string;
  __DIFF_PROFILE_RESULT__?: unknown;
  gc?: () => void;
  performance: Performance & { memory?: { usedJSHeapSize: number } };
};

const profileWindow = window as ProfileWindow;
const root = document.querySelector<HTMLElement>("#profile-root");
if (root === null) throw new Error("Profile root is missing");

const run = async () => {
  const heapStart = usedHeap();
  const scenarios = [];
  for (const lineCount of [50_000, 100_000]) {
    scenarios.push(await profileScenario(lineCount));
  }
  const longLine = profileLongLine();
  const scroll = await profileScroll(root, 50_000);
  const denseHighlight = await profileDenseHighlight(root);
  const horizontalReach = await profileHorizontalReach(root);
  const retention = await profileRetention(root);
  forceGc();
  invariant(scroll.blankFrames === 0, "Rapid scroll exposed a blank viewport");
  invariant(
    scroll.finalMountedRow === scroll.targetRow,
    "Rapid scroll did not reach the final row",
  );
  invariant(scroll.maxMountedRows < 200, "Rapid scroll mounted too many rows");
  invariant(scroll.frameDurationsMs.p95 < 50, "Rapid scroll exceeded the frame-time budget");
  invariant(denseHighlight.highlightCount === 1_000, "Dense highlights exceeded the row cap");
  invariant(
    denseHighlight.resultStatus === "1 of 2000000+ (results limited)",
    "Dense result cap was not exposed",
  );
  invariant(denseHighlight.elapsedMs < 2_000, "Dense search exceeded the interaction budget");
  invariant(horizontalReach.activeVisible, "Final tab-heavy source column was not revealed");
  invariant(
    (horizontalReach.railScrollWidthCssPixels ?? Number.POSITIVE_INFINITY) < 25_000_000,
    "Horizontal rail approached the browser layout limit",
  );
  const firstLoadedHeap = retention.loadedBytes[0];
  const finalLoadedHeap = retention.loadedBytes.at(-1);
  if (
    firstLoadedHeap !== null &&
    firstLoadedHeap !== undefined &&
    finalLoadedHeap !== null &&
    finalLoadedHeap !== undefined
  ) {
    invariant(finalLoadedHeap < firstLoadedHeap * 1.5, "Sequential Diff heap did not stabilize");
  }
  const result = {
    environment: {
      hardwareConcurrency: navigator.hardwareConcurrency,
      language: navigator.language,
      userAgent: navigator.userAgent,
      viewport: { height: window.innerHeight, width: window.innerWidth },
    },
    denseHighlight,
    heapAfterProfileBytes: usedHeap(),
    heapStartBytes: heapStart,
    horizontalReach,
    longLine,
    retention,
    scenarios,
    scroll,
  };
  return result;
};

const profileDenseHighlight = async (host: HTMLElement) => {
  const diff = generatedDenseDiff();
  const dispose = render(() => <DiffView diff={diff} />, host);
  await animationFrame();
  const input = document.querySelector<HTMLInputElement>(".pr-diff-searchInput");
  if (input === null) throw new Error("Profile search input is missing");
  forceGc();
  const heapBeforeSearch = usedHeap();
  const startedAt = performance.now();
  input.value = "a";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  for (let frame = 0; frame < 120; frame += 1) {
    await animationFrame();
    if (document.querySelector(".pr-diff-searchMatch--active") !== null) break;
  }
  const result = {
    elapsedMs: round(performance.now() - startedAt),
    heapDeltaBytes: observedHeapDelta(heapBeforeSearch, usedHeap()),
    highlightCount: document.querySelectorAll("mark").length,
    resultStatus: document.querySelector(".pr-diff-searchCount")?.textContent ?? null,
  };
  dispose();
  host.replaceChildren();
  await animationFrame();
  forceGc();
  return result;
};

const profileHorizontalReach = async (host: HTMLElement) => {
  const diff = generatedLongLineDiff(512 * 1024);
  const dispose = render(() => <DiffView diff={diff} />, host);
  await animationFrame();
  const input = document.querySelector<HTMLInputElement>(".pr-diff-searchInput");
  if (input === null) throw new Error("Profile search input is missing");
  input.value = "z";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  for (let frame = 0; frame < 120; frame += 1) {
    await animationFrame();
    if (document.querySelector(".pr-diff-searchMatch--active") !== null) break;
  }
  const rail = document.querySelector<HTMLElement>(".pr-diff-horizontalRail");
  const active = document.querySelector<HTMLElement>(".pr-diff-searchMatch--active");
  const source = active?.closest<HTMLElement>(".pr-diff-source");
  const activeRect = active?.getBoundingClientRect();
  const sourceRect = source?.getBoundingClientRect();
  const result = {
    activeVisible:
      activeRect !== undefined &&
      sourceRect !== undefined &&
      activeRect.left >= sourceRect.left &&
      activeRect.right <= sourceRect.right,
    railClientWidthCssPixels: rail?.clientWidth ?? null,
    railScrollLeftCssPixels: rail?.scrollLeft ?? null,
    railScrollWidthCssPixels: rail?.scrollWidth ?? null,
  };
  dispose();
  host.replaceChildren();
  await animationFrame();
  return result;
};

const profileLongLine = () => {
  const sourceBytes = 512 * 1024;
  const diff = generatedLongLineDiff(sourceBytes);
  const layoutBuildMs = measure(() => buildDiffLayout(diff));
  const layout = buildDiffLayout(diff);
  const searchMs = measure(() => searchDiff(layout, "z"));
  const results = searchDiff(layout, "z");
  return {
    layoutBuildMs,
    matches: results.count,
    resultBytes:
      results.rowIndexes.byteLength +
      results.matchOffsets.byteLength +
      results.matchLengths.byteLength,
    searchMs,
    sourceBytes,
    visualColumns: layout.maxSourceColumns,
  };
};

const profileScenario = async (lineCount: number) => {
  const diff = generatedDiff(lineCount);
  const jsonStringifyMs = measure(() => JSON.stringify(diff));
  const json = JSON.stringify(diff);
  const jsonParseMs = measure(() => JSON.parse(json) as PullRequestDiff);
  const layoutBuildMs = measure(() => buildDiffLayout(diff));
  const layout = buildDiffLayout(diff);
  const searchCommonMs = measure(() => searchDiff(layout, "a"));
  const searchRareMs = measure(() => searchDiff(layout, "RARE"));
  const commonResultObservation = observeHeap(() => searchDiff(layout, "a"));
  const commonResults = commonResultObservation.value;
  const rareResults = searchDiff(layout, "RARE");
  const file = diff.files[0];
  const hunk = file?.hunks[0];
  if (file === undefined || hunk === undefined)
    throw new Error("Generated profile Diff is invalid");
  const copyFileMs = measure(() => buildFileCopyText(file));
  const copyHunkMs = measure(() => buildHunkCopyText(file, hunk));
  const fileTextObservation = observeHeap(() => buildFileCopyText(file) as string);
  const fileText = fileTextObservation.value;
  const hunkTextObservation = observeHeap(() => buildHunkCopyText(file, hunk) as string);
  const hunkText = hunkTextObservation.value;
  forceGc();
  const heapBeforeClipboard = usedHeap();
  window.focus();
  invariant(document.hasFocus(), "Profile document does not have clipboard focus");
  const clipboardMs =
    lineCount === 100_000
      ? await measureAsync(() => navigator.clipboard.writeText(fileText), 20)
      : null;
  const clipboardHeapDeltaBytes =
    clipboardMs === null ? null : observedHeapDelta(heapBeforeClipboard, usedHeap());
  let virtualHeight = 0;
  for (let rowIndex = 0; rowIndex < layout.rowCount; rowIndex += 1) {
    virtualHeight += rowHeight(layout, rowIndex);
  }

  return {
    clipboardMs,
    clipboardHeapDeltaBytes,
    commonMatches: commonResults.count,
    commonResultBytes:
      commonResults.rowIndexes.byteLength +
      commonResults.matchOffsets.byteLength +
      commonResults.matchLengths.byteLength,
    commonSearchHeapDeltaBytes: commonResultObservation.heapDeltaBytes,
    copyFileMs,
    copyFileBytes: byteLength(fileText),
    copyFileHeapDeltaBytes: fileTextObservation.heapDeltaBytes,
    copyHunkMs,
    copyHunkBytes: byteLength(hunkText),
    copyHunkHeapDeltaBytes: hunkTextObservation.heapDeltaBytes,
    jsonBytes: byteLength(json),
    layoutBuildMs,
    layoutMetadataBytes: layout.metadataByteLength,
    lineCount,
    jsonParseMs,
    rareMatches: rareResults.count,
    searchRareMs,
    rowCount: layout.rowCount,
    searchCommonMs,
    jsonStringifyMs,
    virtualHeightCssPixels: virtualHeight,
  };
};

const profileScroll = async (host: HTMLElement, lineCount: number) => {
  document.documentElement.style.scrollBehavior = "auto";
  const diff = generatedDiff(lineCount);
  const dispose = render(() => <DiffView diff={diff} />, host);
  await animationFrame();
  await animationFrame();
  const scrollingElement = document.scrollingElement as HTMLElement;
  const maximum = Math.max(0, scrollingElement.scrollHeight - window.innerHeight);
  const frameDurations: number[] = [];
  let blankFrames = 0;
  let maxMountedRows = 0;
  const frameCount = 120;
  for (let frame = 0; frame <= frameCount; frame += 1) {
    const startedAt = performance.now();
    window.scrollTo(0, (maximum * frame) / frameCount);
    await animationFrame();
    frameDurations.push(performance.now() - startedAt);
    const rows = [...document.querySelectorAll<HTMLElement>("[data-diff-row]")];
    maxMountedRows = Math.max(maxMountedRows, rows.length);
    if (!rows.some(rowIntersectsViewport)) blankFrames += 1;
  }
  await animationFrame();
  const mountedIndexes = [...document.querySelectorAll<HTMLElement>("[data-diff-row]")].map((row) =>
    Number(row.dataset["diffRow"]),
  );
  const result = {
    blankFrames,
    finalMountedRow: Math.max(...mountedIndexes),
    frameDurationsMs: summarize(frameDurations),
    maxMountedRows,
    scrollHeightCssPixels: scrollingElement.scrollHeight,
    targetRow: lineCount + 1,
  };
  dispose();
  host.replaceChildren();
  window.scrollTo(0, 0);
  await animationFrame();
  return result;
};

const profileRetention = async (host: HTMLElement) => {
  forceGc();
  const before = usedHeap();
  const loaded: Array<number | null> = [];
  const [diff, setDiff] = createSignal(generatedDiff(100_000, 0));
  const dispose = render(() => <DiffView diff={diff()} />, host);
  for (let index = 0; index < 3; index += 1) {
    if (index > 0) setDiff(generatedDiff(100_000, index));
    await animationFrame();
    await animationFrame();
    forceGc();
    loaded.push(usedHeap());
  }
  dispose();
  host.replaceChildren();
  await animationFrame();
  forceGc();
  return { afterDisposeBytes: usedHeap(), beforeBytes: before, loadedBytes: loaded };
};

const rowIntersectsViewport = (row: HTMLElement): boolean => {
  const rect = row.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight;
};

const generatedDiff = (lineCount: number, suffix = 0): PullRequestDiff => ({
  files: [
    {
      additions: 0,
      binary: false,
      deletions: 0,
      hunks: [
        {
          context: null,
          lines: Array.from({ length: lineCount }, (_, index) => ({
            content: `aaaaaaaaaa${index === 0 || index === Math.floor(lineCount / 2) || index === lineCount - 1 ? " rare" : ""}`,
            kind: "context" as const,
            missingNewline: false,
            newLine: index + 1,
            oldLine: index + 1,
          })),
          newCount: lineCount,
          newStart: 1,
          oldCount: lineCount,
          oldStart: 1,
        },
      ],
      newMode: "100644",
      newPath: `profile-${suffix}.txt`,
      oldMode: "100644",
      oldPath: `profile-${suffix}.txt`,
      operation: "modified",
    },
  ],
  syncedAt: "2026-01-04T00:00:00Z",
});

const generatedLongLineDiff = (sourceBytes: number): PullRequestDiff => {
  const diff = generatedDiff(1);
  const line = diff.files[0]?.hunks[0]?.lines[0];
  if (line === undefined) throw new Error("Generated long-line Diff is invalid");
  line.content = `${"\t".repeat(sourceBytes - 1)}z`;
  return diff;
};

const generatedDenseDiff = (): PullRequestDiff => {
  const diff = generatedDiff(5);
  const lines = diff.files[0]?.hunks[0]?.lines;
  if (lines === undefined) throw new Error("Generated dense Diff is invalid");
  for (const line of lines) line.content = "a".repeat(400_001);
  return diff;
};

const measure = <T,>(operation: () => T, sampleCount = 20): DurationSummary => {
  consume(operation());
  const samples: number[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    forceGc();
    const startedAt = performance.now();
    consume(operation());
    samples.push(performance.now() - startedAt);
  }
  return summarize(samples);
};

const observeHeap = <T,>(operation: () => T) => {
  forceGc();
  const before = usedHeap();
  const value = operation();
  return { heapDeltaBytes: observedHeapDelta(before, usedHeap()), value };
};

const measureAsync = async (
  operation: () => Promise<void>,
  sampleCount: number,
): Promise<DurationSummary> => {
  await operation();
  const samples: number[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const startedAt = performance.now();
    await operation();
    samples.push(performance.now() - startedAt);
  }
  return summarize(samples);
};

let sink = 0;
const consume = (value: unknown) => {
  if (typeof value === "string") sink ^= value.length;
  else if (typeof value === "object" && value !== null) sink ^= Object.keys(value).length;
};

const summarize = (samples: number[]): DurationSummary => {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] as number;
  return {
    max: round(sorted.at(-1) ?? 0),
    median: round(percentile(0.5)),
    p95: round(percentile(0.95)),
  };
};

const round = (value: number): number => Math.round(value * 1_000) / 1_000;
const invariant = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
const byteLength = (value: string): number => new Blob([value]).size;
const animationFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));
const forceGc = () => profileWindow.gc?.();
const usedHeap = (): number | null => profileWindow.performance.memory?.usedJSHeapSize ?? null;
const observedHeapDelta = (before: number | null, after: number | null): number | null =>
  before === null || after === null ? null : Math.max(0, after - before);

run()
  .then((result) => {
    root.textContent = "Profile complete";
    profileWindow.__DIFF_PROFILE_RESULT__ = result;
  })
  .catch((error: unknown) => {
    const message =
      error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    root.textContent = message;
    profileWindow.__DIFF_PROFILE_ERROR__ = message;
  });
