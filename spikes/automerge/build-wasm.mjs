import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const root = fileURLToPath(new URL("../../", import.meta.url));
function run(program, args) {
  execFileSync(program, args, { cwd: root, stdio: "inherit" });
}
run("cargo", [
  "build",
  "--locked",
  "--release",
  "--target",
  "wasm32-unknown-unknown",
  "-p",
  "review-wasm",
]);
run("cargo", ["build", "--locked", "-p", "review-core", "--example", "fixture"]);
for (const target of ["web", "nodejs"]) {
  run("wasm-bindgen", [
    "target/wasm32-unknown-unknown/release/review_wasm.wasm",
    "--target",
    target,
    "--out-dir",
    `spikes/automerge/generated/${target}`,
  ]);
}
writeFileSync(new URL("generated/nodejs/package.json", import.meta.url), '{"type":"commonjs"}\n');
