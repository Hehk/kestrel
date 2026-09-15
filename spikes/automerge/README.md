# Automerge review spike

## Verdict

This is the retained compatibility harness, not the production UI or storage adapter. **The actual review feature is now implemented:** see [setup and architecture](../../src/review/README.md) and [the updated plan](../../automerge-plan.md). Production uses the shared Rust/WASM crates but does not import this test package or the official JS runtime.

Binary interoperability and domain semantics work with the pinned pair. Arbitrary binary history authorization remains unproven; production instead reconstructs bounded typed proposals at their exact original causal frontier and verifies change hashes. These counterexamples remain regression evidence for why opaque client imports are not exposed.

## Reproduce

From the repository root, with Node 24+ and stable Rust (Automerge requires at least 1.90):

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128 --locked
npm ci --prefix spikes/automerge
npx --prefix spikes/automerge playwright install --with-deps chromium
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
npm test --prefix spikes/automerge
```

The last command builds native fixtures and both WASM bindings, runs interoperability assertions, typechecks against generated declarations, builds an isolated Vite page, and runs Chromium. Generated bindings and binaries are ignored. The official JS implementation is an isolated development dependency, not a second runtime in Kestrel's production bundle.

The browser page contains only synthetic data. The isolated package is excluded from root Knip analysis and typechecked by its own test command.

## Evidence

| Check                                          | Result                                                                                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust `automerge = 0.11.0`, official JS `3.4.1` | Native bootstrap/agent save → JS load/merge → shared Rust WASM sync → JS save → native Rust load; domain views and heads agree                                                   |
| Shared Rust commands and generated types       | `wasm-bindgen 0.2.128`, `tsify 0.5.8`; browser command/view types generated from the core; invalid inputs return errors                                                          |
| Three independently owned writers              | Native fake agent, official-JS tab, custom-WASM browser descend from one bootstrap; human importance survives offline save/reload and agent merge; context remains attributed    |
| Transition table                               | All combinations of reviewed/collapsed/requested review; repeated review does not alter visibility; exact old version restores explicit unreview                                 |
| Conflicts                                      | Enumerated review alternatives converge in either merge order; normal repetition preserves conflicts; explicit reassert resolves observed alternatives                           |
| Grouping                                       | Review updates commit in one change; unchanged field writes may be elided; a concurrent expansion can yield a reviewed, open file                                                |
| Persistence failure                            | Candidate publication happens only after persistence callback success; quota failure retains earlier merged agent work; retry restores the same domain view                      |
| Transport interruption                         | Native ordered sync test drops a reply after receiver save, reloads the receiver, resets both peer states, and converges                                                         |
| Generated schedules                            | 256 property-test cases by default: commands, duplicate merges, disconnection, reload, reassert, and failed saves; all accepted change hashes remain reachable after convergence |
| Actual browser                                 | Production Vite initialization, edit with network disabled, IndexedDB transaction completion, page reload and binary restoration                                                 |
| Schema fence                                   | Unsupported schema rejects without silently recreating the workspace                                                                                                             |

**Browser test limitation:** network is restored before page reload to fetch static assets. This is not proof of offline app-shell availability. The spike's IndexedDB adapter is a single-fixture, single-writer test harness: no cross-tab coordinator, command journal, account partitioning, or persistence receipts. It must not be reused as the production adapter.

### Measurements

Initial local run on Apple Silicon, release WASM with `opt-level = "s"` and LTO:

- WASM approximately **2.07 MB raw / 628 KB gzip**; generated app JS approximately **10.7 KB / 4.1 KB gzip**.
- Browser WASM initialization approximately **3 ms** on a warm local run. This is not a cold/mobile/network benchmark.
- Canonical bootstrap approximately **203 bytes**, three-writer fixture approximately **508 bytes**. Actor IDs and compression can change sizes slightly.
- First WASM release compilation after fetching dependencies approximately **16 seconds**; excludes CLI installation. Generated bindings require an exactly matching `wasm-bindgen` CLI.

The test prints fresh measurements. Bundle cost is material: lazy-load for opened review workspaces if adopted. This harness does not establish a representative large-PR/long-history benchmark. Production adds explicit quotas, documented separately.

### Important findings

1. **An unchanged `put` can be skipped by Automerge.** Atomic application commands do not imply two operations or whole-command conflict winners. Tests assert one change and resulting flags, not a fictitious operation count.
2. **Use `tsify::Ts<T>`, not the deprecated ABI derive options.** Tsify documents leaks when invalid arguments throw across the WASM boundary. The wrapper converts inputs fallibly inside Rust and emits the same TypeScript declarations.
3. **Actors are writer identities only.** Loads explicitly switch actors; forks get independent actors. The fake agent's attribution is fixture data, not verified identity.
4. **Library sync quiescence is not a durability receipt.** The sync tests establish convergence only. Neither the browser page nor WASM wrapper claims server durability.

## Authorization gate: concrete counterexamples

See `crates/review-core/tests/import_boundary.rs` and the deleted-history test in `semantics.rs`:

- An agent can write a reviewed flag and delete it later. The final review view matches the original; forbidden history remains.
- A forbidden string can lose a reviewed-map conflict to a boolean. The visible winner looks well-typed; `get_all()` and decoded operations still expose the forbidden payload.
- Two forks can each pass local immutable-contribution checks while writing different payloads under the same ID. Merging retains a conflict; checking only the projected contribution misses it.

`get_changes()` plus `Change::decode().operations` exposes the needed operation data publicly. This removes one API uncertainty, **not** the trust-boundary problem. `check_schema` only checks the schema version and collection shape. The explicit `load_trusted`, `merge_trusted`, and `receiveSyncTrusted` names are intentional; these methods are not validators.

Before ever exposing arbitrary binary imports, implement and adversarially test:

- Trusted scope and actor registration, including rejection of spoofed actors; replica actor IDs are not credentials.
- Validation of every new operation, object ancestry, conflicting values, deletion, and attempted replacement of canonical maps; reject noncanonical ancestry and actor-sequence collisions.
- Immutable contribution IDs across forks, with trusted agent/run attribution and duplicate-ID payload checking at the service boundary.
- Limits on compressed input **and expanded resource use**, operation counts, strings, nesting, pending dependencies, and decoding time. A frame-length check is insufficient.
- Extend the tested candidate document **and candidate peer state** rollback for schema rejection to the full validator and durable storage path; add durable rejection/recovery/export behavior.

This harness exposes no network route. The production service deliberately accepts typed proposals, not opaque history; its tests check exact causal reconstruction, fresh actors, command capability and external snapshot membership. Do not promote the test harness's command capability checks into a claim that arbitrary Automerge history is authorized.

## Deliberate spike simplifications

- Version IDs (`v1`, `v2`) are fixtures, not backend fingerprints or snapshot authorization. No source/diff data is stored.
- Immutable contributions are scalar JSON payloads under unique map keys, not replaceable collection snapshots. Assessment and attributed context are committed together. A single assessment supplies inherited importance; multiple assessments are retained without inventing consensus. Sequential stream replacement, contribution amendments/dismissals, and conflict UI are not implemented.
- Shared-core review and importance alternatives/reassertion are exposed by the production UI; this synthetic page is not its UX test.
- The core's durable callback exercises candidate publication, not real SQLite/IndexedDB+journal atomicity or optimistic UI rollback. The WASM sync wrapper is trusted-only and in-memory.
- The page does not model active-tab visibility, route integration, review controls, session expiry, account switching, or a service worker.

## Current review decisions

See the [implementation checklist](../../automerge-plan.md). Deterministic human winners and WASM cost remain product-review topics. Revision-consistent snapshot identity, authenticated typed synchronization, real IndexedDB/SQLite durability and the review UI are implemented outside this harness.

Repository validation also needs the existing root checks. This change includes a four-line indentation-only fix in `src/components/Tooltip.tsx` because the baseline failed `npm run format:check`.
