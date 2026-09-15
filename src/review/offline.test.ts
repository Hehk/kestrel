import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedDiff, offlineFetch, setOfflineAccount } from "./offline";
import { deleteAccountStorage } from "./storage";
const url = "http://localhost/api/repositories/example/demo/pull-requests/1/diff";
afterEach(async () => {
  vi.unstubAllGlobals();
  setOfflineAccount(null);
  await deleteAccountStorage("alice");
  await deleteAccountStorage("bob");
});

describe("offline snapshot cache", () => {
  it("restores only explicitly cached, authenticated snapshots on transport failure", async () => {
    setOfflineAccount("alice");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ files: ["alice"] }, { headers: { "X-Kestrel-User": "alice" } }),
        ),
    );
    await offlineFetch(url);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect(await (await offlineFetch(url)).json()).toEqual({ files: ["alice"] });
    expect((await offlineFetch("http://localhost/api/auth/me")).status).toBe(503);
    setOfflineAccount("bob");
    expect((await offlineFetch(url)).status).toBe(503);
  });

  it("labels cached diffs during server outages without treating authorization rejection as offline", async () => {
    setOfflineAccount("alice");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ files: ["alice"] }, { headers: { "X-Kestrel-User": "alice" } }),
        ),
    );
    await offlineFetch(url);
    expect(cachedDiff()).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("gateway unavailable", { status: 502 })),
    );
    expect(await (await offlineFetch(url)).json()).toEqual({ files: ["alice"] });
    expect(cachedDiff()).toBe(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "expired" }, { status: 401 })),
    );
    expect((await offlineFetch(url)).status).toBe(401);
  });

  it("does not fall back to private cached data after online permission rejection", async () => {
    setOfflineAccount("alice");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ files: ["alice"] }, { headers: { "X-Kestrel-User": "alice" } }),
        ),
    );
    await offlineFetch(url);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "forbidden" }, { status: 403 })),
    );
    expect((await offlineFetch(url)).status).toBe(403);
  });

  it("rejects responses authenticated as a different account before caching or displaying them", async () => {
    setOfflineAccount("alice");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ files: ["bob"] }, { headers: { "X-Kestrel-User": "bob" } }),
        ),
    );
    expect((await offlineFetch(url)).status).toBe(409);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect((await offlineFetch(url)).status).toBe(503);
  });
});
