import {
  Virtualizer,
  observeWindowOffset,
  observeWindowRect,
  windowScroll,
} from "@tanstack/virtual-core";
import type { Configuration, Effect, Geometry, Model, Msg, VirtualWindow } from "./diffViewModel";
import type { DiffLayout } from "./layout";
import { DIFF_ROW_HEIGHT, rowHeight, rowKey } from "./layout";
import { searchDiff } from "./search";

export type DiffViewElements = {
  horizontalRail: HTMLDivElement;
  searchInput: HTMLInputElement;
  stickyStack: HTMLDivElement;
  table: HTMLDivElement;
};

type Cancel = () => void;
type Schedule = (task: () => void) => Cancel;
type ViewConfiguration = Configuration & { layout: DiffLayout; geometry: Geometry };

export type RuntimeEnvironment = {
  clipboard: Pick<Clipboard, "writeText"> | undefined;
  createResizeObserver: ((callback: ResizeObserverCallback) => ResizeObserver) | undefined;
  schedule: Schedule;
  afterRender: Schedule;
  window: Window;
};

export type DiffViewRuntime = {
  attach: (elements: DiffViewElements, model: Model) => void;
  dispose: () => void;
  run: (effect: Effect) => void;
};

const browserEnvironment = (): RuntimeEnvironment => ({
  clipboard: navigator.clipboard,
  createResizeObserver:
    typeof ResizeObserver === "undefined" ? undefined : (callback) => new ResizeObserver(callback),
  schedule: (task) => {
    const id = window.setTimeout(task, 0);
    return () => window.clearTimeout(id);
  },
  afterRender: (task) => {
    const id = window.requestAnimationFrame(task);
    return () => window.cancelAnimationFrame(id);
  },
  window,
});

export const createDiffViewRuntime = (
  send: (msg: Msg) => void,
  env: RuntimeEnvironment = browserEnvironment(),
): DiffViewRuntime => {
  let disposed = false;
  let elements: DiffViewElements | null = null;
  let configuration: ViewConfiguration | null = null;
  let virtualizer: ReturnType<typeof createVirtualizer> | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let removeListeners: Cancel | null = null;
  let searchReturnFocus: HTMLElement | null = null;
  const capturedPointers = new Set<number>();
  const searchTask = scheduledTask(env.schedule);
  const revealTask = scheduledTask(env.afterRender);
  const geometryTask = scheduledTask(env.afterRender);

  const current = (identity: Configuration) =>
    !disposed &&
    configuration?.revision === identity.revision &&
    configuration.configuration === identity.configuration;

  const measureGeometry = () => {
    if (elements === null || configuration === null || disposed) return;
    const rect = elements.table.getBoundingClientRect();
    const rail = elements.horizontalRail;
    send({
      kind: "GeometryObserved",
      revision: configuration.revision,
      configuration: configuration.configuration,
      geometry: {
        horizontalMaximum: Math.max(0, rail.scrollWidth - rail.clientWidth),
        horizontalOffset: rail.scrollLeft,
        railLeft: rect.left,
        railWidth: rect.width,
        scrollMargin: rect.top + env.window.scrollY,
        stickyHeight: elements.stickyStack.getBoundingClientRect().height,
      },
    });
  };

  const observeHorizontalOffset = () => {
    if (elements !== null && configuration !== null && !disposed) {
      send({
        kind: "HorizontalOffsetObserved",
        offset: elements.horizontalRail.scrollLeft,
        revision: configuration.revision,
      });
    }
  };

  const releasePointer = (id: number) => {
    if (!capturedPointers.delete(id)) return;
    if (elements?.table.hasPointerCapture?.(id)) elements.table.releasePointerCapture(id);
  };

  const attach: DiffViewRuntime["attach"] = (nextElements, model) => {
    if (disposed || elements !== null) return;
    elements = nextElements;
    configuration = {
      configuration: model.configuration,
      geometry: model.geometry,
      layout: model.layout,
      revision: model.revision,
    };
    virtualizer = createVirtualizer(env.window, configuration, (snapshot, identity) => {
      if (current(identity)) send({ ...snapshot, ...identity, kind: "VirtualWindowChanged" });
    });

    const sourceTarget = (target: EventTarget | null) =>
      target instanceof Element &&
      elements?.table.contains(target) &&
      target.closest("[data-diff-source]") !== null;
    const handleWheel = (event: WheelEvent) => {
      if (elements === null) return;
      if (!sourceTarget(event.target) || event.ctrlKey) {
        send({ kind: "ViewportInteraction" });
        return;
      }
      const rawDelta =
        Math.abs(event.deltaX) >= Math.abs(event.deltaY)
          ? event.deltaX
          : event.shiftKey
            ? event.deltaY
            : 0;
      const unit =
        event.deltaMode === 1
          ? DIFF_ROW_HEIGHT.source
          : event.deltaMode === 2
            ? elements.horizontalRail.clientWidth
            : 1;
      const before = elements.horizontalRail.scrollLeft;
      send({ kind: "HorizontalMoveRequested", delta: rawDelta * unit });
      if (before !== elements.horizontalRail.scrollLeft) event.preventDefault();
    };
    const handlePointerDown = (event: PointerEvent) => {
      send({ kind: "ViewportInteraction" });
      if (
        sourceTarget(event.target) &&
        (event.pointerType === "touch" || event.pointerType === "pen")
      ) {
        send({ kind: "PointerStarted", id: event.pointerId, x: event.clientX });
      }
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (elements === null) return;
      const before = elements.horizontalRail.scrollLeft;
      send({ kind: "PointerMoved", id: event.pointerId, x: event.clientX });
      if (before !== elements.horizontalRail.scrollLeft) event.preventDefault();
    };
    const handlePointerEnd = (event: PointerEvent) =>
      send({ kind: "PointerEnded", id: event.pointerId });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (elements === null || event.isComposing || event.defaultPrevented) return;
      const isFindShortcut =
        event.metaKey !== event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f";
      if (isFindShortcut) {
        event.preventDefault();
        send({ kind: "FindRequested" });
      } else if (event.target === elements.searchInput && event.key === "Escape") {
        event.preventDefault();
        send({ kind: "SearchDismissRequested" });
      } else if (event.target === elements.searchInput && event.key === "Enter") {
        event.preventDefault();
        send({ direction: event.shiftKey ? -1 : 1, kind: "SearchMoveRequested" });
      } else if (
        [
          "ArrowDown",
          "ArrowUp",
          "ArrowLeft",
          "ArrowRight",
          "PageDown",
          "PageUp",
          "Home",
          "End",
          " ",
        ].includes(event.key) &&
        !(
          event.target instanceof Element &&
          event.target.closest("input, textarea, select, [contenteditable='true']")
        )
      ) {
        send({ kind: "ViewportInteraction" });
      }
    };

    const rail = elements.horizontalRail;
    rail.addEventListener("scroll", observeHorizontalOffset);
    env.window.addEventListener("wheel", handleWheel, { passive: false });
    env.window.addEventListener("pointerdown", handlePointerDown);
    env.window.addEventListener("pointermove", handlePointerMove, { passive: false });
    env.window.addEventListener("pointerup", handlePointerEnd);
    env.window.addEventListener("pointercancel", handlePointerEnd);
    env.window.addEventListener("lostpointercapture", handlePointerEnd);
    env.window.addEventListener("resize", measureGeometry);
    env.window.addEventListener("keydown", handleKeyDown);
    removeListeners = () => {
      rail.removeEventListener("scroll", observeHorizontalOffset);
      env.window.removeEventListener("wheel", handleWheel);
      env.window.removeEventListener("pointerdown", handlePointerDown);
      env.window.removeEventListener("pointermove", handlePointerMove);
      env.window.removeEventListener("pointerup", handlePointerEnd);
      env.window.removeEventListener("pointercancel", handlePointerEnd);
      env.window.removeEventListener("lostpointercapture", handlePointerEnd);
      env.window.removeEventListener("resize", measureGeometry);
      env.window.removeEventListener("keydown", handleKeyDown);
    };
    resizeObserver = env.createResizeObserver?.(measureGeometry) ?? null;
    for (const element of new Set([
      elements.table.parentElement,
      elements.table.closest("[data-pr-diff-content]"),
      elements.table.closest("[data-pr-view]"),
      elements.stickyStack,
      rail,
    ])) {
      if (element !== null) resizeObserver?.observe(element);
    }
    measureGeometry();
  };

  const run = (effect: Effect) => {
    if (disposed) return;
    switch (effect.kind) {
      case "CancelReveal":
        revealTask.cancel();
        return;
      case "CancelSearch":
        searchTask.cancel();
        return;
      case "ConfigureVirtualizer":
        configuration = effect;
        virtualizer?.configure(effect);
        return;
      case "MeasureGeometry":
        geometryTask.run(() => {
          if (current(effect)) measureGeometry();
        });
        return;
      case "ScrollToRow":
        virtualizer?.scrollToIndex(effect.rowIndex, effect.align);
        return;
      case "SetHorizontalOffset":
        if (elements !== null) {
          elements.horizontalRail.scrollLeft = effect.offset;
          observeHorizontalOffset();
        }
        return;
      case "CapturePointer":
        if (elements !== null) {
          elements.table.setPointerCapture?.(effect.id);
          capturedPointers.add(effect.id);
        }
        return;
      case "ReleasePointer":
        releasePointer(effect.id);
        return;
      case "Search":
        searchTask.run(() => {
          if (!disposed)
            send({
              kind: "SearchCompleted",
              revision: effect.revision,
              requestId: effect.requestId,
              results: searchDiff(effect.layout, effect.query),
            });
        });
        return;
      case "WriteClipboard": {
        const finished = (ok: boolean) => {
          if (!disposed)
            send({
              kind: "ClipboardWriteFinished",
              ok,
              requestId: effect.requestId,
              revision: effect.revision,
            });
        };
        try {
          if (env.clipboard === undefined) finished(false);
          else
            void env.clipboard.writeText(effect.text).then(
              () => finished(true),
              () => finished(false),
            );
        } catch {
          finished(false);
        }
        return;
      }
      case "FocusSearch":
        if (elements === null) return;
        if (
          env.window.document.activeElement instanceof HTMLElement &&
          env.window.document.activeElement !== elements.searchInput
        )
          searchReturnFocus = env.window.document.activeElement;
        elements.searchInput.focus();
        elements.searchInput.select();
        return;
      case "RestoreSearchFocus": {
        if (elements === null) return;
        const returnFocus = searchReturnFocus;
        searchReturnFocus = null;
        if (returnFocus?.isConnected) returnFocus.focus();
        else elements.searchInput.blur();
        return;
      }
      case "MeasureMatch": {
        const target = effect.target;
        revealTask.run((isCurrent) => {
          if (disposed || elements === null || configuration?.revision !== target.revision) return;
          measureGeometry();
          if (!isCurrent()) return;
          const match = elements.table.querySelector<HTMLElement>(
            `[data-diff-row="${target.rowIndex}"] mark[data-match-offset="${target.offset}"][data-match-length="${target.length}"]`,
          );
          const source = match?.closest<HTMLElement>("[data-diff-source]");
          const matchRect = match?.getBoundingClientRect();
          const sourceRect = source?.getBoundingClientRect();
          send({
            kind: "MatchMeasured",
            id: target.id,
            revision: target.revision,
            bounds:
              matchRect === undefined || sourceRect === undefined
                ? null
                : {
                    left: matchRect.left,
                    right: matchRect.right,
                    viewportLeft: sourceRect.left,
                    viewportRight: sourceRect.right,
                    horizontalOffset: elements.horizontalRail.scrollLeft,
                  },
          });
        });
        return;
      }
    }
  };

  return {
    attach,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      searchTask.cancel();
      revealTask.cancel();
      geometryTask.cancel();
      removeListeners?.();
      resizeObserver?.disconnect();
      virtualizer?.dispose();
      for (const id of capturedPointers) releasePointer(id);
      elements = null;
      configuration = null;
      virtualizer = null;
      resizeObserver = null;
      removeListeners = null;
      searchReturnFocus = null;
    },
    run,
  };
};

const scheduledTask = (schedule: Schedule) => {
  let version = 0;
  let cleanup: Cancel | undefined;
  const cancel = () => {
    version += 1;
    cleanup?.();
    cleanup = undefined;
  };
  return {
    cancel,
    run: (task: (isCurrent: () => boolean) => void) => {
      cancel();
      const scheduledVersion = version;
      const isCurrent = () => scheduledVersion === version;
      cleanup = schedule(() => {
        if (!isCurrent()) return;
        cleanup = undefined;
        task(isCurrent);
      });
    },
  };
};

const createVirtualizer = (
  target: Window,
  initial: ViewConfiguration,
  onChange: (
    snapshot: VirtualWindow & { firstVisibleRowIndex: number | null },
    identity: Configuration,
  ) => void,
) => {
  let configuration = initial;
  let disposed = false;
  const options = () => ({
    count: configuration.layout.rowCount,
    estimateSize: (index: number) => rowHeight(configuration.layout, index),
    getItemKey: (index: number) => rowKey(configuration.layout, index),
    getScrollElement: () => target,
    initialOffset: () => target.scrollY,
    observeElementOffset: observeWindowOffset,
    observeElementRect: observeWindowRect,
    onChange: (instance: Virtualizer<Window, HTMLDivElement>) => publish(instance),
    overscan: 20,
    scrollMargin: configuration.geometry.scrollMargin,
    scrollPaddingStart: configuration.geometry.stickyHeight,
    scrollToFn: windowScroll,
  });
  const virtualizer = new Virtualizer<Window, HTMLDivElement>(options());
  function publish(instance: Virtualizer<Window, HTMLDivElement>) {
    if (disposed) return;
    const { geometry, revision, configuration: generation } = configuration;
    onChange(
      {
        firstVisibleRowIndex:
          instance.getVirtualItemForOffset(
            Math.max(geometry.scrollMargin, target.scrollY + geometry.stickyHeight),
          )?.index ?? null,
        rows: instance.getVirtualItems().map((item) => ({
          index: item.index,
          key: String(item.key),
          size: item.size,
          start: item.start,
        })),
        totalSize: instance.getTotalSize(),
      },
      { revision, configuration: generation },
    );
  }
  // virtual-core exposes these lifecycle hooks with internal names; keep them here.
  const cleanup = virtualizer._didMount();
  virtualizer._willUpdate();
  publish(virtualizer);
  return {
    configure: (next: ViewConfiguration) => {
      const layoutChanged = configuration.layout !== next.layout;
      configuration = next;
      virtualizer.setOptions(options());
      if (layoutChanged) virtualizer.measure();
      virtualizer._willUpdate();
      publish(virtualizer);
    },
    dispose: () => {
      disposed = true;
      cleanup();
    },
    scrollToIndex: (index: number, align: "center" | "start") => {
      const offset = virtualizer.getOffsetForIndex(index, align)?.[0];
      // Fixed-height rows need one scroll, not virtual-core's retrying navigation loop.
      if (offset !== undefined) target.scrollTo({ behavior: "auto", top: offset });
    },
  };
};
