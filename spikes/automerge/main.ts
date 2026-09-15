import init, { ReviewReplica, type Command } from "./generated/web/review_wasm";

const result = document.querySelector<HTMLOutputElement>("#result")!;
const button = document.querySelector<HTMLButtonElement>("#review")!;

async function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("automerge-boundary-spike", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("documents");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function load(db: IDBDatabase): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction("documents").objectStore("documents").get("fixture");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function save(db: IDBDatabase, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("documents", "readwrite");
    tx.objectStore("documents").put(bytes, "fixture");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Storage transaction aborted"));
  });
}

async function main() {
  const start = performance.now();
  await init();
  const wasmInitMs = performance.now() - start;
  const db = await openStore();
  const bytes = await load(db);
  let replica = new ReviewReplica(bytes ?? ReviewReplica.bootstrap());
  const render = () => {
    result.textContent = JSON.stringify({ restored: !!bytes, wasmInitMs, ...replica.view("v1") });
    result.dataset.ready = "true";
  };
  render();
  button.disabled = false;
  button.onclick = async () => {
    button.disabled = true;
    const candidate = new ReviewReplica(replica.save());
    try {
      const command: Command = { kind: "review", version: "v1", value: true };
      candidate.apply(command);
      await save(db, candidate.save());
      replica.free();
      replica = candidate;
      render();
    } catch (error) {
      candidate.free();
      result.textContent = String(error);
    } finally {
      button.disabled = false;
    }
  };
}

main().catch((error: unknown) => {
  result.textContent = String(error);
});
