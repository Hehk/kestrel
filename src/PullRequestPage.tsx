import { Tooltip } from "@kobalte/core/tooltip";
import * as stylex from "@stylexjs/stylex";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import type { Accessor, JSX, ParentProps } from "solid-js";
import { appStore, send } from "./store";
import * as Repositories from "./repositoriesSlice";
import { apiUrl } from "./api/client";
import { Link } from "./Link";
import { Anchor } from "./components/Anchor";
import { Button } from "./components/Button";
import {
  ArrowLeftIcon,
  CheckIcon,
  GitHubIcon,
  HourglassIcon,
  MinusIcon,
  SyncIcon,
  XIcon,
} from "./icons/Icons";
import PullRequestsError from "./PullRequestError";
import type { PullRequestView } from "./router";
import { DiffView } from "./diff/DiffView";
import { diffFileHunks } from "./diff/layout";
import { styles as baseStyles } from "./styles/base";
import { tokens } from "./styles/tokens.stylex";

const mobile = "@media (max-width: 640px)";
const narrow = "@media (max-width: 1100px)";
const syncing = stylex.keyframes({ to: { transform: "rotate(360deg)" } });

const styles = stylex.create({
  page: {
    width: { default: "min(1280px, calc(100vw - 32px))", [mobile]: "calc(100vw - 24px)" },
    display: "grid",
    gridTemplateAreas: {
      default: '"header header header" "left content right"',
      [narrow]: '"header" "left" "content" "right"',
    },
    gridTemplateColumns: {
      default: "minmax(0, 1fr) minmax(0, 720px) minmax(0, 1fr)",
      [narrow]: "minmax(0, 720px)",
    },
    alignItems: "start",
    justifyContent: { default: "normal", [narrow]: "center" },
    marginBlock: "0",
    marginInline: "auto",
    padding: { default: "2rem 0 1rem", [mobile]: "24px 0 48px" },
  },
  diffPage: {
    width: "auto",
    gridTemplateAreas: '"header" "diff"',
    gridTemplateColumns: "minmax(0, 1fr)",
    marginRight: {
      default: "calc(16px + env(safe-area-inset-right))",
      [mobile]: "calc(12px + env(safe-area-inset-right))",
    },
    marginLeft: {
      default: "calc(16px + env(safe-area-inset-left))",
      [mobile]: "calc(12px + env(safe-area-inset-left))",
    },
  },
  header: {
    gridColumnEnd: "header",
    gridColumnStart: "header",
    gridRowEnd: "header",
    gridRowStart: "header",
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr) minmax(0, 720px) minmax(0, 1fr)",
      [narrow]: "minmax(0, 720px)",
    },
    justifyContent: { default: "normal", [narrow]: "center" },
    minWidth: 0,
    marginBottom: "1.5rem",
  },
  headerSection: {
    minWidth: 0,
    boxSizing: "border-box",
    paddingBlock: "0",
    paddingInline: "1rem",
    gridColumnStart: { default: null, [narrow]: "1" },
    gridColumnEnd: { default: null, [narrow]: "auto" },
  },
  headerActions: {
    gridColumnStart: "1",
    gridColumnEnd: "auto",
    marginBottom: { default: 0, [narrow]: "1rem" },
  },
  heading: {
    gridColumnStart: { default: "2", [narrow]: "1" },
    gridColumnEnd: "auto",
  },
  title: {
    marginTop: 0,
  },
  views: {
    display: "flex",
    gap: "1rem",
    marginTop: "0.75rem",
    paddingBottom: "0.45rem",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.rule,
    fontFamily: tokens.mono,
    fontSize: "0.85rem",
  },
  diffContent: {
    gridColumnEnd: "diff",
    gridColumnStart: "diff",
    gridRowEnd: "diff",
    gridRowStart: "diff",
    minWidth: 0,
    boxSizing: "border-box",
    paddingBlock: "1.25rem",
    paddingInline: "1rem",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: tokens.rule,
  },
  diffHeading: {
    marginTop: "0",
    marginRight: "0",
    marginBottom: "0.5rem",
    marginLeft: "0",
  },
  content: {
    gridColumnEnd: "content",
    gridColumnStart: "content",
    gridRowEnd: "content",
    gridRowStart: "content",
    minWidth: 0,
    boxSizing: "border-box",
    paddingBlock: "0",
    paddingInline: "1rem",
  },
  sidebar: {
    minWidth: 0,
    boxSizing: "border-box",
    paddingBlock: "0",
    paddingInline: "1rem",
  },
  leftSidebar: {
    gridColumnEnd: "left",
    gridColumnStart: "left",
    gridRowEnd: "left",
    gridRowStart: "left",
    position: { default: "sticky", [narrow]: "static" },
    top: { default: "2rem", [narrow]: "auto" },
    height: { default: "calc(100svh - 3rem)", [narrow]: "auto" },
    display: { default: "flex", [narrow]: "block" },
    flexDirection: "column",
    gap: "1.5rem",
    marginBottom: { default: 0, [narrow]: { default: 0, ":not(:empty)": "2rem" } },
  },
  rightSidebar: {
    gridColumnEnd: "right",
    gridColumnStart: "right",
    gridRowEnd: "right",
    gridRowStart: "right",
    display: "grid",
    gap: "1.5rem",
    marginTop: { default: 0, [narrow]: { default: 0, ":not(:empty)": "2rem" } },
  },
  sidebarActions: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: "0.35rem",
    marginBottom: { default: 0, [narrow]: "1.5rem" },
  },
  pageBack: {
    width: "2rem",
    marginBottom: "1rem",
  },
  syncIcon: {
    animationName: { default: syncing, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "0.8s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  detailSections: {
    display: "grid",
    gap: "1rem",
    marginTop: "1rem",
  },
  detailSection: {
    display: "grid",
    gap: "0.45rem",
    paddingTop: "0.85rem",
  },
  detailHeading: {
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
    fontSize: "1rem",
  },
  description: {
    paddingTop: "0.25rem",
    paddingRight: "0",
    paddingBottom: "1.5rem",
    paddingLeft: "0",
  },
  descriptionText: {
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
    lineHeight: 1.7,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  activityHeading: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "1rem",
  },
  activityItemHeading: {
    display: "flex",
    alignItems: { default: "flex-start", [mobile]: "stretch" },
    justifyContent: "space-between",
    gap: "1rem",
    flexDirection: { default: "row", [mobile]: "column" },
  },
  activityList: {
    padding: 0,
    margin: 0,
    listStyle: "none",
  },
  activityItem: {
    position: "relative",
    paddingTop: "0.85rem",
    paddingRight: "0",
    paddingBottom: "1rem",
    paddingLeft: "1.25rem",
    "::before": {
      position: "absolute",
      top: "1.15rem",
      left: "0.1rem",
      width: "0.45rem",
      height: "0.45rem",
      content: '""',
      backgroundColor: tokens.textMuted,
      borderRadius: "50%",
    },
    "::after": {
      position: "absolute",
      top: "1.6rem",
      bottom: "-0.25rem",
      left: "0.3rem",
      width: "1px",
      content: '""',
      backgroundColor: tokens.rule,
      display: { default: "block", ":last-child": "none" },
    },
  },
  activityHeadingText: {
    minWidth: 0,
  },
  activityTime: {
    flexGrow: "0",
    flexShrink: "0",
    flexBasis: "auto",
    whiteSpace: "nowrap",
  },
  activityBody: {
    maxWidth: "66ch",
    marginTop: "0.65rem",
    marginRight: "0",
    marginBottom: "0",
    marginLeft: "0",
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  reviewComments: {
    display: "grid",
    gap: "0.75rem",
    paddingTop: "0.75rem",
    paddingRight: "0",
    paddingBottom: "0",
    paddingLeft: "0",
    marginTop: "0.75rem",
    marginRight: "0",
    marginBottom: "0",
    marginLeft: "0",
    listStyle: "none",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: tokens.rule,
  },
  reviewComment: {
    paddingLeft: "0.75rem",
    borderLeftWidth: 2,
    borderLeftStyle: "solid",
    borderLeftColor: tokens.rule,
  },
  activityTruncated: {
    maxWidth: "66ch",
    marginTop: "0.75rem",
    marginRight: "0",
    marginBottom: "0",
    marginLeft: "0",
    color: tokens.textMuted,
    fontSize: "0.88rem",
  },
  loadOlder: {
    display: "flex",
    justifySelf: "start",
    marginTop: "0.35rem",
  },
  sidebarSection: {
    minHeight: 0,
    display: "grid",
    gap: "0.45rem",
  },
  scrollableSidebarSection: {
    overflowY: "auto",
  },
  reviewSection: {
    marginBottom: { default: 0, [narrow]: "1.5rem" },
  },
  sidebarHeader: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "1rem",
    paddingInline: "0.25rem",
  },
  sidebarTitle: {
    margin: 0,
    fontFamily: tokens.mono,
    fontSize: tokens.fontSizeExtraSmall,
    lineHeight: 1.45,
  },
  sidebarCount: {
    color: tokens.textMuted,
    fontFamily: tokens.mono,
    fontSize: tokens.fontSizeExtraSmall,
    lineHeight: 1.45,
  },
  sidebarList: {
    display: "grid",
    gap: "0.125rem",
    padding: 0,
    margin: 0,
    listStyle: "none",
  },
  sidebarItem: {
    minWidth: 0,
  },
  sidebarDataRow: {
    minWidth: 0,
    minHeight: "1.5rem",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "baseline",
    gap: "0.5rem",
    paddingInline: "0.25rem",
  },
  sidebarData: {
    fontFamily: tokens.mono,
    fontSize: tokens.fontSizeExtraSmall,
    lineHeight: 1.45,
  },
  sidebarDataPrimary: {
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  sidebarDataSecondary: {
    color: tokens.textMuted,
    whiteSpace: "nowrap",
  },
  sidebarEmpty: {
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
    paddingInline: "0.25rem",
    color: tokens.textMuted,
    fontFamily: tokens.mono,
    fontSize: tokens.fontSizeExtraSmall,
    lineHeight: 1.45,
  },
  reviewDecision: {
    maxWidth: "66ch",
    minHeight: "1.5rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    paddingInline: "0.25rem",
    margin: 0,
  },
  metadataList: {
    display: "grid",
    gap: "0.125rem",
    paddingInline: "0.25rem",
    margin: 0,
  },
  metadataItem: {
    minHeight: "1.5rem",
    display: "grid",
    gridTemplateColumns: "4.5rem minmax(0, 1fr)",
    alignItems: "baseline",
    gap: "0.5rem",
  },
  metadataTerm: {
    color: tokens.textMuted,
    fontFamily: tokens.mono,
    fontSize: tokens.fontSizeExtraSmall,
    lineHeight: 1.45,
  },
  metadataValue: {
    minWidth: 0,
    margin: 0,
    overflowWrap: "anywhere",
    textAlign: "right",
    fontFamily: tokens.mono,
    fontSize: tokens.fontSizeExtraSmall,
    lineHeight: 1.45,
  },
  sidebarTime: {
    whiteSpace: "nowrap",
  },
  statusName: {
    fontFamily: tokens.mono,
    fontSize: tokens.fontSizeExtraSmall,
    lineHeight: 1.45,
  },
  statusIcon: {
    display: "inline-flex",
    flexGrow: "0",
    flexShrink: "0",
    flexBasis: "auto",
    color: tokens.statusNeutral,
  },
  statusSuccess: { color: tokens.statusSuccess },
  statusFailure: { color: tokens.statusFailure },
  statusPending: { color: tokens.statusPending },
  tooltipPositioner: {
    zIndex: 20,
  },
  tooltip: {
    display: "grid",
    gap: "0.2rem",
    boxSizing: "border-box",
    maxWidth: "min(20rem, calc(100vw - 24px))",
    paddingBlock: "0.5rem",
    paddingInline: "0.65rem",
    color: tokens.text,
    backgroundColor: tokens.background,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.border,
    borderRadius: tokens.borderRadius,
    boxShadow: "0.25rem 0.25rem 0 rgb(0 0 0 / 12%)",
    fontFamily: tokens.mono,
    fontSize: tokens.fontSizeExtraSmall,
    lineHeight: 1.45,
    outline: "none",
  },
  checkTooltip: {
    width: "min(20rem, calc(100vw - 24px))",
  },
  tooltipSecondary: {
    color: tokens.textMuted,
  },
  tooltipText: {
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
  },
  tooltipDetailTitle: {
    fontWeight: 700,
  },
  tooltipAction: {
    marginTop: "0.3rem",
  },
  eyebrow: {
    marginTop: "0",
    marginRight: "0",
    marginBottom: "0.35rem",
    marginLeft: "0",
    color: tokens.textMuted,
    fontFamily: tokens.mono,
    fontSize: "0.78rem",
  },
  repoStatus: {
    maxWidth: "66ch",
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
    color: tokens.textMuted,
    fontSize: "0.92rem",
  },
  repoPrMeta: {
    color: tokens.textMuted,
    fontFamily: tokens.mono,
    fontSize: "0.78rem",
  },
  message: {
    width: { default: "min(720px, calc(100vw - 32px))", [mobile]: "min(100% - 24px, 720px)" },
    marginBlock: "0",
    marginInline: "auto",
    padding: { default: "40px 0 64px", [mobile]: "24px 0 48px" },
    textAlign: "left",
  },
});

// TODO: Figure out a better way to handle all the error cases
const PullRequestPage = ({
  repo,
  id,
  view,
}: {
  repo: string;
  id: string;
  view: PullRequestView;
}) => {
  const repositories = appStore((state) => state.repositories);
  const page = createMemo<PullRequestPageData | PullRequestMessageData>(() => {
    const state = repositories();

    if (state.status === "loading") {
      return {
        content: <p {...stylex.attrs(baseStyles.paragraph)}>Loading repository...</p>,
        kind: "message",
        title: repo,
      };
    }

    if (state.status === "error") {
      return {
        content: <p {...stylex.attrs(baseStyles.paragraph)}>Repositories could not be loaded.</p>,
        kind: "message",
        title: repo,
      };
    }

    const repository = state.repositories.find(
      (candidate) => candidate.fullName === repo.toLowerCase(),
    );
    if (repository === undefined) {
      return {
        content: <p {...stylex.attrs(baseStyles.paragraph)}>Repository is not tracked.</p>,
        kind: "message",
        title: repo,
      };
    }

    const number = Number(id);
    if (!Number.isInteger(number) || number <= 0) {
      return {
        content: <p {...stylex.attrs(baseStyles.paragraph)}>Pull request number is invalid.</p>,
        kind: "message",
        title: repo,
      };
    }

    const pullRequests = state.pullRequests[repository.fullName];
    if (pullRequests === undefined) {
      return {
        content: <p {...stylex.attrs(baseStyles.paragraph)}>Loading pull requests...</p>,
        kind: "message",
        title: `${repo} #${id}`,
      };
    }

    if (pullRequests.status === "loading" || pullRequests.status === "syncing") {
      return {
        content: (
          <p {...stylex.attrs(baseStyles.paragraph)}>
            {pullRequests.status === "loading" ? "Loading" : "Syncing"} pull requests...
          </p>
        ),
        kind: "message",
        title: `${repo} #${id}`,
      };
    }

    if (pullRequests.status === "error") {
      return {
        content: <PullRequestsError error={pullRequests.error} />,
        kind: "message",
        title: `${repo} #${id}`,
      };
    }

    const pullRequest = pullRequests.pullRequests.find((candidate) => candidate.number === number);
    if (pullRequest === undefined) {
      return {
        content: (
          <>
            <p {...stylex.attrs(baseStyles.paragraph)}>Pull request is not stored yet.</p>
            <Button
              onClick={() =>
                send({
                  kind: "Repositories",
                  msg: { kind: "PullRequestsSyncRequested", repository },
                })
              }
              type="button"
            >
              Sync pull requests
            </Button>
          </>
        ),
        kind: "message",
        title: `${repo} #${id}`,
      };
    }

    const pullRequestDetail =
      state.pullRequestDetails[Repositories.pullRequestDetailKey(repository, number)];
    const currentPullRequestDiff = state.currentPullRequestDiff;
    const pullRequestDiff =
      currentPullRequestDiff?.key === Repositories.pullRequestDiffKey(repository, number)
        ? currentPullRequestDiff.state
        : undefined;
    return {
      kind: "ready",
      number,
      pullRequest,
      pullRequestDetail,
      pullRequestDiff,
      repository,
    };
  });

  const ready = () => (page().kind === "ready" ? (page() as PullRequestPageData) : undefined);
  const message = () =>
    page().kind === "message" ? (page() as PullRequestMessageData) : undefined;

  return (
    <Switch>
      <Match when={ready()}>{(data) => <PullRequestContent data={data} view={view} />}</Match>
      <Match when={message()}>
        {(data) => <PullRequestMessage title={data().title}>{data().content}</PullRequestMessage>}
      </Match>
    </Switch>
  );
};

type PullRequestPageData = {
  kind: "ready";
  number: number;
  pullRequest: Repositories.PullRequest;
  pullRequestDetail: Repositories.PullRequestDetailState | undefined;
  pullRequestDiff: Repositories.PullRequestDiffState | undefined;
  repository: Repositories.Repository;
};

type PullRequestMessageData = {
  content: JSX.Element;
  kind: "message";
  title: string;
};

const PullRequestContent = (props: {
  data: Accessor<PullRequestPageData>;
  view: PullRequestView;
}) => {
  const details = () => getDetails(props.data().pullRequestDetail);

  return (
    <div
      data-pr-view={props.view}
      {...stylex.attrs(styles.page, props.view === "diff" && styles.diffPage)}
    >
      <PullRequestHeader data={props.data} view={props.view} />
      <Show when={props.view === "overview"} fallback={<PullRequestDiff data={props.data} />}>
        <aside
          aria-label="Pull request status"
          {...stylex.attrs(styles.sidebar, styles.leftSidebar)}
        >
          <PullRequestReviewStatus details={details} />
          <PullRequestChecks details={details} />
        </aside>
        <section {...stylex.attrs(styles.content)} data-pr-content="">
          <PullRequestDetailPanel data={props.data} />
        </section>
        <aside
          aria-label="Pull request metadata"
          {...stylex.attrs(styles.sidebar, styles.rightSidebar)}
        >
          <PullRequestMetadata data={props.data} />
          <Show when={details()}>
            {(detail) => (
              <>
                <PullRequestFiles files={() => detail().files} />
                <PullRequestCommits commits={() => detail().commits} />
              </>
            )}
          </Show>
        </aside>
      </Show>
    </div>
  );
};

const PullRequestHeader = (props: {
  data: Accessor<PullRequestPageData>;
  view: PullRequestView;
}) => (
  <header {...stylex.attrs(styles.header)}>
    <div {...stylex.attrs(styles.headerSection, styles.headerActions)}>
      <PullRequestActions data={props.data} view={props.view} />
    </div>
    <div {...stylex.attrs(styles.headerSection, styles.heading)}>
      <h1 {...stylex.attrs(baseStyles.heading, baseStyles.heading1, styles.title)}>
        {props.data().pullRequest.title}
      </h1>
      <nav aria-label="Pull request views" {...stylex.attrs(styles.views)}>
        <Link
          variant="navigation"
          aria-current={props.view === "overview" ? "page" : undefined}
          to={{
            name: "PullRequest",
            repo: props.data().repository.fullName,
            id: String(props.data().number),
            view: "overview",
          }}
        >
          Overview
        </Link>
        <Link
          variant="navigation"
          aria-current={props.view === "diff" ? "page" : undefined}
          to={{
            name: "PullRequest",
            repo: props.data().repository.fullName,
            id: String(props.data().number),
            view: "diff",
          }}
        >
          Diff
        </Link>
      </nav>
    </div>
  </header>
);

const PullRequestDiff = (props: { data: Accessor<PullRequestPageData> }) => {
  const detailState = () => props.data().pullRequestDetail;
  const diffState = () => props.data().pullRequestDiff;
  const diff = () => diffState()?.diff;
  const error = () => {
    const state = diffState();
    return state?.status === "error" ? state.error : undefined;
  };

  return (
    <section
      aria-label="Pull request diff"
      data-pr-diff-content=""
      {...stylex.attrs(styles.diffContent)}
    >
      <p {...stylex.attrs(baseStyles.paragraph, styles.eyebrow)}>Changed files</p>
      <h2 {...stylex.attrs(baseStyles.heading, baseStyles.heading2, styles.diffHeading)}>
        Diff view
      </h2>
      <div aria-live="polite">
        <Switch>
          <Match when={detailState()?.status === "syncing"}>
            <p {...stylex.attrs(styles.repoStatus)}>Syncing pull request details...</p>
          </Match>
          <Match when={detailState()?.status === "error"}>
            <PullRequestDetailError
              error={
                (detailState() as Extract<Repositories.PullRequestDetailState, { status: "error" }>)
                  .error
              }
            />
          </Match>
        </Switch>
        <Show
          when={diff()}
          fallback={
            <Switch
              fallback={<p {...stylex.attrs(styles.repoStatus)}>Loading pull request diff...</p>}
            >
              <Match when={error()}>
                {(currentError) => <PullRequestDiffError error={currentError()} />}
              </Match>
            </Switch>
          }
        >
          <>
            <Show when={diffState()?.status === "loading"}>
              <p {...stylex.attrs(styles.repoStatus)}>Refreshing pull request diff...</p>
            </Show>
            <Show when={error()}>
              {(currentError) => (
                <>
                  <PullRequestDiffError error={currentError()} />
                  <p {...stylex.attrs(styles.repoStatus)}>
                    Showing the last successfully loaded diff.
                  </p>
                </>
              )}
            </Show>
          </>
        </Show>
      </div>
      <Show when={diff()}>
        {(currentDiff) => (
          <Show
            keyed
            when={Repositories.pullRequestDiffKey(props.data().repository, props.data().number)}
          >
            <div>
              <PullRequestDiffTotals diff={currentDiff()} />
            </div>
          </Show>
        )}
      </Show>
    </section>
  );
};

const PullRequestDiffTotals = (props: { diff: Repositories.PullRequestDiff }) => {
  const lineCount = () =>
    props.diff.files.reduce(
      (total, file) =>
        total + diffFileHunks(file).reduce((fileTotal, hunk) => fileTotal + hunk.lines.length, 0),
      0,
    );

  return (
    <Show
      when={props.diff.files.length > 0}
      fallback={<p {...stylex.attrs(styles.repoStatus)}>This pull request has no changed files.</p>}
    >
      <p {...stylex.attrs(styles.repoStatus)}>
        {props.diff.files.length} changed {props.diff.files.length === 1 ? "file" : "files"},{" "}
        {lineCount()} source {lineCount() === 1 ? "line" : "lines"}.
      </p>
      <DiffView diff={props.diff} />
    </Show>
  );
};

const PullRequestDiffError = ({ error }: { error: Repositories.PullRequestDiffError }) => {
  switch (error) {
    case "authenticationRequired":
      return (
        <p {...stylex.attrs(styles.repoStatus)}>Authentication is required to load this diff.</p>
      );
    case "authorizationRequired":
      return (
        <p {...stylex.attrs(styles.repoStatus)}>
          GitHub App authorization required.{" "}
          <Anchor href={apiUrl("/api/github-app/authorize")}>Authorize more repos</Anchor>.
        </p>
      );
    case "diffParseFailed":
      return <p {...stylex.attrs(styles.repoStatus)}>The stored diff could not be parsed.</p>;
    case "diffResourceLimitExceeded":
      return <p {...stylex.attrs(styles.repoStatus)}>The stored diff is too large to display.</p>;
    case "diffUnavailable":
      return (
        <p {...stylex.attrs(styles.repoStatus)}>The stored pull request does not include a diff.</p>
      );
    case "pullRequestNotFound":
      return <p {...stylex.attrs(styles.repoStatus)}>Pull request details are not stored yet.</p>;
    case "repositoryNotTracked":
      return <p {...stylex.attrs(styles.repoStatus)}>Repository is not tracked.</p>;
    case "invalidPullRequest":
    case "invalidRepository":
      return <p {...stylex.attrs(styles.repoStatus)}>The pull request diff URL is invalid.</p>;
    case "loadFailed":
      return <p {...stylex.attrs(styles.repoStatus)}>The pull request diff could not be loaded.</p>;
  }
};

const PullRequestMessage = ({ children, title }: ParentProps<{ title: string }>) => (
  <section {...stylex.attrs(styles.message)}>
    <div {...stylex.attrs(styles.pageBack)}>
      <Link aria-label="Back to home" variant="icon" title="Back to home" to={{ name: "Home" }}>
        <ArrowLeftIcon />
      </Link>
    </div>
    <h1 {...stylex.attrs(baseStyles.heading, baseStyles.heading1, styles.title)}>{title}</h1>
    {children}
  </section>
);

const PullRequestActions = (props: {
  data: Accessor<PullRequestPageData>;
  view: PullRequestView;
}) => {
  const diffLoading = () =>
    props.view === "diff" && props.data().pullRequestDiff?.status === "loading";
  const lastSyncedAt = () =>
    props.data().pullRequestDetail?.detail?.syncedAt ??
    props.data().pullRequestDiff?.diff?.syncedAt ??
    props.data().pullRequest.syncedAt;

  return (
    <nav aria-label="Pull request actions" {...stylex.attrs(styles.sidebarActions)}>
      <Tooltip closeDelay={150} gutter={8} ignoreSafeArea openDelay={0}>
        <Tooltip.Trigger as={Link} aria-label="Back to home" variant="icon" to={{ name: "Home" }}>
          <ArrowLeftIcon />
        </Tooltip.Trigger>
        <PullRequestTooltip>Back to tracked repositories</PullRequestTooltip>
      </Tooltip>
      <Tooltip closeDelay={150} gutter={8} ignoreSafeArea openDelay={0}>
        <Tooltip.Trigger
          as={Anchor}
          aria-label="Open on GitHub"
          variant="icon"
          href={props.data().pullRequest.htmlUrl}
        >
          <GitHubIcon />
        </Tooltip.Trigger>
        <PullRequestTooltip>Open this pull request on GitHub</PullRequestTooltip>
      </Tooltip>
      <Tooltip closeDelay={150} gutter={8} ignoreSafeArea openDelay={0}>
        <Tooltip.Trigger
          as={Button}
          aria-busy={props.data().pullRequestDetail?.status === "syncing"}
          aria-label="Sync pull request from GitHub"
          variant="icon"
          disabled={
            props.data().pullRequestDetail?.status === "loading" ||
            props.data().pullRequestDetail?.status === "loadingTimeline" ||
            props.data().pullRequestDetail?.status === "syncing" ||
            diffLoading()
          }
          onClick={() =>
            send({
              kind: "Repositories",
              msg: {
                kind: "PullRequestDetailSyncRequested",
                number: props.data().number,
                repository: props.data().repository,
              },
            })
          }
          type="button"
        >
          <SyncIcon
            data-syncing={props.data().pullRequestDetail?.status === "syncing" ? "" : undefined}
            {...stylex.attrs(
              props.data().pullRequestDetail?.status === "syncing" && styles.syncIcon,
            )}
          />
        </Tooltip.Trigger>
        <PullRequestTooltip>
          <span>Sync pull request from GitHub</span>
          <span {...stylex.attrs(styles.tooltipSecondary)}>
            Last synced:{" "}
            {lastSyncedAt() === undefined ? "Never" : formatLocalDateTime(lastSyncedAt() ?? "")}
          </span>
        </PullRequestTooltip>
      </Tooltip>
    </nav>
  );
};

const PullRequestTooltip = ({ children }: ParentProps) => (
  <Tooltip.Portal>
    <Tooltip.Content {...stylex.attrs(styles.tooltip, styles.tooltipPositioner)}>
      {children}
    </Tooltip.Content>
  </Tooltip.Portal>
);

const getDetails = (details: Repositories.PullRequestDetailState | undefined) => {
  if (details === undefined) {
    return undefined;
  }
  if (details.detail !== null) {
    return details.detail;
  }
  return undefined;
};

const PullRequestDetailPanel = (props: { data: Accessor<PullRequestPageData> }) => {
  const detailState = () => props.data().pullRequestDetail;
  const detail = () => getDetails(detailState());
  return (
    <Switch fallback={<p {...stylex.attrs(styles.repoStatus)}>Pull request details not loaded.</p>}>
      <Match when={detailState()?.status === "loading"}>
        <p {...stylex.attrs(styles.repoStatus)}>Loading pull request details...</p>
      </Match>
      <Match when={detailState()?.status === "syncing"}>
        <p {...stylex.attrs(styles.repoStatus)}>Syncing pull request details...</p>
      </Match>
      <Match when={detailState()?.status === "error" && detail() === undefined}>
        <PullRequestDetailError
          error={
            (detailState() as Extract<Repositories.PullRequestDetailState, { status: "error" }>)
              .error
          }
        />
      </Match>
      <Match when={detail()}>
        <div {...stylex.attrs(styles.detailSections)}>
          <Show when={detailState()?.status === "error"}>
            <PullRequestDetailError
              error={
                (detailState() as Extract<Repositories.PullRequestDetailState, { status: "error" }>)
                  .error
              }
            />
          </Show>
          <PullRequestDescription body={() => detail()?.body} />
          <PullRequestTimeline data={props.data} />
        </div>
      </Match>
    </Switch>
  );
};

const PullRequestDetailError = ({ error }: { error: Repositories.PullRequestsError }) => {
  switch (error) {
    case "authorizationRequired":
      return (
        <p {...stylex.attrs(styles.repoStatus)}>
          GitHub App authorization required.{" "}
          <Anchor href={apiUrl("/api/github-app/authorize")}>Authorize more repos</Anchor>.
        </p>
      );
    case "pullRequestNotFound":
      return <p {...stylex.attrs(styles.repoStatus)}>Pull request details are not stored yet.</p>;
    case "repositoryNotTracked":
      return <p {...stylex.attrs(styles.repoStatus)}>Repository is not tracked.</p>;
    case "syncFailed":
      return <p {...stylex.attrs(styles.repoStatus)}>Pull request details could not be loaded.</p>;
  }
};

const PullRequestFiles = (props: { files: Accessor<Repositories.PullRequestDetail["files"]> }) => {
  return (
    <section {...stylex.attrs(styles.sidebarSection)}>
      <header {...stylex.attrs(styles.sidebarHeader)}>
        <h2 {...stylex.attrs(baseStyles.heading, styles.sidebarTitle)}>Files changed</h2>
        <span {...stylex.attrs(styles.sidebarCount)}>{props.files().length}</span>
      </header>
      {props.files().length === 0 ? (
        <p {...stylex.attrs(styles.sidebarEmpty)}>None stored.</p>
      ) : (
        <ul {...stylex.attrs(styles.sidebarList)}>
          <For each={props.files()}>
            {(file) => (
              <li {...stylex.attrs(styles.sidebarDataRow)}>
                <span {...stylex.attrs(styles.sidebarData, styles.sidebarDataPrimary)}>
                  {file.filename}
                </span>
                <span {...stylex.attrs(styles.sidebarData, styles.sidebarDataSecondary)}>
                  {file.status}
                </span>
              </li>
            )}
          </For>
        </ul>
      )}
    </section>
  );
};

const PullRequestCommits = (props: {
  commits: Accessor<Repositories.PullRequestDetail["commits"]>;
}) => {
  return (
    <section {...stylex.attrs(styles.sidebarSection)}>
      <header {...stylex.attrs(styles.sidebarHeader)}>
        <h2 {...stylex.attrs(baseStyles.heading, styles.sidebarTitle)}>Commits</h2>
        <span {...stylex.attrs(styles.sidebarCount)}>{props.commits().length}</span>
      </header>
      {props.commits().length === 0 ? (
        <p {...stylex.attrs(styles.sidebarEmpty)}>None stored.</p>
      ) : (
        <ul {...stylex.attrs(styles.sidebarList)}>
          <For each={props.commits()}>
            {(commit) => (
              <li {...stylex.attrs(styles.sidebarDataRow)}>
                <span {...stylex.attrs(styles.sidebarData, styles.sidebarDataPrimary)}>
                  {commit.message}
                </span>
                <span {...stylex.attrs(styles.sidebarData, styles.sidebarDataSecondary)}>
                  {commit.sha.slice(0, 7)}
                </span>
              </li>
            )}
          </For>
        </ul>
      )}
    </section>
  );
};

const PullRequestDescription = (props: { body: Accessor<string | null | undefined> }) => {
  return (
    <section aria-label="Pull request description" {...stylex.attrs(styles.description)}>
      {props.body()?.trim() ? (
        <p {...stylex.attrs(baseStyles.paragraph, styles.descriptionText)}>{props.body()}</p>
      ) : (
        <p {...stylex.attrs(styles.repoStatus)}>No description provided.</p>
      )}
    </section>
  );
};

const PullRequestTimeline = (props: { data: Accessor<PullRequestPageData> }) => {
  const detailState = () => props.data().pullRequestDetail;
  const detail = () => getDetails(detailState());
  const timeline = () => detail()?.timeline ?? [];

  return (
    <section
      aria-labelledby="pull-request-activity-heading"
      {...stylex.attrs(styles.detailSection)}
    >
      <header {...stylex.attrs(styles.activityHeading)}>
        <h2
          {...stylex.attrs(baseStyles.heading, baseStyles.heading2, styles.detailHeading)}
          id="pull-request-activity-heading"
        >
          Activity
        </h2>
        <span {...stylex.attrs(styles.repoPrMeta)}>
          {timeline().some((event) => event.id === undefined && event.occurredAt === undefined)
            ? "Stored activity; sync to refresh"
            : "Newest first"}
        </span>
      </header>
      {timeline().length === 0 ? (
        <p {...stylex.attrs(styles.repoStatus)}>No activity stored.</p>
      ) : (
        <ol {...stylex.attrs(styles.activityList)}>
          <For each={timeline()}>{(event) => <PullRequestTimelineItem event={event} />}</For>
        </ol>
      )}
      {detailState()?.status === "timelineError" ? (
        <p {...stylex.attrs(styles.repoStatus)} role="alert">
          Older activity could not be loaded. Try again.
        </p>
      ) : null}
      <Show when={detail()?.timelinePagination.kind === "hasOlder"}>
        <div {...stylex.attrs(styles.loadOlder)}>
          <Button
            aria-busy={detailState()?.status === "loadingTimeline"}
            disabled={detailState()?.status === "loadingTimeline"}
            onClick={() =>
              send({
                kind: "Repositories",
                msg: {
                  kind: "PullRequestTimelineOlderRequested",
                  number: props.data().number,
                  repository: props.data().repository,
                },
              })
            }
            type="button"
          >
            {detailState()?.status === "loadingTimeline"
              ? "Loading older activity..."
              : "Load older activity"}
          </Button>
        </div>
      </Show>
    </section>
  );
};

type TimelineEvent = Repositories.PullRequestDetail["timeline"][number];

const PullRequestTimelineItem = ({ event }: { event: TimelineEvent }) => {
  const action = timelineAction(event);
  const actor = event.actorLogin ?? "GitHub";
  const payload = event.event;
  const body =
    "body" in payload ? payload.body : payload.kind === "committed" ? payload.message : undefined;
  const url = "url" in payload ? payload.url : undefined;
  const reviewComments = payload.kind === "reviewed" ? payload.reviewComments.items : [];
  const reviewCommentsTruncated =
    payload.kind === "reviewed" && payload.reviewComments.kind === "truncated";

  return (
    <li {...stylex.attrs(styles.activityItem)}>
      <div {...stylex.attrs(styles.activityItemHeading)}>
        <span {...stylex.attrs(styles.activityHeadingText)}>
          <strong>{actor}</strong>{" "}
          {url ? (
            <Anchor href={url} rel="noreferrer" target="_blank">
              {action}
            </Anchor>
          ) : (
            action
          )}
        </span>
        {event.occurredAt ? (
          <time
            {...stylex.attrs(styles.repoPrMeta, styles.activityTime)}
            dateTime={event.occurredAt}
          >
            {formatLocalDateTime(event.occurredAt)}
          </time>
        ) : null}
      </div>
      {body ? <p {...stylex.attrs(styles.activityBody)}>{body}</p> : null}
      {reviewComments.length === 0 ? null : (
        <ul aria-label="Review comments" {...stylex.attrs(styles.reviewComments)}>
          {reviewComments.map((comment) => (
            <li {...stylex.attrs(styles.reviewComment)}>
              <div {...stylex.attrs(styles.activityItemHeading)}>
                <strong>{comment.actorLogin ?? "GitHub"}</strong>
                {comment.occurredAt ? (
                  <time
                    {...stylex.attrs(styles.repoPrMeta, styles.activityTime)}
                    dateTime={comment.occurredAt}
                  >
                    {formatLocalDateTime(comment.occurredAt)}
                  </time>
                ) : null}
              </div>
              {comment.body ? <p {...stylex.attrs(styles.activityBody)}>{comment.body}</p> : null}
            </li>
          ))}
        </ul>
      )}
      {reviewCommentsTruncated ? (
        <p {...stylex.attrs(styles.activityTruncated)}>
          Additional review comments are available.{" "}
          {url ? (
            <Anchor href={url} rel="noreferrer" target="_blank">
              View the complete review on GitHub
            </Anchor>
          ) : (
            "Open the review on GitHub to see them."
          )}
        </p>
      ) : null}
    </li>
  );
};

const timelineAction = (event: TimelineEvent): string => {
  const payload = event.event;
  switch (payload.kind) {
    case "commented":
      return "commented";
    case "committed":
      return payload.commitSha ? `committed ${payload.commitSha.slice(0, 7)}` : "committed";
    case "reviewed":
      return reviewAction(payload.state);
    case "closed":
      return "closed the pull request";
    case "reopened":
      return "reopened the pull request";
    case "merged":
      return "merged the pull request";
    case "readyForReview":
      return "marked the pull request ready for review";
    case "convertedToDraft":
      return "converted the pull request to draft";
    case "reviewRequested":
      return payload.reviewer
        ? `requested a review from ${payload.reviewer}`
        : "requested a review";
    case "reviewRequestRemoved":
      return payload.reviewer
        ? `removed the review request for ${payload.reviewer}`
        : "removed a review request";
    case "reviewDismissed":
      return "dismissed a review";
    case "headRefForcePushed":
      return "force-pushed the head branch";
    case "baseRefForcePushed":
      return "force-pushed the base branch";
    case "headRefDeleted":
      return payload.name ? `deleted the ${payload.name} branch` : "deleted the head branch";
    case "headRefRestored":
      return "restored the head branch";
    case "unknown":
      return humanizeEvent(payload.name ?? "unknown");
  }
};

const reviewAction = (state?: string | null | undefined) => {
  switch (state) {
    case "APPROVED":
      return "approved the pull request";
    case "CHANGES_REQUESTED":
      return "requested changes";
    case "COMMENTED":
      return "reviewed with comments";
    case "DISMISSED":
      return "submitted a dismissed review";
    default:
      return "submitted a review";
  }
};

const humanizeEvent = (event: string) => {
  const label = event
    .replace(/Event$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .trim()
    .toLowerCase();
  return label === "" ? "updated the pull request" : label;
};

const PullRequestChecks = (props: { details: Accessor<ReturnType<typeof getDetails>> }) => {
  return (
    <Show when={props.details()}>
      {(details) => (
        <section {...stylex.attrs(styles.sidebarSection, styles.scrollableSidebarSection)}>
          <header {...stylex.attrs(styles.sidebarHeader)}>
            <h2 {...stylex.attrs(baseStyles.heading, styles.sidebarTitle)}>Checks</h2>
            <span {...stylex.attrs(styles.sidebarCount)}>
              {details().checkRuns.length + details().statuses.length}
            </span>
          </header>
          {details().checkRuns.length + details().statuses.length === 0 ? (
            <p {...stylex.attrs(styles.sidebarEmpty)}>None stored.</p>
          ) : (
            <ul {...stylex.attrs(styles.sidebarList)}>
              <For each={details().checkRuns}>
                {(check) => (
                  <li {...stylex.attrs(styles.sidebarItem)}>
                    <PullRequestStatusIcon
                      label={check.name}
                      state={check.state}
                      summary={check.summary}
                      title={check.title}
                      url={check.url}
                    />
                  </li>
                )}
              </For>
              <For each={details().statuses}>
                {(status) => (
                  <li {...stylex.attrs(styles.sidebarItem)}>
                    <PullRequestStatusIcon
                      description={status.description}
                      label={status.context}
                      state={status.state}
                      url={status.url}
                    />
                  </li>
                )}
              </For>
            </ul>
          )}
        </section>
      )}
    </Show>
  );
};

const PullRequestMetadata = (props: { data: Accessor<PullRequestPageData> }) => {
  return (
    <section {...stylex.attrs(styles.sidebarSection)}>
      <header {...stylex.attrs(styles.sidebarHeader)}>
        <h2 {...stylex.attrs(baseStyles.heading, styles.sidebarTitle)}>Details</h2>
      </header>
      <dl {...stylex.attrs(styles.metadataList)}>
        <div {...stylex.attrs(styles.metadataItem)}>
          <dt {...stylex.attrs(styles.metadataTerm)}>Repository</dt>
          <dd {...stylex.attrs(styles.metadataValue)}>{props.data().repository.fullName}</dd>
        </div>
        <div {...stylex.attrs(styles.metadataItem)}>
          <dt {...stylex.attrs(styles.metadataTerm)}>Number</dt>
          <dd {...stylex.attrs(styles.metadataValue)}>#{props.data().pullRequest.number}</dd>
        </div>
        <div {...stylex.attrs(styles.metadataItem)}>
          <dt {...stylex.attrs(styles.metadataTerm)}>State</dt>
          <dd {...stylex.attrs(styles.metadataValue)}>{props.data().pullRequest.state}</dd>
        </div>
        <div {...stylex.attrs(styles.metadataItem)}>
          <dt {...stylex.attrs(styles.metadataTerm)}>Author</dt>
          <dd {...stylex.attrs(styles.metadataValue)}>
            {props.data().pullRequest.authorLogin ?? "Unknown"}
          </dd>
        </div>
        <div {...stylex.attrs(styles.metadataItem)}>
          <dt {...stylex.attrs(styles.metadataTerm)}>Updated</dt>
          <dd {...stylex.attrs(styles.metadataValue)}>
            <time
              {...stylex.attrs(styles.sidebarTime)}
              dateTime={props.data().pullRequest.updatedAt}
            >
              {formatLocalDateTime(props.data().pullRequest.updatedAt)}
            </time>
          </dd>
        </div>
      </dl>
    </section>
  );
};

const PullRequestReviewStatus = (props: { details: Accessor<ReturnType<typeof getDetails>> }) => {
  const decision = createMemo(() => reviewDecisionPresentation(props.details()));

  return (
    <section {...stylex.attrs(styles.sidebarSection, styles.reviewSection)}>
      <header {...stylex.attrs(styles.sidebarHeader)}>
        <h2 {...stylex.attrs(baseStyles.heading, styles.sidebarTitle)}>Review status</h2>
      </header>
      <p {...stylex.attrs(styles.reviewDecision)} data-status-kind={decision().kind}>
        <span {...stylex.attrs(styles.statusName)} data-status-kind={decision().kind}>
          {decision().label}
        </span>
        <span {...stylex.attrs(styles.statusIcon, statusColor(decision().kind))}>
          {decision().kind === "success" ? <CheckIcon /> : null}
          {decision().kind === "failure" ? <XIcon /> : null}
          {decision().kind === "pending" ? <HourglassIcon /> : null}
          {decision().kind === "neutral" ? <MinusIcon /> : null}
        </span>
      </p>
    </section>
  );
};

const reviewDecisionPresentation = (
  details: ReturnType<typeof getDetails>,
): { kind: StatusKind; label: string } => {
  if (details === undefined) {
    return { kind: "neutral", label: "Not loaded" };
  }

  switch (details.reviewDecision) {
    case "APPROVED":
      return { kind: "success", label: "Approved" };
    case "CHANGES_REQUESTED":
      return { kind: "failure", label: "Changes requested" };
    case "REVIEW_REQUIRED":
      return { kind: "pending", label: "Review required" };
    case null:
    case undefined:
      return { kind: "neutral", label: "No decision" };
    default:
      return { kind: "neutral", label: statusLabel(details.reviewDecision) };
  }
};

const formatLocalDateTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
};

type StatusKind = "failure" | "neutral" | "pending" | "success";

const statusKind = (state: string): StatusKind => {
  switch (state.toLowerCase()) {
    case "success":
      return "success";
    case "pending":
    case "queued":
    case "in_progress":
    case "waiting":
    case "requested":
      return "pending";
    case "failure":
    case "error":
    case "cancelled":
    case "timed_out":
    case "action_required":
    case "startup_failure":
    case "stale":
      return "failure";
    case "neutral":
    case "skipped":
    default:
      return "neutral";
  }
};

const statusColor = (kind: StatusKind) => {
  switch (kind) {
    case "success":
      return styles.statusSuccess;
    case "failure":
      return styles.statusFailure;
    case "pending":
      return styles.statusPending;
    case "neutral":
      return null;
  }
};

const statusLabel = (state: string) => {
  const label = state.trim().replaceAll("_", " ").toLowerCase();
  return label === "" ? "Unknown" : label.charAt(0).toUpperCase() + label.slice(1);
};

const PullRequestStatusIcon = ({
  description,
  label,
  state,
  summary,
  title,
  url,
}: {
  description?: string | null | undefined;
  label: string;
  state: string;
  summary?: string | null | undefined;
  title?: string | null | undefined;
  url?: string | null | undefined;
}) => {
  const kind = statusKind(state);
  const accessibleState = statusLabel(state);
  const detail = description ?? summary;

  return (
    <Tooltip closeDelay={150} gutter={8} ignoreSafeArea openDelay={0} placement="right">
      <Tooltip.Trigger
        as={Button}
        variant="row"
        aria-label={`${label}: ${accessibleState}`}
        data-status-kind={kind}
        type="button"
      >
        <span {...stylex.attrs(styles.statusName)}>{label}</span>
        <span {...stylex.attrs(styles.statusIcon, statusColor(kind))}>
          {kind === "success" ? <CheckIcon /> : null}
          {kind === "failure" ? <XIcon /> : null}
          {kind === "pending" ? <HourglassIcon /> : null}
          {kind === "neutral" ? <MinusIcon /> : null}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          {...stylex.attrs(styles.tooltip, styles.checkTooltip, styles.tooltipPositioner)}
        >
          <p {...stylex.attrs(styles.tooltipText)}>{label}</p>
          <p {...stylex.attrs(styles.tooltipText, styles.tooltipSecondary)}>{accessibleState}</p>
          {title ? (
            <p {...stylex.attrs(styles.tooltipText, styles.tooltipDetailTitle)}>{title}</p>
          ) : null}
          {detail ? <p {...stylex.attrs(styles.tooltipText)}>{detail}</p> : null}
          {url ? (
            <div {...stylex.attrs(styles.tooltipAction)}>
              <Anchor href={url} rel="noreferrer" target="_blank">
                View run
              </Anchor>
            </div>
          ) : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  );
};

export default PullRequestPage;
