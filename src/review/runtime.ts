import { createSignal } from "solid-js";
import type { components } from "../api/schema";
import type { Command, ReviewReplica, View } from "./generated/review_wasm";
import { changeStored, readArchives, readStored } from "./storage";

type Manifest = components["schemas"]["ReviewSnapshot"];
type Receipt = components["schemas"]["ReviewReceipt"];
type Entry = components["schemas"]["ReviewEntry"];
export type StoredWorkspace = {
  format: 1;
  generation: string;
  document: Uint8Array;
  pending: Entry[];
  revision: number;
  blocked?: string;
};
export type ReviewRuntime = ReturnType<typeof createReviewRuntime>;
class BlockedSync extends Error {}
let wasm: Promise<typeof import("./generated/review_wasm")> | undefined;
const loadWasm = () =>
  (wasm ??= import("./generated/review_wasm")
    .then(async (module) => {
      await module.default();
      return module;
    })
    .catch((error: unknown) => {
      wasm = undefined;
      throw error;
    }));

export function createReviewRuntime(user: string, repository: number, number: number) {
  const key = `${encodeURIComponent(user)}:${repository}:${number}`;
  const endpoint = `/api/review/${repository}/${number}`;
  const [views, setViews] = createSignal<Record<string, View>>({});
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({});
  const [status, setStatus] = createSignal("Loading local review…");
  const [ready, setReady] = createSignal(false);
  const [pending, setPending] = createSignal(0);
  const [blocked, setBlocked] = createSignal(false);
  let manifest: Manifest | undefined;
  let record: StoredWorkspace | undefined;
  let module: Awaited<ReturnType<typeof loadWasm>>;
  let queue = Promise.resolve();
  let stopped = false;
  let discarded = false;
  let saving = 0;
  const requests = new AbortController();
  const protectUnsaved = (event: BeforeUnloadEvent) => {
    if (saving) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  const changeSaving = (delta: number) => {
    saving += delta;
    if (saving) window.addEventListener("beforeunload", protectUnsaved);
    else window.removeEventListener("beforeunload", protectUnsaved);
  };
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let receiptTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let inFlight = false;
  let connected = false;
  let authExpired = false;
  const channel =
    typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(`review:${key}`);
  const accountChannel =
    typeof BroadcastChannel === "undefined"
      ? undefined
      : new BroadcastChannel("kestrel-review-storage");

  const replica = (stored: StoredWorkspace): ReviewReplica => {
    if (stored.format !== 1)
      throw new BlockedSync(
        "Upgrade required. Export this workspace before changing application versions.",
      );
    try {
      return new module.ReviewReplica(stored.document);
    } catch (error) {
      throw new BlockedSync(`Cannot read the saved review schema: ${String(error)}`);
    }
  };
  const publish = (next: StoredWorkspace) => {
    if (stopped) return;
    record = next;
    const doc = replica(next);
    try {
      const versions = [
        ...new Set(
          (manifest?.files ?? []).flatMap((file) =>
            file.predecessor ? [file.id, file.predecessor] : [file.id],
          ),
        ),
      ];
      const projections = doc.views(versions);
      const nextViews = Object.fromEntries(
        versions.map((version, index) => [version, projections[index]!]),
      );
      const local = { ...collapsed() };
      for (const file of manifest?.files ?? []) local[file.id] ??= nextViews[file.id]!.collapsed;
      setViews(nextViews);
      setCollapsed(local);
      setPending(next.pending.length);
      setBlocked(!!next.blocked);
      setReady(true);
      setStatus(
        saving
          ? "Saving locally…"
          : (next.blocked ??
              (authExpired
                ? "Session expired. Sign in again; local edits are preserved."
                : next.pending.length
                  ? `Saved locally · ${next.pending.length} pending`
                  : connected
                    ? "Synchronized"
                    : "Saved locally · offline")),
      );
    } finally {
      doc.free();
    }
  };
  const enqueue = (task: () => Promise<void>, durable = false) => {
    queue = queue
      .then(async () => {
        if (!stopped || (durable && !discarded)) await task();
      })
      .catch(async (error: unknown) => {
        if (stopped) return;
        if (error instanceof BlockedSync && record) {
          const reason = `Sync blocked: ${error.message}. Export or recover this workspace.`;
          record = { ...record, blocked: reason };
          setBlocked(true);
          setStatus(reason);
          socket?.close();
          try {
            const next = await changeStored<StoredWorkspace>("workspaces", key, (current) => {
              if (!current || stopped) throw new Error("Local workspace was cleared or closed.");
              return {
                ...current,
                blocked: reason,
              };
            });
            publish(next);
            notify();
            socket?.close();
            return;
          } catch {
            setStatus(
              `${reason} The original branch is retained; the blocked state could not be published.`,
            );
          }
          return;
        }
        setStatus(`Not saved: ${String(error)}. Retry or export your locally saved work.`);
      });
    return queue;
  };
  const notify = (durable = false) => {
    if (!stopped || durable) channel?.postMessage("changed");
  };

  const receive = async (receipt: Receipt) => {
    if (stopped) return;
    if (receipt.userId !== user || receipt.protocol !== 1)
      throw new BlockedSync("Account or protocol changed. Local work has been preserved");
    const acknowledged = new Set(receipt.acknowledged);
    const next = await changeStored<StoredWorkspace>("workspaces", key, (current) => {
      if (stopped) throw new Error("Review closed before import was saved.");
      if (!current && record) throw new BlockedSync("Local workspace was cleared");
      const base: StoredWorkspace = current ?? {
        format: 1,
        generation: crypto.randomUUID(),
        document: Uint8Array.from(receipt.document),
        pending: [],
        revision: receipt.revision,
      };
      const doc = replica(base);
      try {
        try {
          doc.mergeTrusted(Uint8Array.from(receipt.document));
        } catch (error) {
          throw new BlockedSync(String(error));
        }
        return {
          ...base,
          document: doc.save(),
          revision: Math.max(base.revision, receipt.revision),
          pending: base.pending.filter((entry) => !acknowledged.has(entry.proposal.hash)),
        };
      } finally {
        doc.free();
      }
    });
    publish(next);
    notify();
  };

  const network = (task: (isCurrent: () => boolean) => Promise<void>) => {
    const generation = record?.generation;
    const isCurrent = () => !stopped && record?.generation === generation;
    return task(isCurrent).catch(async (error: unknown) => {
      if (isCurrent())
        await enqueue(async () => {
          throw error;
        });
    });
  };

  const flush = () => {
    if (
      stopped ||
      !record ||
      record.blocked ||
      inFlight ||
      socket?.readyState !== WebSocket.OPEN ||
      !record.pending.length
    )
      return;
    let entries = record.pending.slice(0, 64);
    const encode = () =>
      JSON.stringify({
        protocol: 1,
        userId: user,
        entries,
      } satisfies components["schemas"]["ReviewUpdate"]);
    let payload = encode();
    while (new TextEncoder().encode(payload).byteLength > 128 * 1024) {
      if (entries.length === 1) {
        void enqueue(async () => {
          throw new BlockedSync("A pending command exceeds the protocol size limit");
        });
        return;
      }
      entries = entries.slice(0, Math.floor(entries.length / 2));
      payload = encode();
    }
    inFlight = true;
    const connection = socket;
    clearTimeout(receiptTimer);
    receiptTimer = setTimeout(() => connection.close(), 15000);
    connection.send(payload);
  };
  const connect = () => {
    if (
      stopped ||
      record?.blocked ||
      socket?.readyState === WebSocket.OPEN ||
      socket?.readyState === WebSocket.CONNECTING
    )
      return;
    clearTimeout(timer);
    const url = new URL(`${endpoint}/socket`, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const connection = new WebSocket(url);
    socket = connection;
    setTimeout(() => {
      if (connection.readyState === WebSocket.CONNECTING) connection.close();
    }, 15000);
    connection.onopen = () => {
      connected = true;
      authExpired = false;
      failures = 0;
      inFlight = false;
      flush();
    };
    connection.onmessage = (event) => {
      void enqueue(async () => {
        if (socket !== connection) return;
        const response = JSON.parse(String(event.data)) as
          | Receipt
          | { error: string; status: number };
        if ("error" in response) {
          authExpired = response.status === 401;
          const message = authExpired
            ? "Session expired. Sign in again; local edits are preserved."
            : response.error;
          if ([400, 403, 409, 413].includes(response.status)) {
            const next = await changeStored<StoredWorkspace>("workspaces", key, (current) => {
              if (!current) throw new Error(message);
              return {
                ...current,
                blocked: `Sync blocked: ${message}. Export or recover this workspace.`,
              };
            });
            publish(next);
            notify();
          } else setStatus(message);
          connection.close();
          return;
        }
        try {
          await receive(response);
        } catch (error) {
          connection.close();
          throw error;
        }
        if (response.acknowledged.length) {
          inFlight = false;
          clearTimeout(receiptTimer);
        }
        flush();
      });
    };
    connection.onclose = () => {
      if (socket !== connection) return;
      connected = false;
      inFlight = false;
      clearTimeout(receiptTimer);
      if (stopped) return;
      if (record && !record.blocked && !authExpired && !saving)
        setStatus(
          record.pending.length
            ? `Saved locally · ${record.pending.length} pending · reconnecting`
            : "Saved locally · offline",
        );
      void network(async (isCurrent) => {
        const response = await fetch(endpoint, {
          credentials: "include",
          signal: AbortSignal.timeout(15000),
        }).catch(() => undefined);
        await enqueue(async () => {
          if (!isCurrent()) return;
          if (response?.status === 401) {
            authExpired = true;
            setStatus("Session expired. Sign in again; local edits are preserved.");
          }
          if (response?.status === 403)
            throw new BlockedSync("Workspace permission is no longer available");
        });
      });
      timer = setTimeout(
        connect,
        Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)) * (0.75 + Math.random() / 2),
      );
    };
  };
  const retry = () => {
    void network(async (isCurrent) => {
      module ??= await loadWasm();
      const response = await fetch(endpoint, { credentials: "include", signal: requests.signal });
      if (!response.ok)
        throw new Error(
          response.status === 401 ? "Sign in again to synchronize." : "Review server unavailable.",
        );
      const receipt = (await response.json()) as Receipt;
      await enqueue(async () => {
        if (!isCurrent()) return;
        await receive(receipt);
        if (record?.blocked) {
          const next = await changeStored<StoredWorkspace>("workspaces", key, (current) => {
            if (!current || stopped) throw new Error("Local workspace was cleared or closed.");
            const next = { ...current };
            delete next.blocked;
            return next;
          });
          publish(next);
          notify();
        }
        connect();
        flush();
      });
    });
  };
  const wake = () => {
    if (!record?.blocked) connect();
  };
  const disconnect = () => socket?.close();
  window.addEventListener("offline", disconnect);
  window.addEventListener("online", wake);
  window.addEventListener("focus", wake);
  if (channel)
    channel.onmessage = () => {
      void enqueue(async () => {
        const latest = await readStored<StoredWorkspace>("workspaces", key);
        if (latest) publish(latest);
        flush();
      });
    };

  void enqueue(async () => {
    module = await loadWasm();
    const saved = await readStored<StoredWorkspace>("workspaces", key);
    if (saved) publish(saved);
    else {
      const response = await fetch(endpoint, { credentials: "include", signal: requests.signal });
      if (!response.ok)
        throw new Error("Connect and sign in once to initialize this review workspace.");
      await receive((await response.json()) as Receipt);
    }
    connect();
  });

  const apply = (command: Command) => {
    const snapshot = manifest;
    const generation = record?.generation;
    let saved = false;
    changeSaving(1);
    setStatus("Saving locally…");
    return enqueue(async () => {
      if (
        !snapshot ||
        !("version" in command) ||
        !snapshot.files.some((file) => file.id === command.version)
      )
        throw new Error("This version is not displayed.");
      const version = command.version;
      setStatus("Saving locally…");
      let changed = false;
      const next = await changeStored<StoredWorkspace>("workspaces", key, (current) => {
        if (!current || discarded || current.generation !== generation)
          throw new Error(
            "Review was cleared or recovered before this command could save. Retry the action.",
          );
        const doc = replica(current);
        try {
          const proposal = doc.propose(command);
          changed = !!proposal;
          return proposal
            ? {
                ...current,
                document: doc.save(),
                pending: [...current.pending, { snapshot: snapshot.id, proposal }],
              }
            : current;
        } finally {
          doc.free();
        }
      });
      changeSaving(-1);
      saved = true;
      if (
        command.kind === "collapse" ||
        (changed && (command.kind === "review" || command.kind === "reassertReview"))
      ) {
        setCollapsed((local) => ({ ...local, [version]: command.value }));
      }
      publish(next);
      notify(true);
      flush();
    }, true).finally(() => {
      if (!saved) changeSaving(-1);
      if (stopped && !saving) {
        channel?.close();
        accountChannel?.close();
      }
    });
  };

  const dispose = (discard = false) => {
    stopped = true;
    discarded ||= discard;
    requests.abort();
    clearTimeout(timer);
    clearTimeout(receiptTimer);
    socket?.close();
    if (!saving) {
      channel?.close();
      accountChannel?.close();
    }
    window.removeEventListener("offline", disconnect);
    window.removeEventListener("online", wake);
    window.removeEventListener("focus", wake);
  };
  if (accountChannel)
    accountChannel.onmessage = (event: MessageEvent<{ clearedAccount: string }>) => {
      if (event.data.clearedAccount === user) {
        dispose(true);
        record = undefined;
        setReady(false);
        setViews({});
        setCollapsed({});
        setStatus("Offline account data was cleared in another tab. Reload to continue.");
      }
    };

  return {
    views,
    collapsed,
    status,
    ready,
    pending,
    blocked,
    apply,
    retry,
    setSnapshot(snapshot: Manifest) {
      const currentVersions = new Set(snapshot.files.map((file) => file.id));
      setCollapsed((local) =>
        Object.fromEntries(
          Object.entries(local).filter(([version]) => currentVersions.has(version)),
        ),
      );
      manifest = snapshot;
      if (record && module) publish(record);
    },
    export: () =>
      enqueue(async () => {
        const current = await readStored<StoredWorkspace>("workspaces", key);
        if (!current) return;
        const archives = await readArchives<StoredWorkspace>(`${key}:`);
        const bytes = JSON.stringify({
          user,
          repository,
          number,
          ...current,
          document: Array.from(current.document),
          archives: archives.map((branch) => ({
            ...branch,
            document: Array.from(branch.document),
          })),
        });
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `kestrel-review-${repository}-${number}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),
    recover: () =>
      network(async (isCurrent) => {
        const response = await fetch(endpoint, { credentials: "include", signal: requests.signal });
        if (!response.ok) throw new Error("Sign in with the original account before recovering.");
        const receipt = (await response.json()) as Receipt;
        if (receipt.userId !== user || receipt.protocol !== 1)
          throw new Error("Account or protocol changed.");
        await enqueue(async () => {
          if (!isCurrent()) return;
          const next = await changeStored<StoredWorkspace>(
            "workspaces",
            key,
            (current) => {
              if (!current || stopped) throw new Error("Local workspace was cleared or closed.");
              if (current.format !== 1)
                throw new Error(
                  "Upgrade the app before replaying this archive. Export remains available.",
                );
              const doc = new module.ReviewReplica(Uint8Array.from(receipt.document));
              try {
                const pending: Entry[] = [];
                for (const entry of current?.pending ?? []) {
                  const proposal = doc.propose(entry.proposal.command);
                  if (proposal) pending.push({ snapshot: entry.snapshot, proposal });
                }
                return {
                  format: 1,
                  generation: crypto.randomUUID(),
                  document: doc.save(),
                  pending,
                  revision: receipt.revision,
                };
              } finally {
                doc.free();
              }
            },
            true,
          );
          publish(next);
          notify();
          socket?.close();
          socket = undefined;
          connect();
        });
      }),
    demoAgent: (version: string) => {
      const snapshot = manifest?.id;
      return network(async (isCurrent) => {
        if (!snapshot) return;
        const response = await fetch(`${endpoint}/demo-agent`, {
          method: "POST",
          credentials: "include",
          signal: requests.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: user,
            snapshot,
            version,
          } satisfies components["schemas"]["AgentRequest"]),
        });
        if (!response.ok)
          throw new Error("Demo agent could not save its assessment. Retry when connected.");
        const receipt = (await response.json()) as Receipt;
        await enqueue(async () => {
          if (isCurrent()) await receive(receipt);
        });
      });
    },
    dispose,
  };
}
