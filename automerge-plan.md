# PR review workspace with Automerge

## Status and goal

Implementation proposal with an isolated step-1 spike, not a production library selection. See [spike results and reproduction instructions](spikes/automerge/README.md).

**Current gate:** native/official-JS/WASM interoperability and the tested command semantics pass. Import authorization and bounded decoding are not proven; do not begin production transport or UI integration. Steps 2–5 and the product approvals remain open.

Alternative: the original local `loro-plan.md` proposal (not included in this PR).

Sources: the original local `diff-review-doc.md` specification (not changed by this spike), [LUN-22](https://linear.app/lunch/issue/LUN-22/investigate-crdts-for-pr-review-state-synchronization), and our subsequent discussion about offline review and backend agents.

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

- `crates/review-core/`: Automerge document schema, typed commands, validation, and materialized review views. No Axum, SQLite, browser APIs, or agent runtime dependencies.
- `crates/review-wasm/`: a narrow `wasm-bindgen` interface around that core for the browser.
- `backend/src/review.rs`: authenticated workspace loading, persistence, synchronization, and the service API used by agents.
- `src/review/`: IndexedDB storage, transport, Solid/MVU integration, and local visibility state.

Compile the same domain implementation natively for the backend and to WASM for the browser. Generate TypeScript command/view types rather than maintaining handwritten parallel schemas. Include a schema version in the document and a protocol version in the transport.

Use the Rust `automerge` crate. Use `@automerge/automerge` in the interoperability spike to verify compatibility with the official browser implementation; do not ship two Automerge WASM runtimes in the production app. The custom WASM boundary is a proposed tradeoff for sharing domain behavior. The spike compiles and generates command/view declarations with `tsify::Ts<T>` and measures approximately 2.07 MB raw / 628 KB gzip WASM. Accept its cold-load/build cost before committing to production use.

Prefer explicit Automerge operations and transactions initially. `autosurgeon` is an option for ergonomic typed access, not a requirement; prove its update behavior before using it for contested fields or nested objects.

### Document boundary and ownership

Use one document per `(user ID, immutable repository ID, PR number)` initially. Server-side metadata owns that mapping and authorization; document contents cannot grant access or redefine their owner.

The document stores review metadata, not source files, raw diffs, GitHub timeline data, or credentials. Cache immutable diff snapshots separately. Agents working for that user contribute to that user's workspace; sharing an agent result across users is later work.

A document has one serialized mutation queue per replica. Documents initialized by the server and later opened by a browser must switch to that browser writer's actor before its first mutation. Browser tabs and independently writable agent forks need distinct Automerge actor IDs. Actor identity is not authenticated user identity. Reuse an actor only when its write sequence has exclusive ownership; never copy it into concurrent writers.

### Proposed schema

Create shared collection objects once in a canonical bootstrap document, distributed with the cached PR. Browser replicas must descend from this history. Do not independently initialize equivalent nested maps: Automerge object identity is not JSON key equality.

| Collection         | Key                    | Value                                                                                                  |
| ------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `reviewed`         | file-version ID        | Boolean; missing means false                                                                           |
| `collapsed`        | file-version ID        | Boolean; missing means false                                                                           |
| `humanImportance`  | file-version ID        | Scalar `important`, `unimportant`, or `inherit`                                                        |
| `agentAssessments` | stable contribution ID | Version-bound assessment, agent/run identity, evidence references, optional superseded contribution ID |
| `context`          | stable contribution ID | Version-bound, attributed contextual note                                                              |

These are sibling Automerge maps, not replaceable JSON snapshots. Agents cannot write human decisions or collapse flags. Human review marks mean the human reviewed that version; an agent assessment is not a human review mark.

Separate human and agent fields make precedence independent of arrival order. An explicit `inherit` action relinquishes a human importance override; do not infer this from deleting a value. Initially support one designated assessment stream per version, with sequential replacements. Preserve different streams as separate attributed assessments rather than inventing a consensus between agents.

Create each contribution under a unique ID in one change. Treat its original content as immutable in the first slice. Human amendments and dismissals reference the contribution ID separately. This avoids pretending whole-string replacement is collaborative text editing. Shared editing of one note, threaded comments, and concurrent deletion semantics are follow-ups.

### Decision semantics

- Automerge retains concurrent map values and selects a deterministic visible winner. Rust exposes alternatives through `ReadDoc::get_all()`.
- Proposed first policy: use that winner for concurrent human decisions, retain/expose conflicts, and provide an explicit reassert action that resolves observed alternatives. Normal repeated review commands remain no-ops.
- A causally later write wins over writes it has observed. The winner of genuinely concurrent writes is not necessarily the latest wall-clock action or last server arrival.
- Do not implement human precedence through timestamps or actor-ID sorting. It comes from the separate human override field.
- One review/unreview command updates both flags in one Automerge change and one durable storage transaction. Publish one view update after the command/import, not intermediate writes. The spike confirms that Automerge elides unchanged `put` operations: test resulting flags and one committed change, not exactly two stored operations.
- CRDT change grouping is not application-level isolation. Concurrent commands can merge independent fields; an expanded reviewed file is valid. Test and approve the resulting flag combinations rather than promising that a whole action always wins as a unit.
- A tab initializes its local visibility from the persisted flag. Its own review/visibility actions update both. Remote changes update the persisted replica and reviewed indicator, but not that tab's current visibility. Reload/reopen restores the converged persisted visibility.

The concurrent-human policy is a product decision still to approve. If deterministic library winners are too arbitrary, resolve that before implementation; a CRDT does not make backend-arrival ordering disappear without a behavior change.

## Exact version identity

This is a prerequisite, not a CRDT feature.

Compute an opaque, versioned fingerprint on the backend from canonical input containing:

- Before/after full Git object identities, with explicit absent-side markers.
- Before/after paths and modes, including additions, deletions, renames, copies, symlinks, gitlinks, and binary objects.
- Canonical reviewable hunks, line numbers, context, and missing-newline information, independent of UI display preferences.

Include the repository hash algorithm where relevant. Do not include the PR head SHA merely as an invalidation shortcut. Identical contents and reviewable changes after a rebase must retain identity; unrelated file changes must not affect it.

Current gap: `backend/src/pull_request_diff.rs` retains parsed hunks but discards binary payloads, has no full before/after blob IDs, and represents unchanged modes without their actual values. Hashing its current DTO alone cannot satisfy the specification. Extend the GitHub ingestion/snapshot path to obtain full object identities and modes for the exact comparison represented by the stored diff, including its merge-base semantics. Avoid combining metadata fetched from different PR revisions.

Store a snapshot manifest linking files to version IDs and explicit predecessor relationships. That history explains changed-version invalidation without using path equality as a universal file identity. Copies get distinct entries; ambiguous rename lineage must not inherit review state by guesswork. Missing trustworthy identity is a visible unavailable/loading condition, not permission to reuse an old review mark.

Retain old version records. Select the current snapshot's records rather than clearing flags in response to refresh. Agent jobs carry the immutable snapshot/version references they analyzed; late results remain attached there.

## Offline storage and application lifecycle

Use IndexedDB for Automerge binary documents and durable sync bookkeeping, not `localStorage` JSON. Begin with full binary saves per small metadata document; measure before adding an incremental binary journal. Full saves must preserve Automerge history.

Persist a small pending-command journal atomically with each local save: stable command ID, typed intent, target snapshot/version, and generated change references. It supports attribution, durability tracking, and explicit recovery after rejected history. It is not a second merge engine: normal synchronization exchanges Automerge changes, never blindly replays commands. Retire acknowledged journal entries only under the recovery/audit retention policy.

For each local command:

1. Serialize it with other commands/imports and check it against the displayed snapshot.
2. Apply it to a candidate document and show an optimistic projection.
3. Atomically persist the resulting binary document and pending status in IndexedDB.
4. Only then describe it as saved locally and make its update eligible for transmission.

On local disk/quota failure, discard the candidate and restore the last durable document, preserving unrelated accepted changes. Show a retryable error. Do not attempt a broad CRDT undo that could undo another actor's work. Serialize publication so a failed earlier command cannot roll back a later durable command.

Persist accepted remote changes before acknowledging browser durability. Multiple tabs must merge with the latest durable state under a cross-tab lock or equivalent single-writer storage coordinator; last-writer-wins IndexedDB snapshot replacement would lose work even though Automerge itself merges correctly. BroadcastChannel can notify tabs, but is not the durable source of truth.

Offline reload also requires the app shell/WASM and the displayed PR snapshot. Add a service worker for versioned static assets and an explicit user-scoped IndexedDB cache for previously opened PR metadata/diffs/manifests. Do not indiscriminately cache authenticated API responses. Uncached PRs require a connection. If application code or migrations cannot safely open an older cache, preserve it and explain the upgrade requirement.

Request persistent browser storage where supported and expose eviction/quota limitations honestly. Partition all storage by account; prevent logout/account switching from showing another user's cached review. Define an explicit warning/export/discard policy for unsynced data before deleting it. Offline cached access after an online permission revocation cannot be retroactively prevented; document that limitation.

## Synchronization and backend durability

Use an authenticated same-origin WebSocket for live metadata exchange. Keep ordinary HTTP APIs for PR snapshots and workspace discovery. Add WebSocket support to the existing Axum setup and validate the upgrade origin/session.

Automerge provides `generate_sync_message` / `receive_sync_message` and per-peer sync state. Its protocol assumes a reliable, ordered stream. Maintain one sync state per document/connection; serialize messages, and reset/re-negotiate after reconnect. Do not replay old session messages into a new sync state or assume arbitrary message reordering is supported.

On the backend:

1. Load the workspace under a per-document mutation queue.
2. Import into a candidate document and validate newly introduced operations and resulting schema.
3. Commit the Automerge bytes and a server persistence receipt in one SQLite transaction.
4. Publish the accepted document and produce sync responses/broadcasts only after commit.

Start with one strict SQLite workspace table containing scope, schema version, binary document, and persistence revision, plus the snapshot/lineage tables. Revision is for durable receipts/coordination, not CRDT conflict resolution. Use compare-and-swap/reload if multiple backend processes can write the same row; an in-process lock alone is insufficient then.

Track durable server acknowledgment of local change hashes/heads. A sent WebSocket frame or an empty `generate_sync_message()` result does not by itself mean the server saved the user's work. Distinguish saving locally, saved locally/pending, synchronized, and blocked states.

Reconnect with backoff and jitter; resume on connectivity/focus signals, but let actual transport results determine connectivity. Preserve local edits through session expiry and server outages. A lost reply after a committed save must converge without duplicating the action.

### Trust boundary and rejected updates

CRDT actor IDs and change messages are not authentication. Authenticate agents through the backend service and bind their write capability to the target user's workspace and permitted contribution fields.

The import validator must inspect newly introduced operations, not only the final visible JSON: losing/conflicting values and hidden history can still contain forbidden writes. Enforce document scope, actor registration/provenance, schema, payload limits, and immutable contribution rules. Use resource limits before/while decoding untrusted input.

Prove this boundary in the spike. Public `get_changes()` and `Change::decode().operations` expose newly introduced operations in the pinned version. Tests reproduce forbidden deleted history, losing conflicting payloads, and concurrent duplicate contribution IDs that local command checks miss. A complete provenance/object-ancestry/immutability validator and expanded-resource limits are still missing. The spike's imports are explicitly trusted-only and have no network endpoint. If safe validation is impractical with available APIs, revisit the document/capability boundary before shipping opaque browser writes; do not ship a final-state-only validator and call it authorization.

Authorization/schema rejection is different from a transient network error. Preserve the local branch and an export, stop retrying blocked updates, and offer recovery onto a fresh authorized replica by replaying valid typed commands. Do not silently discard pending work or mutate published history to pretend a rejected change never happened.

Agents call the shared core through a service API. Jobs may compute from an older snapshot, then submit version-bound contributions to the current backend document. Use stable job/contribution IDs so job retries are idempotent. A fake Rust agent is enough to prove this integration; a production agent runner is out of scope.

## Retention and schema evolution

- Keep full Automerge history and old file-version records initially. Binary checkpointing is not permission to remove causal history.
- Do not round-trip through JSON or rebuild a new document to compact it: that breaks offline descendants and object identity.
- Measure storage/load growth with many agent runs and returning versions. Set quotas and archival policy before broad rollout.
- Perform migrations through the shared core, test reconnecting older clients, and fence incompatible writers with a minimum supported schema/protocol. Preserve offline edits for recovery.
- Keep human/agent attribution in domain data and trusted audit metadata, not only debugging change messages. Client-asserted authorship must not be presented as verified identity.

## Implementation sequence

### 1. Compatibility and semantics spike

- [x] Pin Rust `automerge 0.11.0` / official JS `3.4.1`; verify binary save/load and bidirectional sync interoperability.
- [x] Compile a minimal shared Rust core to browser WASM; verify production Vite initialization, bundle cost, and generated types.
- [x] Build canonical initialization plus independent custom-WASM browser, official-JS tab-model, and native Rust fake-agent replicas. This is not yet a coordinated multi-tab browser runtime.
- [x] Prove offline human importance versus agent assessment/context, including binary reload before reconnect in the interoperability harness.
- [x] Verify reviewed conflict enumeration/reassertion, distinct writer actors, command grouping, and candidate storage failure behavior; add generated merge/reload/failure schedules.
- [x] Record boundary findings in `spikes/automerge/README.md`: custom WASM is technically viable at measured cost; import authorization is not yet acceptable for shipping.
- [ ] Complete operation-level authorization, actor provenance, immutable-ID handling, and bounded decoding. **Stop before production imports until this passes or the capability boundary changes.**
- [ ] Prove actual cross-tab storage coordination, command-journal atomicity, and offline app-shell reload; the Chromium spike proves only offline edit and IndexedDB restore with static assets reachable.

### 2. Snapshot identity prerequisite

- [ ] Extend GitHub ingestion to persist complete, revision-consistent identity inputs.
- [ ] Add canonical fingerprinting, manifests, and lineage fixtures.
- [ ] Extend diff DTOs and regenerate `src/api/schema.ts` through the existing API generation scripts.

### 3. Durable document and transport

- [ ] Implement the shared schema/commands and deterministic view projection.
- [ ] Add strict SQLite migration, authenticated workspace discovery/sync, and fake agent service integration.
- [ ] Add IndexedDB persistence, cross-tab storage coordination, durable receipts, and reconnect/error states.
- [ ] Add offline app-shell and opened-PR snapshot caching, account isolation, and recovery/export flow.

### 4. Review UI

- [ ] Integrate a route-owned review runtime with `src/repositoriesSlice.ts`, `src/PullRequestPage.tsx`, and `src/diff/DiffView.tsx` without putting mutable documents in pure MVU state.
- [ ] Wire both flags and all idempotent transitions into the diff view model/runtime.
- [ ] Preserve active-tab visibility on remote imports; maintain virtualization/search behavior when collapsing files.
- [ ] Add accessible reviewed controls, invalidation explanations, and truthful local/sync/error indicators.
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
| Network interruption within sync exchange                                     | New ordered session recovers without losing durable changes                                                     |
| Two tabs save concurrently, one crashes                                       | Durable storage retains both actors' accepted changes                                                           |
| Remote reviewed/collapsed update                                              | Reviewed indicator converges; current tab's visibility does not jump                                            |
| File changes while an old tab/agent is working                                | Old action/result remains on old version; new unseen version starts unreviewed/open                             |
| Exact old version returns after explicit unreview                             | Its last saved flags return; earlier review does not resurrect                                                  |
| Context/line, whitespace/out-of-hunk, binary, mode, path, base changes        | Relevant file version invalidates; rebases alone and unrelated-file changes do not                              |
| Add/delete/copy/rename/force-push/disappear/return                            | Correct version selection and conservative lineage; no accidental state transfer                                |
| Quota failure, expired session, rejected import                               | Distinct actionable states; no silent loss or misleading “synced” label                                         |
| Spoofed author, forbidden agent write, cross-user document, oversized payload | Rejected safely, including forbidden values hidden by conflicts                                                 |
| Library/schema upgrade with an old offline replica                            | Compatible merge or explicit recoverable upgrade path, never silent reset                                       |

Use property-based schedules for local commands, disconnects, retries, duplicate changes, and reloads. Reorder independent change deliveries where the API permits; do not violate the sync protocol's ordered-stream contract. Assert convergence of domain views/history reachability, not byte-identical serialized files.

## Decisions to approve before implementation

1. Native deterministic conflict winners for concurrent human decisions, with explicit conflict resolution, instead of backend-arrival wins.
2. Shared Rust/WASM domain core, subject to the spike, rather than separate TypeScript/Rust command implementations.
3. Agents contribute assessments/context but do not impersonate human reviewed/visibility actions.
4. Offline support covers previously opened/cached PRs, including reload, not fetching never-seen PRs offline.
5. Saved visibility converges while each open tab retains local control; exact UX for pending/blocked/conflicted decisions.
6. Initial retention, user-visible recovery/export, and account-cache deletion policy.

## Library references

- [Automerge overview and Rust API caveat](https://github.com/automerge/automerge)
- [Rust document, conflict, actor, and transaction APIs](https://docs.rs/automerge/latest/automerge/)
- [Sync protocol and ordered-stream requirement](https://docs.rs/automerge/latest/automerge/sync/index.html)
- [Official JavaScript documentation](https://automerge.org/docs/hello/)
- [Autosurgeon](https://github.com/automerge/autosurgeon)

The root `Cargo.lock` and `spikes/automerge/package-lock.json` pin the tested spike dependencies. The evidence above covers only the explicit spike tests, not every capability described in this proposal.
