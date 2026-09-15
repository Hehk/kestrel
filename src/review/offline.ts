import { changeStored, readStored } from "./storage";
import { createSignal } from "solid-js";
const [offlineCacheWarning, setWarning] = createSignal<string>();
const [cachedDiff, setCachedDiff] = createSignal(false);
export { offlineCacheWarning, cachedDiff };

let account: string | null = null;
export const setOfflineAccount = (user: string | null) => {
  if (user !== account) {
    setWarning(undefined);
    setCachedDiff(false);
  }
  account = user;
};
const cacheable = (path: string) =>
  path === "/api/repositories" ||
  /^\/api\/repositories\/[^/]+\/[^/]+\/pull-requests(?:\/\d+(?:\/diff)?)?$/.test(path);

type Snapshot = { body: string; contentType: string };

export const offlineFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const user = account;
  if (!user || request.method !== "GET" || !cacheable(new URL(request.url).pathname)) {
    try {
      return await fetch(request);
    } catch (error) {
      if (request.signal.aborted) throw error;
      return Response.json({ error: "offline" }, { status: 503 });
    }
  }
  const key = `${encodeURIComponent(user)}:${request.url}`;
  let response: Response;
  try {
    response = await fetch(request);
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (account !== user) return Response.json({ error: "accountChanged" }, { status: 409 });
    const cached = await readStored<Snapshot>("snapshots", key).catch(() => undefined);
    if (!cached || account !== user) return Response.json({ error: "offline" }, { status: 503 });
    if (new URL(request.url).pathname.endsWith("/diff")) setCachedDiff(true);
    return new Response(cached.body, {
      headers: { "Content-Type": cached.contentType, "X-Kestrel-Offline": "true" },
    });
  }
  if (account !== user) return Response.json({ error: "accountChanged" }, { status: 409 });
  const owner = response.headers.get("X-Kestrel-User");
  if (owner && owner !== user) return Response.json({ error: "accountChanged" }, { status: 409 });
  if (response.status >= 500) {
    const cached = await readStored<Snapshot>("snapshots", key).catch(() => undefined);
    if (cached && account === user) {
      if (new URL(request.url).pathname.endsWith("/diff")) setCachedDiff(true);
      return new Response(cached.body, {
        headers: { "Content-Type": cached.contentType, "X-Kestrel-Offline": "true" },
      });
    }
  }
  if (response.ok && account === user && owner === user) {
    if (new URL(request.url).pathname.endsWith("/diff")) setCachedDiff(false);
    const body = await response.clone().text();
    const contentType = response.headers.get("Content-Type") ?? "application/json";
    if (account === user) {
      try {
        await changeStored<Snapshot>("snapshots", key, () => ({ body, contentType }));
        if (new URL(request.url).pathname.endsWith("/diff")) {
          const snapshot = (JSON.parse(body) as { review?: { id?: string } }).review?.id;
          if (snapshot)
            await changeStored<Snapshot>("snapshots", `${key}#${snapshot}`, () => ({
              body,
              contentType,
            }));
        }
      } catch {
        if (account === user)
          setWarning(
            "Some opened snapshots could not be saved for offline reload. Free browser storage and refresh before disconnecting.",
          );
      }
    }
  }
  return response;
};
