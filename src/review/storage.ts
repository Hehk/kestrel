const DATABASE = "kestrel-review-v1";
export type Store = "workspaces" | "snapshots" | "archives";

const openReviewStorage = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      for (const name of ["workspaces", "snapshots", "archives"])
        request.result.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close older Kestrel tabs to upgrade local storage."));
  });

export async function readStored<T>(store: Store, key: string): Promise<T | undefined> {
  const db = await openReviewStorage();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

// The read, synchronous WASM mutation, document and journal write share one readwrite
// transaction. IndexedDB serializes it across tabs; no stale snapshot can overwrite a peer.
export async function changeStored<T>(
  store: Store,
  key: string,
  change: (current: T | undefined) => T,
  archiveCurrent = false,
): Promise<T> {
  const db = await openReviewStorage();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(archiveCurrent ? [store, "archives"] : store, "readwrite");
      const objects = tx.objectStore(store);
      const request = objects.get(key);
      let next: T;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          next = change(request.result as T | undefined);
          if (archiveCurrent && request.result !== undefined)
            tx.objectStore("archives").put(request.result, `${key}:${crypto.randomUUID()}`);
          objects.put(next, key);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(next);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Local save was aborted."));
      tx.onerror = () => {
        failure ??= tx.error;
      };
    });
  } finally {
    db.close();
  }
}

export async function readArchives<T>(prefix: string): Promise<T[]> {
  const db = await openReviewStorage();
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const request = db
        .transaction("archives")
        .objectStore("archives")
        .getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function deleteAccountStorage(user: string): Promise<void> {
  const db = await openReviewStorage();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["workspaces", "snapshots", "archives"], "readwrite");
      for (const name of ["workspaces", "snapshots", "archives"]) {
        const request = tx.objectStore(name).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (String(cursor.key).startsWith(`${encodeURIComponent(user)}:`)) cursor.delete();
          cursor.continue();
        };
      }
      tx.oncomplete = () => {
        if (typeof BroadcastChannel !== "undefined") {
          const channel = new BroadcastChannel("kestrel-review-storage");
          channel.postMessage({ clearedAccount: user });
          channel.close();
        }
        resolve();
      };
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
