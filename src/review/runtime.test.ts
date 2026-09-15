import { describe, expect, it } from "vitest";
import type { PullRequestDiff } from "../diff/layout";
import type { CommandRequest, ReviewView } from "./generated/review_wasm";
import type { Document, Engine } from "./engine";
import { createReviewRuntime } from "./runtime";
import type { ReviewState } from "./runtime";
import type { ReviewStorage, StoredReview } from "./storage";

// This fake tests lifecycle/IO scheduling only. Real Loro semantics run in Rust and Chromium.
class TestDocument implements Document {
  readonly flags: Record<string, { reviewed: boolean; collapsed: boolean }>;
  constructor(flags: TestDocument["flags"] = {}) {
    this.flags = flags;
  }
  free() {}
  command({ command }: CommandRequest): Document {
    const flags = structuredClone(this.flags);
    if (command.kind !== "review" && command.kind !== "collapse")
      throw new Error("unsupported test command");
    const state = (flags[command.target.version] ??= { reviewed: false, collapsed: false });
    if (command.kind === "review" && state.reviewed !== command.reviewed)
      state.reviewed = state.collapsed = command.reviewed;
    if (command.kind === "collapse") state.collapsed = command.collapsed;
    return new TestDocument(flags);
  }
  importTrusted(bytes: Uint8Array) {
    return engine.restore(bytes);
  }
  view(version: string): ReviewView {
    return {
      reviewed: false,
      collapsed: false,
      human_importance: "inherit",
      effective_importance: null,
      assessments: [],
      context: [],
      ...this.flags[version],
    };
  }
  snapshot() {
    return new TextEncoder().encode(JSON.stringify(this.flags));
  }
  version() {
    return this.snapshot();
  }
}
const engine: Engine = {
  create: () => new TestDocument(),
  restore: (bytes) =>
    new TestDocument(JSON.parse(new TextDecoder().decode(bytes)) as TestDocument["flags"]),
};

class MemoryStorage implements ReviewStorage {
  value: StoredReview | undefined;
  fail = false;
  closes = 0;
  private tail: Promise<unknown> = Promise.resolve();
  locked<T>(action: Parameters<ReviewStorage["locked"]>[0]): Promise<T> {
    const run = this.tail.then(() =>
      action(
        async () => {
          const cloned = structuredClone(this.value);
          if (cloned) cloned.snapshot = new Uint8Array(cloned.snapshot);
          return cloned;
        },
        async (value) => {
          if (this.fail) throw new Error("Disk full");
          this.value = structuredClone(value);
        },
      ),
    );
    this.tail = run.catch(() => {});
    return run as Promise<T>;
  }
  notify() {}
  close() {
    this.closes++;
  }
}

const diff = (version = "v1"): PullRequestDiff => ({
  syncedAt: "now",
  review: {
    repositoryId: "github:1",
    snapshotId: `snapshot:${version}`,
    fileVersions: [`file:${version}`, "file:other"],
  },
  files: ["main.rs", "other.rs"].map((path) => ({
    additions: 0,
    deletions: 0,
    operation: { kind: "modified", path, modeChange: { kind: "unchanged" } },
    content: { kind: "binary" },
  })),
});
function replica(storage = new MemoryStorage()) {
  const states: ReviewState[] = [];
  const runtime = createReviewRuntime(engine, storage, (state) => states.push(state));
  return { runtime, states, storage, state: () => states.at(-1)! };
}

describe("route-owned local review runtime", () => {
  it("publishes coupled optimistic state, then atomically journals the durable snapshot", async () => {
    const { runtime, state, storage, states } = replica();
    await runtime.select(diff());
    const save = runtime.act(0, "review", true);
    expect(state().phase).toBe("saving");
    await save;
    expect(
      states.some(
        (state) =>
          state.phase === "saving" && state.files[0]?.reviewed && state.files[0]?.collapsed,
      ),
    ).toBe(true);
    expect(state().phase).toBe("ready");
    expect(storage.value?.journal).toHaveLength(1);
    expect(storage.value?.journal[0]?.request.displayed).toEqual({
      snapshot: "snapshot:v1",
      version: "file:v1",
    });
    await runtime.act(0, "collapse", false);
    await runtime.act(0, "review", true);
    expect(state().files[0]).toMatchObject({ reviewed: true, collapsed: false });
    expect(storage.value?.journal).toHaveLength(2);
  });

  it("retains concurrent tab saves without changing active-tab visibility", async () => {
    const first = replica();
    const second = replica(first.storage);
    await first.runtime.select(diff());
    await second.runtime.select(diff());
    await Promise.all([
      first.runtime.act(0, "review", true),
      second.runtime.act(1, "review", true),
    ]);
    await first.runtime.refresh();
    await second.runtime.refresh();
    expect(first.state().files.map((file) => file.reviewed)).toEqual([true, true]);
    expect(second.state().files.map((file) => file.reviewed)).toEqual([true, true]);
    expect(first.state().files.map((file) => file.collapsed)).toEqual([true, false]);
    expect(second.state().files.map((file) => file.collapsed)).toEqual([false, true]);
    const reopened = replica(first.storage);
    await reopened.runtime.select(diff());
    expect(reopened.state().files.map((file) => file.collapsed)).toEqual([true, true]);
    expect(first.storage.value?.journal).toHaveLength(2);
  });

  it("rolls back only a failed candidate, retains accepted work, and keeps retry through remote notifications", async () => {
    const first = replica();
    const second = replica(first.storage);
    await first.runtime.select(diff());
    await second.runtime.select(diff());
    await second.runtime.act(1, "review", true);
    first.storage.fail = true;
    await first.runtime.act(0, "review", true);
    expect(first.state()).toMatchObject({ phase: "error", error: "Disk full" });
    expect(first.state().files.map((file) => file.reviewed)).toEqual([false, true]);
    await first.runtime.refresh();
    expect(first.state().phase).toBe("error");
    first.storage.fail = false;
    await first.runtime.retry();
    expect(first.state().phase).toBe("ready");
    expect(first.state().files.map((file) => file.reviewed)).toEqual([true, true]);
    expect(first.storage.value?.journal).toHaveLength(2);
  });

  it("pins queued actions and retries to the clicked version, never a refreshed file", async () => {
    const { runtime, state, storage } = replica();
    await runtime.select(diff());
    storage.fail = true;
    await runtime.act(0, "review", true);
    storage.fail = false;
    await runtime.select(diff("v2"));
    await runtime.retry();
    expect(state().files[0]).toMatchObject({ reviewed: false, collapsed: false });
    expect(storage.value?.journal[0]?.request.displayed.version).toBe("file:v1");
    await runtime.select(diff());
    expect(state().files[0]).toMatchObject({ reviewed: true, collapsed: true });
  });

  it("explains changed versions but restores explicit unreview without resurrecting an earlier mark", async () => {
    const { runtime, state } = replica();
    await runtime.select(diff());
    await runtime.act(0, "review", true);
    await runtime.select(diff("v2"));
    expect(state().files[0]).toMatchObject({
      reviewed: false,
      collapsed: false,
      invalidated: true,
    });
    await runtime.select(diff());
    await runtime.act(0, "review", false);
    await runtime.select(diff("v2"));
    await runtime.select(diff());
    expect(state().files[0]).toMatchObject({
      reviewed: false,
      collapsed: false,
      invalidated: false,
    });
  });

  it("does not infer review identity from paths when the manifest is incomplete", async () => {
    const { runtime, state } = replica();
    const unavailable = {
      ...diff(),
      review: { repositoryId: "github:1", snapshotId: "snapshot:1", fileVersions: [null, null] },
    };
    await runtime.select(unavailable);
    await runtime.act(0, "review", true);
    expect(state().files.every((file) => !file.available && !file.reviewed)).toBe(true);
  });

  it("preserves an incompatible record for export instead of resetting it", async () => {
    const { runtime, storage, state } = replica();
    await runtime.select(diff());
    const value = { ...storage.value!, format: 99 };
    storage.value = value as unknown as StoredReview;
    await runtime.refresh();
    expect(state().phase).toBe("error");
    expect(storage.value).toBe(value);
    expect(JSON.parse((await runtime.export())!)).toMatchObject({ format: 99 });
  });

  it("reports unreadable materialized data without breaking the queue or destroying the export", async () => {
    class BrokenDocument extends TestDocument {
      override view(): ReviewView {
        throw new Error("Unreadable review value");
      }
    }
    const storage = new MemoryStorage();
    const states: ReviewState[] = [];
    const runtime = createReviewRuntime(
      { ...engine, create: () => new BrokenDocument() },
      storage,
      (state) => states.push(state),
    );
    await runtime.select(diff());
    expect(states.at(-1)).toMatchObject({ phase: "error" });
    expect(await runtime.export()).toBeDefined();
    await runtime.retry();
    expect(states.at(-1)).toMatchObject({ phase: "ready" });
  });

  it("does not publish queued work into an unmounted route", async () => {
    const { runtime, storage, states } = replica();
    await runtime.select(diff());
    const pending = runtime.act(0, "review", true);
    const count = states.length;
    runtime.dispose();
    await pending;
    expect(states).toHaveLength(count);
    expect(storage.closes).toBe(1);
  });
});
