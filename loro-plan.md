# PR review workspace with Loro

## Status and goal

Implementation in progress, not a library selection. The separate Automerge proposal and original diff-review specification are not included in this branch. Sources: that specification, [LUN-22](https://linear.app/lunch/issue/LUN-22/investigate-crdts-for-pr-review-state-synchronization), and our subsequent discussion about offline review and backend agents.

**Current implementation: local review on the existing PR diff page.** See [integration, tests and limitations](docs/loro-integration.md). Reviewed/collapsed controls, exact Git identities, durable local history, cross-tab coordination and export are implemented. The standalone demo is removed. Untrusted binary network synchronization remains [gated](docs/loro-spike.md); backend review durability, cross-device transport, offline app-shell reload and agent UI remain outstanding.

Build a local-first, personal PR review workspace. A reviewer can keep working through poor connectivity while Rust agents independently add context and assessments. Reconnection must preserve contributions, respect explicit human decisions, and never apply an old review mark to unseen changes.

Start with reviewed/collapsed state and a minimal agent-assessment test slice. Do not build a general collaboration framework, an agent scheduler, or a collaborative code editor.

## Requirements and changes to the original specification

Retain:

- Scope state to user, repository, and PR. No GitHub viewed-file or approval synchronization.
- Keep `reviewed` and `collapsed` independent. Reviewing collapses; unreviewing opens. Manual expand/collapse does not change review status.
- Repeating the current review decision does nothing, including no visibility change.
- Apply actions to the exact displayed version. Refresh changes the displayed diff explicitly, never as a side effect of agent activity or metadata synchronization.
- An unseen changed version starts unreviewed and open. Returning to an exact previous version restores its saved flags, including explicit unreviewing.
- Keep the checkbox on the right of the file header, keyboard accessible. Explain automatic invalidation on hover and focus.
- Persist visibility, but do not force an already-open tab to expand/collapse in response to another replica.

Changes required by the discussion:

| Original baseline                 | Proposed replacement                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Network save failure rolls back   | Locally durable edits stay pending and retry. Network failure does not undo review work.                                                         |
| Last backend-accepted action wins | Causally later changes supersede earlier changes; truly concurrent decisions follow an explicit deterministic policy. See below; needs approval. |
| Reviewed-state-only investigation | Review workspace foundation, including attributed agent assessments and context.                                                                 |
| Browser/backend persistence       | Browser durability across offline reloads, backend durability, and bidirectional synchronization.                                                |

Human decisions override agent assessments. An agent may fill in an assessment or supply additional context, but must not silently reverse an explicit human decision. Exact UI for suggestions remains to be designed.

## Architecture

### Shared Rust core

Proposed layout:

- `crates/review-core/`: Loro document schema, typed commands, validation, and materialized review views. No Axum, SQLite, browser APIs, or agent runtime dependencies.
- `crates/review-wasm/`: a narrow `wasm-bindgen` interface around that core for the browser.
- `backend/src/review.rs`: authenticated workspace loading, persistence, synchronization, and the service API used by agents.
- `src/review/`: IndexedDB storage, transport, Solid/MVU integration, and local visibility state.

Compile the same domain implementation natively for the backend and to WASM for the browser. Generate TypeScript command/view types rather than maintaining handwritten parallel schemas. Include a schema version in the document and a protocol version in the transport.

Use the Rust `loro` crate. Use the official WASM-backed `loro-crdt` package in the interoperability spike; do not ship that runtime alongside a second Loro runtime in the custom WASM module. The custom WASM boundary is a proposed tradeoff for sharing domain behavior. Measure its build/API cost before committing to it.

Do not substitute the experimental pure-TypeScript `loro.js` implementation for this plan. The goal is to share the Rust implementation, not introduce a second engine whose supported edge cases must also be evaluated.

### Document boundary and ownership

Use one document per `(user ID, immutable repository ID, PR number)` initially. Server-side metadata owns that mapping and authorization; document contents cannot grant access or redefine their owner.

The document stores review metadata, not source files, raw diffs, GitHub timeline data, or credentials. Cache immutable diff snapshots separately. Agents working for that user contribute to that user's workspace; sharing an agent result across users is later work.

A document has one serialized mutation queue per replica. Browser tabs and independently writable agent forks need distinct Loro peer IDs. Peer identity is not authenticated user identity. Never let independent writers continue the same peer/counter sequence. Verify ownership behavior through load, fork, crash, and restart rather than assuming a saved snapshot gives each loader a fresh identity.

### Proposed schema

Use named root `LoroMap` containers for collections. Version IDs are scalar keys inside those maps. This avoids concurrent first creation of per-version nested containers.

| Root map           | Key                    | Value                                                                                                  |
| ------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `reviewed`         | file-version ID        | Boolean; missing means false                                                                           |
| `collapsed`        | file-version ID        | Boolean; missing means false                                                                           |
| `humanImportance`  | file-version ID        | Scalar `important`, `unimportant`, or `inherit`                                                        |
| `agentAssessments` | stable contribution ID | Version-bound assessment, agent/run identity, evidence references, optional superseded contribution ID |
| `context`          | stable contribution ID | Version-bound, attributed contextual note                                                              |

Store small immutable contribution payloads as values under unique IDs. Do not replace an entire collection with a JSON object to update one key. If contributions later require collaboratively editable fields, introduce appropriate child containers deliberately.

Ordinary concurrently inserted child containers at the same map key can compete instead of combining their children. Newer Loro APIs document mergeable child containers; verify their availability in the pinned Rust/WASM versions before relying on them. The initial flat schema does not require them.

Agents cannot write human decisions or collapse flags. Human review marks mean the human reviewed that version; an agent assessment is not a human review mark.

Separate human and agent fields make precedence independent of arrival order. An explicit `inherit` action relinquishes a human importance override; do not infer this from deleting a value. Initially support one designated assessment stream per version, with sequential replacements. Preserve different streams as separate attributed assessments rather than inventing a consensus between agents.

Create each contribution under a unique ID and treat its original content as immutable in the first slice. Human amendments and dismissals reference the contribution ID separately. This avoids pretending whole-string replacement is collaborative text editing. Shared editing of one note, threaded comments, and concurrent deletion semantics are follow-ups.

### Decision semantics

- `LoroMap` uses last-write-wins semantics based on CRDT ordering, not browser wall clocks or backend arrival time. Verify/document the precise ordering in the pinned release.
- Proposed first policy: use the native deterministic map winner for concurrent human decisions. Causally later writes supersede the writes they observed.
- Unlike Automerge's map-conflict API, do not assume Loro exposes losing concurrent map values as a ready-made multi-value register. If visible conflict choices are required, prove suitable history APIs or explicitly design additional decision records before implementation.
- An explicit reassert command should create a resolving write after synchronization; verify same-value write behavior. Normal repeated review commands remain no-ops.
- Do not implement human precedence through timestamps or peer-ID sorting. It comes from the separate human override field.
- One review/unreview command changes both flags before one explicit `commit()`, then persists one resulting document state. Publish one view update after the command/import, not intermediate writes.
- Loro commit grouping is not ACID isolation or rollback. Concurrent commands can merge independent fields; an expanded reviewed file is valid. Test and approve the resulting flag combinations rather than promising that a whole action always wins as a unit.
- A tab initializes its local visibility from the persisted flag. Its own review/visibility actions update both. Remote changes update the persisted replica and reviewed indicator, but not that tab's current visibility. Reload/reopen restores the converged persisted visibility.

The concurrent-human policy is a product decision still to approve. Both plans require deterministic convergence, but native tie-break outcomes need not match between libraries. If the product needs identical semantic winners or an “unreview wins” rule, specify and implement that explicitly rather than relying on either default.

## Exact version identity

This is a prerequisite, not a CRDT feature. Loro history/frontiers identify review-document state; they are not Git file-version identities.

Compute an opaque, versioned fingerprint on the backend from canonical input containing:

- Before/after full Git object identities, with explicit absent-side markers.
- Before/after paths and modes, including additions, deletions, renames, copies, symlinks, gitlinks, and binary objects.
- Canonical reviewable hunks, line numbers, context, and missing-newline information, independent of UI display preferences.

Include the repository hash algorithm where relevant. Do not include the PR head SHA merely as an invalidation shortcut. Identical contents and reviewable changes after a rebase must retain identity; unrelated file changes must not affect it.

Implemented for fresh syncs: `backend/src/pull_requests/review_identity.rs` obtains full before/after objects and modes from the pinned comparison's merge-base/head trees and persists them with a canonical manifest. `pull_request_diff.rs` alone still cannot provide trustworthy identity; its DTO is not hashed in isolation. Legacy or incomplete snapshots remain readable but cannot receive review marks until trustworthy identity is available.

Store a snapshot manifest linking files to version IDs and explicit predecessor relationships. That history explains changed-version invalidation without using path equality as a universal file identity. Copies get distinct entries; ambiguous rename lineage must not inherit review state by guesswork. Missing trustworthy identity is a visible unavailable/loading condition, not permission to reuse an old review mark.

Retain old version records. Select the current snapshot's records rather than clearing flags in response to refresh. Agent jobs carry the immutable snapshot/version references they analyzed; late results remain attached there. Do not `checkout()` the live review document to an old frontier merely to display an older Git diff.

## Offline storage and application lifecycle

Use IndexedDB for full-history Loro snapshots and durable sync bookkeeping, not `localStorage` JSON. Begin with a full binary snapshot per small metadata document; measure before adding an incremental binary update journal.

Persist a small pending-command journal atomically with each local save: stable command ID, typed intent, target snapshot/version, and generated operation ranges. It supports attribution, durability tracking, and explicit recovery after rejected history. It is not a second merge engine: normal synchronization exchanges Loro updates, never blindly replays commands. Retire acknowledged journal entries only under the recovery/audit retention policy.

For each local command:

1. Serialize it with other commands/imports and check it against the displayed snapshot.
2. Validate first, apply to a candidate document, and commit explicitly without yielding between coupled writes.
3. Show the optimistic projection and atomically persist the resulting full snapshot and pending status in IndexedDB.
4. Only then describe it as saved locally and make its update eligible for transmission.

Loro documents use an implicit transaction, and import/export can commit it. Do not allow network callbacks or subscriptions to export half of a domain command. Keep domain command boundaries explicit even if the library combines history entries internally.

On local disk/quota failure, discard the candidate and restore the last durable document, preserving unrelated accepted changes. Show a retryable error. Loro's `UndoManager` is not a persistence rollback or authorization mechanism. Serialize publication so a failed earlier command cannot roll back a later durable command. Verify the candidate-copy strategy preserves history and does not create unnecessary peer identities on every action.

Persist accepted remote changes before acknowledging browser durability. Multiple tabs must merge with the latest durable state under a cross-tab lock or equivalent single-writer storage coordinator; last-writer-wins IndexedDB snapshot replacement would lose work even though Loro itself merges correctly. BroadcastChannel can notify tabs, but is not the durable source of truth.

Offline reload also requires the app shell/WASM and the displayed PR snapshot. Add a service worker for versioned static assets and an explicit user-scoped IndexedDB cache for previously opened PR metadata/diffs/manifests. Do not indiscriminately cache authenticated API responses. Uncached PRs require a connection. If application code or migrations cannot safely open an older cache, preserve it and explain the upgrade requirement.

Request persistent browser storage where supported and expose eviction/quota limitations honestly. Partition all storage by account; prevent logout/account switching from showing another user's cached review. Define an explicit warning/export/discard policy for unsynced data before deleting it. Offline cached access after an online permission revocation cannot be retroactively prevented; document that limitation.

## Synchronization and backend durability

Use an authenticated same-origin WebSocket for live metadata exchange. Keep ordinary HTTP APIs for PR snapshots and workspace discovery. Add WebSocket support to the existing Axum setup and validate the upgrade origin/session.

Build a small protocol around Loro's binary update export/import and version vectors:

1. Exchange workspace/schema identity and durable oplog version vectors.
2. Export updates missing from the other replica, using the supported update-from-version-vector API.
3. Import into a candidate document and inspect `ImportStatus`, including missing/pending dependencies.
4. Validate, persist, and only then publish the accepted state and acknowledge its durable version vector.
5. Repeat until both peers have the required history; send new local updates through the same path.

Use `oplog_vv()` in Rust / the corresponding official JS `oplogVersion()` API during the spike. Do not confuse a checked-out document's visible state with its complete oplog. The review runtime remains attached to current document history.

Loro supplies merge/update primitives; this plan owns handshake, reconnect, framing, dependency recovery, durability receipts, limits, and authentication. Validate behavior for out-of-order updates instead of treating successful `import()` as proof that every dependency is applied. Bound pending data and request missing ranges. A stored but incomplete update is not yet a synchronized review decision.

On the backend, serialize imports and agent commands per workspace. Import into a candidate, validate newly introduced operations and resulting schema, then commit the full-history snapshot and persistence receipt in one SQLite transaction. Only publish/broadcast after commit. A receive notification or local update callback is not a database durability acknowledgment.

Start with one strict SQLite workspace table containing scope, schema version, binary snapshot, and persistence revision, plus the snapshot/lineage tables. Revision is for durable receipts/coordination, not Loro conflict resolution. Use compare-and-swap/reload if multiple backend processes can write the same row; an in-process lock alone is insufficient then.

A local edit is synchronized only when the backend's acknowledged durable version covers it. Encode version vectors and peer IDs through lossless library/binary formats, not JavaScript numbers that may lose integer precision. Distinguish saving locally, saved locally/pending, synchronized, and blocked states.

Reconnect with backoff and jitter; resume on connectivity/focus signals, but let actual transport results determine connectivity. Preserve local edits through session expiry and server outages. After reconnect, exchange fresh durable versions rather than trusting a stale socket's send position. Duplicate imports/job retries must be harmless. Persist only complete validated states in the initial design; keep unresolved network data bounded and recover it again after a crash if necessary.

### Trust boundary and rejected updates

Loro peer IDs, commit messages, and event origins are not authentication. In particular, local event origin metadata is not durable replicated authorship. Authenticate agents through the backend service and bind their write capability to the target user's workspace and permitted contribution fields.

The import validator must inspect newly introduced operations, not only the final visible JSON: overwritten values and hidden history can still contain forbidden writes. Enforce document scope, peer registration/provenance, schema, payload limits, and immutable contribution rules. Use resource limits before/while decoding untrusted input.

Prove this boundary in the spike using supported inspection APIs. If safe validation is impractical, revisit the document/capability boundary before shipping opaque browser writes; do not ship a final-state-only validator and call it authorization.

Authorization/schema rejection is different from a transient network error. Preserve the local branch and an export, stop retrying blocked updates, and offer recovery onto a fresh authorized replica by replaying valid typed commands. Do not use time travel or a compensating write to pretend rejected history was never published.

Agents call the shared core through a service API. Jobs may compute from an older snapshot, then submit version-bound contributions to the current backend document. Use stable job/contribution IDs so job retries are idempotent. A fake Rust agent is enough to prove this integration; a production agent runner is out of scope.

## Retention and schema evolution

- Keep full-history snapshots and old file-version records initially. Periodic checkpointing must preserve history needed by offline peers.
- Do not start with shallow snapshots. Loro documents that peers cannot import updates from before the shallow-history boundary; enabling this needs a deliberate stale-client recovery policy.
- Never compact by exporting JSON and building a fresh document. That loses CRDT identity/history and can strand offline edits.
- Measure storage/load growth with many agent runs and returning versions. Set quotas and archival policy before broad rollout.
- Perform migrations through the shared core, test reconnecting older clients, and fence incompatible writers with a minimum supported schema/protocol. Preserve offline edits for recovery.
- Keep human/agent attribution in domain data and trusted audit metadata, not only commit messages or subscription origins. Client-asserted authorship must not be presented as verified identity.

## Implementation sequence

### 1. Compatibility and semantics spike

- [x] Pin a tested Rust/official-JS package pair; verify full snapshots and bidirectional incremental-update interoperability.
- [x] Compile a minimal shared Rust core to browser WASM; verify Vite initialization, bundle cost, and generated types.
- [x] Build the root-map schema plus three independent replicas: browser, second tab, Rust agent. The three roles are modeled in native tests; a separate Chromium test exercises the custom WASM.
- [x] Prove offline human importance versus agent assessment/context, including reload before reconnect. Proven using native full-snapshot restore; offline app-shell reload is still outstanding.
- [ ] Verify LWW ordering, same-value reassertion, peer ownership, command/commit boundaries, and safe candidate imports. All but safe **untrusted** imports are covered; imports remain explicitly trusted-only.
- [ ] Test missing dependencies, durable version receipts, snapshot restore, and bounded reconnect recovery. Core recovery/coverage simulations pass; actual transport and database receipts are not implemented.
- [x] Record whether the custom WASM boundary and import validation are acceptable; stop if either is a blocker. WASM is viable; the pre-decode resource/provenance boundary needs further design. See the spike report.

### 2. Snapshot identity prerequisite

- [x] Extend GitHub ingestion to persist complete, revision-consistent identity inputs. Pinned comparison/merge-base trees supply full before/after objects, paths and modes; incomplete identities remain unavailable.
- [ ] Add canonical fingerprinting, manifests, and lineage fixtures. Fingerprinting and manifests are implemented; a full server-side lineage/archive model remains outstanding. Local invalidation explanations use conservative path-pair history without transferring flags.
- [x] Extend diff DTOs and regenerate `src/api/schema.ts` through the existing API generation scripts.

### 3. Durable document and transport

- [x] Implement the shared schema/commands and deterministic view projection.
- [ ] Add strict SQLite migration, authenticated workspace discovery/sync, and fake agent service integration.
- [ ] Add version-vector handshake, update exchange, dependency recovery, and persistence acknowledgments.
- [ ] Add IndexedDB persistence, cross-tab storage coordination, and reconnect/error states. Local persistence, Web Locks, notifications, quota rollback/retry and truthful local-only status are implemented; network reconnection remains outstanding.
- [ ] Add offline app-shell and opened-PR snapshot caching, account isolation, and recovery/export flow. Account isolation and export are implemented; offline reload and recovery import are not.

### 4. Review UI

- [x] Integrate a route-owned review runtime with `src/repositoriesSlice.ts`, `src/PullRequestPage.tsx`, and `src/diff/DiffView.tsx` without putting mutable documents in pure MVU state.
- [x] Publish batched materialized views after explicit command/import boundaries; guard against update/echo loops. The serialized runtime publishes directly rather than subscribing to intermediate Loro writes.
- [x] Wire both flags and all idempotent transitions into the diff view model/runtime.
- [x] Preserve active-tab visibility on imports from other tabs; maintain virtualization/search behavior when collapsing files. Search explicitly covers expanded files.
- [x] Add accessible reviewed controls, invalidation explanations, and truthful local/sync/error indicators. Server synchronization is clearly labeled unavailable.
- [ ] Add a minimal attributed importance/context surface behind the experiment flag; no full agent feature suite.

### 5. Hardening and rollout

- [ ] Run the acceptance matrix below, migration tests, and abuse/size tests.
- [ ] Measure load time, WASM size, update bandwidth, and document growth using representative large PRs.
- [ ] Run `npm run check`, `npm run api:check`, `npm run build`, and backend Cargo tests; add browser offline/reload tests beyond jsdom.
- [ ] Roll out behind a feature flag with observable sync failures/pending counts, without logging source/context contents.
- [ ] Update the original specification and LUN-22 only after decisions are approved; do not run both library implementations against one workspace.

## Acceptance matrix

| Scenario                                                                      | Required result                                                                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Review/unreview, manual expand/collapse, repeated actions                     | Exact original transition table and idempotence; coupled local changes publish/persist together                 |
| Disconnect, edit, reload offline, reconnect                                   | Cached diff opens, edits survive, backend eventually persists them                                              |
| Offline human marks important; Rust agent marks unimportant and adds context  | Human importance is effective; agent assessment and context remain attributed and available                     |
| Concurrent human decisions on two devices                                     | Same effective value everywhere under the approved conflict policy; no browser-clock/backend-arrival dependency |
| Agent job retries or duplicate update delivery                                | No duplicate contribution or repeated visibility side effect                                                    |
| Server saves, reply disappears, server restarts                               | Retry converges and pending status eventually clears                                                            |
| Updates arrive with missing dependencies                                      | Bounded recovery fetches missing history; no false “synced” state                                               |
| Two tabs save concurrently, one crashes                                       | Durable storage retains both peers' accepted changes                                                            |
| Remote reviewed/collapsed update                                              | Reviewed indicator converges; current tab's visibility does not jump                                            |
| File changes while an old tab/agent is working                                | Old action/result remains on old version; new unseen version starts unreviewed/open                             |
| Exact old version returns after explicit unreview                             | Its last saved flags return; earlier review does not resurrect                                                  |
| Context/line, whitespace/out-of-hunk, binary, mode, path, base changes        | Relevant file version invalidates; rebases alone and unrelated-file changes do not                              |
| Add/delete/copy/rename/force-push/disappear/return                            | Correct version selection and conservative lineage; no accidental state transfer                                |
| Quota failure, expired session, rejected import                               | Distinct actionable states; no silent loss or misleading “synced” label                                         |
| Spoofed author, forbidden agent write, cross-user document, oversized payload | Rejected safely, including forbidden values hidden in history                                                   |
| Library/schema upgrade with an old offline replica                            | Compatible merge or explicit recoverable upgrade path, never silent reset                                       |

Use property-based schedules for local commands, disconnects, retries, reordered/duplicate updates, missing dependencies, and reloads. Assert convergence of domain views and applied history, not byte-identical serialized files. Include an explicit regression preventing shallow-history snapshots from being introduced into the initial persistence path.

## Decisions to approve before implementation

1. Native deterministic conflict winners for concurrent human decisions instead of backend-arrival wins; whether visible alternative values are a requirement.
2. Shared Rust/WASM domain core, subject to the spike, rather than separate TypeScript/Rust command implementations.
3. Agents contribute assessments/context but do not impersonate human reviewed/visibility actions.
4. Offline support covers previously opened/cached PRs, including reload, not fetching never-seen PRs offline.
5. Saved visibility converges while each open tab retains local control; exact UX for pending/blocked/conflicted decisions.
6. Initial retention, user-visible recovery/export, and account-cache deletion policy.

## Library references

- [Loro overview and Rust/JS support](https://github.com/loro-dev/loro)
- [Rust API](https://docs.rs/loro/latest/loro/)
- [Getting started](https://loro.dev/docs/tutorial/get_started)
- [Map semantics](https://loro.dev/docs/tutorial/map)
- [Shallow snapshot constraints](https://loro.dev/docs/advanced/shallow_snapshot)
- [Rust API source: commit behavior, import status, export modes, mergeable containers](https://github.com/loro-dev/loro/blob/main/crates/loro/src/lib.rs)
- [Experimental pure-TypeScript implementation, not selected here](https://github.com/loro-dev/loro/tree/main/loro-js)

These references establish candidate capabilities, not a tested dependency lock. Pin versions and verify all relied-on behavior in step 1.
