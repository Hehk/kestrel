import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { preview } from "vite";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "kestrel-review-e2e-"));
const database = join(temporary, "review.sqlite3");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const timestamp = "2026-01-01T00:00:00Z";
const version = sha("one-v1");
const secondVersion = sha("two-v1");
const snapshot = sha("snapshot-v1");
const manifest = {
  hashAlgorithm: "sha1",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  mergeBaseCommit: "c".repeat(40),
  repositoryId: 42,
  id: snapshot,
  files: [
    { id: version, path: "one.ts", predecessor: null },
    { id: secondVersion, path: "two.ts", predecessor: null },
  ],
};
const raw = (one = "ONE") =>
  `diff --git a/one.ts b/one.ts\nindex aaaaaaa..bbbbbbb 100644\n--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-old\n+${one}\ndiff --git a/two.ts b/two.ts\nindex ccccccc..ddddddd 100644\n--- a/two.ts\n+++ b/two.ts\n@@ -1 +1 @@\n-old\n+TWO\n`;
const port = await new Promise((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const backendUrl = `http://127.0.0.1:${port}`;
const server = await preview({
  root,
  configFile: false,
  preview: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: backendUrl, ws: true } } },
});
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let backend;
let browser;
let db;
let backendOutput = "";

async function eventually(test, description = "condition", timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}
async function startBackend() {
  backend = spawn(join(root, "backend/target/debug/kestrel-backend"), [], {
    cwd: temporary,
    env: {
      PATH: process.env.PATH,
      HOME: temporary,
      APP_ENV: "development",
      APP_URL: origin,
      API_URL: backendUrl,
      BIND_ADDR: `127.0.0.1:${port}`,
      DATABASE_URL: `sqlite://${database}`,
      RUST_LOG: "error",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.stdout.on("data", (data) => {
    backendOutput += data.toString();
  });
  backend.stderr.on("data", (data) => {
    backendOutput += data.toString();
  });
  await eventually(async () => {
    try {
      return (await fetch(`${backendUrl}/api/health`)).ok;
    } catch {
      return false;
    }
  }, "backend startup");
}
async function stopBackend() {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise((resolve) => backend.once("exit", resolve));
  backend.kill("SIGTERM");
  await exited;
}
function storeManifest(user, next, diff) {
  db.prepare(
    "UPDATE tracked_repository_pull_request_details SET review_snapshot_json = ?, diff = ? WHERE user_id = ?",
  ).run(JSON.stringify(next), diff, user);
  db.prepare("INSERT OR IGNORE INTO review_snapshots VALUES (?, 42, 1, ?, ?, ?)").run(
    user,
    next.id,
    JSON.stringify(next),
    diff,
  );
  for (const file of next.files)
    db.prepare("INSERT OR IGNORE INTO review_versions VALUES (?, 42, 1, ?, ?)").run(
      user,
      next.id,
      file.id,
    );
}
function seed(user) {
  db.prepare("INSERT INTO users VALUES (?, ?, NULL, ?, ?)").run(user, user, timestamp, timestamp);
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").run(
    user,
    user,
    createHash("sha256").update(user).digest("base64url"),
    "2099-01-01T00:00:00Z",
    timestamp,
  );
  db.prepare(
    "INSERT INTO tracked_repositories (user_id, owner, name, created_at) VALUES (?, 'example', 'demo', ?)",
  ).run(user, timestamp);
  db.prepare(
    "INSERT INTO tracked_repository_pull_requests (user_id, provider, owner, name, number, github_id, title, state, draft, html_url, created_at, updated_at, synced_at) VALUES (?, 'github', 'example', 'demo', 1, 900, 'Review fixture', 'open', 0, 'https://github.com/example/demo/pull/1', ?, ?, ?)",
  ).run(user, timestamp, timestamp, timestamp);
  db.prepare(
    "INSERT INTO tracked_repository_pull_request_details (user_id, provider, owner, name, number, files_json, commits_json, reviews_json, review_comments_json, issue_comments_json, timeline_json, check_runs_json, statuses_json, synced_at) VALUES (?, 'github', 'example', 'demo', 1, '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', ?)",
  ).run(user, timestamp);
  storeManifest(user, manifest, raw());
}
const endpoint = "/api/review/42/1";
async function request(path, body, user = "reviewer", requestOrigin = origin) {
  return fetch(`${backendUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: `kestrel_session=${user}`,
      Origin: requestOrigin,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function stored(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("kestrel-review-v1");
        request.onsuccess = () => {
          const db = request.result;
          const read = db.transaction("workspaces").objectStore("workspaces").get("reviewer:42:1");
          read.onsuccess = () => {
            resolve(read.result);
            db.close();
          };
          read.onerror = () => reject(read.error);
        };
      }),
  );
}
const checkbox = (page, file = "one.ts") =>
  page.getByRole("checkbox", { name: `Reviewed ${file}`, exact: true }).first();
const synced = (page) => page.getByText("Synchronized", { exact: true }).waitFor();

try {
  await startBackend();
  db = new DatabaseSync(database);
  db.exec("PRAGMA busy_timeout = 5000");
  seed("reviewer");
  seed("other");
  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([{ name: "kestrel_session", value: "reviewer", url: origin }]);
  const errors = [];
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => !!localStorage.getItem("kestrel.session"));
  const route = `${origin}/pull/example%2Fdemo/1/diff`;
  // Use the actual application router URL.
  await page.goto(route);
  await synced(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await eventually(
    () => page.evaluate(() => !!navigator.serviceWorker.controller),
    "service worker controlling page",
  );
  assert.equal(await checkbox(page).isChecked(), false);
  await checkbox(page).check();
  await synced(page);
  assert.equal(await checkbox(page).isChecked(), true);
  await page.getByRole("button", { name: "Expand one.ts", exact: true }).first().waitFor();

  let tab = await context.newPage();
  await tab.goto(route);
  await synced(tab);
  await page.getByRole("button", { name: "Expand one.ts", exact: true }).first().click();
  await synced(page);
  assert.equal(await checkbox(page).isChecked(), true);
  await tab.getByRole("button", { name: "Expand one.ts", exact: true }).first().waitFor();
  await tab.reload();
  await synced(tab);
  await tab.getByRole("button", { name: "Collapse one.ts", exact: true }).first().waitFor();

  await context.setOffline(true);
  await eventually(
    () =>
      page
        .getByText(/offline|reconnecting/)
        .count()
        .then((n) => n > 0),
    "offline state",
  );
  await Promise.all([checkbox(page).uncheck(), checkbox(tab, "two.ts").check()]);
  await eventually(async () => (await stored(page)).pending.length >= 2, "both tabs durably saved");
  await tab.close();
  tab = await context.newPage();
  await tab.goto(route);
  await eventually(
    async () => await checkbox(tab, "two.ts").isChecked(),
    "crashed tab's durable edit restored",
  );
  await page.getByText("Importance and agent context", { exact: true }).click();
  await page.getByRole("combobox", { name: "Human importance" }).selectOption("important");
  await checkbox(page).uncheck();
  await eventually(async () => (await stored(page)).pending.length >= 3, "offline journal");
  await page.reload();
  await checkbox(page).waitFor();
  await eventually(async () => !(await checkbox(page).isChecked()), "offline unreview restored");
  await page.getByText("Importance and agent context", { exact: true }).click();
  assert.equal(
    await page.getByRole("combobox", { name: "Human importance" }).inputValue(),
    "important",
  );
  const pending = (await stored(page)).pending;
  const agent = await request(`${endpoint}/demo-agent`, { userId: "reviewer", snapshot, version });
  assert.equal(agent.status, 200);
  // Save the browser's exact changes while its connection is down: persistence receipt is lost.
  const accepted = await request(endpoint, { protocol: 1, userId: "reviewer", entries: pending });
  assert.equal(accepted.status, 200);
  const acceptedRevision = (await accepted.json()).revision;
  await stopBackend();
  await startBackend();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Retry sync", exact: true }).click();
  await synced(page);
  assert.equal((await stored(page)).pending.length, 0);
  assert.equal((await (await request(endpoint)).json()).revision, acceptedRevision);
  await page.getByText("Effective: important", { exact: true }).waitFor();
  await page.getByText("Kestrel demo agent", { exact: true }).waitFor();
  assert.equal(await checkbox(page).isChecked(), false);

  // A local disk failure must not leave the checkbox optimistically checked or undo agent context.
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "workspaces") {
        IDBObjectStore.prototype.put = put;
        throw new DOMException("test quota", "QuotaExceededError");
      }
      return put.apply(this, args);
    };
  });
  await checkbox(page).click();
  await page.getByText(/Not saved:.*test quota/).waitFor();
  assert.equal(await checkbox(page).isChecked(), false);
  await page.getByText("Kestrel demo agent", { exact: true }).waitFor();

  const changed = {
    ...manifest,
    id: sha("snapshot-v2"),
    files: [{ id: sha("one-v2"), path: "one.ts", predecessor: version }, manifest.files[1]],
  };
  storeManifest("reviewer", changed, raw("ONE_CHANGED"));
  // Old tab commands continue to target the old snapshot, never an unseen new version.
  await checkbox(page).check();
  await synced(page);
  await tab.reload();
  await synced(tab);
  assert.equal(await checkbox(tab).isChecked(), false);
  assert.equal(await checkbox(page).isChecked(), true);
  await checkbox(tab).focus();
  await tab
    .getByRole("tooltip")
    .filter({ hasText: "Marked unreviewed because this file changed." })
    .waitFor();
  await checkbox(page).uncheck();
  await synced(page);
  storeManifest("reviewer", manifest, raw());
  await tab.reload();
  await synced(tab);
  assert.equal(await checkbox(tab).isChecked(), false);

  // Cross-user, cross-origin, unknown version, protocol and opaque-operation requests cannot mutate history.
  const before = (await (await request(endpoint)).json()).revision;
  assert.equal(
    (await request(endpoint, { protocol: 1, userId: "other", entries: [] })).status,
    403,
  );
  assert.equal(
    (
      await request(
        endpoint,
        { protocol: 1, userId: "reviewer", entries: [] },
        "reviewer",
        "https://evil.invalid",
      )
    ).status,
    403,
  );
  assert.equal(
    (await request(endpoint, { protocol: 999, userId: "reviewer", entries: [] })).status,
    409,
  );
  assert.equal(
    (await request(endpoint, { protocol: 1, userId: "reviewer", entries: [], document: [1, 2, 3] }))
      .status,
    422,
  );
  assert.equal(
    (
      await request(endpoint, {
        protocol: 1,
        userId: "reviewer",
        entries: [],
        extra: "x".repeat(200_000),
      })
    ).status,
    413,
  );
  const unknown = structuredClone(pending[0]);
  unknown.proposal.command = { kind: "review", version: sha("unknown-version"), value: true };
  assert.equal(
    (await request(endpoint, { protocol: 1, userId: "reviewer", entries: [unknown] })).status,
    403,
  );
  const spoofedAgent = structuredClone(pending[0]);
  spoofedAgent.proposal.command = {
    kind: "assess",
    contribution: {
      id: "spoofed",
      version,
      agent: "forged agent",
      run: "forged run",
      importance: "important",
      evidence: [],
      context: "Not trusted",
    },
  };
  assert.equal(
    (await request(endpoint, { protocol: 1, userId: "reviewer", entries: [spoofedAgent] })).status,
    409,
  );
  assert.equal((await (await request(endpoint)).json()).revision, before);
  assert.equal((await request("/api/review/999/1")).status, 403);
  assert.equal((await request(endpoint, undefined, "no-session")).status, 401);

  await tab.close();
  await context.setOffline(true);
  await checkbox(page).check();
  await eventually(async () => (await stored(page)).pending.length > 0, "pending recovery command");
  db.prepare("DELETE FROM review_workspaces WHERE user_id = 'reviewer'").run();
  await request(endpoint);
  await context.setOffline(false);
  await page.getByRole("button", { name: "Retry sync", exact: true }).click();
  await page.getByRole("button", { name: "Recover review", exact: true }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Recover review", exact: true }).click();
  await synced(page);
  assert.equal(await checkbox(page).isChecked(), true);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export review", exact: true }).click();
  const download = await downloading;
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(exported.archives.length, 1);
  assert.ok(exported.archives[0].pending.length > 0);
  assert.ok(exported.archives[0].document.length > 0);

  db.prepare(
    "UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z' WHERE user_id = 'reviewer'",
  ).run();
  await page.getByRole("link", { name: "Sign in again", exact: true }).waitFor();
  await checkbox(page).uncheck();
  await eventually(
    async () => (await stored(page)).pending.length > 0,
    "expired-session work stays pending",
  );
  db.prepare(
    "INSERT OR REPLACE INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES ('reviewer', 'reviewer', ?, '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z')",
  ).run(createHash("sha256").update("reviewer").digest("base64url"));
  await page.getByRole("button", { name: "Retry sync", exact: true }).click();
  await synced(page);
  assert.equal(await checkbox(page).isChecked(), false);
  await checkbox(page).check();
  await synced(page);

  const device = await browser.newContext();
  await device.addCookies([{ name: "kestrel_session", value: "reviewer", url: origin }]);
  const remote = await device.newPage();
  remote.on("pageerror", (error) => errors.push(error.message));
  await remote.goto(origin);
  await remote.waitForFunction(() => !!localStorage.getItem("kestrel.session"));
  await remote.goto(route);
  await synced(remote);
  await context.setOffline(true);
  await device.setOffline(true);
  await checkbox(page).uncheck();
  await checkbox(page).check();
  await checkbox(remote).uncheck();
  await eventually(
    async () =>
      (await stored(page)).pending.length === 2 && (await stored(remote)).pending.length === 1,
    "independent offline device branches",
  );
  await context.setOffline(false);
  await device.setOffline(false);
  await synced(page);
  await synced(remote);
  await page.getByRole("button", { name: "Resolve conflict", exact: true }).first().waitFor();
  await remote.getByRole("button", { name: "Resolve conflict", exact: true }).first().waitFor();
  assert.equal(await checkbox(page).isChecked(), await checkbox(remote).isChecked());
  await page.getByRole("button", { name: "Resolve conflict", exact: true }).first().click();
  await synced(page);
  await eventually(
    async () =>
      (await remote.getByRole("button", { name: "Resolve conflict", exact: true }).count()) === 0,
    "explicit conflict reassertion converges",
  );
  await device.close();
  await checkbox(page).check();
  await synced(page);

  let pausedAgent;
  let agentStarted;
  const waitingForAgent = new Promise((resolve) => {
    agentStarted = resolve;
  });
  const agentUrl = `${origin}${endpoint}/demo-agent`;
  await page.route(agentUrl, (route) => {
    pausedAgent = route;
    agentStarted();
  });
  const beforeHungRequest = (await stored(page)).revision;
  await page.getByRole("button", { name: "Run demo Rust agent", exact: true }).click();
  await waitingForAgent;
  await checkbox(page).uncheck();
  await synced(page);
  assert.ok(
    (await stored(page)).revision > beforeHungRequest,
    "a stalled HTTP request must not block local persistence or WebSocket receipts",
  );
  await pausedAgent.continue();
  await page.getByText("Kestrel demo agent", { exact: true }).waitFor();
  await page.unroute(agentUrl);
  assert.equal(await checkbox(page).isChecked(), false);
  await checkbox(page).check();
  await synced(page);

  await page.evaluate(() => {
    const input = document.querySelector('input[aria-label="Reviewed one.ts"]');
    input.checked = false;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await eventually(
    async () => (await stored(page)).pending.length === 1,
    "captured commands finish saving after route disposal",
  );
  await page.goto(route);
  await synced(page);
  assert.equal(await checkbox(page).isChecked(), false);
  await checkbox(page).check();
  await synced(page);

  await context.addCookies([{ name: "kestrel_session", value: "other", url: origin }]);
  await page.reload();
  await eventually(
    () =>
      page.evaluate(() => JSON.parse(localStorage.getItem("kestrel.session"))?.user.id === "other"),
    "account switch",
  );
  await page.goto(route);
  await synced(page);
  assert.equal(await checkbox(page).isChecked(), false);
  assert.deepEqual(errors, []);
  console.log(
    "Review feature E2E passed: real Axum/SQLite/WASM, two tabs, offline shell reload, agent precedence, lost receipt/restart, quota rollback, exact versions, recovery/export, expired sessions, independent-device conflicts, stalled HTTP, route disposal, account isolation and request rejection.",
  );
} catch (error) {
  console.error(backendOutput);
  if (browser)
    for (const context of browser.contexts())
      for (const page of context.pages())
        console.error(
          await page
            .locator("body")
            .innerText()
            .catch(() => "closed page"),
        );
  throw error;
} finally {
  await browser?.close();
  db?.close();
  await stopBackend();
  await new Promise((resolve) => server.httpServer.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
