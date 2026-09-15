# Local review on the pull request page

The existing PR diff page now owns the review runtime. There is no separate demo page. Review controls appear in file headers and the sticky active-file header.

## Implemented

- [x] Reviewed checkbox on the right; keyboard-accessible collapse/expand on the left.
- [x] Review collapses, unreview opens, manual visibility leaves reviewed unchanged. Repeating the current review decision does not change visibility.
- [x] The shared Rust/WASM core owns those transitions. Mutable documents stay in `src/review/runtime.ts`, outside the application's pure MVU state.
- [x] Candidate snapshot and typed-command journal save together in one IndexedDB transaction before “saved” is shown. Quota/save failure discards only the candidate, retains unrelated accepted changes and offers retry.
- [x] Web Locks serialize read/merge/write across tabs. BroadcastChannel and window focus trigger storage rereads, not remote diff refreshes. Notifications do not change an open tab's visibility; reopening restores the persisted visibility.
- [x] Scope is account ID + immutable GitHub repository ID + PR number. Account changes dispose the old route runtime. Logout hides but does not delete local work; other open tabs hide their review and ask to reload when the cached account changes.
- [x] Explicit GitHub refresh selects the new snapshot. Queued actions/retries retain the snapshot and version clicked, including after a refresh.
- [x] Exact old versions restore saved flags, including explicit unreviewing. New versions start open/unreviewed. A previously reviewed version at the same before/after path pair gives the changed-version explanation on hover and keyboard focus; paths are never used to transfer flags.
- [x] Collapsing removes content rows from the virtual layout, not the source data. Navigation and copy still work. Search explicitly searches **expanded files**, reruns on visibility changes and never targets unmounted hidden content.
- [x] Export includes the full-history snapshot, typed-command journal and local metadata, including when the saved format cannot be opened by this version. No automatic deletion or reset.
- [x] Tests exercise the built application and actual PR route with the real WASM, IndexedDB, Web Locks and two Chromium tabs. The standalone spike page was removed; binary interoperability remains a Node/Rust test under `tests/review/`.

## Trustworthy file identity

On fresh GitHub sync, `backend/src/pull_requests/review_identity.rs`:

1. Captures full base/head Git object IDs and immutable repository ID from the PR response.
2. Fetches both comparison metadata and the diff using the immutable `baseSHA...headSHA` URL, rather than mixing a moving `/pulls/N` diff with older metadata.
3. Resolves the comparison's **merge base**, then loads complete trees for that merge base and the head.
4. Hashes versioned canonical input containing the before/after full object identities, paths, modes and parsed reviewable changes. Missing sides are explicit. The Git hash algorithm is included (GitHub SHA-1 currently supported). PR head/commit IDs are not file-version invalidation shortcuts.
5. Persists the full before/after identity inputs and manifest with the diff in the existing SQLite transaction. On read, the raw digest and recomputed fingerprints must match; a stale manifest or incompatible parser result is not exposed as reviewable identity.

Full objects cover binary/out-of-hunk changes; parsed hunks cover line numbers, context and missing-newline markers. Unrelated files and commit/rebase identities do not affect the file fingerprint. Rename/copy operations include both paths and their distinct operation kinds; no flags are inherited by path or guessed lineage.

The GitHub App needs **Contents: read** permission for the comparison/commit/tree endpoints, in addition to the permissions already used by PR syncing. Missing permissions can make sync fail; they must be granted on the GitHub App/installation rather than bypassing identity checks.

Old stored snapshots without manifests remain readable and require a fresh GitHub sync before reviewing. Incomplete/truncated tree results or missing object identities disable the affected review controls rather than inventing a fingerprint. Truncated trees retain the repository scope so existing local work can still be exported. This intentionally does not introduce a full backend lineage/archive table; old flags and a conservative explanation history are retained locally.

## Storage and build

`npm run dev` and `npm run build` generate the custom runtime before Vite runs:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128 --locked
npm ci
npm run dev
```

Generated TypeScript declarations are committed so ordinary typechecking does not require Rust. JS/WASM artifacts are ignored and rebuilt. CI checks declaration drift. Only the custom WASM is loaded by the page, lazily when a reviewable manifest exists; official `loro-crdt` remains a development-only interoperability dependency. The binary is approximately 2.69 MB raw / 0.83 MB gzip.

IndexedDB database `kestrel-review` contains full-history snapshots and the journal under account/repository/PR keys. A write is eligible to be called locally saved only after the transaction completes. Each restored replica gets a fresh Loro peer; candidates retain the active writer's peer/counter sequence. Unsupported storage formats are preserved, not rebuilt from JSON. Browsers without Web Locks cannot edit this storage safely and receive an error rather than an unsafe last-writer-wins fallback.

The page requests persistent storage after an explicit action where supported. Eviction/quota limits still apply. Export a backup before clearing site data. Export is a recovery artifact; an import/recovery UI is not implemented yet.

## Deliberate remaining scope

- **Local-only, not server-synchronized.** The UI says this explicitly. No new endpoint accepts browser Loro bytes; untrusted decode/provenance validation remains gated by the findings in [the compatibility report](loro-spike.md).
- Editing a loaded diff works without network connectivity. **Offline app-shell/diff reload is not implemented**; reloading the application still needs its existing APIs/assets. Metadata survives reload independently in IndexedDB.
- No service worker, account-scoped immutable PR cache, production agent service/UI, backend review-document durability or cross-device transport.
- No GitHub viewed-file/approval writes. No automatic diff replacement caused by review metadata.
- No inference of rename lineage for invalidation explanations. No full retention/archival policy beyond retaining local history and export.

## Validation

```sh
npm run check
npm run knip
npm run api:check
cargo test --locked --manifest-path backend/Cargo.toml
cargo clippy --locked --manifest-path backend/Cargo.toml --all-targets -- -D warnings
npx playwright install --with-deps chromium
npm run review:check
```

`review:check` runs the native semantics suite, Rust/official-JS binary interoperability, the production application build, and browser tests against `/pull/kestrel%2Fapp/42/diff` with fixture HTTP responses. The browser tests cover keyboard controls, search/collapse, explicit refresh, old versions, independent tab visibility, concurrent saves, offline edits, quota rollback/retry, export, mobile layout, account switching/logout across tabs and missing identities. Unit tests additionally cover preserving retry after remote notifications, incompatible storage export and route teardown. Backend tests cover fixed comparison URLs, merge-base tree selection, lossless repository IDs, manifest persistence/readback, mismatched snapshots and fingerprint inputs.
