import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { cpus, tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import solid from "vite-plugin-solid";
import { build } from "vite";

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => this.rejectPending("CDP socket closed"));
    this.socket.addEventListener("error", () => this.rejectPending("CDP socket failed"));
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => {
        this.socket.close();
        rejectOpen(new Error("CDP socket open timed out"));
      }, 10_000);
      this.socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolveOpen();
        },
        { once: true },
      );
      this.socket.addEventListener(
        "error",
        (error) => {
          clearTimeout(timer);
          rejectOpen(error);
        },
        { once: true },
      );
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`CDP command timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { reject: rejectSend, resolve: resolveSend, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  rejectPending(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  async close() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  }
}

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromeExecutable = resolveChromeExecutable();
const viewportOption = process.argv.find((argument) => argument.startsWith("--viewport="));
const viewport = parseViewport(viewportOption?.slice("--viewport=".length) ?? "1440x900");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "kestrel-diff-profile-"));
const outputDirectory = join(temporaryDirectory, "dist");
const chromeDataDirectory = join(temporaryDirectory, "chrome");
let chrome;
let server;
let cleanupPromise;

const cleanup = () => {
  cleanupPromise ??= (async () => {
    if (chrome !== undefined) await stopChrome(chrome);
    if (server !== undefined) await new Promise((resolveClose) => server.close(resolveClose));
    await rm(temporaryDirectory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  })();
  return cleanupPromise;
};
const handleSignal = (exitCode) => {
  void cleanup().finally(() => process.exit(exitCode));
};
const handleInterrupt = () => handleSignal(130);
const handleTerminate = () => handleSignal(143);
process.once("SIGINT", handleInterrupt);
process.once("SIGTERM", handleTerminate);

try {
  if (!existsSync(chromeExecutable)) throw new Error(`Chrome not found at ${chromeExecutable}`);
  await build({
    build: {
      emptyOutDir: true,
      outDir: outputDirectory,
      rollupOptions: { input: join(workspace, "scripts/profile-diff.html") },
    },
    configFile: false,
    logLevel: "warn",
    plugins: [solid()],
    root: workspace,
  });

  server = createStaticServer(outputDirectory);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Profile server failed");
  const origin = `http://127.0.0.1:${address.port}`;
  const profileUrl = `${origin}/scripts/profile-diff.html`;

  chrome = spawn(
    chromeExecutable,
    [
      "--disable-background-networking",
      "--disable-component-update",
      "--enable-precise-memory-info",
      "--headless=new",
      "--js-flags=--expose-gc",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${chromeDataDirectory}`,
      `--window-size=${viewport.width},${viewport.height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const chromeStartupError = new Promise((_, rejectStartup) => {
    chrome.once("error", rejectStartup);
  });
  const debuggingPort = await Promise.race([
    readDebuggingPort(chromeDataDirectory),
    chromeStartupError,
  ]);
  const targets = await waitForTargets(debuggingPort);
  const pageTarget = targets.find((target) => target.type === "page");
  if (pageTarget === undefined) throw new Error("Chrome profile page target was not created");

  const browserVersion = await fetch(`http://127.0.0.1:${debuggingPort}/json/version`, {
    signal: AbortSignal.timeout(5_000),
  }).then((response) => response.json());
  const browser = new Cdp(browserVersion.webSocketDebuggerUrl);
  await browser.open();
  await browser.send("Browser.grantPermissions", {
    origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });

  const page = new Cdp(pageTarget.webSocketDebuggerUrl);
  await page.open();
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: viewport.height,
    mobile: viewport.width < 600,
    width: viewport.width,
  });
  await page.send("Page.bringToFront");
  await page.send("Page.navigate", { url: profileUrl });
  await page.send("Page.bringToFront");
  const result = await waitForResult(page);
  console.log(
    JSON.stringify(
      {
        ...result,
        runner: {
          browser: browserVersion.Browser,
          cpu: cpus()[0]?.model ?? "unknown",
          dirty:
            execFileSync("git", ["status", "--porcelain"], {
              cwd: workspace,
              encoding: "utf8",
            }).length > 0,
          node: process.version,
          platform: `${process.platform}-${process.arch}`,
          revision: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: workspace,
            encoding: "utf8",
          }).trim(),
          viewport,
        },
      },
      null,
      2,
    ),
  );
  await page.close();
  await browser.send("Browser.close").catch(() => undefined);
  await browser.close();
} finally {
  process.removeListener("SIGINT", handleInterrupt);
  process.removeListener("SIGTERM", handleTerminate);
  await cleanup();
}

function resolveChromeExecutable() {
  const configured = process.env["CHROME_PATH"];
  const candidates = [
    configured,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const executable = candidates.find(
    (candidate) => candidate !== undefined && existsSync(candidate),
  );
  if (executable === undefined) {
    throw new Error("Chrome was not found; set CHROME_PATH to a Chromium executable");
  }
  return executable;
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (match === null) throw new Error("--viewport must use WIDTHxHEIGHT");
  return { height: Number(match[2]), width: Number(match[1]) };
}

async function stopChrome(process) {
  if (process.exitCode !== null) return;
  const exited = new Promise((resolveExit) => process.once("exit", resolveExit));
  process.kill("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  if (process.exitCode === null) {
    process.kill("SIGKILL");
    await Promise.race([exited, delay(3_000)]);
  }
}

function createStaticServer(root) {
  return createServer(async (request, response) => {
    try {
      const requestPath = new URL(request.url ?? "/", "http://localhost").pathname;
      const relativePath = requestPath === "/" ? "scripts/profile-diff.html" : requestPath.slice(1);
      const filePath = normalize(join(root, relativePath));
      if (!filePath.startsWith(root)) throw new Error("Invalid profile asset path");
      const details = await stat(filePath);
      if (!details.isFile()) throw new Error("Profile asset is not a file");
      response.statusCode = 200;
      response.setHeader("Content-Type", contentType(filePath));
      createReadStream(filePath).pipe(response);
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case ".css":
      return "text/css";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript";
    default:
      return "application/octet-stream";
  }
}

async function readDebuggingPort(dataDirectory) {
  const portFile = join(dataDirectory, "DevToolsActivePort");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const [port] = (await readFile(portFile, "utf8")).split("\n");
      if (port !== undefined) return Number(port);
    } catch {
      await delay(50);
    }
  }
  throw new Error("Chrome did not expose a debugging port");
}

async function waitForTargets(port) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      const targets = await response.json();
      if (targets.length > 0) return targets;
    } catch {
      await delay(50);
    }
  }
  throw new Error("Chrome did not expose a page target");
}

async function waitForResult(page) {
  for (let attempt = 0; attempt < 1_800; attempt += 1) {
    const evaluation = await page.send("Runtime.evaluate", {
      expression:
        "({ result: globalThis.__DIFF_PROFILE_RESULT__ ?? null, error: globalThis.__DIFF_PROFILE_ERROR__ ?? null })",
      returnByValue: true,
    });
    const value = evaluation.result.value;
    if (value?.error !== null) throw new Error(value.error);
    if (value?.result !== null) return value.result;
    await delay(100);
  }
  throw new Error("Browser profile timed out");
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
