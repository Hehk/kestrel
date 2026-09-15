import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { changeStored, deleteAccountStorage, readArchives, readStored } from "./storage";

describe("review durability", () => {
  it("serializes independent writers without replacing another tab's accepted document or journal", async () => {
    const key = `concurrent:${crypto.randomUUID()}`;
    type Document = { journal: number[]; document: Uint8Array };
    await Promise.all(
      Array.from({ length: 100 }, (_, id) =>
        changeStored<Document>("workspaces", key, (old) => ({
          journal: [...(old?.journal ?? []), id],
          document: Uint8Array.of((old?.journal.length ?? 0) + 1),
        })),
      ),
    );
    const saved = await readStored<Document>("workspaces", key);
    expect(saved?.journal.sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(Array.from(saved!.document)).toEqual([100]);
  });

  it("aborts a failing candidate without undoing an earlier durable import", async () => {
    const key = `quota:${crypto.randomUUID()}`;
    await changeStored("workspaces", key, () => ({ reviewed: false, agent: "accepted" }));
    await expect(
      changeStored<{ reviewed: boolean; agent: string }>("workspaces", key, (value) => {
        value!.reviewed = true;
        throw new DOMException("quota", "QuotaExceededError");
      }),
    ).rejects.toThrow("quota");
    expect(await readStored("workspaces", key)).toEqual({ reviewed: false, agent: "accepted" });
  });

  it("archives exactly the branch replaced by recovery in the same transaction", async () => {
    const key = `recovery:${crypto.randomUUID()}`;
    await changeStored("workspaces", key, () => ({ pending: [1, 2] }));
    await expect(
      changeStored(
        "workspaces",
        key,
        () => {
          throw new Error("replay failed");
        },
        true,
      ),
    ).rejects.toThrow("replay failed");
    expect(await readArchives(`${key}:`)).toEqual([]);
    await changeStored("workspaces", key, () => ({ pending: [3] }), true);
    expect(await readArchives(`${key}:`)).toEqual([{ pending: [1, 2] }]);
    expect(await readStored("workspaces", key)).toEqual({ pending: [3] });
  });

  it("explicit account deletion removes only that account's snapshots, branches and archives", async () => {
    for (const store of ["workspaces", "snapshots", "archives"] as const) {
      await changeStored(store, "alice:42:1", () => ({ secret: "alice" }));
      await changeStored(store, "bob:42:1", () => ({ secret: "bob" }));
    }
    await deleteAccountStorage("alice");
    for (const store of ["workspaces", "snapshots", "archives"] as const) {
      expect(await readStored(store, "alice:42:1")).toBeUndefined();
      expect(await readStored(store, "bob:42:1")).toEqual({ secret: "bob" });
    }
  });
});
