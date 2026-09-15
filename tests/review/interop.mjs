import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc, VersionVector } from "loro-crdt";

const dir = mkdtempSync(join(tmpdir(), "kestrel-loro-"));
const read = (name) => new Uint8Array(readFileSync(join(dir, name)));
const write = (name, bytes) => writeFileSync(join(dir, name), bytes);
const native = (mode) =>
  execFileSync(
    "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/Cargo.toml",
      "-p",
      "review-core",
      "--example",
      "interop",
      "--",
      mode,
      dir,
    ],
    { stdio: "inherit" },
  );
try {
  native("emit");
  const doc = new LoroDoc();
  doc.import(read("rust.snapshot"));
  assert.deepEqual(doc.oplogVersion().encode(), read("rust.vv"));
  doc.import(read("rust.update"));
  assert.equal(doc.getMap("reviewed").get("file:v1"), true);
  const before = doc.oplogVersion();
  doc.setPeerId("18446744073709551614");
  doc.getMap("collapsed").set("file:v1", false);
  doc.getMap("humanImportance").set("file:v1", "important");
  doc.commit();
  write("js.update", doc.export({ mode: "update", from: before }));
  write("js.snapshot", doc.export({ mode: "snapshot" }));
  write("js.vv", doc.oplogVersion().encode());
  native("verify");
  doc.import(read("rust-reply.update"));
  doc.import(read("rust-reply.update"));
  assert.equal(doc.getMap("reviewed").get("file:v1"), false);
  assert.equal(doc.getMap("collapsed").get("file:v1"), false);
  assert.equal(doc.oplogVersion().compare(VersionVector.decode(read("rust-reply.vv"))), 0);
  console.log(
    "Native Rust ↔ official loro-crdt snapshots, incremental updates, duplicate delivery and u64 peer IDs passed",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
