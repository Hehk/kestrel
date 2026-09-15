# Kestrel

WIP

## Development

Right now, I am reviewing the TypeScript code while building because I want to get the defaults there done right. The CSS, Tests and Backend are pure vibes.

## Personal PR review

Reviewed/collapsed state is version-bound, offline-capable and synchronized through a shared Rust/WASM Automerge core. See [setup, behavior, recovery and tests](src/review/README.md).

Frontend builds now require the Rust `wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.128. `npm run review:build` generates the WASM artifact and TypeScript declarations; dev, typecheck and build run it automatically.
