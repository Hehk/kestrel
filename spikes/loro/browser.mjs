import assert from "node:assert/strict";
import { chromium } from "playwright";
import { preview } from "vite";
import { LoroDoc } from "loro-crdt";

const server = await preview({
  configFile: "spikes/loro/vite.config.ts",
  preview: { host: "127.0.0.1", port: 0 },
});
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const port = server.httpServer.address().port;
  await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForFunction(() => window.loroSpike);
  const initialPeer = await page.evaluate(() => window.loroSpike.peerId());
  assert.equal((await page.evaluate(() => window.loroSpike.view())).reviewed, false);
  await context.setOffline(true);
  assert.equal((await page.evaluate(() => window.loroSpike.review())).reviewed, true);
  // Only metadata durability is under test here. Offline app-shell reload is NOT implemented.
  await context.setOffline(false);
  await page.reload();
  await page.waitForFunction(() => window.loroSpike);
  const restored = await page.evaluate(() => window.loroSpike.view());
  assert.equal(restored.reviewed, true);
  assert.equal(restored.collapsed, true);
  assert.notEqual(await page.evaluate(() => window.loroSpike.peerId()), initialPeer);
  const official = new LoroDoc();
  official.import(new Uint8Array(await page.evaluate(() => window.loroSpike.snapshot())));
  assert.equal(official.getMap("reviewed").get("file:v1"), true);
  assert.deepEqual(errors, []);
  console.log(
    `Chromium: Vite/WASM initialization, generated commands, offline edit, IndexedDB restore and fresh peer passed (${Math.round(await page.evaluate(() => window.loroSpike.initializationMs))} ms warm init)`,
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
