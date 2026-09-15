import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("./", import.meta.url));
await build({ root, configFile: false });
const server = await preview({ root, configFile: false, preview: { port: 0, host: "127.0.0.1" } });
let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const address = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.locator('#result[data-ready="true"]').waitFor();
  let view = JSON.parse(await page.locator("#result").textContent());
  assert.equal(view.reviewed, false);
  assert.equal(view.restored, false);
  await context.setOffline(true);
  await page.locator("#review").click();
  await page.waitForFunction(
    () => JSON.parse(document.querySelector("#result").textContent).reviewed,
  );
  // This spike restores IndexedDB bytes, not an offline app shell. Reload needs static assets.
  await context.setOffline(false);
  await page.reload();
  await page.locator('#result[data-ready="true"]').waitFor();
  view = JSON.parse(await page.locator("#result").textContent());
  assert.equal(view.restored, true);
  assert.equal(view.reviewed, true);
  assert.equal(view.collapsed, true);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browser: "Vite/WASM, offline edit, IndexedDB restore passed",
      wasmInitMs: view.wasmInitMs,
    }),
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
}
