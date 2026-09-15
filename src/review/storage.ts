import type { CommandRequest } from "./generated/review_wasm";

export type Scope = { account: string; repository: string; number: number };
type JournalEntry = {
  id: string;
  request: CommandRequest;
  before: Uint8Array;
  after: Uint8Array;
};
export type StoredReview = {
  format: 1;
  snapshot: Uint8Array;
  journal: JournalEntry[];
  seen: Record<string, true>;
  paths: Record<string, string>;
  invalidated: Record<string, true>;
};
export type ReviewStorage = {
  locked<T>(
    action: (
      read: () => Promise<StoredReview | undefined>,
      write: (value: StoredReview) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
  notify(): void;
  close(): void;
};

export const exportStoredReview = (storage: ReviewStorage) =>
  storage.locked(async (read) =>
    JSON.stringify(await read(), (_, value: unknown) =>
      value instanceof Uint8Array ? Array.from(value) : value,
    ),
  );

const scopeKey = (scope: Scope) => JSON.stringify([scope.account, scope.repository, scope.number]);

export function openReviewStorage(scope: Scope, changed: () => void): ReviewStorage {
  const key = scopeKey(scope);
  const lock = `kestrel-review:${key}`;
  const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(lock);
  if (channel) channel.onmessage = changed;
  let database: Promise<IDBDatabase> | undefined;
  let closed = false;
  const open = () =>
    (database ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (closed) {
        reject(new Error("Review storage is closed."));
        return;
      }
      let failed = false;
      const request = indexedDB.open("kestrel-review", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("workspaces");
      request.onsuccess = () => {
        if (failed || closed) {
          request.result.close();
          reject(new Error("Review storage is closed."));
          return;
        }
        request.result.onversionchange = () => {
          request.result.close();
          database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        if (failed) return;
        failed = true;
        database = undefined;
        reject(request.error);
      };
      request.onblocked = () => {
        if (failed) return;
        failed = true;
        database = undefined;
        reject(new Error("Close other Kestrel tabs to upgrade review storage."));
      };
    }));
  async function transaction<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("workspaces", mode);
      const request = run(transaction.objectStore("workspaces"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () =>
        reject(transaction.error ?? request.error ?? new Error("Review storage was not saved."));
      transaction.onerror = () => reject(transaction.error ?? request.error);
    });
  }
  return {
    locked: async (action) => {
      if (!navigator.locks)
        throw new Error("This browser cannot safely coordinate review storage between tabs.");
      return await navigator.locks.request(lock, () =>
        action(
          () => transaction("readonly", (store) => store.get(key)),
          async (value) => {
            await transaction("readwrite", (store) => store.put(value, key));
          },
        ),
      );
    },
    notify: () => channel?.postMessage("changed"),
    close: () => {
      closed = true;
      channel?.close();
      void database?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
