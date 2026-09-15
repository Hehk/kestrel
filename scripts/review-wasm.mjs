import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
const version = execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).trim();
if (version !== "wasm-bindgen 0.2.128") {
  throw new Error(
    "Install the pinned CLI: cargo install wasm-bindgen-cli --version 0.2.128 --locked",
  );
}
run("cargo", [
  "build",
  "--locked",
  "--manifest-path",
  "crates/Cargo.toml",
  "-p",
  "review-wasm",
  "--target",
  "wasm32-unknown-unknown",
  "--release",
]);
run("wasm-bindgen", [
  "crates/target/wasm32-unknown-unknown/release/review_wasm.wasm",
  "--target",
  "web",
  "--out-dir",
  "src/review/generated",
]);
run("npx", ["oxfmt", "--write", "src/review/generated/review_wasm.d.ts"]);
const wasm = readFileSync("src/review/generated/review_wasm_bg.wasm");
console.log(`review WASM: ${wasm.length} bytes; ${gzipSync(wasm).length} bytes gzip`);
