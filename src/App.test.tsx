import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetForTest } from "./store";
import type { PullRequestDetail, PullRequestDiff } from "./repositoriesSlice";
import * as Session from "./session";

const signedInResponse = {
  user: {
    avatarUrl: "https://avatars.example.test/user_1",
    displayName: "User One",
    id: "user_1",
  },
};

const jsonResponse = (body: unknown, status = 200) => {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
};

type SaveSettings = (theme: string) => Response | Promise<Response>;
type Repository = {
  createdAt: string;
  fullName: string;
  htmlUrl: string;
  name: string;
  owner: string;
  pullRequestsSyncError?: string | null;
  pullRequestsSyncedAt?: string | null;
};
type PullRequest = {
  authorLogin: string | null;
  closedAt: string | null;
  createdAt: string;
  draft: boolean;
  githubId: number;
  htmlUrl: string;
  mergedAt: string | null;
  number: number;
  state: string;
  syncedAt: string;
  title: string;
  updatedAt: string;
};
type SaveRepository = (repository: string) => Response | Promise<Response>;
type SyncPullRequests = (fullName: string) => Response | Promise<Response>;
type SyncPullRequestDetail = (fullName: string, number: number) => Response | Promise<Response>;
type LoadPullRequestDiff = (fullName: string, number: number) => Response | Promise<Response>;
type LoadOlderPullRequestTimeline = (
  fullName: string,
  number: number,
) => Response | Promise<Response>;

const repository = (fullName: string, metadata: Partial<Repository> = {}): Repository => {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    createdAt: "2026-01-01T00:00:00Z",
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    name,
    owner,
    ...metadata,
  };
};

const pullRequest = (number: number, title = `PR ${number}`): PullRequest => {
  return {
    authorLogin: "octocat",
    closedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    draft: false,
    githubId: 1000 + number,
    htmlUrl: `https://github.com/kestrel/app/pull/${number}`,
    mergedAt: null,
    number,
    state: "open",
    syncedAt: "2026-01-03T00:00:00Z",
    title,
    updatedAt: "2026-01-02T00:00:00Z",
  };
};

const pullRequestDetail = (): PullRequestDetail => {
  return {
    body: "Adds pull request syncing.\n\nThe description is stored as plain text.",
    checkRuns: [
      {
        name: "test",
        state: "success",
        summary: "All test suites completed successfully.",
        title: "Tests passed",
        url: "https://ci.example.test/runs/42",
      },
      { name: "lint", state: "in_progress", summary: "Lint is still running.", url: null },
      { name: "optional", state: "neutral" },
      { name: "docs", state: "skipped" },
      { name: "mystery", state: "new_state" },
    ],
    commits: [{ message: "Add syncing", sha: "abcdef123456" }],
    files: [{ filename: "app.rs", status: "modified" }],
    issueComments: [{ authorLogin: "octocat", body: "looks good" }],
    reviewComments: [{ authorLogin: "reviewer", body: "nit" }],
    reviewDecision: "APPROVED",
    reviews: [{ authorLogin: "reviewer", state: "APPROVED" }],
    statuses: [
      {
        context: "ci",
        description: "Build failed",
        state: "failure",
        url: "https://ci.example.test/builds/42",
      },
      { context: "deploy", description: null, state: "pending", url: null },
    ],
    syncedAt: "2026-01-04T00:00:00Z",
    timeline: [
      {
        actorLogin: "octocat",
        body: "looks good",
        event: "commented",
        id: "comment-1",
        occurredAt: "2026-01-04T00:00:00Z",
        reviewComments: [],
        url: "https://github.com/kestrel/app/pull/42#issuecomment-1",
      },
      {
        actorLogin: "reviewer",
        body: "Approved after one small note.",
        event: "reviewed",
        id: "review-1",
        occurredAt: "2026-01-03T00:00:00Z",
        reviewComments: [
          {
            actorLogin: "reviewer",
            body: "nit",
            id: "review-comment-1",
            occurredAt: "2026-01-03T00:01:00Z",
          },
        ],
        reviewCommentsHasMore: true,
        state: "APPROVED",
        url: "https://github.com/kestrel/app/pull/42#pullrequestreview-1",
      },
      {
        actorLogin: "octocat",
        body: "Add syncing",
        commitSha: "abcdef123456",
        event: "committed",
        id: "commit-1",
        occurredAt: "2026-01-02T00:00:00Z",
      },
    ],
    timelineHasOlder: true,
  };
};

const pullRequestDiff = (): PullRequestDiff => ({
  files: [
    {
      additions: 1,
      binary: false,
      deletions: 1,
      hunks: [
        {
          context: "fn main()",
          lines: [
            {
              content: "old line",
              kind: "deletion",
              missingNewline: false,
              newLine: null,
              oldLine: 1,
            },
            {
              content: "new line",
              kind: "addition",
              missingNewline: false,
              newLine: 1,
              oldLine: null,
            },
          ],
          newCount: 1,
          newStart: 1,
          oldCount: 1,
          oldStart: 1,
        },
      ],
      newMode: "100644",
      newPath: "src/main.rs",
      oldMode: "100644",
      oldPath: "src/main.rs",
      operation: "modified",
    },
  ],
  syncedAt: "2026-01-04T00:00:00Z",
});

const mockAuth = (
  body: unknown = signedInResponse,
  initialTheme = "system",
  saveSettings?: SaveSettings,
  initialRepositories: Repository[] = [],
  saveRepository?: SaveRepository,
  initialPullRequests: Record<string, PullRequest[]> = {},
  syncPullRequests?: SyncPullRequests,
  initialPullRequestDetails: Record<string, PullRequestDetail> = {},
  syncPullRequestDetail?: SyncPullRequestDetail,
  loadOlderPullRequestTimeline?: LoadOlderPullRequestTimeline,
  initialPullRequestDiffs: Record<string, PullRequestDiff> = {},
  loadPullRequestDiff?: LoadPullRequestDiff,
) => {
  let theme = initialTheme;
  let repositories = initialRepositories;
  let pullRequestsByRepository = initialPullRequests;
  let pullRequestDetailsByKey = initialPullRequestDetails;
  const pullRequestDiffsByKey = initialPullRequestDiffs;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = input instanceof Request ? input.method : "GET";

      if (url.endsWith("/api/auth/me")) {
        return jsonResponse(body);
      }

      if (url.endsWith("/api/auth/logout")) {
        return new Response(null, { status: 204 });
      }

      if (url.endsWith("/api/settings") && method === "GET") {
        return jsonResponse({ theme });
      }

      if (url.endsWith("/api/settings") && method === "PUT" && input instanceof Request) {
        const request = (await input.clone().json()) as { theme: string };
        if (saveSettings !== undefined) {
          return saveSettings(request.theme);
        }

        theme = request.theme;
        return jsonResponse({ theme });
      }

      if (url.endsWith("/api/repositories") && method === "GET") {
        return jsonResponse({ repositories });
      }

      if (url.endsWith("/api/repositories") && method === "POST" && input instanceof Request) {
        const request = (await input.clone().json()) as { repository: string };
        if (saveRepository !== undefined) {
          return saveRepository(request.repository);
        }

        const nextRepository = repositoryFromInput(request.repository);
        repositories = [...repositories, nextRepository];
        return jsonResponse({ repository: nextRepository }, 201);
      }

      const olderTimelineMatch = url.match(
        /\/api\/repositories\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)\/timeline\/older$/,
      );
      if (olderTimelineMatch && method === "POST") {
        const owner = decodeURIComponent(olderTimelineMatch[1] ?? "");
        const name = decodeURIComponent(olderTimelineMatch[2] ?? "");
        const number = Number(olderTimelineMatch[3]);
        const fullName = `${owner}/${name}`;
        if (loadOlderPullRequestTimeline !== undefined) {
          return loadOlderPullRequestTimeline(fullName, number);
        }

        const key = `${fullName}#${number}`;
        const detail = pullRequestDetailsByKey[key] ?? pullRequestDetail();
        const updatedDetail = { ...detail, timelineHasOlder: false };
        pullRequestDetailsByKey = { ...pullRequestDetailsByKey, [key]: updatedDetail };
        return jsonResponse({ pullRequestDetail: updatedDetail });
      }

      const pullRequestDiffMatch = url.match(
        /\/api\/repositories\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)\/diff$/,
      );
      if (pullRequestDiffMatch && method === "GET") {
        const owner = decodeURIComponent(pullRequestDiffMatch[1] ?? "");
        const name = decodeURIComponent(pullRequestDiffMatch[2] ?? "");
        const number = Number(pullRequestDiffMatch[3]);
        const fullName = `${owner}/${name}`;
        if (loadPullRequestDiff !== undefined) {
          return loadPullRequestDiff(fullName, number);
        }

        const diff = pullRequestDiffsByKey[`${fullName}#${number}`];
        return diff === undefined
          ? jsonResponse({ error: "pull_request_not_found" }, 404)
          : jsonResponse(diff);
      }

      const pullRequestDetailMatch = url.match(
        /\/api\/repositories\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)(?:\/sync)?$/,
      );
      if (pullRequestDetailMatch) {
        const owner = decodeURIComponent(pullRequestDetailMatch[1] ?? "");
        const name = decodeURIComponent(pullRequestDetailMatch[2] ?? "");
        const number = Number(pullRequestDetailMatch[3]);
        const fullName = `${owner}/${name}`;
        const key = `${fullName}#${number}`;

        if (method === "GET") {
          const detail = pullRequestDetailsByKey[key];
          return detail === undefined
            ? jsonResponse({ error: "pull_request_not_found" }, 404)
            : jsonResponse({ pullRequestDetail: detail });
        }

        if (method === "POST") {
          if (syncPullRequestDetail !== undefined) {
            return syncPullRequestDetail(fullName, number);
          }

          const detail = pullRequestDetail();
          pullRequestDetailsByKey = { ...pullRequestDetailsByKey, [key]: detail };
          const syncedPullRequest =
            pullRequestsByRepository[fullName]?.find(
              (pullRequest) => pullRequest.number === number,
            ) ?? pullRequest(number);
          return jsonResponse({ pullRequest: syncedPullRequest, pullRequestDetail: detail });
        }
      }

      const pullRequestsMatch = url.match(
        /\/api\/repositories\/([^/]+)\/([^/]+)\/pull-requests(?:\/sync)?$/,
      );
      if (pullRequestsMatch) {
        const owner = decodeURIComponent(pullRequestsMatch[1] ?? "");
        const name = decodeURIComponent(pullRequestsMatch[2] ?? "");
        const fullName = `${owner}/${name}`;

        if (method === "GET") {
          return jsonResponse({ pullRequests: pullRequestsByRepository[fullName] ?? [] });
        }

        if (method === "POST") {
          if (syncPullRequests !== undefined) {
            return syncPullRequests(fullName);
          }

          const synced = pullRequestsByRepository[fullName] ?? [];
          pullRequestsByRepository = { ...pullRequestsByRepository, [fullName]: synced };
          return jsonResponse({
            complete: true,
            nextPage: null,
            pullRequests: synced,
            syncedCount: synced.length,
          });
        }
      }

      return new Response(null, { status: 404 });
    }),
  );
};

const repositoryFromInput = (input: string) => {
  const fullName = input
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();

  return repository(fullName);
};

const renderApp = () => {
  Session.start();
  return render(() => <App />);
};

const clearCache = () => {
  window.localStorage.clear();
};

const writeCachedUser = (user: typeof signedInResponse.user) => {
  window.localStorage.setItem("kestrel.session", JSON.stringify({ version: 1, user }));
};

const readCachedUser = () => {
  return JSON.parse(window.localStorage.getItem("kestrel.session") ?? "null") as unknown;
};

const selectTheme = async (user: ReturnType<typeof userEvent.setup>, theme: string) => {
  await user.click(screen.getByRole("button", { name: /^Theme / }));
  await user.click(await screen.findByRole("option", { name: theme }));
};

const deferredResponse = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
};

const writeCachedSettings = (userId: string, theme: string) => {
  window.localStorage.setItem(
    `kestrel.settings.${userId}`,
    JSON.stringify({ version: 1, userId, theme }),
  );
};

describe("App", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("scrollTo", vi.fn());
    clearCache();
    mockAuth();
    writeCachedUser(signedInResponse.user);
    writeCachedSettings(signedInResponse.user.id, "system");
    resetForTest();
    Session.resetForTest();
  });

  afterEach(() => {
    cleanup();
    Session.resetForTest();
    clearCache();
    document.documentElement.removeAttribute("data-theme");
    vi.unstubAllGlobals();
  });

  it("renders cached authenticated state before the session check resolves", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    clearCache();
    writeCachedUser(signedInResponse.user);
    writeCachedSettings(signedInResponse.user.id, "dark");
    resetForTest();
    Session.resetForTest();

    renderApp();

    expect(screen.getByRole("heading", { name: "Tracked repositories" })).toBeInTheDocument();
    expect(screen.getByText("Loading repositories...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("shows an empty repository state", async () => {
    renderApp();

    expect(screen.getByRole("heading", { name: "Tracked repositories" })).toBeInTheDocument();
    expect(await screen.findByText("No repositories tracked yet.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Add GitHub repository" })).toHaveAttribute(
      "placeholder",
      "owner/name or GitHub URL",
    );
    expect(screen.getByRole("button", { name: "Track repo" })).toBeInTheDocument();
  });

  it("navigates between the basic pages", async () => {
    const user = userEvent.setup();

    renderApp();

    expect(screen.getByRole("heading", { name: "Tracked repositories" })).toBeInTheDocument();
    await screen.findByRole("button", { name: "Sign out" });

    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^Theme / })).toHaveTextContent("System");

    await user.click(screen.getByRole("link", { name: "Sample PR" }));
    expect(screen.getByRole("heading", { name: "kestrel" })).toBeInTheDocument();
    expect(screen.getByText("Repository is not tracked.")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Back to home" }));
    expect(screen.getByRole("heading", { name: "Tracked repositories" })).toBeInTheDocument();
  });

  it("renders tracked repositories", async () => {
    mockAuth(signedInResponse, "system", undefined, [repository("kestrel/app")]);

    renderApp();

    const link = await screen.findByRole("link", { name: "kestrel/app" });
    expect(link).toHaveAttribute("href", "https://github.com/kestrel/app");
    expect(screen.queryByText("No repositories tracked yet.")).not.toBeInTheDocument();
  });

  it("renders persisted pull request sync metadata", async () => {
    mockAuth(signedInResponse, "system", undefined, [
      repository("kestrel/app", {
        pullRequestsSyncError: "authorization_required",
        pullRequestsSyncedAt: "2026-01-02T00:00:00Z",
      }),
    ]);

    renderApp();

    expect(await screen.findByRole("link", { name: "kestrel/app" })).toBeInTheDocument();
    expect(
      screen.getByText("Last PR sync failed: GitHub App authorization required."),
    ).toBeInTheDocument();
  });

  it("loads stored pull requests for tracked repositories", async () => {
    const user = userEvent.setup();
    mockAuth(signedInResponse, "system", undefined, [repository("kestrel/app")], undefined, {
      "kestrel/app": [pullRequest(42, "Add syncing")],
    });

    renderApp();

    await user.click(await screen.findByRole("button", { name: "Load PRs for kestrel/app" }));

    const link = await screen.findByRole("link", { name: "#42 Add syncing" });
    expect(link).toHaveAttribute("href", "/pull/kestrel%2Fapp/42");
    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("renders stored pull request details", async () => {
    const user = userEvent.setup();
    mockAuth(signedInResponse, "system", undefined, [repository("kestrel/app")], undefined, {
      "kestrel/app": [pullRequest(42, "Add syncing")],
    });

    renderApp();

    await user.click(await screen.findByRole("button", { name: "Load PRs for kestrel/app" }));
    await user.click(await screen.findByRole("link", { name: "#42 Add syncing" }));

    expect(screen.getByRole("heading", { name: "Add syncing" })).toBeInTheDocument();
    const sidebar = screen.getByRole("complementary", { name: "Pull request metadata" });
    expect(within(sidebar).getByRole("heading", { name: "Details" })).toBeInTheDocument();
    expect(within(sidebar).getByText("kestrel/app")).toBeInTheDocument();
    expect(within(sidebar).getByText("#42")).toBeInTheDocument();
    expect(within(sidebar).getByText("open")).toBeInTheDocument();
    expect(within(sidebar).getByText("octocat")).toBeInTheDocument();
    expect(
      within(sidebar).getByText(
        new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(
          new Date("2026-01-02T00:00:00Z"),
        ),
      ),
    ).toHaveAttribute("datetime", "2026-01-02T00:00:00Z");
    expect(screen.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/kestrel/app/pull/42",
    );
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
  });

  it("syncs and renders pull request detail sections", async () => {
    const user = userEvent.setup();
    mockAuth(signedInResponse, "system", undefined, [repository("kestrel/app")], undefined, {
      "kestrel/app": [pullRequest(42, "Add syncing")],
    });

    renderApp();

    await user.click(await screen.findByRole("button", { name: "Load PRs for kestrel/app" }));
    await user.click(await screen.findByRole("link", { name: "#42 Add syncing" }));
    await screen.findByText("Pull request details are not stored yet.");
    await user.click(screen.getByRole("button", { name: "Sync pull request from GitHub" }));

    const sidebar = screen.getByRole("complementary", { name: "Pull request metadata" });
    const detailsHeading = within(sidebar).getByRole("heading", { name: "Details" });
    const filesHeading = within(sidebar).getByRole("heading", { name: "Files changed" });
    const commitsHeading = within(sidebar).getByRole("heading", { name: "Commits" });
    expect(detailsHeading.compareDocumentPosition(filesHeading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(filesHeading.compareDocumentPosition(commitsHeading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(within(sidebar).getByText("app.rs")).toBeInTheDocument();
    expect(within(sidebar).getByText("Add syncing")).toBeInTheDocument();

    const content = document.querySelector<HTMLElement>(".PullRequestPage-content");
    expect(content).not.toBeNull();
    expect(
      within(content as HTMLElement).queryByRole("heading", { name: /Files changed/ }),
    ).toBeNull();
    expect(within(content as HTMLElement).queryByRole("heading", { name: /Commits/ })).toBeNull();
    expect(within(content as HTMLElement).queryByRole("heading", { name: /Reviews/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "Checks" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("complementary", { name: "Pull request status" })).getByText("test"),
    ).toBeInTheDocument();
    expect(within(content as HTMLElement).queryByRole("heading", { name: "Diff" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Load stored details" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Details synced:/)).not.toBeInTheDocument();
  });

  it("renders the plain-text description and canonical activity newest first", async () => {
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42");
    const detail = {
      ...pullRequestDetail(),
      body: "**Plain text**\n\n[not a rendered link](https://example.test)",
    };
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [pullRequest(42, "Add syncing")] },
      undefined,
      { "kestrel/app#42": detail },
    );

    renderApp();

    const description = await screen.findByRole("region", { name: "Pull request description" });
    expect(description).toHaveTextContent(
      "**Plain text** [not a rendered link](https://example.test)",
    );
    expect(within(description).queryByRole("link")).not.toBeInTheDocument();
    expect(within(description).queryByText("Plain text", { selector: "strong" })).toBeNull();

    const activity = screen.getByRole("region", { name: "Activity" });
    expect(within(activity).getByText("Newest first")).toBeInTheDocument();
    const newest = within(activity).getByText("looks good");
    const oldest = within(activity).getByText("Add syncing");
    expect(newest.compareDocumentPosition(oldest)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(activity).getByText("approved the pull request")).toBeInTheDocument();
    expect(within(activity).getByText("nit")).toBeInTheDocument();
    expect(
      within(activity).getByRole("link", { name: "View the complete review on GitHub" }),
    ).toHaveAttribute("href", "https://github.com/kestrel/app/pull/42#pullrequestreview-1");
    expect(within(activity).getByText("committed abcdef1")).toBeInTheDocument();
    expect(activity.querySelector('time[datetime="2026-01-04T00:00:00Z"]')).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Conversation comments" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Review comments" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Timeline" })).toBeNull();
  });

  it("loads and appends older pull request activity", async () => {
    const user = userEvent.setup();
    const olderRequest = deferredResponse();
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42");
    const detail = pullRequestDetail();
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [pullRequest(42, "Add syncing")] },
      undefined,
      { "kestrel/app#42": detail },
      undefined,
      () => olderRequest.promise,
    );

    renderApp();

    const button = await screen.findByRole("button", { name: "Load older activity" });
    await user.click(button);
    const loadingButton = screen.getByRole("button", { name: "Loading older activity..." });
    expect(loadingButton).toBeDisabled();
    expect(loadingButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Sync pull request from GitHub" })).toBeDisabled();

    olderRequest.resolve(
      jsonResponse({
        pullRequestDetail: {
          ...detail,
          timeline: [
            ...detail.timeline,
            {
              actorLogin: "octocat",
              event: "closed",
              id: "closed-1",
              occurredAt: "2026-01-01T00:00:00Z",
            },
          ],
          timelineHasOlder: false,
        },
      }),
    );

    expect(await screen.findByText("closed the pull request")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older activity" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sync pull request from GitHub" })).toBeEnabled();
  });

  it("refreshes the current pull request summary and details from the toolbar", async () => {
    const user = userEvent.setup();
    let finishSync: ((response: Response) => void) | undefined;
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [pullRequest(42, "Old title")] },
      undefined,
      {},
      () =>
        new Promise<Response>((resolve) => {
          finishSync = resolve;
        }),
    );

    renderApp();
    await user.click(await screen.findByRole("button", { name: "Load PRs for kestrel/app" }));
    await user.click(await screen.findByRole("link", { name: "#42 Old title" }));

    const syncButton = screen.getByRole("button", { name: "Sync pull request from GitHub" });
    await user.click(syncButton);

    const syncingButton = screen.getByRole("button", { name: "Sync pull request from GitHub" });
    expect(syncingButton).toBeDisabled();
    expect(syncingButton).toHaveAttribute("aria-busy", "true");
    expect(syncingButton.querySelector("svg")).toHaveClass("pr-sidebar-sync-icon");

    if (finishSync === undefined) {
      throw new Error("sync request did not start");
    }
    finishSync(
      jsonResponse({
        pullRequest: {
          ...pullRequest(42, "Synced title"),
          authorLogin: "hubot",
          state: "closed",
          updatedAt: "2026-01-05T00:00:00Z",
        },
        pullRequestDetail: pullRequestDetail(),
      }),
    );

    expect(await screen.findByRole("heading", { name: "Synced title" })).toBeInTheDocument();
    const metadata = screen.getByRole("complementary", { name: "Pull request metadata" });
    expect(within(metadata).getByText("closed")).toBeInTheDocument();
    expect(within(metadata).getByText("hubot")).toBeInTheDocument();
    const completedSyncButton = screen.getByRole("button", {
      name: "Sync pull request from GitHub",
    });
    expect(completedSyncButton).toHaveAttribute("aria-busy", "false");
    expect(completedSyncButton.querySelector("svg")).not.toHaveClass("pr-sidebar-sync-icon");
  });

  it("renders shared actions before the Overview status sidebar", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42");
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [pullRequest(42, "Add syncing")] },
      undefined,
      {
        "kestrel/app#42": {
          ...pullRequestDetail(),
          reviewDecision: "CHANGES_REQUESTED",
        },
      },
    );

    renderApp();

    await screen.findByRole("heading", { name: "Checks" });
    const sidebar = screen.getByRole("complementary", { name: "Pull request status" });
    const actions = screen.getByRole("navigation", { name: "Pull request actions" });
    const reviewHeading = within(sidebar).getByRole("heading", { name: "Review status" });
    const checksHeading = within(sidebar).getByRole("heading", { name: "Checks" });
    expect(actions.compareDocumentPosition(reviewHeading)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(reviewHeading.compareDocumentPosition(checksHeading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(within(sidebar).getByText("Changes requested")).toHaveAttribute(
      "data-status-kind",
      "failure",
    );

    const backLink = within(actions).getByRole("link", { name: "Back to home" });
    await user.hover(backLink);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Back to tracked repositories");
    await user.unhover(backLink);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    const githubLink = within(actions).getByRole("link", { name: "Open on GitHub" });
    await user.hover(githubLink);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Open this pull request on GitHub",
    );
    await user.unhover(githubLink);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    const syncButton = within(actions).getByRole("button", {
      name: "Sync pull request from GitHub",
    });
    await user.hover(syncButton);
    const syncTooltip = await screen.findByRole("tooltip");
    expect(syncTooltip).toHaveTextContent("Sync pull request from GitHub");
    expect(syncTooltip).toHaveTextContent(
      `Last synced: ${new Intl.DateTimeFormat(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date("2026-01-04T00:00:00Z"))}`,
    );
  });

  it("keeps retained sidebar details visible when a refresh fails", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42");
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [pullRequest(42, "Add syncing")] },
      undefined,
      { "kestrel/app#42": pullRequestDetail() },
      () => Promise.reject(new Error("network failed")),
    );

    renderApp();
    await user.click(await screen.findByRole("button", { name: "Sync pull request from GitHub" }));
    expect(
      await screen.findByText("Pull request details could not be loaded."),
    ).toBeInTheDocument();

    const metadata = screen.getByRole("complementary", { name: "Pull request metadata" });
    expect(within(metadata).getByText("app.rs")).toBeInTheDocument();
    const status = screen.getByRole("complementary", { name: "Pull request status" });
    expect(within(status).getByText("Approved")).toBeInTheDocument();
  });

  it("renders check and status icons by state", async () => {
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42");
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [pullRequest(42, "Add syncing")] },
      undefined,
      { "kestrel/app#42": pullRequestDetail() },
    );

    renderApp();

    expect(await screen.findByRole("button", { name: "test: Success" })).toHaveAttribute(
      "data-status-kind",
      "success",
    );
    expect(screen.getByRole("button", { name: "ci: Failure" })).toHaveAttribute(
      "data-status-kind",
      "failure",
    );
    expect(screen.getByRole("button", { name: "lint: In progress" })).toHaveAttribute(
      "data-status-kind",
      "pending",
    );
    expect(screen.getByRole("button", { name: "deploy: Pending" })).toHaveAttribute(
      "data-status-kind",
      "pending",
    );
    expect(screen.getByRole("button", { name: "optional: Neutral" })).toHaveAttribute(
      "data-status-kind",
      "neutral",
    );
    expect(screen.getByRole("button", { name: "docs: Skipped" })).toHaveAttribute(
      "data-status-kind",
      "neutral",
    );
    expect(screen.getByRole("button", { name: "mystery: New state" })).toHaveAttribute(
      "data-status-kind",
      "neutral",
    );
  });

  it("shows check run details on hover and closes on activation", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42");
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [pullRequest(42, "Add syncing")] },
      undefined,
      { "kestrel/app#42": pullRequestDetail() },
    );

    renderApp();

    const trigger = await screen.findByRole("button", { name: "test: Success" });
    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Success")).toBeInTheDocument();
    expect(within(tooltip).getByText("Tests passed")).toBeInTheDocument();
    expect(
      within(tooltip).getByText("All test suites completed successfully."),
    ).toBeInTheDocument();
    const runLink = within(tooltip).getByRole("link", { name: "View run" });
    expect(runLink).toHaveAttribute("href", "https://ci.example.test/runs/42");
    expect(runLink).toHaveAttribute("target", "_blank");
    expect(runLink).toHaveAttribute("rel", "noreferrer");

    await user.hover(runLink);
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    expect(tooltip).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows status details on hover and handles missing run links", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42");
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [pullRequest(42, "Add syncing")] },
      undefined,
      { "kestrel/app#42": pullRequestDetail() },
    );

    renderApp();

    const statusTrigger = await screen.findByRole("button", { name: "ci: Failure" });
    await user.hover(statusTrigger);

    const statusTooltip = await screen.findByRole("tooltip");
    expect(within(statusTooltip).getByText("Failure")).toBeInTheDocument();
    expect(within(statusTooltip).getByText("Build failed")).toBeInTheDocument();
    expect(within(statusTooltip).getByRole("link", { name: "View run" })).toHaveAttribute(
      "href",
      "https://ci.example.test/builds/42",
    );

    await user.unhover(statusTrigger);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    await user.hover(screen.getByRole("button", { name: "lint: In progress" }));

    const checkTooltip = await screen.findByRole("tooltip");
    expect(within(checkTooltip).getByText("In progress")).toBeInTheDocument();
    expect(within(checkTooltip).getByText("Lint is still running.")).toBeInTheDocument();
    expect(within(checkTooltip).queryByRole("link", { name: "View run" })).not.toBeInTheDocument();
  });

  it("loads pull requests automatically from the pull request route", async () => {
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42");
    mockAuth(signedInResponse, "system", undefined, [repository("kestrel/app")], undefined, {
      "kestrel/app": [pullRequest(42, "Add syncing")],
    });

    renderApp();

    expect(await screen.findByRole("heading", { name: "Add syncing" })).toBeInTheDocument();
  });

  it("loads the Diff route directly with shared pull request chrome", async () => {
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42/diff");
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [pullRequest(42, "Add syncing")] },
      undefined,
      {},
      undefined,
      undefined,
      { "kestrel/app#42": pullRequestDiff() },
    );

    renderApp();

    expect(await screen.findByRole("heading", { name: "Add syncing" })).toBeInTheDocument();
    expect(await screen.findByText("1 changed file, 2 source lines.")).toBeInTheDocument();
    const diffTable = screen.getByRole("table", { name: "Pull request diff contents" });
    expect(diffTable).toHaveAttribute("aria-rowcount", "4");
    expect(diffTable.closest("[aria-live]")).toBeNull();
    const views = screen.getByRole("navigation", { name: "Pull request views" });
    expect(within(views).getByRole("link", { name: "Diff" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("region", { name: "Pull request diff" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Pull request actions" })).toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "Pull request status" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "Pull request metadata" }),
    ).not.toBeInTheDocument();
    const requestedUrls = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => (input instanceof Request ? input.url : input.toString()));
    expect(requestedUrls.some((url) => url.endsWith("/pull-requests/42/diff"))).toBe(true);
    expect(requestedUrls.some((url) => url.endsWith("/pull-requests/42"))).toBe(false);
  });

  it("shows Diff loading before rendering an empty response", async () => {
    const pendingDiff = deferredResponse();
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42/diff");
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [pullRequest(42, "Add syncing")] },
      undefined,
      {},
      undefined,
      undefined,
      {},
      () => pendingDiff.promise,
    );

    renderApp();

    const loadingStatus = await screen.findByText("Loading pull request diff...");
    expect(loadingStatus.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Sync pull request from GitHub" })).toBeDisabled();
    pendingDiff.resolve(jsonResponse({ files: [], syncedAt: "2026-01-04T00:00:00Z" }));
    expect(await screen.findByText("This pull request has no changed files.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync pull request from GitHub" })).toBeEnabled();
  });

  it.each([
    ["pull_request_not_found", 404, /Pull request details are not stored yet/],
    ["diff_unavailable", 409, /The stored pull request does not include a diff/],
    ["diff_parse_failed", 500, /The stored diff could not be parsed/],
    ["diff_resource_limit_exceeded", 422, /The stored diff is too large to display/],
    ["authentication_required", 401, /Authentication is required to load this diff/],
    ["authorization_required", 403, /GitHub App authorization required/],
    ["sync_failed", 500, /The pull request diff could not be loaded/],
  ])("renders Diff error %s", async (error, status, message) => {
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42/diff");
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [pullRequest(42, "Add syncing")] },
      undefined,
      {},
      undefined,
      undefined,
      {},
      () => jsonResponse({ error }, status),
    );

    renderApp();

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("shows sync failures from the Diff route", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42/diff");
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [pullRequest(42, "Add syncing")] },
      undefined,
      { "kestrel/app#42": pullRequestDetail() },
      () => Promise.reject(new Error("network failed")),
      undefined,
      { "kestrel/app#42": pullRequestDiff() },
    );

    renderApp();
    await screen.findByText("1 changed file, 2 source lines.");
    await user.click(screen.getByRole("button", { name: "Sync pull request from GitHub" }));

    expect(
      await screen.findByText("Pull request details could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.getByText("1 changed file, 2 source lines.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Pull request diff" })).toBeInTheDocument();
  });

  it("keeps stale Diff totals visible when refresh fails after sync", async () => {
    const user = userEvent.setup();
    const pendingRefresh = deferredResponse();
    let diffRequests = 0;
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42/diff");
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [pullRequest(42, "Add syncing")] },
      undefined,
      {},
      () =>
        jsonResponse({
          pullRequest: pullRequest(42, "Add syncing"),
          pullRequestDetail: pullRequestDetail(),
        }),
      undefined,
      {},
      () => {
        diffRequests += 1;
        return diffRequests === 1 ? jsonResponse(pullRequestDiff()) : pendingRefresh.promise;
      },
    );

    renderApp();
    await screen.findByText("1 changed file, 2 source lines.");
    await user.click(screen.getByRole("button", { name: "Sync pull request from GitHub" }));

    expect(await screen.findByText("Refreshing pull request diff...")).toBeInTheDocument();
    expect(screen.getByText("1 changed file, 2 source lines.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync pull request from GitHub" })).toBeDisabled();

    pendingRefresh.resolve(jsonResponse({ error: "sync_failed" }, 500));
    expect(
      await screen.findByText("The pull request diff could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.getByText("Showing the last successfully loaded diff.")).toBeInTheDocument();
    expect(screen.getByText("1 changed file, 2 source lines.")).toBeInTheDocument();
  });

  it("navigates between pull request views with browser back and forward", async () => {
    const user = userEvent.setup();
    let diffRequests = 0;
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42");
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [pullRequest(42, "Add syncing")] },
      undefined,
      {},
      undefined,
      undefined,
      {},
      () => {
        diffRequests += 1;
        return jsonResponse(pullRequestDiff());
      },
    );

    renderApp();
    const views = await screen.findByRole("navigation", { name: "Pull request views" });
    const overviewLink = within(views).getByRole("link", { name: "Overview" });
    const diffLink = within(views).getByRole("link", { name: "Diff" });
    expect(overviewLink).toHaveAttribute("aria-current", "page");
    expect(overviewLink).toHaveAttribute("href", "/pull/kestrel%2Fapp/42");
    expect(diffLink).toHaveAttribute("href", "/pull/kestrel%2Fapp/42/diff");

    await user.click(diffLink);
    expect(window.location.pathname).toBe("/pull/kestrel%2Fapp/42/diff");
    expect(await screen.findByText("1 changed file, 2 source lines.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Diff" })).toHaveAttribute("aria-current", "page");

    const back = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    window.history.back();
    await back;
    await waitFor(() => expect(window.location.pathname).toBe("/pull/kestrel%2Fapp/42"));
    expect(screen.getByRole("complementary", { name: "Pull request status" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");

    const forward = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    window.history.forward();
    await forward;
    await waitFor(() => expect(window.location.pathname).toBe("/pull/kestrel%2Fapp/42/diff"));
    expect(screen.getByText("1 changed file, 2 source lines.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Diff" })).toHaveAttribute("aria-current", "page");
    expect(diffRequests).toBe(1);
  });

  it("syncs missing pull requests automatically from the pull request route", async () => {
    const syncedRepositories: string[] = [];
    window.history.replaceState({}, "", "/pull/kestrel%2Fapp/42");
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      { "kestrel/app": [] },
      (fullName) => {
        syncedRepositories.push(fullName);
        const pullRequests = [pullRequest(42, "Add syncing")];
        return jsonResponse({ complete: true, nextPage: null, pullRequests, syncedCount: 1 });
      },
    );

    renderApp();

    expect(await screen.findByRole("heading", { name: "Add syncing" })).toBeInTheDocument();
    expect(syncedRepositories).toEqual(["kestrel/app"]);
  });

  it("syncs pull requests for tracked repositories", async () => {
    const user = userEvent.setup();
    const syncedRepositories: string[] = [];
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      {},
      (fullName) => {
        syncedRepositories.push(fullName);
        const pullRequests = [pullRequest(7, "Fix checkout")];
        return jsonResponse({ complete: true, nextPage: null, pullRequests, syncedCount: 1 });
      },
    );

    renderApp();

    await user.click(await screen.findByRole("button", { name: "Sync PRs for kestrel/app" }));

    expect(await screen.findByRole("link", { name: "#7 Fix checkout" })).toBeInTheDocument();
    expect(syncedRepositories).toEqual(["kestrel/app"]);
  });

  it("shows GitHub App authorization failures when syncing pull requests", async () => {
    const user = userEvent.setup();
    mockAuth(
      signedInResponse,
      "system",
      undefined,
      [repository("kestrel/app")],
      undefined,
      {},
      () => jsonResponse({ error: "authorization_required" }, 403),
    );

    renderApp();

    await user.click(await screen.findByRole("button", { name: "Sync PRs for kestrel/app" }));

    expect(await screen.findByText(/GitHub App authorization required/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Authorize more repos" })).toHaveAttribute(
      "href",
      "http://localhost/api/github-app/authorize",
    );
  });

  it("adds owner/name repositories", async () => {
    const user = userEvent.setup();
    const addedRepositories: string[] = [];
    mockAuth(signedInResponse, "system", undefined, [], (input) => {
      addedRepositories.push(input);
      return jsonResponse({ repository: repositoryFromInput(input) }, 201);
    });

    renderApp();

    await screen.findByText("No repositories tracked yet.");
    await user.type(screen.getByRole("textbox", { name: "Add GitHub repository" }), "Kestrel/App");
    await user.click(screen.getByRole("button", { name: "Track repo" }));

    expect(await screen.findByRole("link", { name: "kestrel/app" })).toHaveAttribute(
      "href",
      "https://github.com/kestrel/app",
    );
    expect(screen.getByRole("textbox", { name: "Add GitHub repository" })).toHaveValue("");
    expect(addedRepositories).toEqual(["Kestrel/App"]);
  });

  it("adds GitHub URL repositories", async () => {
    const user = userEvent.setup();
    const addedRepositories: string[] = [];
    mockAuth(signedInResponse, "system", undefined, [], (input) => {
      addedRepositories.push(input);
      return jsonResponse({ repository: repositoryFromInput(input) }, 201);
    });

    renderApp();

    await screen.findByText("No repositories tracked yet.");
    const input = await screen.findByRole("textbox", { name: "Add GitHub repository" });
    await user.type(input, "https://github.com/Kestrel/App.git");
    expect(input).toHaveValue("https://github.com/Kestrel/App.git");
    await user.click(screen.getByRole("button", { name: "Track repo" }));

    expect(await screen.findByRole("link", { name: "kestrel/app" })).toBeInTheDocument();
    expect(addedRepositories).toEqual(["https://github.com/Kestrel/App.git"]);
  });

  it("disables repository additions while saving", async () => {
    const user = userEvent.setup();
    const deferred = deferredResponse();
    mockAuth(signedInResponse, "system", undefined, [], () => deferred.promise);

    renderApp();

    const input = await screen.findByRole("textbox", { name: "Add GitHub repository" });
    await user.type(input, "Kestrel/App");
    await user.click(screen.getByRole("button", { name: "Track repo" }));

    expect(input).toHaveValue("");
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tracking..." })).toBeDisabled();

    deferred.resolve(jsonResponse({ repository: repository("kestrel/app") }, 201));
    expect(await screen.findByRole("link", { name: "kestrel/app" })).toBeInTheDocument();
  });

  it("shows duplicate repository add errors", async () => {
    const user = userEvent.setup();
    mockAuth(signedInResponse, "system", undefined, [repository("kestrel/app")], () =>
      jsonResponse({ error: "duplicate_repository" }, 409),
    );

    renderApp();

    await screen.findByRole("link", { name: "kestrel/app" });
    const input = screen.getByRole("textbox", { name: "Add GitHub repository" });
    await user.type(input, "Kestrel/App");
    await user.click(screen.getByRole("button", { name: "Track repo" }));

    expect(await screen.findByText("That repository is already tracked.")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("shows invalid repository add errors", async () => {
    const user = userEvent.setup();
    mockAuth(signedInResponse, "system", undefined, [], () =>
      jsonResponse({ error: "invalid_repository" }, 400),
    );

    renderApp();

    await screen.findByText("No repositories tracked yet.");
    const input = screen.getByRole("textbox", { name: "Add GitHub repository" });
    await user.type(input, "owner/name/issues");
    await user.click(screen.getByRole("button", { name: "Track repo" }));

    expect(
      await screen.findByText("Enter a GitHub repository as owner/name or a GitHub URL."),
    ).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("shows generic repository add errors", async () => {
    const user = userEvent.setup();
    mockAuth(signedInResponse, "system", undefined, [], () => new Response(null, { status: 500 }));

    renderApp();

    await screen.findByText("No repositories tracked yet.");
    await user.type(screen.getByRole("textbox", { name: "Add GitHub repository" }), "Kestrel/App");
    await user.click(screen.getByRole("button", { name: "Track repo" }));

    expect(
      await screen.findByText("Repository could not be added. Try again."),
    ).toBeInTheDocument();
  });

  it("shows the login page when signed out", async () => {
    const user = userEvent.setup();
    clearCache();
    mockAuth({ user: null });
    resetForTest();
    Session.resetForTest();

    renderApp();

    await screen.findByRole("link", { name: "Login" });

    await user.click(screen.getByRole("link", { name: "Login" }));

    expect(screen.getByRole("heading", { name: "Sign in to Kestrel" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute(
      "href",
      "http://localhost/api/auth/github/start",
    );
  });

  it("protects settings when signed out", async () => {
    window.history.replaceState({}, "", "/settings");
    clearCache();
    mockAuth({ user: null });
    resetForTest();
    Session.resetForTest();

    renderApp();

    expect(await screen.findByRole("heading", { name: "Sign in to Kestrel" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toBeInTheDocument();
  });

  it("boots a stale cached session after validation", async () => {
    mockAuth({ user: null });

    renderApp();

    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Login" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sign in to Kestrel" })).toBeInTheDocument();
  });

  it("stores the loaded user for future optimistic boots", async () => {
    clearCache();
    resetForTest();
    Session.resetForTest();

    renderApp();

    await screen.findByRole("button", { name: "Sign out" });
    expect(readCachedUser()).toEqual({ version: 1, user: signedInResponse.user });
  });

  it("navigates a newly authenticated session away from login", async () => {
    window.history.replaceState({}, "", "/login");
    clearCache();
    resetForTest();
    Session.resetForTest();

    renderApp();

    await screen.findByRole("button", { name: "Sign out" });
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("heading", { name: "Tracked repositories" })).toBeInTheDocument();
  });

  it("logs out", async () => {
    const user = userEvent.setup();

    renderApp();

    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("link", { name: "Login" })).toBeInTheDocument();
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => {
        return (
          input instanceof Request &&
          input.method === "POST" &&
          input.url === "http://localhost/api/auth/logout"
        );
      }),
    ).toBe(true);
  });

  it("saves theme when the selection changes", async () => {
    const user = userEvent.setup();

    renderApp();

    await screen.findByRole("button", { name: "Sign out" });

    await user.click(screen.getByRole("link", { name: "Settings" }));
    await selectTheme(user, "Dark");

    expect(screen.getByRole("button", { name: /^Theme / })).toHaveTextContent("Dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) => {
          return (
            input instanceof Request &&
            input.method === "PUT" &&
            input.url === "http://localhost/api/settings"
          );
        }),
      ).toBe(true),
    );
  });

  it("keeps the local theme and offers a retry when syncing fails", async () => {
    const user = userEvent.setup();
    const save = deferredResponse();
    mockAuth(signedInResponse, "system", () => save.promise);

    renderApp();

    await screen.findByRole("button", { name: "Sign out" });

    await user.click(screen.getByRole("link", { name: "Settings" }));
    await selectTheme(user, "Dark");

    expect(screen.getByRole("button", { name: /^Theme / })).toHaveTextContent("Dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    save.resolve(new Response(null, { status: 500 }));
    await save.promise;

    expect(
      await screen.findByText(/Theme is saved on this device but has not synced/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Theme / })).toHaveTextContent("Dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("serializes theme sync and continues with the latest value after a stale failure", async () => {
    const user = userEvent.setup();
    const firstSave = deferredResponse();
    const secondSave = deferredResponse();
    const savedThemes: string[] = [];

    mockAuth(signedInResponse, "system", (theme) => {
      savedThemes.push(theme);
      return savedThemes.length === 1 ? firstSave.promise : secondSave.promise;
    });

    renderApp();

    await screen.findByRole("button", { name: "Sign out" });

    await user.click(screen.getByRole("link", { name: "Settings" }));
    await selectTheme(user, "Dark");

    await waitFor(() => expect(savedThemes).toEqual(["dark"]));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    await selectTheme(user, "Light");

    expect(savedThemes).toEqual(["dark"]);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    firstSave.resolve(new Response(null, { status: 500 }));
    await firstSave.promise;

    await waitFor(() => expect(savedThemes).toEqual(["dark", "light"]));

    secondSave.resolve(jsonResponse({ theme: "light" }));
    await secondSave.promise;
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Theme / })).toHaveTextContent("Light"),
    );

    expect(screen.getByRole("button", { name: /^Theme / })).toHaveTextContent("Light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(
      screen.queryByText(/Theme is saved on this device but has not synced/),
    ).not.toBeInTheDocument();
  });

  it("applies the loaded and saved theme", async () => {
    const user = userEvent.setup();
    mockAuth(signedInResponse, "dark");

    renderApp();

    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "dark"));

    await user.click(screen.getByRole("link", { name: "Settings" }));
    await selectTheme(user, "Light");

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) => {
          return (
            input instanceof Request &&
            input.method === "PUT" &&
            input.url === "http://localhost/api/settings"
          );
        }),
      ).toBe(true),
    );
  });
});
