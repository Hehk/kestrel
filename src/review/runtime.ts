import { diffFilePaths } from "../diff/layout";
import type { PullRequestDiff } from "../diff/layout";
import type { CommandRequest } from "./generated/review_wasm";
import type { Document, Engine } from "./engine";
import type { ReviewStorage, StoredReview } from "./storage";
import { exportStoredReview } from "./storage";

export type FileReview = {
  reviewed: boolean;
  collapsed: boolean;
  invalidated: boolean;
  available: boolean;
};
export type ReviewState = {
  phase: "loading" | "ready" | "saving" | "error";
  files: FileReview[];
  pending: number;
  error: string | null;
};
const empty = (): FileReview => ({
  reviewed: false,
  collapsed: false,
  invalidated: false,
  available: false,
});

export function createReviewRuntime(
  engine: Engine,
  storage: ReviewStorage,
  publish: (state: ReviewState) => void,
) {
  let document: Document | undefined;
  let current: PullRequestDiff | undefined;
  let record: StoredReview | undefined;
  let disposed = false;
  let tail = Promise.resolve();
  let pendingActions = 0;
  let failure: { task: () => Promise<void>; action: boolean; message: string } | undefined;
  const visibility = new Map<string, boolean>();

  function view(phase: ReviewState["phase"], error: string | null = null) {
    if (disposed) return;
    if (phase === "ready" && failure) {
      phase = "error";
      error = failure.message;
    }
    let files: FileReview[];
    try {
      files = (current?.files ?? []).map((_, index) => {
        const version = current?.review?.fileVersions[index];
        if (!version || !document) return empty();
        const state = document.view(version);
        return {
          reviewed: state.reviewed,
          collapsed: visibility.get(version) ?? state.collapsed,
          invalidated: record?.invalidated[version] === true && !state.reviewed,
          available: true,
        };
      });
    } catch {
      files = (current?.files ?? []).map(empty);
      phase = "error";
      error = "The saved review cannot be read. Export it for recovery; it has not been reset.";
    }
    publish({
      phase: phase === "ready" && pendingActions > 0 ? "saving" : phase,
      files,
      pending: record?.journal.length ?? 0,
      error,
    });
  }

  function queue(task: () => Promise<void>, action = false) {
    if (action) {
      pendingActions++;
      view("saving");
    }
    const run = async () => {
      if (disposed) {
        if (action) pendingActions--;
        return;
      }
      try {
        await task();
        if (failure?.task === task) failure = undefined;
      } catch (error) {
        failure = {
          task,
          action,
          message: error instanceof Error ? error.message : "Review storage could not be saved.",
        };
      } finally {
        if (action) pendingActions--;
      }
      view("ready");
    };
    tail = tail.then(run);
    return tail;
  }

  function readRecord(value: StoredReview | undefined) {
    if (
      value &&
      (value.format !== 1 ||
        !(value.snapshot instanceof Uint8Array) ||
        !Array.isArray(value.journal) ||
        !value.seen ||
        !value.paths ||
        !value.invalidated)
    ) {
      throw new Error(
        "Review storage needs a compatible application version. Export it before upgrading; it has not been reset.",
      );
    }
    const next = value
      ? (document?.importTrusted(value.snapshot) ?? engine.restore(value.snapshot))
      : engine.create();
    document?.free();
    document = next;
    record = value ?? {
      format: 1,
      snapshot: next.snapshot(),
      journal: [],
      seen: {},
      paths: {},
      invalidated: {},
    };
    return record;
  }

  function initializeVisibility() {
    const versions = new Set(
      current?.review?.fileVersions.filter((version): version is string => !!version),
    );
    for (const version of visibility.keys()) if (!versions.has(version)) visibility.delete(version);
    for (const version of versions) {
      if (!visibility.has(version) && document)
        visibility.set(version, document.view(version).collapsed);
    }
  }

  const refresh = () =>
    queue(async () => {
      await storage.locked(async (read) => {
        readRecord(await read());
        initializeVisibility();
      });
      view("ready");
    });

  return {
    refresh,
    select(diff: PullRequestDiff) {
      current = diff;
      // Projection is by exact version, never by the old file index or path.
      view("loading");
      return queue(async () => {
        await storage.locked(async (read, write) => {
          const previous = await read();
          const saved = readRecord(previous);
          const seen = { ...saved.seen };
          const paths = { ...saved.paths };
          const invalidated = { ...saved.invalidated };
          diff.files.forEach((file, index) => {
            const version = diff.review?.fileVersions[index];
            if (!version) return;
            const key = JSON.stringify(diffFilePaths(file));
            const predecessor = paths[key];
            if (
              !seen[version] &&
              predecessor &&
              predecessor !== version &&
              document?.view(predecessor).reviewed
            )
              invalidated[version] = true;
            seen[version] = true;
            paths[key] = version;
          });
          const next = { ...saved, seen, paths, invalidated };
          await write(next);
          record = next;
          initializeVisibility();
        });
        view("ready");
      });
    },
    act(index: number, kind: "review" | "collapse", value: boolean) {
      const version = current?.review?.fileVersions[index];
      const snapshot = current?.review?.snapshotId;
      if (!version || !snapshot) return Promise.resolve();
      const target = { snapshot, version };
      const id = crypto.randomUUID();
      const request: CommandRequest = {
        actor: { kind: "human" },
        displayed: target,
        command:
          kind === "review"
            ? { kind, target, reviewed: value }
            : { kind, target, collapsed: value },
      };
      return queue(async () => {
        await storage.locked(async (read, write) => {
          const saved = readRecord(await read());
          const before = document!;
          const previous = before.view(version);
          if (kind === "review" && previous.reviewed === value) {
            view("ready");
            return;
          }
          const candidate = before.command(request);
          const priorVisibility = visibility.get(version);
          const after = candidate.view(version);
          visibility.set(version, after.collapsed);
          document = candidate;
          view("saving");
          try {
            const next: StoredReview = {
              ...saved,
              snapshot: candidate.snapshot(),
              journal: [
                ...saved.journal,
                {
                  id,
                  request,
                  before: before.version(),
                  after: candidate.version(),
                },
              ],
              invalidated: { ...saved.invalidated },
            };
            if (kind === "review") delete next.invalidated[version];
            await write(next);
            record = next;
            before.free();
          } catch (error) {
            candidate.free();
            document = before;
            if (priorVisibility === undefined) visibility.delete(version);
            else visibility.set(version, priorVisibility);
            throw error;
          }
        });
        storage.notify();
        view("ready");
      }, true);
    },
    retry: () => (failure ? queue(failure.task, failure.action) : refresh()),
    export: () => exportStoredReview(storage),
    dispose() {
      if (disposed) return;
      disposed = true;
      void tail.finally(() => {
        document?.free();
        document = undefined;
        storage.close();
      });
    },
  };
}

export type ReviewRuntime = ReturnType<typeof createReviewRuntime>;
