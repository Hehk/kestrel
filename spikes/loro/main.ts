import init, {
  ReviewWorkspace,
  type CommandRequest,
  type ReviewView,
} from "../../crates/review-wasm/pkg/review_wasm";

const started = performance.now();
await init();

// These are generated from Rust, including tagged commands and contribution types.
const displayed = { snapshot: "snapshot:1", version: "file:v1" };
const review: CommandRequest = {
  command: { kind: "review", target: displayed, reviewed: true },
  displayed,
  actor: { kind: "human" },
};

const open = indexedDB.open("kestrel-loro-spike", 1);
open.onupgradeneeded = () => open.result.createObjectStore("snapshots");
const db = await new Promise<IDBDatabase>((resolve, reject) => {
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(open.error);
});

function saved(): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("snapshots", "readonly");
    const request = transaction.objectStore("snapshots").get("fixture");
    transaction.oncomplete = () => resolve(request.result as Uint8Array | undefined);
    transaction.onabort = () => reject(transaction.error);
  });
}

function save(snapshot: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("snapshots", "readwrite");
    transaction.objectStore("snapshots").put(snapshot, "fixture");
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

const bytes = await saved();
let workspace = bytes ? ReviewWorkspace.restoreTrusted(bytes) : new ReviewWorkspace();

const spike = {
  initializationMs: performance.now() - started,
  view(): ReviewView {
    return workspace.view(displayed.version);
  },
  async review() {
    const candidate = workspace.command(review);
    try {
      await save(candidate.snapshot());
    } catch (error) {
      candidate.free();
      throw error;
    }
    workspace.free();
    workspace = candidate;
    return spike.view();
  },
  peerId: () => workspace.peerId(),
  snapshot: () => Array.from(workspace.snapshot()),
};

declare global {
  interface Window {
    loroSpike: typeof spike;
  }
}
window.loroSpike = spike;
document.querySelector("#status")!.textContent = "Ready";
