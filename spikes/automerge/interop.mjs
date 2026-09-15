import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import * as A from "@automerge/automerge";
import { ReviewReplica } from "./generated/nodejs/review_wasm.js";

const fixture = fileURLToPath(new URL("../../target/debug/examples/fixture", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "kestrel-automerge-"));
const basePath = join(directory, "base.am");
const agentPath = join(directory, "agent.am");
const mergedPath = join(directory, "merged.am");
const native = (...args) => execFileSync(fixture, args, { encoding: "utf8" });

function sync(rust, js) {
  rust.resetSync();
  let state = A.initSyncState();
  for (let round = 0; round < 30; round++) {
    const outbound = rust.generateSync();
    if (outbound) [js, state] = A.receiveSyncMessage(js, state, outbound);
    let inbound;
    [state, inbound] = A.generateSyncMessage(js, state);
    if (inbound) rust.receiveSyncTrusted(inbound);
    if (!outbound && !inbound) return js;
  }
  throw new Error("sync did not settle");
}

try {
  native("bootstrap", basePath);
  native("agent", basePath, agentPath);
  const base = readFileSync(basePath);
  let browser = new ReviewReplica(base);
  browser.apply({ kind: "importance", version: "v1", value: "important" });
  const savedOffline = browser.save();
  browser.free();
  browser = new ReviewReplica(savedOffline);

  let tab = A.load(base);
  tab = A.change(tab, (doc) => {
    doc.reviewed.v1 = true;
    doc.collapsed.v1 = true;
  });
  const agent = A.load(readFileSync(agentPath));
  tab = A.merge(tab, agent);
  tab = sync(browser, tab);
  assert.equal(browser.view("v1").effectiveImportance, "important");
  assert.equal(browser.view("v1").assessments[0].agent, "native-rust-agent");
  assert.equal(browser.view("v1").reviewed, true);
  assert.equal(tab.reviewed.v1, true);
  assert.equal(tab.humanImportance.v1.toString(), "important");

  browser.apply({ kind: "review", version: "v1", value: false });
  tab = sync(browser, tab);
  assert.equal(tab.reviewed.v1, false);
  assert.equal(tab.collapsed.v1, false);
  const rustReload = new ReviewReplica(A.save(tab));
  assert.deepEqual(rustReload.view("v1"), browser.view("v1"));
  writeFileSync(mergedPath, A.save(tab));
  assert.deepEqual(JSON.parse(native("view", mergedPath)), browser.view("v1"));
  assert.deepEqual(A.getHeads(A.load(browser.save())).sort(), A.getHeads(tab).sort());

  // Invalid typed inputs fail normally rather than unwinding through the WASM ABI.
  assert.throws(() => browser.apply({ kind: "review", version: "v1", value: "yes" }));
  assert.equal(browser.view("v1").reviewed, false);
  rustReload.free();
  browser.free();
  A.free(tab);
  A.free(agent);
  const wasm = readFileSync(new URL("generated/web/review_wasm_bg.wasm", import.meta.url));
  console.log(
    JSON.stringify(
      {
        interoperability: "native Rust ↔ official JS ↔ shared Rust WASM: passed",
        wasmBytes: wasm.length,
        wasmGzipBytes: gzipSync(wasm).length,
        baseDocumentBytes: base.length,
        mergedDocumentBytes: readFileSync(mergedPath).length,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
