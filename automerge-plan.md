# Automerge personal review workspace

## Status

The feature is implemented in this branch, not just the compatibility spike. The PR Diff page has exact-version reviewed/collapsed controls, a durable offline workspace, authenticated backend synchronization, explicit recovery, and an optional human-importance/agent-context panel.

Implementation and reproduction details: [`src/review/README.md`](src/review/README.md). The original compatibility harness remains in [`spikes/automerge`](spikes/automerge/README.md).

## Product invariants

- Review is private Kestrel state scoped to `(user, immutable repository ID, PR number)`. It does not change GitHub approvals or viewed-file state.
- A command targets the snapshot/version actually displayed when invoked. Refreshing a diff is explicit and independent of metadata synchronization.
- Reviewed and collapsed are independent registers. Review/unreview atomically expresses reviewed plus collapse/open; repeating a decision is a no-op. Manual visibility is independent. Current-tab visibility does not jump on remote updates.
- A new file version defaults to unreviewed/open. Returning to an exact old version restores its saved state, including explicit unreview. Predecessor links explain invalidation; they never carry a review mark forward.
- Causally later commands supersede observed commands. Concurrent human decisions use deterministic CRDT winners, not browser clocks or server arrival order. Conflicts remain inspectable and can be explicitly reasserted. Fieldwise merges can leave a reviewed file expanded.
- Human importance is `inherit`, `important` or `unimportant`, separate from agent assessments. Explicit human values win. Agent provenance fields are immutable/idempotent; agents cannot write human review, collapse or importance.
- Local durability precedes transmission. Network rejection never silently erases pending work. Recovery archives the old branch before replaying pending typed commands; no broad undo or automatic reset.

## Architecture adopted

### Shared Rust, generated boundary types

`review-core` implements commands, projection, conflict inspection, exact-change proposal reconstruction and capability validation. `review-wasm` wraps it for the route-owned browser runtime. Tsify generates command/view TypeScript types; OpenAPI generates HTTP envelope types. There is no handwritten TypeScript copy of the merge rules. Mutable replicas do not live in pure MVU state.

Pinned versions remain Rust Automerge 0.11.0, official JS Automerge 3.4.1, wasm-bindgen 0.2.128 and Tsify 0.5.8. The official JS package is test-only. The actual WASM artifact is about 2.1 MB raw / 640 KB gzip; it is lazy-initialized, and production offline installation includes it.

### Safe import boundary: typed proposals, not arbitrary binary history

The spike demonstrated why merged JSON/schema inspection cannot authorize opaque Automerge changes: deleted forbidden operations, invalid losing values and same-ID concurrent writes can survive or disappear from visible-state checks.

Production avoids that boundary entirely. Each pending proposal contains a shared typed command, fresh actor, original dependency heads and expected change hash. The backend authorizes its account, workspace and known snapshot/version, forks the canonical document at those dependencies, executes the shared human command and compares hashes before merging. Reused actors, unknown frontiers, mismatched changes and client agent commands are rejected. The server does not load client-supplied Automerge bytes.

This preserves the exact original CRDT change and offline causality; it is **not** replay at the latest server state. Actor IDs do not authenticate a writer. Agent contributions originate inside the backend under its agent capability.

The native/WASM trusted binary APIs still exist for compatibility tests and trusted server documents. They are explicitly not authorization boundaries.

### Immutable snapshots

The backend fetches both comparison metadata and raw diff at pinned `baseSHA...headSHA` URLs. Before identities come from the comparison merge-base tree; after identities come from the pinned head tree. Full object IDs/modes are resolved through immutable tree traversal, not abbreviated diff headers or later mutable refs.

The file fingerprint includes a version marker, Git hash algorithm, explicit absent sides, full before/after object IDs and modes, old/new paths, operation kind, and canonical reviewable hunks with context, line numbers, whitespace and missing-newline flags. File identity excludes unrelated PR commit IDs. It covers binary/out-of-hunk changes and preserves identical reviewable versions across rebases.

Manifests retain base/head/merge-base commits and complete per-side identity inputs. SQLite separately retains immutable raw diffs, manifests and version membership. Explicit modifications/renames provide conservative predecessor links; adds/copies do not guess lineage. Legacy snapshots without trustworthy base metadata remain readable but have no review controls until refreshed.

### Durable server and transport

Migration `0011_review_workspaces.sql` adds metadata workspaces and immutable snapshot/version tables. `BEGIN IMMEDIATE` serializes writers across processes. Both browser and Rust demo-agent updates operate on the same canonical document. Persistence finishes before acknowledgment/publication.

The authenticated same-origin WebSocket exchanges typed proposal batches and full trusted binary document receipts encoded in JSON. The backend discovers other committed revisions every three seconds. Reconnect starts a fresh connection; pending hashes replay idempotently after lost replies or server restart. Production deliberately does not import opaque Automerge sync messages.

Protocol limits: 128 KiB inbound request/message, 64 proposals per batch, 8 MiB or 20,000 changes per metadata document, 512 MiB immutable diff history per workspace. Quota rejection preserves prior durable state. Full-history storage is intentional for this first release; no automatic compaction/forgetting policy is hidden in synchronization.

### Browser durability, offline behavior and recovery

Each IndexedDB readwrite transaction reads the latest document, mutates it synchronously in WASM, and saves the full binary plus pending journal atomically. This is the cross-tab coordinator; BroadcastChannel only notifies other runtimes. HTTP waits never block this queue. Captured local actions finish across route disposal; generation fences protect cleared/recovered branches, and unsaved browser exits get a best-effort warning. Failed transactions never publish or send their candidates. Incoming receipts and acknowledged-journal retirement follow the same rule.

Static assets are precached by a service worker. Authenticated API responses are never service-worker cached. An explicit account-scoped IndexedDB allowlist retains previously opened metadata and immutable diff snapshots. Server-authenticated account headers and store-generation guards prevent late cross-account responses. Transport/server failures may use cached data; online authorization failures may not. Uncached PRs require connectivity. Cached diffs are labelled.

The UI distinguishes local saving, durable pending, synchronized, not-saved, expired-session and blocked states. It offers retry, export, explicit archive/replay recovery, persistent-storage requests, and warned account-wide discard. Sign-out retains pending data but clears the cached session marker. Offline access cannot detect an online permission revocation retroactively; browser eviction remains outside application control.

## Implementation checklist

### 1. Semantics and interoperability

- [x] Native domain commands, independent registers and explicit conflict reassertion.
- [x] Agent/human capability separation and immutable contribution validation.
- [x] Official JS ↔ native Rust ↔ custom WASM documents and sync interoperability.
- [x] Generated types, Vite loading and measured WASM cost.
- [x] Negative import-boundary examples and a production-safe alternative.
- [x] Generated convergence schedules, persistence failure, lost replies and restart tests.

### 2. Snapshot identity

- [x] Revision-consistent full object identities, explicit missing sides and real modes.
- [x] Canonical changed-version fingerprint independent of unrelated commits.
- [x] Immutable source/manifest persistence separate from CRDT state.
- [x] Conservative predecessor metadata without guessed review inheritance.
- [x] Native fingerprint matrix and HTTP-level immutable comparison/tree tests.

### 3. Backend service

- [x] Canonical workspace initialization and multi-process SQLite serialization.
- [x] Authenticated discovery/update/WebSocket routes, origin checks and per-message session authorization.
- [x] Exact causal proposal validation, snapshot/version membership and bounded requests.
- [x] Commit-before-receipt, idempotent replay, revisions and agent-writer path.
- [x] OpenAPI-generated request and response envelope types.

### 4. Local-first review UI

- [x] Version-bound reviewed checkbox, collapse/expand, explicit conflict resolution and accessible invalidation explanation.
- [x] Route-owned runtime and active-tab visibility isolation.
- [x] Atomic cross-tab IndexedDB document/journal transactions.
- [x] Reconnect/backoff, durable pending status, expired-session and blocked recovery controls.
- [x] Offline app shell and account-scoped immutable opened-diff caching.
- [x] Explicit data export/discard and atomic archive/replay recovery.
- [x] Search/copy/navigation/virtualization regression coverage.
- [x] Real Chromium E2E using the actual backend, SQLite, WASM and production bundle.

### 5. Agent/human importance foundation

- [x] Optional human importance UI, human precedence and explicit importance conflict resolution.
- [x] Attributed, version-bound immutable assessments with context.
- [x] Clearly labelled Rust demonstration writer sharing the durable workspace service.
- [ ] Production agent execution/scheduling and sequential replacement-stream product semantics.
- [ ] Human context amendments/dismissals and richer evidence presentation.

## Remaining release/product decisions

The implemented feature is reviewable now; these are follow-ups, not reasons to ship only a spike:

- Review deterministic concurrent-human semantics and the WASM footprint. `VITE_REVIEW_ENABLED=false` is the UI rollback switch; importance/agent context defaults off behind `VITE_REVIEW_AGENT_EXPERIMENT`.
- Profile large accumulated histories and cold/mobile browsers before broad rollout; current evidence is native/property tests and Chromium. Bulk projection avoids scanning all assessments for every displayed file.
- Decide user-facing server archival/quota management before relaxing full-history limits. Preserve exports and outstanding commands during any future schema migration.
- Expand agent product semantics only with an explicit capability/authentication design. The demo is not presented as a real code-review agent.

See the feature README for exact reproduction and scope. The original main-worktree planning documents are untouched.
