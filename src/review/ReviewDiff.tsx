import * as stylex from "@stylexjs/stylex";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { Button } from "../components/Button";
import { readCachedUser } from "../cache";
import { DiffView } from "../diff/DiffView";
import type { PullRequestDiff } from "../diff/layout";
import { styles } from "../styles/base";
import { loadReviewEngine } from "./engine";
import { createReviewRuntime } from "./runtime";
import type { ReviewRuntime, ReviewState } from "./runtime";
import { exportStoredReview, openReviewStorage } from "./storage";
import type { ReviewStorage, Scope } from "./storage";

export function ReviewDiff(props: { diff: PullRequestDiff; scope: Scope }) {
  const scope = untrack(() => props.scope);
  const [accountChanged, setAccountChanged] = createSignal(false);
  const [state, setState] = createSignal<ReviewState>({
    phase: "loading",
    files: [],
    pending: 0,
    error: null,
  });
  const [exportError, setExportError] = createSignal<string>();
  let runtime: ReviewRuntime | undefined;
  let storage: ReviewStorage | undefined;
  let disposed = false;
  let starting = false;
  const checkAccount = () => {
    if (readCachedUser()?.id === scope.account) return true;
    disposed = true;
    if (runtime) runtime.dispose();
    else storage?.close();
    runtime = undefined;
    storage = undefined;
    setAccountChanged(true);
    return false;
  };
  const start = async () => {
    if (starting || disposed || !checkAccount()) return;
    starting = true;
    try {
      storage ??= openReviewStorage(scope, refresh);
      const engine = await loadReviewEngine();
      if (disposed || !checkAccount()) return;
      runtime = createReviewRuntime(engine, storage, setState);
      await runtime.select(untrack(() => props.diff));
    } catch (error) {
      if (!disposed)
        setState({
          phase: "error",
          files: [],
          pending: 0,
          error: error instanceof Error ? error.message : "Review could not be loaded.",
        });
    } finally {
      starting = false;
    }
  };
  const refresh = () => {
    if (checkAccount()) void runtime?.refresh();
  };
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (state().phase === "saving") event.preventDefault();
  };
  onMount(() => {
    void start();
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", checkAccount);
    window.addEventListener("beforeunload", beforeUnload);
  });
  createEffect(() => {
    const diff = props.diff;
    void runtime?.select(diff);
  });
  onCleanup(() => {
    disposed = true;
    if (runtime) runtime.dispose();
    else storage?.close();
    window.removeEventListener("focus", refresh);
    window.removeEventListener("storage", checkAccount);
    window.removeEventListener("beforeunload", beforeUnload);
  });

  const act = (index: number, kind: "review" | "collapse", value: boolean) => {
    if (!checkAccount()) return;
    void navigator.storage?.persist?.().catch(() => {});
    void runtime?.act(index, kind, value);
  };
  const review = createMemo(() => ({
    files: state().files,
    disabled: state().phase !== "ready",
    review: (index: number, value: boolean) => act(index, "review", value),
    collapse: (index: number, value: boolean) => act(index, "collapse", value),
  }));
  const exportReview = async () => {
    try {
      if (!storage) throw new Error("Local storage is unavailable for export.");
      const data = await exportStoredReview(storage);
      if (!checkAccount()) return;
      if (!data) throw new Error("No saved review is available to export.");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify({ scope, review: JSON.parse(data) })], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `kestrel-review-${scope.number}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setExportError(undefined);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Export failed.");
    }
  };
  return (
    <Show
      when={!accountChanged()}
      fallback={
        <p role="alert">
          Your account changed in another tab.{" "}
          <Button type="button" onClick={() => window.location.reload()}>
            Reload account
          </Button>{" "}
          to continue reviewing.
        </p>
      }
    >
      <p role="status" aria-live="polite" {...stylex.attrs(styles.statusText)}>
        {state().phase === "loading"
          ? "Loading local review…"
          : state().phase === "saving"
            ? "Saving review locally…"
            : state().phase === "error"
              ? "Local review needs attention."
              : "Review saved on this device only."}{" "}
        {state().files.filter((file) => file.reviewed).length} reviewed. {state().pending} local
        actions; server sync is not enabled.
      </p>
      <p {...stylex.attrs(styles.statusText)}>
        Review is not sent to GitHub. Clearing browser data removes local work; export a backup
        before doing so. Signing out hides your work without deleting it.
      </p>
      <Show when={state().error}>
        <p role="alert">
          {state().error}{" "}
          <Button
            type="button"
            onClick={() => {
              if (runtime) void runtime.retry();
              else void start();
            }}
          >
            Retry local review
          </Button>
        </p>
      </Show>
      <Show when={props.diff.review?.fileVersions.some((version) => !version)}>
        <p {...stylex.attrs(styles.statusText)}>
          Some files lack a trustworthy Git identity and cannot be marked reviewed.
        </p>
      </Show>
      <Button
        type="button"
        disabled={state().phase === "loading" || state().phase === "saving"}
        onClick={() => void exportReview()}
      >
        Export local review
      </Button>
      <Show when={exportError()}>
        <p role="alert">{exportError()}</p>
      </Show>
      <DiffView diff={props.diff} review={review()} />
    </Show>
  );
}
