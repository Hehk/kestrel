# Loro review workspace: compatibility gate

## Outcome

**Shared Rust/WASM core: viable for further work. Untrusted binary synchronization: blocked.**

This implements the first slice of [the plan](../loro-plan.md), not the finished review workspace. Nothing imports the experiment into the application, and no backend route accepts Loro bytes. The official JS runtime is a development-only interoperability oracle; the experimental browser bundle contains only the custom Rust/WASM runtime.

The gate is not a claim that Loro is unsuitable. Its supported history API exposes the operations needed for validation, including overwritten/deleted values. However, the API decodes before our validator can inspect those operations, and an input-byte cap does not bound allocation or decoding work. The plan explicitly requires resource limits **before/while** decoding. Do not remove this gate by validating only the materialized JSON.

### What is implemented

- `crates/review-core`: flat root maps, schema/protocol constants, typed commands, target and actor checks, immutable attributed assessments/context, human importance precedence, deterministic projection.
- `crates/review-wasm`: narrow `wasm-bindgen` API; TypeScript types generated from the Rust domain with `tsify`, not a second handwritten schema.
- Full-history snapshots, binary version-vector coverage/update exchange, fresh identities on restore, isolated command/import candidates retaining the current writer's identity.
- Explicit reassertion and ordinary idempotent review/collapse commands. Reassertion intentionally performs the review action again, including its visibility transition.
- Native regression/property tests, native ↔ official-JS interoperability, and a Chromium/Vite/WASM/IndexedDB smoke test.
- A separate CI job; ordinary app builds do not require Rust/WASM tooling.

This is intentionally a separate Cargo workspace under `crates/`. The existing backend's lockfile and dependency graph are unchanged until there is an approved integration boundary.

## Reproduce

```sh
npm ci
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128 --locked
npx playwright install --with-deps chromium
npm run review:check

cargo fmt --manifest-path crates/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path crates/Cargo.toml --all-targets -- -D warnings
cargo clippy --locked --manifest-path crates/Cargo.toml -p review-wasm --target wasm32-unknown-unknown -- -D warnings
cargo run --release --locked --manifest-path crates/Cargo.toml -p review-core --example measure
```

Pinned pair: Rust `loro = 1.16.0`, official `loro-crdt = 1.16.0`. Cargo/npm lockfiles are committed. WASM generation is ignored; it is rebuilt in CI. No experimental pure-TypeScript engine is used. `tsify::Ts` is used instead of the deprecated ABI derives that can leak memory on deserialization failure.

## Proven semantics

| Question                           | Evidence/result                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native/official-JS compatibility   | Full snapshots and incremental updates in both directions, duplicate import, Rust binary VV decoded by JS and vice versa. A JS peer ID above `Number.MAX_SAFE_INTEGER` survives the exchange.                                                                                                         |
| Concurrent human decisions         | Native map ordering is Lamport, then peer ID. A controlled equal-Lamport test gives the larger peer's value despite the smaller peer's later wall-clock timestamp; reversing import order gives the same result. Causally later writes win. This tests the proposed policy, **not product approval**. |
| Same-value writes                  | `LoroMap::insert` skips them. Explicit reassert uses delete/insert within one synchronous command and one explicit commit; only the completed candidate is published. Ordinary repeated review decisions are true no-ops, including visibility.                                                       |
| Candidate ownership                | `LoroDoc::clone` would alias; we use `fork` and restore the current peer for an unpublished candidate. Independent snapshot restores retain history but get fresh writer IDs. The caller must serialize candidates and discard the previous replica only after persistence succeeds.                  |
| Offline human vs agent             | Three independent native replicas model browser, second tab and agent. Human importance survives snapshot reload before reconnection; agent assessment/context remain attributed; `inherit` relinquishes the override.                                                                                |
| Concurrent assessment replacements | Both heads remain visible; inheritance is unresolved rather than selecting an invented consensus. Sequential replacements are supported.                                                                                                                                                              |
| Commit grouping                    | Coupled local flags are applied before commit. Concurrent commands can still merge to reviewed/open. Commit grouping is not transaction isolation or rollback.                                                                                                                                        |
| Missing dependencies               | A suffix import reports pending history. The entire candidate is discarded; no durable VV advances. A fresh VV exchange recovers all missing history. There is no unbounded retained pending-import queue.                                                                                            |
| Lost receipt/restart               | Reloading the saved full snapshot and retrying the same update is harmless; coverage succeeds. These are persistence simulations, not SQLite/socket tests.                                                                                                                                            |
| History inspection                 | `export_json_updates_without_peer_compression` includes a forbidden string insert, subsequent boolean overwrite, and delete even when the final human view is unchanged.                                                                                                                              |
| Resource boundary                  | A valid snapshot containing an 8 MiB string fits below the 4 MiB binary cap and restores the complete string. Post-import checks cannot enforce a pre-decode allocation budget. This is a bounded amplification regression, not an OOM exploit or a complete decoder audit.                           |
| Retention                          | Export is always full-history `Snapshot`; restore/import rejects shallow snapshots and incompatible schema versions. No JSON reconstruction/compaction.                                                                                                                                               |

The property test runs 64 schedules of three replicas, commands, disconnected changes, partial dissemination, duplicate imports and snapshot reloads. Final domain views and mutual VV coverage converge; serialized snapshot byte equality is deliberately not required. A separate suffix-update test covers missing dependencies.

The Chromium test uses the **built** Vite bundle, edits while offline, persists real IndexedDB bytes, reloads, verifies a fresh peer and retained flags, and imports the custom WASM snapshot into the official runtime in the Node test process. **It reconnects to load the app shell before reload.** It does not claim service-worker/offline-shell support, cross-tab durability, a journal, quota recovery, or account isolation. Its fixed IndexedDB database is synthetic fixture storage, never a real user's review data.

## Measurements

Single local run on macOS arm64; synthetic metadata only, not rollout thresholds:

| Measurement                          | Result                                                                |
| ------------------------------------ | --------------------------------------------------------------------- |
| Custom WASM                          | 2,685,683 bytes raw; 824,088 bytes with Node's default gzip           |
| Vite spike JS                        | 9.43 kB raw; 3.60 kB gzip                                             |
| Chromium warm init + fixture restore | 8 ms                                                                  |
| 100 assessments / 100 versions       | 6,286 snapshot bytes; 0.125 ms restore; 0.131 ms one-file projection  |
| 1,000 assessments / 100 versions     | 67,108 snapshot bytes; 0.159 ms restore; 1.463 ms one-file projection |
| 1,000 sequential candidate commands  | 879 ms cumulative                                                     |

Snapshot import is lazy; the restore timing alone is not a complete load cost. Projection also visits the collection and includes relevant decoding work. Full candidate forks and full snapshots are acceptable for this experiment, not yet justified for large real workspaces. The official runtime is absent from the experimental browser build, and both runtimes are absent from the production app build.

## Stop/go decision and next work

`import_trusted` and `restore_trusted` are deliberately named. They check binary size, pending dependencies and schema compatibility, **not authorization or full schema/history validity**. The core's command actor checks cannot make an opaque update trustworthy.

Before step 2–5 integration:

- [ ] Approve the native concurrent-human policy and reassert visibility behavior. No decision has been made about visible losing alternatives.
- [ ] Choose an enforceable decoder resource boundary. Recommended investigation: a separate, memory/CPU-limited backend worker that decodes into an isolated candidate; also bound concurrency/queues. A timeout around synchronous in-process Rust does not stop allocation or CPU work. A plain browser Worker alone is not a hard memory limit.
- [ ] Implement operation-level validation against server-owned workspace scope, registered peer/provenance, permitted roots/keys/types, target manifests, contribution immutability and attribution. Cover overwritten/deleted writes, same-ID divergent contributions, spoofed peers, peer/counter reuse, cross-user submissions and incompatible history. Never trust the `actor` supplied by browser code.
- [ ] If a bounded opaque-import path is impractical, explicitly revise the capability/document/transport design rather than quietly substituting final-state validation or command replay for CRDT synchronization.
- [ ] Extend revision-consistent GitHub ingestion and exact version identity before enabling any review marks. The current parsed diff is insufficient, especially for binary objects and full Git object identities.
- [ ] Add SQLite durability/CAS, authenticated same-origin transport, durable receipt framing, retries and rejection recovery. The constants here are not a wire protocol implementation.
- [ ] Add account-partitioned IndexedDB + command journal, a cross-tab coordinator, local visibility ownership, cached immutable PR snapshots, app-shell/WASM service worker, and explicit export/deletion policy.
- [ ] Integrate route-owned runtime and accessible diff controls only after those prerequisites. Retain the proposed feature flag and rollout/observability requirements.

## Validation

- `npm run review:check`: 18 native tests (including property schedules), generated TypeScript check, Rust/official-JS interop and real Chromium smoke test.
- `npm run check`: 229 application tests, typecheck, lint and formatting.
- `npm run knip`, `npm run api:check`, `npm run build`.
- Backend `cargo test --locked`: 118 passed, 2 pre-existing ignored profiling tests.
- Native + WASM Clippy with warnings denied; both Rust workspaces' format checks.

The only production source change is a formatting-only correction in `src/components/Tooltip.tsx`, needed for the pre-existing format-check failure. No production review behavior, API schema, database, credentials or GitHub state was changed. The original alternative proposal/specification and LUN-22 were not edited; their approval-dependent changes remain outstanding.
