# Kestrel

WIP

## Development

Right now, I am reviewing the TypeScript code while building because I want to get the defaults there done right. The CSS, Tests and Backend are pure vibes.

## Local PR review

The pull request diff page supports reviewed/collapsed state saved on this device. Sync an existing PR from GitHub once to load trustworthy file-version identities. Server synchronization is not enabled.

The frontend build now generates the shared Rust/WASM review core. Install its tools before `npm run dev` or `npm run build`:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128 --locked
npm ci
```

See [review integration](docs/loro-integration.md) for behavior, tests and limitations, and the [implementation plan](loro-plan.md) for remaining work.
