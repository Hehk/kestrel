# Route-owned state in the global TEA program

Status: deferred to a separate follow-up, not part of the current DiffView rebuild. [Linear ticket draft](./LINEAR_ROUTE_OWNED_STATE_TICKET.md) is prepared but has not been submitted. This extends [the DiffView TEA rebuild](./DIFF_VIEW_TEA_PLAN.md); no implementation changes yet.

## Recommendation

**The active route should describe the page we are running, not just the URL we are displaying.**

Move DiffView into the global program by making it part of the diff route. Route entry creates its state and requests its data. Route messages update it. Route exit destroys its browser resources and releases its document.

Do not do this:

```ts
type State = {
  route: Router.Route;
  diffView: Diff.Model | null;
  // ...
};
```

That leaves two independent fields that must continually be kept in agreement. It also leaves loading elsewhere, so the page is still split between several owners.

Instead:

```text
App state
  user
  settings
  shared repository data
  active route
    Home
    Settings
    NotFound
    PullRequest
      Overview
      Diff
        waiting / loading / failed / loaded
        loaded document + viewer state
```

There is one global message queue, one publication of app state, and one command interpreter. The diff reducer remains a useful pure function—not another running program.

## What changes from today?

Currently, page ownership is spread across:

- `router.ts`: URL descriptors and browser history.
- `store.ts`: `queuePullRequestRouteWork`, which decides what the URL needs loaded.
- `repositoriesSlice.ts`: a nullable `currentPullRequestDiff`, its fetch state, and request counter.
- `PullRequestPage.tsx`: derives page availability and diff loading/error presentation from repository state.
- `DiffView.tsx`: creates another model, queue, interpreter, and lifecycle owner.

The proposed ownership is:

| Concern                                                      | Owner                                               |
| ------------------------------------------------------------ | --------------------------------------------------- |
| Where a link goes; parsing/formatting URLs                   | URL routing functions                               |
| Which page is active and what it needs                       | Router model/update                                 |
| Repository lists, PR summaries, shared detail cache          | Shared repository state                             |
| Diff fetch status, refresh status, document and interactions | Active diff route                                   |
| Publishing state and serializing every message               | Global store                                        |
| HTTP, browser history, observers, clipboard, virtualizer     | Global command interpreter and its browser adapters |
| Rendering and supplying DOM refs                             | Components                                          |

Moving just `Diff.Model` into the global store would be a smaller change, but it would stop short of the ownership you are asking for.

## 1. Separate a destination from a running route

A link describes a destination. It should not have to construct search state or allocate a page identity.

Keep the existing URL-facing types and path behavior. Introduce a richer `Router.Model` for the authenticated app's active route.

Illustrative shape:

```ts
type Model = {
  visitId: number;
} & (
  | { name: "Home" }
  | { name: "Settings" }
  | { name: "NotFound"; path: string }
  | {
      name: "PullRequest";
      repo: string;
      id: string;
      page:
        | { kind: "Overview" }
        | {
            kind: "Diff";
            nextRequestId: number;
            content: DiffPage;
          };
    }
);
```

`Router.location(model)` produces the existing `AuthenticatedRoute`, including `view: "overview" | "diff"`. It is a projection, not another mutable field in app state.

This gives us two distinct comparisons:

- **Destination equality:** are these the same URL destination? Used for navigation and duplicate `RouteChanged` events.
- **Visit identity:** is this still the same running page instance? Used for lifecycle and asynchronous work.

Preserve existing malformed-URL and invalid-PR handling. URL parsing must not require repository data. Normalize repository identity for data lookup; do not accidentally turn this migration into a change to URL canonicalization.

The root state becomes roughly:

```ts
type State = {
  user: User;
  settings: Settings.State;
  repositories: Repositories.State;
  route: Router.Model;
  nextVisitId: number;
  // Existing unrelated fields remain outside this migration.
};
```

There is no `diffView: null`, `currentPage: null`, or separately mutable URL route beside it.

## 2. Put the complete diff page under that route

Use page states that distinguish unavailable data from an available document undergoing refresh:

```ts
type DiffPage =
  | { kind: "Waiting"; for: "Repositories" | "PullRequests" | "PullRequestSync" }
  | { kind: "Unavailable"; reason: PrerequisiteError }
  | { kind: "Loading"; requestId: number }
  | { kind: "Failed"; error: DiffLoadError }
  | {
      kind: "Loaded";
      viewer: Diff.Model;
      refresh:
        | { kind: "Idle" }
        | { kind: "Loading"; requestId: number }
        | { kind: "Failed"; error: DiffLoadError };
    };
```

These are concrete page states, not a generic remote-data framework. `PrerequisiteError` covers the existing untracked/missing/invalid PR and shared-loading failures.

Important details:

- `Loaded.viewer.layout.diff` is the document. Do not also store a raw diff next to it.
- Shared repository records stay shared. The route references their identity rather than copying PR summaries and details into its own cache.
- A refresh keeps the loaded viewer alive. Success feeds the replacement through `Diff.update(DiffChanged, viewer)` in the **same global transition** that completes the request.
- Refresh failure keeps the last successful viewer and displays the error, as today.
- An empty diff is still a successful load. The page renders the empty notice without installing viewer keyboard/pointer subscriptions.
- Keep document/request generations monotonic within a visit, including empty → nonempty transitions. Do not restart IDs while callbacks from that visit may still exist.

For empty results, I recommend retaining the now-empty pure model but clearing search/reveal and detaching browser resources. This avoids a second incarnation-ID scheme just to discard and recreate the model. The visible empty-page behavior stays the same; no hidden viewer shortcuts remain active.

Remove `CurrentPullRequestDiff`, `currentPullRequestDiff`, and `pullRequestDiffRequestId` from repository state. Move their request handling into the active route. Keep the existing HTTP endpoint and error mapping.

## 3. Make routing an explicit update, not a collection of reactive effects

The global reducer delegates active-page work to pure router functions:

```ts
Router.enter(destination, visitId, sharedData);
Router.update(msg, activeRoute, sharedData);
```

Both return state and commands. Neither reads global state, makes browser calls, or imports `store.ts`.

The root reducer has three important paths:

1. **Navigation:** establish the new route, return old-route cleanup and new-route work.
2. **Shared data completion:** update repository state, then let the active route process that specific accepted event against the updated shared data.
3. **Page interaction/completion:** check its scope, update the active route, and lift its commands into the app command type.

This replaces `queuePullRequestRouteWork`; it does not sit alongside it.

For shared prerequisites, preserve today's behavior: direct diff URLs load repository/PR prerequisites, sync a missing PR when appropriate, and load the diff without unnecessarily loading overview details. Track waiting/in-flight work before dispatch so unrelated repository messages cannot repeatedly start the same request. Requests for shared data go through the repository request transitions, not raw HTTP commands that leave shared loading state unset.

Only relevant shared events advance a page: repository/PR loading, the matching PR becoming available, or matching detail sync completing. Scrolling must not rerun prerequisite lookup or loading orchestration.

Keep the current explicit “sync succeeded, now reload the diff” workflow, but restrict it to the matching active diff route. A sync that finishes after leaving may update shared data; it must not resurrect the old viewer or trigger an inactive diff fetch.

## 4. One message path, with scoped page messages

For example:

```ts
type Msg =
  | { kind: "RouteChanged"; route: Router.Route }
  | { kind: "Page"; scope: PageScope; msg: Router.Msg }
  | { kind: "Repositories"; msg: Repositories.Msg };
// Existing application messages.
```

A router message can be `DiffLoaded`, `DiffLoadFailed`, `RetryRequested`, or a lifted diff interaction. It goes directly from the global reducer into the active route, and from there into `Diff.update` when appropriate.

Do not add a chain of independently running App → Router → PullRequest → Diff stores. Pure function delegation is enough. There should be no messages that merely copy the same model into another owner.

Use two levels of identity:

- **Session generation + visit ID:** prevents a completion from an old page or authenticated session entering the current one.
- **Request/document IDs inside the visit:** handles competing loads, searches, clipboard writes, and geometry configurations during a refresh.

The URL alone is insufficient: A → B → A creates a new visit, even though the last URL equals the first. Capture scope when starting work, not when the callback completes.

The app runtime must also guard deliveries after `stop()`. Currently `Store.send` throws when no authenticated store exists; late runtime callbacks must not blindly call it after logout. Session generations must not restart in a way that lets an old callback match a new login.

## 5. Route-owned resources, without DOM in the model

Global state owns the viewer's behavior. It does not own DOM elements or a virtualizer instance.

The global interpreter maintains a small resource record for the active visit: outstanding diff fetch cancellation and, while a nonempty viewer is attached, its existing diff browser adapter. This is imperative resource ownership, not another model or store.

### Enter and attach

- Route entry can start HTTP before the view exists.
- A loaded nonempty viewer renders from global state.
- Its `onMount` supplies refs through an attachment port, scoped to the visit. Refs never travel through the pure router or app message types.
- Attachment validates the committed active route and reads its current viewer—not a model captured when the request started.
- Fresh geometry enters through normal scoped messages. If attachment needs to resume a pending reveal, a plain `ViewportAttached` observation lets `update` choose the required effects from current state.

Do not silently drop pre-attachment navigation, and do not accumulate an unbounded queue of DOM commands waiting for refs. Resume current intent from the model instead.

### Leave and detach

- Route exit invalidates the visit and cancels its requests, searches, measurements, observers, shortcuts, and pointer capture.
- Component cleanup detaches only its own attachment. It does not delete global page state.
- Logout, user replacement, and store reset use the same resource-disposal path.
- An uncancellable clipboard write may finish, but cannot announce or update the next visit. No cross-page clipboard service is introduced in this migration.

There is a real ordering trap here: publishing a new route can mount the new DOM before the returned cleanup command for the old route executes. Therefore cleanup must target an exact visit/attachment, not “whatever runtime is current.” Attachment and route activation must be idempotent and safe in either order. Give each DOM attachment a runtime lease so delayed cleanup or callbacks from an old attachment cannot affect its replacement.

Add tests for that ordering explicitly. Moving cleanup out of the component does not make browser lifecycle disappear.

## 6. Fix global publication and page identity before sending scroll messages through it

The global store currently publishes by setting its value to null and then replacing it inside a batch. Do not carry that mechanism into this design.

Start with the immutable-signal publication approach already used by the local diff program:

- One app-state signal; one serialized global queue.
- Preserve unchanged references and return the original state on no-op messages.
- Publish the new state before executing its commands.
- Keep memoized read subscriptions as a rendering optimization, not another state owner.

This does **not** mean all selectors stop running on every global publication. Cheap root selectors may rerun; expensive derivations and unrelated rendered subtrees must remain stable. Measure both selector work and DOM work rather than claiming a signal automatically solves performance.

There is another important change in `App.tsx`: `Page` currently constructs JSX inside a memo driven by the route. Once the route contains viewport/search state, its object changes frequently. The page must be mounted by stable **visit identity**, with live access to that visit's state—not remounted whenever the route object changes.

The same rule applies to loading → loaded and loaded → refreshing transitions: preserve the viewer DOM while the same nonempty viewer remains valid. Keep the current numeric row identity and row presentation memos.

Acceptance checks should prove that scrolling does not:

- Recreate the page, search input, runtime, or overlapping row DOM.
- Recompute PR totals by scanning the entire diff.
- Re-run repository loading work.
- Invalidate settings or shared repository values that did not change.

If the measured root subscription fan-out is too expensive, improve the Solid publication bridge while preserving one immutable app model and queue. Do not solve it by quietly recreating a local diff store.

## 7. Make page retention a deliberate policy

**Recommendation: discard route-owned diff state on exit and fetch again on re-entry.**

This cleanly implements “the diff state exists because we are on the diff page.” It also releases potentially large layouts and search results when leaving.

This is an intentional behavior change: `store.test.ts` currently asserts reuse of the one-entry diff resource when switching between overview and diff. That behavior cannot simply disappear without review.

| Option                                                         | Consequence                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Route-only ownership; reload on return — recommended initially | Simplest lifetime; no inactive diff state; extra request and loading state on return                                      |
| Separate bounded raw-document cache                            | Avoids some reloads; cache has explicit key/invalidation/eviction policy; never retains viewer state or browser resources |
| Retain complete page models in navigation history              | Restores search/viewport, but retains large state and needs a much larger lifecycle design                                |

Do not disguise the third option as a nullable field called `currentDiff`.

With the recommended option:

- Same-destination duplicate events preserve the current visit and do not reload.
- Refresh preserves the current visit, query, and copy serialization behavior.
- Overview → diff, back/forward, or another PR starts a fresh visit.
- Returning does not restore old search state. Browser scroll restoration must be tested with asynchronous loading; do not promise exact old scroll restoration as part of this migration.

## Code organization

Keep the ownership visible without building a routing framework:

```text
src/
  router.ts                 URL functions; active route Model/Msg/Cmd and pure transitions
  store.ts                  App update, queue, publication, scoped command/resource ownership
  repositoriesSlice.ts      Shared repository/PR data; no current diff state
  PullRequestPage.tsx        Shared chrome and route-state presentation
  diff/
    DiffView.tsx            Viewer rendering, messages, small DOM attachment boundary
    diffViewModel.ts        Existing pure viewer behavior
    diffViewRuntime.ts      Existing browser adapter, owned by the global interpreter
```

The sketch is about responsibilities rather than renaming files. Keeping `Diff.update` in a module is not the same as keeping a dangling global slice. Its only live model belongs to the active diff route.

Delete `createDiffViewProgram` and the diff-prop synchronization effect. Accepted HTTP responses now update the viewer in the global transition, so there is nothing for a component effect to synchronize.

Do not simultaneously rewrite settings, session state, every repository reducer, or the overview page's entire model. Establish the route-owned pattern here first. URL/history functions can be extracted later if `router.ts` genuinely becomes difficult to navigate; do not start with a registry of page controllers.

## Implementation sequence

### 1. Confirm product and ownership decisions

- [ ] Agree that loading/refresh/document state moves with viewer state, rather than retaining `repositories.currentPullRequestDiff`.
- [ ] Choose reload-on-return versus an explicit raw-document cache.
- [ ] Agree that the session store and genuinely shared repository/settings data remain outside this migration.

### 2. Establish route-state invariants

- [ ] Introduce destination versus active-route types, visit identity, and `Router.location`.
- [ ] Implement pure route entry/update and diff-page loading/refresh states.
- [ ] Cover direct loads, prerequisites, invalid URLs, missing PR sync, failed loads, refreshes, empty results, and duplicate route events.
- [ ] Move route work out of `queuePullRequestRouteWork`; remove diff request state from repository state.

### 3. Integrate the single global program

- [ ] Replace null-and-replace publication with immutable app-state publication.
- [ ] Route all diff interactions/completions through the global queue and active route.
- [ ] Add session/visit guards, request cancellation, and scoped runtime attachment/disposal.
- [ ] Verify old cleanup after new mount, detach/reattach, late completion after logout, and A → B → A races.

### 4. Make components render the active visit

- [ ] Mount pages by visit identity while passing live route state.
- [ ] Render diff loading/error/refresh/empty states from the route rather than repository state.
- [ ] Remove `createDiffViewProgram`, its local signal/queue, and its prop bridge.
- [ ] Preserve loaded viewer DOM during refresh; detach browser subscriptions on empty results and route exit.

### 5. Validate behavior and cost

- [ ] Keep pure diff behavior tests; move program/lifecycle tests to the global store and route boundary.
- [ ] Update one-entry-cache tests to the agreed retention policy, not merely to whatever the implementation happens to do.
- [ ] Test unrelated settings/repository updates during scrolling/search/refresh and the reverse.
- [ ] Instrument page mounts, runtime attachments, expensive selectors, and overlapping row identity.
- [ ] Repeat large-diff Chrome measurements, browser back/forward, rapid route switching, and logout with work in flight.
- [ ] Run `npm run check` and `npm run build`.

## What I would review first

1. **Does “active route owns the complete page” match your intent?** I recommend moving diff loading too, not just nesting `Diff.Model` under the route.
2. **Is reloading the diff on return acceptable?** That is the main user-visible tradeoff in the simpler ownership model.
3. **Is keeping the pure diff reducer as a helper acceptable?** I recommend it: one running global program does not require one enormous update function containing every row, search, and clipboard detail.

The end state should be easy to describe: **the global app is running a diff route, and that route owns a diff page. The component is just its view.**
