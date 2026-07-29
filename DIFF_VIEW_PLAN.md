# Pull Request Diff View Plan

## Summary

Pull requests will have two views on separate routes:

- Overview: `/pull/:repo/:id`
- Diff: `/pull/:repo/:id/diff`

The Diff view will display every changed file in source order, with each file's hunks grouped together in one window-scrolling page. It must remain responsive for diffs containing several thousand to tens of thousands of lines.

The backend will parse GitHub's raw git-style unified diff into a semantic file, hunk, and line API response. The frontend will build a compact layout index over that response and use window virtualization so only a small number of visual rows are mounted at once.

## Agreed Product Decisions

- Use separate Overview and Diff routes.
- Keep the base pull request route as Overview.
- Use a unified diff rather than a side-by-side diff initially.
- Use the browser window as the vertical scroller.
- Display all files and hunks in one logical page.
- Do not wrap source lines.
- Virtualize across the complete diff, not independently inside each file.
- Provide custom full-diff search in the first version.
- Intercept `Cmd+F` and `Ctrl+F` while the Diff view is active.
- Allow ordinary selection within mounted rows.
- Provide Copy hunk and Copy file actions for content spanning unmounted rows.
- Do not add syntax highlighting initially.
- Give the Diff view nearly the full viewport width instead of retaining the Overview sidebars.

## Goals

- Make direct navigation to the Diff route work with the existing repository and pull request loading flow.
- Keep Overview responses small by excluding raw diff data.
- Parse GitHub diff syntax in one canonical backend implementation.
- Represent additions, deletions, context, line numbers, hunks, file operations, and binary files explicitly.
- Keep the browser DOM size bounded independently of diff size.
- Keep frontend memory bounded as users visit multiple pull requests.
- Support full-diff file navigation, search, and copying despite DOM virtualization.
- Handle light and dark themes and desktop and mobile viewport sizes.
- Preserve a usable stale diff while a pull request is being refreshed.

## Initial Non-Goals

- Side-by-side rendering.
- Syntax highlighting.
- Inline review comments or annotations.
- Collapsible unchanged context.
- Arbitrary click-drag selection across unmounted lines.
- Editable patches.
- Persisting parsed diff JSON in SQLite.
- Loading individual files on demand.
- Virtualizing horizontally.

## Current System

The existing implementation already does the following:

- Fetches GitHub's complete pull request diff using the `application/vnd.github.v3.diff` media type.
- Stores the raw diff in the `diff` column of `tracked_repository_pull_request_details`.
- Returns the raw diff as `PullRequestDetailDto.diff`.
- Loads pull request details through `src/repositoriesSlice.ts` and route orchestration in `src/store.ts`.
- Renders the existing pull request Overview in `src/PullRequestPage.tsx`.

The existing implementation does not parse or render the diff. The changed-files DTO contains only a filename and status and is not sufficient to render hunks or line numbers.

## High-Level Architecture

The data flow should be:

```text
GitHub raw git diff
    -> pull request sync stores raw diff in SQLite
    -> GET pull request diff endpoint loads raw diff
    -> backend parses raw diff into semantic DTOs
    -> compressed JSON response
    -> frontend stores one current semantic diff
    -> frontend builds a compact virtual layout index
    -> window virtualizer renders the visible rows
```

The backend API should expose domain data, not viewport positions or frontend-specific virtual rows. The frontend remains responsible for layout, navigation, search state, sticky UI, and virtualization.

## Routes

Extend the existing pull request route with a view discriminator:

```ts
type PullRequestRoute = {
  name: "PullRequest";
  repo: string;
  id: string;
  view: "overview" | "diff";
};
```

Route behavior:

- `/pull/kestrel%2Fapp/42` parses as `view: "overview"`.
- `/pull/kestrel%2Fapp/42/diff` parses as `view: "diff"`.
- Additional unknown child segments remain Not Found routes.
- Route equality includes `repo`, `id`, and `view`.
- Existing links to pull requests explicitly target Overview.
- The shared pull request header provides Overview and Diff links.
- Direct navigation, refresh, back, and forward must work on both routes.

The route-loading orchestration in `src/store.ts` becomes view-aware:

- Both views load tracked repositories and the pull request summary.
- Overview loads the ordinary pull request detail resource.
- Diff loads the parsed pull request diff resource.
- Direct Diff navigation does not need to load timeline, checks, statuses, or commits.

## Backend API

Add a dedicated endpoint:

```text
GET /api/repositories/{owner}/{name}/pull-requests/{number}/diff
```

Remove `diff` from `PullRequestDetailDto` and from responses returned by:

- Pull request detail loading.
- Pull request synchronization.
- Timeline pagination.

The existing synchronization endpoint will continue fetching and storing the raw diff. It should not return the raw or parsed diff because that would make Overview synchronization transfer the large payload again.

### Response Model

Use explicit DTOs registered with Utoipa and generated into `src/api/schema.ts`.

```ts
type PullRequestDiffResponse = {
  files: PullRequestDiffFileDto[];
  syncedAt: string;
};

type PullRequestDiffFileDto = {
  additions: number;
  binary: boolean;
  deletions: number;
  hunks: PullRequestDiffHunkDto[];
  newMode: string | null;
  newPath: string | null;
  oldMode: string | null;
  oldPath: string | null;
  operation: "added" | "deleted" | "modified" | "renamed" | "copied";
};

type PullRequestDiffHunkDto = {
  context: string | null;
  lines: PullRequestDiffLineDto[];
  newCount: number;
  newStart: number;
  oldCount: number;
  oldStart: number;
};

type PullRequestDiffLineDto = {
  content: string;
  kind: "context" | "addition" | "deletion";
  missingNewline: boolean;
  newLine: number | null;
  oldLine: number | null;
};
```

The parser spike should confirm whether file modes can be obtained reliably. If they cannot, omit `oldMode` and `newMode` from the first contract rather than implementing a broad second parser solely for those fields.

Line content should not include the unified-diff prefix (`+`, `-`, or space) or its terminating newline. The `kind` field carries the prefix semantics. `missingNewline` preserves the `No newline at end of file` condition.

Line number rules:

- Context lines have both old and new line numbers.
- Deletions have only an old line number.
- Additions have only a new line number.
- Numbering starts from the hunk's old and new ranges and advances according to line kind.

Binary and mode-only files may have no hunks and must still appear in `files`.

### Error Behavior

- Unauthenticated requests return 401.
- Invalid repository or pull request paths return 400.
- An untracked repository returns 404 with `repository_not_tracked`.
- A pull request with no stored detail snapshot returns 404 with `pull_request_not_found`.
- A stored snapshot without a diff returns a successful empty response or a specific unavailable response; choose one behavior and test it consistently.
- A parser failure returns a specific `diff_parse_failed` error and is logged with repository and pull request context.

A diff parse failure must not make pull request synchronization fail. The raw diff remains stored so parser fixes can make old snapshots readable without another GitHub sync.

## Backend Parsing

Use a Rust parser that explicitly supports multi-file git-style diffs. `diffy` is the leading candidate because its `PatchSet` API supports git diff parsing, file operations, text patches, and binary patches.

Before adopting it, implement a focused parser spike against GitHub-style fixtures covering:

- Multiple files.
- Multiple hunks.
- Added and deleted files using `/dev/null`.
- Renames and copies.
- Binary markers and git binary patches.
- Mode-only changes.
- Quoted paths and spaces in paths.
- Hunk function context.
- Empty lines.
- Missing final newlines.
- Very long lines.
- Malformed and truncated input.

The repository does not currently pin a Rust toolchain. Confirm that the chosen parser version's minimum Rust version matches development and CI environments before adding it.

Keep the parser behind a local function returning application DTOs. No parser crate types should appear in HTTP response types or database code.

```rust
fn parse_pull_request_diff(raw: &str) -> Result<Vec<PullRequestDiffFileDto>, DiffParseError>
```

Parsing and DTO construction are CPU work. Run them with `tokio::task::spawn_blocking` so a very large diff does not block an async Tokio worker. Profile JSON serialization as well; if serialization creates material long tasks on the server, serialize the response bytes inside the blocking task while retaining the DTO in the OpenAPI response declaration.

## Storage And Caching

Continue storing only the raw diff in the existing SQLite column initially.

Reasons:

- No migration is required.
- Existing stored pull requests continue working.
- Raw and structured forms are not duplicated on disk.
- Changing parsers or DTOs does not require rewriting persisted parsed JSON.
- Parse failures can be investigated from the original data.

Parse the raw diff when the Diff endpoint is requested. The frontend should retain the result while navigating between Overview and Diff for the same pull request, avoiding repeated requests during normal tab switching.

Do not add persisted parsed JSON or a backend in-memory cache before profiling. If repeated parsing becomes material, add a bounded cache keyed by user, repository, pull request number, and `synced_at`. The cache must have explicit memory limits because parsed diffs can be large.

## Response Compression

Enable HTTP response compression in `backend/src/http.rs` through `tower-http`.

This is required for the structured diff endpoint because line DTO property names repeat many thousands of times. Validate the compressed response with an `Accept-Encoding` request and confirm the resulting `Content-Encoding` header.

Do not send both the raw diff and parsed DTOs. Compression reduces transfer size but does not remove browser allocation costs after JSON parsing.

## Frontend State

Store at most one current parsed pull request diff rather than a record containing every visited diff:

```ts
type CurrentPullRequestDiff = {
  key: string;
  state: PullRequestDiffState;
} | null;

type PullRequestDiffState =
  | { status: "loading"; diff: PullRequestDiffResponse | null }
  | { status: "loaded"; diff: PullRequestDiffResponse }
  | { status: "error"; diff: PullRequestDiffResponse | null; error: PullRequestDiffError };
```

This design:

- Keeps Overview-to-Diff switching for the same pull request fast.
- Keeps stale data visible while refreshing.
- Prevents memory growth as users visit many large pull requests.
- Allows navigation to another pull request to replace the previous parsed document.

The state update and command flow should include:

- Diff load requested.
- Diff loaded.
- Diff load failed.
- Pull request sync requested.
- Pull request sync completed and current matching diff reload requested.
- Pull request sync failed while stale diff remains available.

## Shared Pull Request Page

Refactor `src/PullRequestPage.tsx` into a shared resource resolver and view-specific content without introducing unnecessary layers.

Suggested responsibilities:

- `PullRequestPage`: resolve repository, pull request number, summary, and common errors.
- `PullRequestHeader`: title, back action, GitHub link, sync action, and Overview/Diff navigation.
- `PullRequestOverview`: current description, timeline, status, checks, metadata, files, and commits.
- `PullRequestDiff`: diff loading states, toolbar, layout index, virtualizer, and rendered rows.

The Overview can retain its current three-column layout. The Diff view should use a separate wide layout optimized for code.

## Frontend Layout Index

Do not create a second full array of JavaScript objects mirroring every API line. The API response already contains one object per line.

Build a compact index that maps virtual row indexes to semantic data. Acceptable implementations include prefix indexes or typed arrays. A typed-array representation gives predictable memory and constant-time row lookup:

```ts
type DiffLayout = {
  fileStartRows: Uint32Array;
  fileIndexes: Uint32Array;
  hunkIndexes: Uint32Array;
  kinds: Uint8Array;
  lineIndexes: Uint32Array;
  rowCount: number;
};
```

Each virtual row is one of:

- File header.
- Hunk header.
- Context line.
- Addition line.
- Deletion line.
- File notice for binary or hunkless changes, if needed.

Use a sentinel such as `0xffffffff` where a hunk or line index does not apply. Provide small helpers such as `rowAt(index)`, `rowKey(index)`, and `rowHeight(index)` so rendering code does not manipulate the arrays directly.

The hierarchical DTO remains the source for Copy file and Copy hunk. The layout index exists only for viewport navigation and rendering.

## Window Virtualization

Add `@tanstack/solid-virtual` and use `createWindowVirtualizer`.

Use one virtualizer for the complete ordered diff. Do not create a virtualizer per file because one file can itself contain tens of thousands of lines, and nested virtualizers make window scrolling and direct jumps unreliable.

Configuration principles:

- `count` is the layout's total visual row count.
- `getItemKey` derives stable keys from file, hunk, and line indexes.
- `estimateSize` returns the exact fixed height for each row kind.
- Start with approximately 20 rows of overscan and tune through profiling.
- `scrollMargin` accounts for page content before the virtual list.
- `scrollPaddingStart` accounts for the sticky diff toolbar and active-file header.
- `scrollToIndex` powers file navigation and search results.

All vertical dimensions must remain deterministic:

- Source lines use one fixed line height.
- Source lines never wrap.
- Hunk headers use one fixed height.
- File headers use one fixed height and truncate long paths.
- Toolbar controls do not wrap into a second row.

Avoid dynamic row measurement unless a concrete feature requires variable heights. Exact sizes prevent scroll correction, jumping, and repeated `ResizeObserver` work.

Render a total-height spacer with one translated contiguous block containing the current virtual items. The target is fewer than 200 diff rows in the DOM regardless of total diff size.

## File Grouping And Navigation

Files remain semantically hierarchical in the API and visually grouped in the flattened virtual sequence:

- A file-header row begins each file.
- Its hunk-header and source-line rows follow in order.
- Binary and hunkless files receive a fixed-height notice row.
- File spacing is represented by fixed row styling or a fixed spacer row.

Because an earlier file header will be unmounted, render a separate sticky active-file header above the virtual rows. Determine the active file from the first genuinely visible row, not the first overscan row.

Provide a file picker in the sticky diff toolbar. Selecting a file calls `scrollToIndex(fileStartRows[fileIndex])`.

Stable URL hashes for files are desirable but optional for the first implementation. If added, hash navigation must call the virtualizer directly because the target file header might not exist in the DOM.

## Horizontal Scrolling

Non-wrapping lines and window-based vertical scrolling make ordinary container scrollbars insufficient: a horizontal scrollbar attached to the entire multi-million-pixel list would only be reachable at the bottom.

Use one synchronized horizontal offset for the diff:

- Keep old and new line-number gutters fixed.
- Translate or scroll the mounted source-content cells using the shared offset.
- Provide a sticky or fixed horizontal scrollbar rail at the bottom of the viewport while the Diff view is active.
- Synchronize trackpad horizontal gestures over source rows with the rail.
- Add bottom padding so the rail does not cover the final diff rows.
- Reset or clamp the offset when the available width or maximum source width changes.

Calculate a conservative maximum visual line width while building the layout index. Account for tabs consistently. Exact Unicode display width can be refined later; the rail must at least allow every rendered line to become visible.

## Full-Diff Search

DOM virtualization means native browser Find can only see mounted rows. The Diff view therefore needs model-based search from the first version.

Search behavior:

- `Cmd+F` and `Ctrl+F` focus the custom search input while the Diff view is active.
- Escape clears or closes search.
- Enter moves to the next match.
- Shift+Enter moves to the previous match.
- Navigation wraps at the first and last match.
- The toolbar displays the current result and total count.
- Result counts are announced through an `aria-live` region.
- The active match and other mounted matches are highlighted.
- Moving to a match calls `scrollToIndex(rowIndex, { align: "center" })`.
- Moving to a match adjusts the shared horizontal offset enough to reveal it.

Search the semantic line content, not the DOM. Start with case-insensitive literal matching. Regex, case-sensitive mode, and whole-word matching can be added later.

Defer query processing so typing stays responsive. Search results should store compact virtual row indexes and match offsets rather than references to DOM nodes.

## Copying

Virtualized DOM cannot support click-drag selection across unmounted rows. Provide explicit copy operations:

- Copy hunk on every hunk header.
- Copy file on every file header and in the sticky active-file header.
- Preserve unified-diff line prefixes in copied text.
- Include file and hunk headers needed to make copied text understandable and patch-like.
- Handle clipboard failure visibly.
- Announce success or failure through a polite live region.
- Disable or adjust Copy file for binary patches when textual reconstruction is not meaningful.

Copying is generated from the hierarchical API data, not from mounted DOM rows.

## Rendering And Styling

The diff should use a grid-like row with:

- Old line-number gutter.
- New line-number gutter.
- Source-content cell.

Visual requirements:

- Monospace source text.
- Preserved whitespace and tabs.
- No source-line wrapping.
- Distinct context, addition, deletion, hunk, and file-header treatments.
- Addition and deletion meaning conveyed by both color and symbols or accessible labels.
- Line-number gutters remain readable in light and dark themes.
- Very long paths truncate visually but remain available through accessible text or a tooltip.
- Mobile keeps both line-number gutters compact and allows horizontal code navigation.

Replace the existing unused `.pr-diff` rule, which currently creates a nested `24rem` scroll area. The page must use window scrolling instead.

## Accessibility

Use virtual table semantics where practical:

- The virtual list exposes `role="table"` and `aria-rowcount`.
- Mounted rows expose `role="row"` and the correct `aria-rowindex`.
- Line-number and source cells expose appropriate cell roles.
- File and hunk headers have distinct labels.
- Additions and deletions are not identified by color alone.
- Search counts and copy outcomes use live regions.
- Toolbar controls are keyboard reachable and have explicit labels.

Only mounted rows will be exposed to assistive technology. File navigation and full-model search provide non-linear access to the complete diff. This limitation should be recorded as an intentional virtualization tradeoff.

## Loading, Empty, Error, And Sync States

The Diff view must explicitly render:

- Diff loading with no previous data.
- Diff refresh while stale data remains visible.
- Pull request snapshot not stored yet, with a Sync action.
- Diff unavailable in an older stored snapshot.
- Empty diff.
- Binary-only diff.
- Parser failure.
- Authorization failure.
- General loading or sync failure.

Sync behavior:

- Use the existing pull request sync action.
- Keep the old parsed diff visible while synchronization is in progress.
- On successful synchronization, reload the Diff endpoint only if the current diff belongs to that pull request and the Diff route is active.
- Replace the layout atomically after the new response and layout index are ready.
- On failure, retain the old diff and show a non-destructive error.

When replacing a visible diff after sync, initially reset to the top. Preserving a semantically equivalent file and line can be added later if user feedback shows it is important.

## Performance Strategy

Performance work covers more than DOM virtualization:

- Backend parsing runs outside async Tokio workers.
- Responses are compressed.
- Overview never transfers diff data.
- The browser stores only one current parsed diff.
- The frontend does not create a duplicate object per source line.
- Virtualized row heights are exact.
- Search operates on the model and stores compact result indexes.
- Syntax highlighting is deferred because tokenization and token DOM would materially increase cost.

Create generated fixtures at 50,000 and 100,000 lines and profile:

- Backend raw-diff parsing time.
- Backend DTO construction time.
- JSON serialization time.
- Raw, JSON, and compressed response sizes.
- Browser JSON parse time.
- Frontend layout-index construction time.
- Search latency for common and uncommon queries.
- Scroll frame behavior from top to bottom.
- Browser heap before and after navigating between several large pull requests.

Do not add a parser cache, parsed SQLite storage, frontend Web Worker, or chunked API until measurements identify a bottleneck those mechanisms solve.

## Testing Plan

### Backend Parser Tests

Use committed realistic fixtures for:

- Multiple text files and hunks.
- Correct operation and path detection.
- Correct old and new line numbering.
- Added and deleted files.
- Rename and copy operations.
- Binary files.
- Mode-only changes.
- Missing-final-newline markers.
- Quoted and spaced paths.
- Hunk context.
- Empty source lines.
- Malformed and truncated diffs.

### Backend Endpoint Tests

Cover:

- Authentication.
- Invalid repository and pull request values.
- Untracked repository.
- Missing stored snapshot.
- Stored snapshot without a diff.
- Successful parsed response.
- Parse failure behavior.
- Diff absence from ordinary detail and sync responses.
- Response compression.

### Router And Store Tests

Cover:

- Encoding and decoding both pull request views.
- Rejection of unknown child routes.
- Route equality including view.
- Direct Diff navigation load orchestration.
- Overview loading detail without loading diff.
- Diff loading diff without loading timeline detail.
- Current-diff replacement when navigating to another pull request.
- Diff refresh after sync.
- Stale diff retention after sync failure.

### Frontend Model Tests

Cover:

- Layout row count and row-kind mapping.
- File and hunk start rows.
- Stable row keys.
- Fixed row heights.
- Search results and wraparound navigation.
- Copy hunk and Copy file reconstruction.
- Maximum visual line-width calculation.

### Frontend Component Tests

Cover:

- Overview and Diff navigation.
- Loading, empty, binary, unavailable, and error states.
- Correct mounted line numbers and content.
- File picker navigation through `scrollToIndex`.
- Search shortcut, counts, navigation, and highlighting.
- Copy controls and announcements.
- Bounded mounted row count with a large fixture.
- Horizontal offset synchronization.
- Sticky active-file header changes.

JSDOM does not provide real layout. Mock viewport dimensions and virtualizer measurements for deterministic component tests. Use manual browser profiling or a browser-level test harness for actual scrolling and frame behavior.

## Acceptance Criteria

- Overview is available at `/pull/:repo/:id`.
- Diff is available at `/pull/:repo/:id/diff`.
- Both routes work through direct navigation and browser history.
- Overview responses do not include raw or parsed diff content.
- The Diff endpoint returns typed semantic files, hunks, lines, and line numbers.
- The Diff endpoint response is compressed when requested by the client.
- Multiple files and hunks render in source order as one window-scrolling page.
- A 50,000-line diff results in fewer than 200 mounted diff rows.
- Rapid vertical scrolling does not leave persistent blank regions.
- Long lines do not wrap and can be reached with the synchronized horizontal control.
- Full-diff search finds unmounted lines and navigates to them.
- Copy hunk and Copy file do not depend on mounted DOM.
- Navigating through multiple large pull requests does not retain every parsed diff.
- Binary, hunkless, unavailable, and malformed diffs have explicit states.
- Light, dark, desktop, and mobile presentations remain usable.

## Likely Change Surface

Backend:

- `backend/Cargo.toml`
- `backend/src/http.rs`
- `backend/src/openapi.rs`
- `backend/src/pull_requests.rs`

Frontend:

- `package.json`
- `package-lock.json`
- `src/api/schema.ts` through generation
- `src/router.ts`
- `src/router.test.ts`
- `src/store.ts`
- `src/store.test.ts`
- `src/repositoriesSlice.ts`
- `src/repositoriesSlice.test.ts`
- `src/PullRequestPage.tsx`
- New focused diff model and component files under `src/`
- `src/App.css`
- `src/App.test.tsx`

Fixtures may be placed in backend and frontend test fixture directories rather than embedded as very large strings in existing test files.

## Implementation Stages

Each stage should leave the repository in a working state. Complete its focused tests and exit criteria before starting the next stage. A stage can be implemented as its own pull request or as one reviewable commit when working on a single branch.

The verification commands below run from the repository root unless a stage says otherwise.

### Testing Ladder

Use three levels of verification while iterating:

1. Run the focused test files or Rust test filters listed in the current stage.
2. Run the stage verification commands before considering that stage complete.
3. Run the complete frontend and backend suites during the final stage and whenever a shared contract changes substantially.

Common commands:

```sh
npm run test:run -- src/router.test.ts
npm run typecheck
npm run api:check
npm run check
cargo fmt --manifest-path backend/Cargo.toml -- --check
cargo test --manifest-path backend/Cargo.toml
```

If a command reveals an unrelated pre-existing failure, record it before implementation and continue to require that the stage introduces no additional failures.

### Two-Agent Review Gate

The final todo in every stage is an independent review by two agents. Launch both agents in parallel after the implementation and focused tests are complete. Do not give either agent the other agent's findings.

Both agents must:

- Remain read-only and make no code changes.
- Inspect the complete stage diff and the surrounding code paths affected by it.
- Look beyond changed lines for integration problems in callers, consumers, persistence, generated types, tests, and lifecycle behavior.
- Report findings first, ordered by severity.
- Include file and line references, impact, reasoning, and a concrete correction for every finding.
- Identify missing tests and verification gaps.
- Explicitly state when no findings are discovered.
- Avoid reporting style preferences unless they create a concrete maintenance or correctness risk.

#### Agent A: Correctness And Integration Reviewer

Give Agent A the stage outcome, completed todos, verification results, and this focus:

```text
Review the completed stage as a correctness and integration reviewer. Inspect the full current code paths, not only changed lines. Look for behavioral bugs, regressions, incorrect assumptions, API or persistence contract mismatches, error-handling gaps, concurrency problems, security issues, generated-schema drift, and missing tests. Remain read-only. Return findings ordered by severity with file:line references, impact, reasoning, and a concrete fix. If there are no findings, say so and list residual testing risks.
```

#### Agent B: Scale And User-Experience Reviewer

Give Agent B the stage outcome, completed todos, verification results, and this focus:

```text
Review the completed stage as a scale and user-experience reviewer. Inspect the full current code paths, not only changed lines. Look for performance and memory risks at 50,000 to 100,000 diff lines, unnecessary allocation or network cost, async-runtime blocking, state-lifecycle leaks, virtualization instability, accessibility failures, keyboard or responsive interaction regressions, and missing stress tests. Remain read-only. Return findings ordered by severity with file:line references, impact, reasoning, and a concrete fix. If there are no findings, say so and list residual testing risks.
```

After both agents return:

1. Consolidate duplicate findings.
2. Validate each finding against the code before changing anything.
3. Fix every accepted high- and medium-severity finding.
4. Fix accepted low-severity findings when they are in scope and do not expand the stage unnecessarily.
5. Record deferred findings with a reason and a follow-up stage or issue.
6. Rerun the stage's focused tests and stage verification commands.
7. Repeat the two-agent review if the fixes materially changed architecture, contracts, state transitions, or rendering behavior.

A stage cannot meet its exit criteria until this review gate is complete and accepted findings are resolved or explicitly deferred.

### Stage 0: Baseline And Fixtures

**Outcome:** Establish a known-green baseline and a reusable GitHub-style fixture corpus before changing production behavior.

**Todos:**

- [x] Run the complete existing frontend suite and record any pre-existing failures.
- [x] Run the complete existing backend suite and record any pre-existing failures.
- [x] Confirm the Rust version used locally and by any deployment or CI environment.
- [x] Create a backend diff fixture directory rather than embedding large patches in `pull_requests.rs`.
- [x] Add a small multi-file text fixture with multiple hunks.
- [x] Add fixtures for added, deleted, renamed, copied, binary, mode-only, quoted-path, and missing-newline changes.
- [x] Add one intentionally malformed fixture.
- [x] Keep large generated performance fixtures out of normal source files; generate them in tests or scripts.
- [x] Run the two-agent review gate, resolve accepted findings, and rerun this stage's verification.

**Verification:**

```sh
npm run check
cargo fmt --manifest-path backend/Cargo.toml -- --check
cargo test --manifest-path backend/Cargo.toml
```

**Exit Criteria:**

- The baseline result is known.
- Small realistic fixtures are committed and readable.
- No production behavior has changed.
- The selected Rust toolchain can support the parser candidate evaluated in Stage 1.

**Stage Record (2026-07-22):**

- `npm run check` passed: typecheck, lint, formatting, 7 test files, and 86 tests.
- `cargo fmt --manifest-path backend/Cargo.toml -- --check` passed.
- `cargo test --manifest-path backend/Cargo.toml` passed: 77 tests.
- CI-equivalent `npm run build` and `cargo clippy --manifest-path backend/Cargo.toml --locked --all-targets -- -D warnings` passed.
- Local versions are `rustc 1.96.0` and `cargo 1.96.0`.
- CI uses the floating stable channel through `dtolnay/rust-toolchain@stable`; its exact resolved compiler version is not pinned in the repository.
- No deployment configuration or deployment-specific Rust toolchain is present in the repository.
- `cargo info diffy` reports `diffy 0.5.1` with an MSRV of Rust `1.85.0`, compatible with the local toolchain and CI stable channel. No parser dependency was added in this stage.
- Git's patch parser accepts every intended-valid fixture and rejects `malformed.diff` as corrupt.
- Independent review additions include hunkless operations, escaped path forms, one-sided and context missing-newline markers, Git-generated rename/copy metadata, and explicit generated scale scenarios in their implementation stages.
- Both independent re-reviewers reported no remaining findings; residual parser and browser-performance risks are assigned to later stages.

### Stage 1: Backend Parser Adapter

**Outcome:** Convert a raw GitHub git diff into application-owned semantic Rust types without exposing parser-crate types.

**Todos:**

- [x] Add the selected Rust parser dependency, initially evaluating `diffy` with git-diff parsing options.
- [x] Define internal semantic file, hunk, and line types in or near `backend/src/pull_requests.rs`.
- [x] Implement `parse_pull_request_diff(raw)` behind an application-owned adapter.
- [x] Map create, delete, modify, rename, and copy operations.
- [x] Map text and binary content separately.
- [x] Map hunk ranges and optional function context.
- [x] Calculate old and new line numbers for context, addition, and deletion lines.
- [x] Preserve missing-final-newline information.
- [x] Calculate per-file addition and deletion totals.
- [x] Determine whether the parser reliably exposes old and new file modes.
- [x] Return a typed parse error without changing synchronization behavior.
- [x] Test every fixture created in Stage 0.
- [x] Generate substantially long source lines and large literal and delta binary patches in tests rather than committing them.
- [x] Verify binary patch payload bytes are not retained in the semantic model; Stage 2 will verify serialized responses.
- [x] Document any unsupported GitHub syntax discovered by the fixture tests.
- [x] Run the two-agent review gate, resolve accepted findings, and rerun this stage's verification.

**Focused Tests:**

```sh
cargo test --manifest-path backend/Cargo.toml parse_pull_request_diff
```

Use the actual Rust test filter names if they differ from the function name.

**Stage Verification:**

```sh
cargo fmt --manifest-path backend/Cargo.toml -- --check
cargo test --manifest-path backend/Cargo.toml
```

**Exit Criteria:**

- All supported fixtures produce deterministic semantic structures.
- Malformed input produces a typed error and never panics.
- Parser-crate types do not escape the adapter.
- The API DTO design can now be finalized from demonstrated parser capabilities.
- Pull request synchronization still stores raw diffs exactly as before.

**Stage Record (2026-07-22):**

- Added `diffy 0.5.1` without optional binary decoding or formatting features.
- Added an owned semantic model and parser adapter in `backend/src/pull_request_diff.rs`; no Diffy type escapes its private mapping functions.
- All Stage 0 fixtures parse deterministically except the intentionally malformed fixture, which returns `DiffParseError`.
- Twenty-four focused parser tests plus limit-helper coverage exercise operations, paths, explicit modes, hunks, line numbers, totals, missing newlines, binary classification, 64 KiB lines, generated literal/delta payloads, strict section framing, and resource limits.
- Binary patches map to a payload-free semantic variant. Base85, zlib, and delta payload contents are intentionally not decoded or retained.
- Diffy reports modes only from explicit `new file mode`, `deleted file mode`, `old mode`, and `new mode` headers. The optional mode on an `index` line is not exposed, so ordinary text modifications have unknown modes.
- Combined merge diffs (`diff --cc`, `diff --combined`, and `@@@` hunks) are unsupported. GitHub-style LF input is supported; CRLF behavior is not part of the adapter contract.
- The adapter accepts empty diffs and enforces strict section ordering, paired operation metadata, text-path consistency, count-complete hunks, two-block binary framing, and payload-free binary mapping.
- Parser budgets permit the target scale while bounding raw bytes, physical lines, files, hunks, semantic lines, source-line length, decoded path length, numeric range, and aggregate unquoted-path parsing complexity.
- Deterministic one-large-hunk and many-file/many-hunk scenarios each parse 100,000 semantic lines; the optimized combined test completed in approximately 0.02 seconds in the local Rust test harness.
- `cargo fmt --manifest-path backend/Cargo.toml -- --check`, `cargo test --manifest-path backend/Cargo.toml --locked` with 102 tests, and locked all-target Clippy with warnings denied passed.
- Pull request synchronization is unchanged and does not invoke the parser.
- Both independent final re-reviewers reported no remaining findings. Binary decoding, non-UTF-8 input, endpoint concurrency, and serialization measurements remain explicit later-stage risks.

### Stage 2: Parsed Diff Endpoint

**Outcome:** A tested backend endpoint returns semantic files, hunks, lines, and line numbers from a stored raw diff.

**Todos:**

- [x] Define Utoipa response DTOs and enums based on the Stage 1 semantic types.
- [x] Add a database loader selecting only `diff` and `synced_at` for one pull request.
- [x] Add `GET /api/repositories/{owner}/{name}/pull-requests/{number}/diff`.
- [x] Reuse existing authentication, path parsing, and tracked-repository authorization behavior.
- [x] Run parsing and DTO construction through `tokio::task::spawn_blocking`.
- [x] Log raw and serialized bytes, semantic counts, and parse/serialization timings; defer concurrency admission controls until measurements justify them.
- [x] Return a specific `diff_parse_failed` error for malformed stored data.
- [x] Map parser resource-limit errors to a stable response distinct from malformed stored data.
- [x] Keep parser details out of responses and bound contextual error logging so pathological headers cannot create oversized logs.
- [x] Decide and implement one consistent response for a stored snapshot with a null diff.
- [x] Register the handler and DTOs in `backend/src/openapi.rs`.
- [x] Add handler tests for authentication, invalid paths, untracked repositories, missing snapshots, null diffs, successful responses, and parse failures.
- [x] Add a test proving a parse failure does not alter the stored raw diff.
- [x] Regenerate `src/api/schema.ts`.
- [x] Run the two-agent review gate, resolve accepted findings, and rerun this stage's verification.

During this stage, the existing detail response may temporarily continue returning `diff`. Removing it is the explicit cutover in Stage 3.

**Focused Tests:**

```sh
cargo test --manifest-path backend/Cargo.toml pull_request_diff
npm run api:check
npm run typecheck
```

**Stage Verification:**

```sh
cargo fmt --manifest-path backend/Cargo.toml -- --check
cargo test --manifest-path backend/Cargo.toml
npm run api:check
npm run typecheck
```

**Manual Check:**

- With a stored pull request fixture or development database, request the new endpoint and inspect file order, hunk ranges, and line numbers.

**Exit Criteria:**

- The endpoint is represented in generated frontend API types.
- The endpoint returns semantic data for a realistic multi-file diff.
- Authentication and error behavior match existing pull request endpoints.
- Existing Overview behavior remains unchanged.

**Stage Record (2026-07-24):**

- Added the authenticated, user-scoped parsed Diff endpoint with dedicated DTOs, source-order semantic mapping, explicit nullable fields, and generated frontend API types.
- The endpoint selects only `diff` and `synced_at`; `octet_length` prevents oversized SQLite values from being hydrated before the 64 MiB byte check.
- A null stored diff returns `409 diff_unavailable`; malformed data returns `500 diff_parse_failed`; resource limits return `422 diff_resource_limit_exceeded`.
- Parsing, DTO construction, and JSON serialization run in `spawn_blocking`. Successful requests log raw and serialized bytes, file/hunk/line counts, parse time, DTO-build time, serialization time, blocking-task time, and total endpoint time; failure logs include the available size and timing fields.
- Parser and SQLite input limits remain enforced, but no speculative response cap, mutex, semaphore, admission guard, or delivery-timeout machinery is used until observed usage demonstrates a need.
- All Diff-route responses, including CORS preflight and errors, use `Cache-Control: private, no-store`.
- Router tests cover authentication, numeric and nonnumeric paths, cross-user snapshot isolation, missing/null/empty snapshots, semantic output, malformed and oversized data, unchanged persistence, binary payload exclusion, and 50,000-line serialization.
- `cargo fmt --manifest-path backend/Cargo.toml -- --check`, 114 locked backend tests, locked all-target Clippy with warnings denied, `npm run api:check` against a fresh backend, and `npm run typecheck` passed.
- Concurrency admission and response-delivery controls were intentionally removed after review so production observations can establish whether their complexity is necessary. Stage 11 will use the logged measurements to revisit that decision.

### Stage 3: API Payload Cutover And Compression

**Outcome:** Overview and sync responses no longer carry diff content, while the dedicated Diff response is compressed.

**Todos:**

- [x] Remove `diff` from `PullRequestDetailDto`.
- [x] Stop returning diff content from detail loading, pull request synchronization, and timeline pagination.
- [x] Keep raw diff fetching and SQLite persistence inside pull request synchronization.
- [x] Bound the GitHub raw-diff download to the parser byte budget while preserving accepted bytes exactly, and test an oversized response.
- [x] Update backend construction, storage-loading, and tests for the revised detail DTO.
- [x] Update frontend fixtures that currently set `detail.diff`.
- [x] Enable an appropriate `tower-http` compression feature.
- [x] Add `CompressionLayer` to the backend router.
- [x] Add an endpoint test sending `Accept-Encoding` and asserting compressed response behavior.
- [x] Regenerate `src/api/schema.ts` after the DTO removal.
- [x] Confirm API schema generation has no uncommitted drift.
- [x] Run the two-agent review gate, resolve accepted findings, and rerun this stage's verification.

**Focused Tests:**

```sh
cargo test --manifest-path backend/Cargo.toml pull_request_detail
cargo test --manifest-path backend/Cargo.toml pull_request_diff
npm run test:run -- src/repositoriesSlice.test.ts src/App.test.tsx
npm run api:check
```

**Stage Verification:**

```sh
cargo fmt --manifest-path backend/Cargo.toml -- --check
cargo test --manifest-path backend/Cargo.toml
npm run check
```

**Manual Check:**

- Inspect an Overview detail response and confirm it contains no raw or parsed diff.
- Request the Diff endpoint with compression enabled and confirm `Content-Encoding` and a materially smaller transferred body.

**Exit Criteria:**

- Overview, sync, and timeline responses contain no diff payload.
- Raw diff persistence still passes its existing backend tests.
- The dedicated Diff endpoint is the only frontend API source for diff content.
- Compressed responses are covered by an automated test.
- Frontend and generated API types are green after the contract change.

**Stage Record (2026-07-24):**

- Removed `diff` from `PullRequestDetailDto`, its ordinary SQLite loader, and detail/sync/timeline responses. Overview requests no longer hydrate or serialize the raw diff.
- Kept the internal synchronization snapshot, SQLite `diff` column, upsert binding, and dedicated semantic Diff loader unchanged. Tests verify detail and timeline responses omit the field while stored bytes remain exact.
- Replaced the unbounded lossy `Response::text` download with a 64 MiB streaming collector. Exactly-at-limit valid UTF-8 is preserved byte-for-byte; cumulative overflow, invalid UTF-8, and non-identity content codings are rejected.
- GitHub raw-diff requests explicitly send `Accept-Encoding: identity`; tests cover multi-chunk bodies and repeated and comma-separated `Content-Encoding` fields.
- Enabled `tower-http` gzip compression globally and added a Diff endpoint test proving negotiation, headers, smaller transfer size, and byte-identical decompression.
- Removed obsolete frontend fixture fields and regenerated `src/api/schema.ts`; the dedicated semantic Diff contract remains unchanged.
- `cargo fmt --manifest-path backend/Cargo.toml -- --check`, 118 locked backend tests, locked all-target Clippy with warnings denied, `npm run check` with 86 frontend tests, `npm run build`, and `npm run api:check` against a fresh backend passed.
- Both final Stage 3 reviewers reported no findings. Live GitHub encoding behavior and large concurrent compression remain explicit telemetry/profiling risks.

### Stage 4: Routes And Shared Pull Request Shell

**Outcome:** Overview and Diff are navigable routes with shared pull request chrome, while Diff can still be a placeholder.

**Todos:**

- [x] Add `view: "overview" | "diff"` to the pull request route type.
- [x] Parse the base pull request path as Overview.
- [x] Encode Diff as `/pull/:repo/:id/diff`.
- [x] Include `view` in route equality.
- [x] Keep unknown child segments as Not Found.
- [x] Update every existing pull request link to target Overview explicitly.
- [x] Pass the selected view from `App.tsx` into the pull request page.
- [x] Extract shared title, actions, sync control, and Overview/Diff navigation from the current page.
- [x] Preserve the existing Overview rendering and three-column layout.
- [x] Add a simple Diff placeholder inside the wide Diff layout.
- [x] Make direct Diff navigation reuse existing repository and pull request summary resolution.
- [x] Add browser back and forward integration coverage.
- [x] Run the two-agent review gate, resolve accepted findings, and rerun this stage's verification.

**Focused Tests:**

```sh
npm run test:run -- src/router.test.ts src/Link.test.tsx src/store.test.ts src/App.test.tsx
```

**Stage Verification:**

```sh
npm run typecheck
npm run lint
npm run test:run
```

**Manual Check:**

- Navigate Overview to Diff and back.
- Load the Diff URL directly.
- Use browser back and forward between the views.
- Confirm the Overview layout has not visually regressed.

**Exit Criteria:**

- Both URLs are stable and typed.
- The selected view is represented in browser history.
- Shared actions work from both views.
- Overview behavior and tests remain intact.
- Diff has a wide placeholder page ready for data loading.

**Stage Record (2026-07-27):**

- Added typed Overview and Diff pull request routes. The base path remains the canonical Overview URL, `/diff` selects Diff, route equality includes the view, and malformed or unknown child paths resolve to Not Found.
- Updated all pull request links to select Overview explicitly and passed the selected view through `App.tsx` into a shared pull request shell.
- Moved the title, actions, sync control, and accessible Overview/Diff navigation into shared chrome while preserving Overview's three-column content and adding a responsive wide Diff placeholder.
- Reused the existing pull request summary and detail resolution for direct Diff entry. Automatic detail loading now records its loading state before dispatch, preventing duplicate GETs and disabling Sync while the request is in flight.
- Added route round-trip and equality tests, direct Diff resolution and rendering coverage, selected-view assertions, failed Diff sync feedback, and browser back and forward integration coverage.
- `npm run check` with 91 frontend tests, `npm run build`, and `git diff --check` passed.
- Both final Stage 4 reviewers reported no findings. Responsive grid geometry remains a manual browser verification risk because JSDOM does not evaluate CSS layout.

### Stage 5: Frontend Diff State And Loading

**Outcome:** The Diff route loads, caches, refreshes, and displays the state of the dedicated Diff resource without rendering all source rows yet.

**Todos:**

- [x] Add the one-entry `CurrentPullRequestDiff` state to `repositoriesSlice.ts`.
- [x] Add load requested, loaded, and failed messages and commands.
- [x] Fetch the generated Diff endpoint through the existing API client.
- [x] Key the current resource by repository and pull request number.
- [x] Preserve a matching loaded diff while switching Overview to Diff and back.
- [x] Replace the one-entry resource when visiting a different pull request.
- [x] Make `queuePullRequestRouteWork` load detail for Overview and diff for Diff.
- [x] Avoid loading timeline detail during direct Diff navigation.
- [x] Reload the current matching diff after a successful pull request sync.
- [x] Preserve stale diff data and show a non-destructive error after refresh failure.
- [x] Render loading, refreshing, unavailable, empty, parse-error, authorization-error, and general-error states.
- [x] Temporarily render file and line totals for a successfully loaded response to prove the full data path.
- [x] Run the two-agent review gate, resolve accepted findings, and rerun this stage's verification.

**Focused Tests:**

```sh
npm run test:run -- src/repositoriesSlice.test.ts src/store.test.ts src/App.test.tsx
```

**Stage Verification:**

```sh
npm run typecheck
npm run lint
npm run test:run
```

**Manual Check:**

- Directly open a stored Diff route and confirm only the Diff resource loads.
- Switch between views for the same PR and confirm the Diff response is reused.
- Open another PR and confirm the previous large Diff resource is replaced.
- Sync from the Diff view and observe stale-while-refresh behavior.

**Exit Criteria:**

- Diff loading is route-specific and test-covered.
- Only one parsed diff is retained by the frontend store.
- All non-rendering states have explicit UI.
- Sync refresh behavior is deterministic.
- No virtualization dependency has been introduced yet.

**Stage Record (2026-07-27):**

- Added a one-entry keyed `CurrentPullRequestDiff` resource with loading, loaded, stale-refresh, and error states. Monotonic request generations reject superseded responses and remain unique across user refreshes.
- Added the generated Diff endpoint command and dedicated error mapping, including terminal handling for rejected requests and malformed successful JSON.
- Made route work view-specific: Overview loads detail and timeline data, while direct Diff loads only the parsed Diff resource. Same-PR view changes reuse the response, and another PR route releases the previous parsed document before destination resolution.
- Reloaded a matching cached Diff after successful pull request sync. Refresh keeps the previous response visible, labels it as stale after failure, and disables overlapping Sync requests.
- Replaced the placeholder with announced loading and refreshing states, empty and successful totals, unavailable, parse-limit, parse, authentication, authorization, repository, validation, and general failure messages.
- Added reducer and command tests for one-entry replacement, stale retention, request races, transport and JSON failures, route retry, and user changes; store tests cover route-specific loading, release, cache reuse, and sync refresh; App tests cover direct loading, all UI states, stale failures, rejected Sync, and browser history reuse.
- `npm run check` with 120 frontend tests, `npm run build`, and `git diff --check` passed.
- Both final Stage 5 reviewers reported no findings. Rapid overlapping large-request heap behavior, responsive layout, and live-region announcements remain manual or later-stage verification risks.

### Stage 6: Compact Layout Index

**Outcome:** Pure frontend code maps the hierarchical API response to stable virtual rows without duplicating every line object.

**Todos:**

- [x] Add focused diff layout types and helpers in a new frontend module.
- [x] Build compact row-kind and semantic-index arrays or an equivalently bounded prefix index.
- [x] Represent file headers, hunk headers, source lines, and binary or hunkless notices.
- [x] Implement `rowAt(index)`.
- [x] Implement stable `rowKey(index)` values.
- [x] Implement exact `rowHeight(index)` values for each row kind.
- [x] Record each file's starting row for future navigation.
- [x] Record each hunk's starting row for search and copying.
- [x] Calculate a conservative maximum visual source width with consistent tab expansion.
- [x] Generate deterministic 50,000-line and 100,000-line test responses without committing giant source files.
- [x] Use a canonical generated scenario matrix covering one large hunk, many files, many hunks, alternating line kinds, and header-heavy input with expected file, hunk, source-line, and visual-row counts.
- [x] Generate 64 KiB and 1 MiB source lines with tabs, trailing whitespace, wide or combining Unicode, and a rare match near the final column.
- [x] Prove the index uses compact metadata rather than one new object per source line.
- [x] Run the two-agent review gate, resolve accepted findings, and rerun this stage's verification.

**Focused Tests:**

```sh
npm run test:run -- src/diff
```

Use the final module or test path if it differs from `src/diff`.

**Stage Verification:**

```sh
npm run typecheck
npm run lint
npm run test:run
```

**Performance Check:**

- Measure layout-index construction for 50,000 and 100,000 lines.
- Inspect retained heap and confirm the index does not duplicate line-content strings.

**Exit Criteria:**

- Every semantic file, hunk, and line maps to the expected visual row.
- Row lookup, keys, heights, and file starts are deterministic.
- Large generated data builds successfully without DOM involvement.
- The index is ready to drive a virtualizer directly.

**Stage Record (2026-07-27):**

- Added `src/diff/layout.ts` with a two-pass exact-allocation index. Each visual row retains one byte of kind data and three `Uint32` semantic indexes; file and flat hunk start arrays support direct navigation without duplicating source objects.
- Represented fixed-height file, hunk, context, addition, deletion, binary-notice, and hunkless-notice rows. `rowAt`, `rowKey`, `rowHeight`, and `hunkStartRow` validate bounds and resolve the original generated DTO objects on demand.
- Added deterministic four-column tab expansion and conservative source-width scanning that counts the Diff prefix, trailing whitespace, combining and variation sequences, emoji presentation, CJK, Hangul, Kana, Nushu, Tangut, and other supplementary wide ranges.
- Added canonical semantic mapping tests plus generated one-large-hunk, many-files, many-hunks, alternating-kind, and header-heavy matrices. The matrices cover 50,000 and 100,000 source lines with exact file, hunk, source-kind, visual-row, key, and metadata-byte assertions.
- Added exact 64 KiB and 1 MiB source-line cases with tabs, trailing spaces, wide and combining Unicode, and a marker in the final 32 code units. Tests prove direct DTO identity and the absence of a retained row-object array.
- Isolated Node measurements after fixture construction built 50,000 lines in 2.72 ms with 650,042 metadata bytes and 100,000 lines in 3.36 ms with 1,300,042 metadata bytes. Observed `ArrayBuffer` growth closely matched the exact typed-array totals.
- `npm run check` with 128 frontend tests, `npm run build`, and `git diff --check` passed.
- Both final Stage 6 reviewers reported no findings. Browser font fallback, future Unicode width changes, and worst-case all-non-ASCII profiling remain Stage 7/8 or manual risks.

### Stage 7: Basic Virtualized Diff Renderer

**Outcome:** All files and hunks appear as one window-scrolling unified diff with a bounded DOM.

**Todos:**

- [x] Add `@tanstack/solid-virtual`.
- [x] Create one `createWindowVirtualizer` for the complete layout index.
- [x] Account for content before the list through `scrollMargin`.
- [x] Use exact row heights and stable item keys.
- [x] Start with approximately 20 rows of overscan.
- [x] Render a total-height spacer and one translated visible block.
- [x] Render fixed-height file headers.
- [x] Render fixed-height hunk headers.
- [x] Render context, addition, and deletion rows with old and new line gutters.
- [x] Render binary and hunkless file notices.
- [x] Preserve whitespace and tabs while preventing line wrapping.
- [x] Escape all source content as text.
- [x] Remove or replace the existing nested-scroll `.pr-diff` CSS.
- [x] Add virtual table, row, row-index, and cell semantics.
- [x] Add component tests with mocked viewport measurements.
- [x] Assert that a 50,000-line fixture mounts fewer than 200 diff rows.
- [x] Run the two-agent review gate, resolve accepted findings, and rerun this stage's verification.

**Focused Tests:**

```sh
npm run test:run -- src/App.test.tsx src/diff
```

**Stage Verification:**

```sh
npm run typecheck
npm run lint
npm run test:run
```

**Manual Check:**

- Scroll rapidly through a large generated diff in a real browser.
- Jump near the bottom and verify row order and line numbers.
- Resize desktop and mobile viewports and confirm row heights remain fixed.
- Confirm no nested vertical scrollbar appears.

**Exit Criteria:**

- Multiple files and hunks render in one browser-window scroll sequence.
- DOM row count remains bounded for large diffs.
- Line numbers and source contents are correct at distant scroll positions.
- Rapid scrolling produces no persistent blank regions.
- Rendering works in light and dark themes at a basic level.

**Stage Record (2026-07-28):**

- Added `@tanstack/solid-virtual` 3.13.35 and one `createWindowVirtualizer` over the complete compact layout with 20 rows of overscan, exact row heights, and semantic coordinate keys.
- Added `src/diff/DiffView.tsx` with one total-height spacer and one translated contiguous mounted block. Diff replacement explicitly clears cached virtual measurements, including same-row-count changes with different geometry.
- Calculated window `scrollMargin` from the table's document position and refresh it on window resize and observed Diff section/page layout changes. Tests cover nonzero scrolling and a dynamically shifted table offset.
- Rendered fixed file, hunk, source, binary, and hunkless rows. Source rows include old/new gutters, visible unified prefixes, accessible line-kind and line-number labels, missing-newline notices, escaped text content, preserved whitespace, four-column tabs, and no wrapping.
- Replaced the nested `.pr-diff` scroller with window-scrolling virtual table styles and fixed 40/32/24 pixel row contracts. File paths stay one line and ellipsize within their fixed-height header.
- Added virtual table, row-count, row-index, column-header, and cell semantics while keeping the virtual source rows outside the polite loading/error live region.
- Added component tests for all row kinds and heights, gutters, prefixes, missing-newline and escaping behavior, same-count geometry replacement, scroll-margin movement, and distant scrolling. A 50,002-row model keeps fewer than 200 rows mounted before and after jumping to the final line.
- `npm run check` with 132 frontend tests, `npm run build`, `git diff --check`, and `npm audit --omit=dev` passed; the production dependency audit reported zero vulnerabilities.
- Both final Stage 7 reviewers reported no findings. Rapid real-browser scrolling, near-bottom jumps, responsive layout, screen-reader table navigation, and light/dark visual checks remain manual risks.

### Stage 8: File Navigation And Horizontal Scrolling

**Outcome:** Users can navigate files directly and reach every column of a non-wrapping line without scrolling to the bottom of the page.

**Todos:**

- [x] Add a file picker to the sticky Diff toolbar.
- [x] Use `fileStartRows` and `scrollToIndex` for file navigation.
- [x] Derive the active file from the first visible row rather than the overscan boundary.
- [x] Render a sticky active-file header independent of virtualized file-header rows.
- [x] Keep long paths to one visual line and expose their complete accessible text.
- [x] Add one shared horizontal offset for mounted source cells.
- [x] Add a sticky or fixed horizontal scrollbar rail while the Diff view is active.
- [x] Keep old and new line-number gutters fixed during horizontal movement.
- [x] Synchronize the rail, trackpad horizontal gestures, and newly mounted rows.
- [x] Size the rail from the layout's conservative maximum source width.
- [x] Clamp the offset after viewport or content-width changes.
- [x] Add bottom spacing so the horizontal rail does not cover final rows.
- [x] Add deterministic tests for file jumps, active-file changes, and horizontal offset synchronization.
- [x] Run the two-agent review gate, resolve accepted findings, and rerun this stage's verification.

**Focused Tests:**

```sh
npm run test:run -- src/App.test.tsx src/diff
```

**Stage Verification:**

```sh
npm run typecheck
npm run lint
npm run test:run
```

**Manual Check:**

- Jump among the first, middle, and last files in a large diff.
- Scroll across a very long line using the rail and a trackpad.
- Confirm gutters remain visible and newly mounted lines retain the shared offset.
- Verify the controls on a narrow mobile viewport.

**Exit Criteria:**

- File jumps land on the correct virtual row.
- The sticky active-file header tracks window scrolling.
- Every column of the longest line can be reached without visiting the bottom of the diff.
- Horizontal movement does not shift line-number gutters.

**Stage Record (2026-07-28):**

- Added a sticky Diff toolbar with a native accessible file picker. Selection calls the virtualizer with the compact `fileStartRows` index and exact sticky-header scroll padding.
- Derived the active file from the first unobscured virtual row at the current window offset rather than from overscan or eager picker state. A separate sticky active-file header remains present when virtual file rows unmount.
- Kept full file paths in picker options, header text, accessible labels, and titles while constraining toolbar and active-header presentation to one ellipsized line.
- Added one inherited horizontal offset for all mounted source-content wrappers. Source viewports clip translated content while old/new gutters remain in fixed grid columns, so newly virtualized rows inherit the current position automatically.
- Added a fixed, named native horizontal-scroll region aligned to the Diff table. Its rail width uses the same monospace `0.85rem` metrics and the layout's conservative maximum columns, including rendered missing-newline notices.
- Synchronized native rail scrolling, horizontal trackpad or shifted-wheel input, and touch/pen dragging. Edge gestures remain available to the browser, vertical panning and pinch zoom stay enabled, and the rail remains keyboard focusable.
- Recomputed rail/table/sticky geometry through existing ancestor observation and window resize handling. Offset is clamped after content replacement or viewport changes, and safe-area-aware bottom spacing prevents the fixed rail covering final rows.
- Added deterministic tests for exact file-start jumps, viewport-derived first/middle/last active files, rail and wheel synchronization, touch dragging, edge behavior, vertical remount inheritance, and content/resize clamping.
- `npm run check` with 134 frontend tests, `npm run build`, and `git diff --check` passed.
- Both final Stage 8 reviewers reported no findings. Real-device touch/pinch behavior, overlay scrollbars, font fallback, mobile browser chrome, safe-area alignment, and short-last-file document clamping remain manual risks.

### Stage 9: Full-Diff Search

**Outcome:** Custom search finds and navigates to matches in mounted and unmounted rows.

**Todos:**

- [ ] Add search query, result indexes, and current-result state local to the Diff view.
- [ ] Search semantic source content rather than DOM text.
- [ ] Start with case-insensitive literal matching.
- [ ] Defer search calculation enough to keep input responsive.
- [ ] Store compact virtual row indexes and match offsets.
- [ ] Intercept `Cmd+F` and `Ctrl+F` only while the Diff view is active.
- [ ] Implement Enter, Shift+Enter, and Escape behavior.
- [ ] Wrap navigation at the first and last result.
- [ ] Use `scrollToIndex` to center an unmounted result.
- [ ] Adjust the shared horizontal offset to reveal the active match.
- [ ] Highlight active and inactive matches only in mounted source rows.
- [ ] Display and announce current and total result counts.
- [ ] Remove keyboard listeners when the Diff view unmounts.
- [ ] Test queries matching the first, middle, and final rows of a large model.
- [ ] Run the two-agent review gate, resolve accepted findings, and rerun this stage's verification.

**Focused Tests:**

```sh
npm run test:run -- src/App.test.tsx src/diff
```

**Stage Verification:**

```sh
npm run typecheck
npm run lint
npm run test:run
```

**Performance Check:**

- Search 50,000 and 100,000 lines for a common one-character query and a rare multi-character query.
- Include repeated matches per line and measure result-index allocation as well as query latency.
- Confirm typing and result navigation remain responsive in a production build.

**Exit Criteria:**

- Search discovers unmounted content.
- Keyboard behavior matches the documented controls.
- Vertical and horizontal navigation reveal the active match.
- Result highlighting does not require mounting additional rows.
- Search listeners do not leak to Overview or other routes.

### Stage 10: Copying, Accessibility, And Responsive Polish

**Outcome:** The feature has complete first-version interactions and is usable with keyboard, assistive technology, themes, and mobile layouts.

**Todos:**

- [ ] Implement pure Copy hunk text generation from semantic DTOs.
- [ ] Implement pure Copy file text generation from semantic DTOs.
- [ ] Preserve file headers, hunk ranges, and unified-diff line prefixes.
- [ ] Define and test binary-file copy behavior.
- [ ] Add Copy hunk controls to hunk headers.
- [ ] Add Copy file controls to file and sticky active-file headers.
- [ ] Handle clipboard rejection without losing diff state.
- [ ] Announce copy success and failure through a polite live region.
- [ ] Audit toolbar, file picker, search, copy, and sync controls for keyboard access and labels.
- [ ] Confirm additions and deletions are distinguishable without color alone.
- [ ] Confirm virtual row count and row indexes are exposed consistently.
- [ ] Complete light and dark theme treatments.
- [ ] Complete desktop and mobile spacing, gutter, toolbar, and horizontal-rail behavior.
- [ ] Respect reduced-motion preferences.
- [ ] Add component coverage for copying and accessibility announcements.
- [ ] Measure Copy file and Copy hunk reconstruction for one 100,000-line target, including peak heap and clipboard failure behavior.
- [ ] Run the two-agent review gate, resolve accepted findings, and rerun this stage's verification.

**Focused Tests:**

```sh
npm run test:run -- src/App.test.tsx src/diff
```

**Stage Verification:**

```sh
npm run check
cargo fmt --manifest-path backend/Cargo.toml -- --check
cargo test --manifest-path backend/Cargo.toml
```

**Manual Check:**

- Navigate, search, and copy using only the keyboard.
- Exercise the feature with a screen reader at least at the toolbar and mounted-row level.
- Check light, dark, desktop, and mobile presentations.
- Copy a hunk and file and verify the resulting text is understandable and patch-like.

**Exit Criteria:**

- Copy actions work independently of mounted DOM.
- All primary controls are keyboard accessible and explicitly labeled.
- Search and copy outcomes are announced.
- Light, dark, desktop, and mobile states are usable.
- All automated frontend and backend tests pass.

### Stage 11: Performance Validation And Release Readiness

**Outcome:** The implementation is measured against the target scale, tuned, and ready to ship without speculative caching or persistence.

**Todos:**

- [ ] Create repeatable 50,000-line and 100,000-line profiling scenarios.
- [ ] Measure backend parsing and DTO construction.
- [ ] Measure JSON serialization and compressed response size.
- [ ] Review Diff endpoint usage logs using `FUTURE_WORK.md` and add concurrency or delivery controls only if observed memory, latency, or overlap justifies them.
- [ ] Measure browser JSON parsing and layout-index construction.
- [ ] Measure retained browser heap before and after visiting several large pull requests.
- [ ] Confirm only one current parsed diff remains retained.
- [ ] Profile rapid top-to-bottom scrolling in a production build.
- [ ] Tune virtualizer overscan based on observed blanking and frame cost.
- [ ] Measure common and rare search queries.
- [ ] Measure high-cardinality search result allocation and Copy file/Copy hunk construction, peak heap, and real-browser clipboard latency.
- [ ] Profile large literal and delta binary patches and confirm payload bytes do not escape into semantic DTOs or JSON.
- [ ] Confirm the diff's total virtual height remains within browser layout limits at the target scale.
- [ ] Run the complete frontend and backend suites after tuning.
- [ ] Review the final OpenAPI diff and generated schema.
- [ ] Record measured results and any intentionally deferred bottlenecks.
- [ ] Run the two-agent review gate, resolve accepted findings, and rerun the complete verification suite.

**Full Verification:**

```sh
npm run check
npm run build
npm run api:check
cargo fmt --manifest-path backend/Cargo.toml -- --check
cargo test --manifest-path backend/Cargo.toml
```

Run Clippy if it is part of the project's accepted backend toolchain:

```sh
cargo clippy --manifest-path backend/Cargo.toml --all-targets -- -D warnings
```

**Release Checks:**

- Direct Overview and Diff URLs load correctly.
- Browser back and forward preserve route selection.
- A 50,000-line diff mounts fewer than 200 rows.
- Rapid scrolling has no persistent blank areas.
- Full-diff search finds unmounted lines.
- Long lines are horizontally reachable.
- Copy actions do not depend on DOM presence.
- Overview transfers no diff data.
- Diff responses are compressed.
- Visiting multiple PRs does not grow retained parsed-diff memory without bound.

**Exit Criteria:**

- All acceptance criteria in this document are satisfied or explicitly documented as deferred.
- Performance has been measured rather than inferred.
- No backend parsed cache, parsed SQLite column, Web Worker, or chunked API has been added without a measured need.
- The implementation is ready for normal code review and release.

## Follow-Up Possibilities

Only consider these after the initial implementation is measured in realistic use:

- Syntax highlighting for mounted rows.
- A bounded backend parsed-diff cache.
- Persisted parsed snapshots with a schema version.
- Background or streamed parsing.
- File-level lazy loading.
- Backend-powered full-diff search for extremely large payloads.
- Side-by-side rendering.
- Context collapsing.
- Inline comments and review annotations.
- Custom arbitrary line-range selection.
- Semantic scroll preservation after synchronization.
