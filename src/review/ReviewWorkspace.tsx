import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
  useContext,
} from "solid-js";
import type { ParentProps } from "solid-js";
import type { components } from "../api/schema";
import { Button } from "../components/Button";
import { Anchor } from "../components/Anchor";
import { apiUrl } from "../api/client";
import { Tooltip } from "../components/Tooltip";
import { tokens } from "../styles/tokens.stylex";
import { createReviewRuntime, type ReviewRuntime } from "./runtime";
import { deleteAccountStorage } from "./storage";
import { cachedDiff, offlineCacheWarning, setOfflineAccount } from "./offline";

type Manifest = components["schemas"]["ReviewSnapshot"];
const Context = createContext<{ runtime: ReviewRuntime; manifest: () => Manifest }>();
export const useReview = () => useContext(Context);
const styles = stylex.create({
  panel: {
    display: "grid",
    gap: "0.5rem",
    paddingBlock: "0.75rem",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.rule,
  },
  row: { display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" },
  controls: { display: "flex", alignItems: "center", gap: "0.6rem", flexShrink: 0 },
  label: { display: "inline-flex", alignItems: "center", gap: "0.25rem", whiteSpace: "nowrap" },
  tooltip: {
    padding: "0.6rem",
    color: tokens.text,
    backgroundColor: tokens.background,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.rule,
    maxWidth: "24rem",
    whiteSpace: "normal",
  },
  note: { margin: 0, fontSize: tokens.fontSizeSmall, color: tokens.textMuted },
  context: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
});

export function ReviewWorkspace(
  props: ParentProps<{ manifest: Manifest; user: string; number: number }>,
) {
  const runtime = createReviewRuntime(props.user, props.manifest.repositoryId, props.number);
  const [selected, setSelected] = createSignal(0);
  const [storage, setStorage] = createSignal(
    "Browser storage may be evicted. Export pending work before clearing site data.",
  );
  createEffect(() => {
    const snapshot = props.manifest;
    untrack(() => runtime.setSnapshot(snapshot));
  });
  onCleanup(runtime.dispose);
  const file = () => props.manifest.files[selected()];
  const view = () => runtime.views()[file()?.id ?? ""];
  return (
    <Context.Provider value={{ runtime, manifest: () => props.manifest }}>
      <section aria-label="Personal review workspace" {...stylex.attrs(styles.panel)}>
        <div {...stylex.attrs(styles.row)}>
          <strong role="status" aria-live="polite">
            {runtime.status()}
          </strong>
          <Button size="compact" onClick={runtime.retry}>
            Retry sync
          </Button>
          <Show when={runtime.status().includes("Session expired")}>
            <Anchor href={apiUrl("/api/auth/github/start")}>Sign in again</Anchor>
          </Show>
          <Button size="compact" onClick={() => void runtime.export()}>
            Export review
          </Button>
          <Show when={runtime.blocked()}>
            <Button
              size="compact"
              onClick={() => {
                if (
                  confirm(
                    "Archive this local branch and replay its pending human commands onto the server workspace? Export first to keep a separate backup.",
                  )
                )
                  void runtime.recover();
              }}
            >
              Recover review
            </Button>
          </Show>
        </div>
        <Show when={cachedDiff()}>
          <p {...stylex.attrs(styles.note)}>
            Showing a cached diff. Review targets this saved snapshot; refresh explicitly when
            connected to see newer changes.
          </p>
        </Show>
        <Show when={offlineCacheWarning()}>{(warning) => <p role="alert">{warning()}</p>}</Show>
        <details>
          <summary>Offline storage and recovery</summary>
          <p {...stylex.attrs(styles.note)}>{storage()}</p>
          <p {...stylex.attrs(styles.note)}>
            Previously opened snapshots stay on this device after sign out, isolated by account.
            Offline access cannot detect revoked GitHub permissions. Review changes do not update
            GitHub approvals or viewed files.
          </p>
          <div {...stylex.attrs(styles.row)}>
            <Button
              size="compact"
              onClick={() =>
                void navigator.storage
                  ?.persist?.()
                  .then((persisted) =>
                    setStorage(
                      persisted
                        ? "Persistent storage granted. Keep exports as backups."
                        : "Persistent storage was not granted. The browser may evict this cache.",
                    ),
                  )
                  .catch(() =>
                    setStorage(
                      "Persistent storage is unavailable. Export backups of pending work.",
                    ),
                  )
              }
            >
              Keep offline storage
            </Button>
            <Button
              size="compact"
              onClick={() => {
                if (
                  !confirm(
                    "Delete ALL offline snapshots, local review branches and pending edits for this account on this device? Export pending work first. Server-saved review remains, and already submitted changes may still finish saving.",
                  )
                )
                  return;
                runtime.dispose(true);
                setOfflineAccount(null);
                void deleteAccountStorage(props.user)
                  .then(() => location.assign("/"))
                  .catch(() => setStorage("Could not delete local data. Reload before retrying."));
              }}
            >
              Forget account’s offline data
            </Button>
          </div>
        </details>
        <Show when={import.meta.env["VITE_REVIEW_AGENT_EXPERIMENT"] === "true"}>
          <details>
            <summary>Importance and agent context</summary>
            <div {...stylex.attrs(styles.row)}>
              <select
                aria-label="Assessment file"
                value={selected()}
                onChange={(e) => setSelected(Number(e.currentTarget.value))}
              >
                <For each={props.manifest.files}>
                  {(file, index) => <option value={index()}>{file.path}</option>}
                </For>
              </select>
              <label>
                Human importance{" "}
                <select
                  aria-label="Human importance"
                  disabled={!runtime.ready()}
                  value={view()?.humanImportance ?? "inherit"}
                  onChange={(e) => {
                    const version = file()?.id;
                    const value = e.currentTarget.value;
                    if (
                      version &&
                      (value === "inherit" || value === "important" || value === "unimportant")
                    )
                      void runtime.apply({ kind: "importance", version, value });
                  }}
                >
                  <option value="inherit">Use agent assessment</option>
                  <option value="important">Important</option>
                  <option value="unimportant">Unimportant</option>
                </select>
              </label>
              <span>Effective: {view()?.effectiveImportance ?? "No single assessment"}</span>
              <Show when={(view()?.importanceAlternatives.length ?? 0) > 1}>
                <Button
                  size="compact"
                  title={`Concurrent decisions: ${view()?.importanceAlternatives.join(", ")}`}
                  onClick={() => {
                    const version = file()?.id;
                    if (version)
                      void runtime.apply({
                        kind: "reassertImportance",
                        version,
                        value: view()?.humanImportance ?? "inherit",
                      });
                  }}
                >
                  Resolve importance conflict
                </Button>
              </Show>
              <Button
                size="compact"
                disabled={!runtime.ready()}
                onClick={() => {
                  const version = file()?.id;
                  if (version) void runtime.demoAgent(version);
                }}
              >
                Run demo Rust agent
              </Button>
            </div>
            <For each={view()?.assessments}>
              {(assessment) => (
                <p {...stylex.attrs(styles.context)}>
                  <strong>{assessment.agent}</strong> ({assessment.run}): {assessment.importance}.{" "}
                  {assessment.context}
                </p>
              )}
            </For>
          </details>
        </Show>
      </section>
      {props.children}
    </Context.Provider>
  );
}

export function ReviewControls(props: { index: number }) {
  const review = useReview();
  const file = () => review?.manifest().files[props.index];
  const view = () => review?.runtime.views()[file()?.id ?? ""];
  const collapsed = () => review?.runtime.collapsed()[file()?.id ?? ""] ?? false;
  const invalidated = () => {
    const version = file();
    return (
      version?.predecessor &&
      !view()?.reviewAlternatives.length &&
      review?.runtime.views()[version.predecessor]?.reviewed
    );
  };
  const explanation = () =>
    !review
      ? "Review is unavailable until an exact snapshot is loaded. Refresh this pull request from GitHub."
      : invalidated()
        ? "Marked unreviewed because this file changed."
        : "Review applies only to this exact file version. Changed versions start unreviewed and open.";
  return (
    <div {...stylex.attrs(styles.controls)}>
      <Show when={review}>
        <Button
          size="compact"
          aria-label={`${collapsed() ? "Expand" : "Collapse"} ${file()?.path ?? "file"}`}
          aria-expanded={!collapsed()}
          disabled={!review?.runtime.ready()}
          onClick={() => {
            const version = file()?.id;
            if (version)
              void review?.runtime.apply({ kind: "collapse", version, value: !collapsed() });
          }}
        >
          {collapsed() ? "Expand" : "Collapse"}
        </Button>
      </Show>
      <Show when={(view()?.reviewAlternatives.length ?? 0) > 1}>
        <Button
          size="compact"
          title={`Concurrent review decisions: ${view()?.reviewAlternatives.join(", ")}`}
          onClick={() => {
            const version = file()?.id;
            if (version)
              void review?.runtime.apply({
                kind: "reassertReview",
                version,
                value: view()?.reviewed ?? false,
              });
          }}
        >
          Resolve conflict
        </Button>
      </Show>
      <Tooltip>
        <label {...stylex.attrs(styles.label)}>
          <Tooltip.Trigger
            as="input"
            type="checkbox"
            aria-label={`Reviewed ${file()?.path ?? "file"}`}
            aria-disabled={!review?.runtime.ready()}
            checked={view()?.reviewed ?? false}
            onChange={(e: Event & { currentTarget: HTMLInputElement }) => {
              const version = file()?.id;
              if (!version || !review?.runtime.ready()) {
                e.currentTarget.checked = view()?.reviewed ?? false;
                return;
              }
              const input = e.currentTarget;
              const value = input.checked;
              void review.runtime.apply({ kind: "review", version, value }).then(() => {
                input.checked = view()?.reviewed ?? false;
              });
            }}
          />{" "}
          Reviewed
        </label>
        <Tooltip.Portal>
          <Tooltip.Content {...stylex.attrs(styles.tooltip)}>{explanation()}</Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip>
    </div>
  );
}
