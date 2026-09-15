import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const inputs = ["Cargo.toml", "Cargo.lock", "scripts/review-wasm.mjs"];
for (const crate of ["review-core", "review-wasm"]) {
  inputs.push(`crates/${crate}/Cargo.toml`);
  for (const file of await readdir(`${root}crates/${crate}/src`))
    inputs.push(`crates/${crate}/src/${file}`);
}
const hash = createHash("sha256");
for (const path of inputs.sort()) hash.update(path).update(await readFile(`${root}${path}`));
const stamp = hash.digest("hex");
const output = `${root}src/review/generated`;
if ((await readFile(`${output}/build-inputs.txt`, "utf8").catch(() => "")) !== stamp) {
  for (const [program, args] of [
    [
      "cargo",
      ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "-p", "review-wasm"],
    ],
    [
      "wasm-bindgen",
      [
        "target/wasm32-unknown-unknown/release/review_wasm.wasm",
        "--target",
        "web",
        "--out-dir",
        "src/review/generated",
      ],
    ],
  ])
    execFileSync(program, args, { cwd: root, stdio: "inherit" });
  await writeFile(`${output}/build-inputs.txt`, stamp);
}
