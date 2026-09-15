import assert from "node:assert/strict";
import { chromium } from "playwright";
import { preview } from "vite";

const server = await preview({ preview: { host: "127.0.0.1", port: 0 } });
const browser = await chromium.launch();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const url = `${origin}/pull/kestrel%2Fapp/42/diff`;
const date = "2026-01-01T00:00:00Z";
const repository = {
  owner: "kestrel",
  name: "app",
  fullName: "kestrel/app",
  htmlUrl: "https://github.com/kestrel/app",
  createdAt: date,
  pullRequestsSyncedAt: date,
  pullRequestsSyncError: null,
};
const pullRequest = {
  number: 42,
  title: "Review integration",
  authorLogin: "octocat",
  closedAt: null,
  createdAt: date,
  draft: false,
  githubId: 42,
  htmlUrl: "https://github.com/kestrel/app/pull/42",
  mergedAt: null,
  state: "open",
  syncedAt: date,
  updatedAt: date,
};
const detail = {
  body: "Review this change",
  checkRuns: [],
  commits: [],
  files: [],
  issueComments: [],
  reviewComments: [],
  reviewDecision: null,
  reviews: [],
  statuses: [],
  syncedAt: date,
  timeline: [],
  timelinePagination: { kind: "complete" },
};
const file = (path, content) => ({
  additions: 1,
  deletions: 1,
  operation: { kind: "modified", path, modeChange: { kind: "unchanged" } },
  content: {
    kind: "text",
    hunks: [
      {
        context: null,
        oldCount: 1,
        newCount: 1,
        oldStart: 1,
        newStart: 1,
        lines: [
          { kind: "deletion", oldLine: 1, content: "before", missingNewline: false },
          { kind: "addition", newLine: 1, content, missingNewline: false },
        ],
      },
    ],
  },
});
const checked = (page, path = "src/main.rs") =>
  page.getByRole("checkbox", { name: `Reviewed ${path}`, exact: true }).first();
const button = (page, name) => page.getByRole("button", { name, exact: true }).first();
const exportReview = async (page) => {
  const downloading = page.waitForEvent("download");
  await button(page, "Export local review").click();
  const download = await downloading;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
};
const ready = (page) =>
  page.getByRole("status").filter({ hasText: "Review saved on this device only." }).waitFor();
const eventually = async (check) => {
  for (let n = 0; n < 100; n++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Timed out waiting for review state");
};

try {
  const context = await browser.newContext({ acceptDownloads: true });
  let version = "v1";
  let account = "user:1";
  let identityAvailable = true;
  let syncs = 0;
  const errors = [];
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/logout") {
      await route.fulfill({ status: 204 });
      return;
    }
    let body;
    if (path === "/api/auth/me")
      body = { user: { id: account, displayName: account, avatarUrl: null } };
    else if (path === "/api/settings") body = { theme: "light" };
    else if (path === "/api/repositories") body = { repositories: [repository] };
    else if (path.endsWith("/diff"))
      body = {
        files: [file("src/main.rs", `after-${version}`), file("src/other.rs", "other")],
        syncedAt: date,
        ...(identityAvailable
          ? {
              review: {
                repositoryId: "github:123",
                snapshotId: `snapshot:${version}`,
                fileVersions: [`file:${version}`, "file:other"],
              },
            }
          : {}),
      };
    else if (path.endsWith("/42/sync")) {
      syncs++;
      body = { pullRequest, pullRequestDetail: detail };
    } else if (path.endsWith("/42")) body = { pullRequestDetail: detail };
    else if (path.endsWith("/pull-requests")) body = { pullRequests: [pullRequest] };
    else throw new Error(`Unexpected API request ${path}`);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await page.goto(url);
  await ready(page);
  assert.equal(await checked(page).isChecked(), false);
  await checked(page).focus();
  await page.keyboard.press("Space");
  await ready(page);
  assert.equal(await checked(page).isChecked(), true);
  assert.equal(await button(page, "Expand src/main.rs").isVisible(), true);
  assert.equal(await page.locator("[data-diff-source]").filter({ hasText: "after-v1" }).count(), 0);
  await page.getByRole("searchbox", { name: "Search diff" }).fill("after-v1");
  await page.getByText("No results", { exact: true }).waitFor();
  await button(page, "Expand src/main.rs").click();
  await ready(page);
  await page.getByText("1 of 1", { exact: true }).waitFor();
  assert.equal(await checked(page).isChecked(), true);
  await page.getByRole("searchbox", { name: "Search diff" }).fill("");
  await checked(page).uncheck();
  await ready(page);
  assert.equal(await button(page, "Collapse src/main.rs").isVisible(), true);

  const tab = await context.newPage();
  await tab.goto(url);
  await ready(tab);
  await checked(page).check();
  await ready(page);
  await eventually(() => checked(tab).isChecked());
  assert.equal(
    await button(tab, "Collapse src/main.rs").isVisible(),
    true,
    "remote review must not collapse an open tab",
  );
  await button(tab, "Collapse src/main.rs").click();
  await ready(tab);
  await button(page, "Expand src/main.rs").click();
  await ready(page);
  assert.equal(
    await button(tab, "Expand src/main.rs").isVisible(),
    true,
    "remote visibility must not expand an open tab",
  );
  await tab.reload();
  await ready(tab);
  assert.equal(
    await button(tab, "Collapse src/main.rs").isVisible(),
    true,
    "reopen restores converged visibility",
  );

  await Promise.all([checked(page).uncheck(), checked(tab, "src/other.rs").check()]);
  await ready(page);
  await ready(tab);
  await tab.reload();
  await ready(tab);
  assert.equal(await checked(tab).isChecked(), false);
  assert.equal(
    await checked(tab, "src/other.rs").isChecked(),
    true,
    "two-tab saves retain both decisions",
  );
  await checked(page).check();
  await ready(page);
  version = "v2";
  await button(page, "Sync pull request from GitHub").click();
  await eventually(
    async () =>
      syncs === 1 &&
      !(await checked(page).isChecked()) &&
      (await button(page, "Collapse src/main.rs").isVisible()),
  );
  await ready(page);
  await page.keyboard.press("Tab");
  await checked(page).focus();
  await page
    .getByRole("tooltip")
    .filter({ hasText: "Marked unreviewed because this file changed." })
    .waitFor();
  assert.equal(
    await checked(page, "src/other.rs").isChecked(),
    true,
    "unrelated file retains its review",
  );

  await context.setOffline(true);
  await checked(page).check();
  await ready(page);
  await context.setOffline(false);
  await page.reload();
  await ready(page);
  assert.equal(await checked(page).isChecked(), true, "offline edit survives IndexedDB restore");
  await checked(page).uncheck();
  await ready(page);
  version = "v1";
  await button(page, "Sync pull request from GitHub").click();
  await eventually(async () => syncs === 2 && (await checked(page).isChecked()));
  await ready(page);
  version = "v2";
  await button(page, "Sync pull request from GitHub").click();
  await eventually(async () => syncs === 3 && !(await checked(page).isChecked()));
  await ready(page);
  assert.equal(
    await button(page, "Collapse src/main.rs").isVisible(),
    true,
    "explicit unreview survives returning versions",
  );

  await page.evaluate(() => {
    window.savedReviewPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("Simulated quota failure", "QuotaExceededError");
    };
  });
  await checked(page).check();
  await page.getByRole("alert").filter({ hasText: "Simulated quota failure" }).waitFor();
  assert.equal(await checked(page).isChecked(), false, "failed local write rolls back candidate");
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = window.savedReviewPut;
    delete window.savedReviewPut;
  });
  await button(page, "Retry local review").click();
  await ready(page);
  assert.equal(await checked(page).isChecked(), true);

  const exported = await exportReview(page);
  assert.equal(exported.scope.account, "user:1");
  assert.equal(exported.review.format, 1);
  assert.ok(exported.review.journal.length >= 5);
  assert.ok(
    exported.review.journal.every(
      (entry) => entry.id && entry.request.displayed.version && entry.after.length,
    ),
  );

  await page.route("**/*.wasm", (route) => route.abort());
  await page.reload();
  await page.getByRole("alert").filter({ hasText: "Retry local review" }).waitFor();
  const preserved = await exportReview(page);
  assert.deepEqual(
    preserved.review.snapshot,
    exported.review.snapshot,
    "export does not depend on a working WASM runtime",
  );
  await page.unroute("**/*.wasm");
  await button(page, "Retry local review").click();
  await ready(page);
  assert.equal(await checked(page).isChecked(), true);

  account = "user:2";
  await page.reload();
  await ready(page);
  await eventually(async () => !(await checked(page).isChecked()));
  assert.equal(
    await checked(page, "src/other.rs").isChecked(),
    false,
    "account partition hides another user's review",
  );
  account = "user:1";
  await page.reload();
  await ready(page);
  await eventually(() => checked(page).isChecked());
  assert.equal(await checked(page, "src/other.rs").isChecked(), true);
  await page.screenshot({ path: "/tmp/kestrel-review-page.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const checkboxBounds = await checked(page).boundingBox();
  assert.ok(
    checkboxBounds && checkboxBounds.x >= 0 && checkboxBounds.x + checkboxBounds.width <= 390,
    "review checkbox stays visible on mobile",
  );
  await checked(page).uncheck();
  await ready(page);
  await checked(page).check();
  await ready(page);
  await page.screenshot({ path: "/tmp/kestrel-review-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  await tab.reload();
  await ready(tab);
  await page.goto(origin);
  await button(page, "Sign out").click();
  await page.waitForURL("**/login");
  await tab
    .getByRole("alert")
    .filter({ hasText: "Your account changed in another tab." })
    .waitFor();
  assert.equal(
    await checked(tab).count(),
    0,
    "logout hides review in other tabs without deleting it",
  );
  await page.goto(origin);
  await button(page, "Sign out").waitFor();
  await page.goto(url);
  await ready(page);
  assert.equal(
    await checked(page).isChecked(),
    true,
    "signing back in restores retained local work",
  );

  identityAvailable = false;
  await page.reload();
  await page.getByText("Review unavailable for this stored diff.", { exact: false }).waitFor();
  assert.equal(await checked(page).isDisabled(), true);
  assert.equal(await page.locator("[data-diff-source]").filter({ hasText: "after-v2" }).count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    "PR page: keyboard review, independent collapse, search, refresh/returning versions, real two-tab IndexedDB coordination, offline edit, quota rollback/retry, export, account isolation and missing-identity handling passed",
  );
} catch (error) {
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      console.error(page.url(), (await page.locator("body").innerText()).slice(0, 3000));
    }
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
