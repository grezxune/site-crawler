import { existsSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const START_TIMEOUT_MS = 20_000;

const INSTALL_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const COMMANDS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];

// Headless with a throwaway profile, and none of Chrome's own background traffic.
const FLAGS = [
  "--headless=new",
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-domain-reliability",
  "--disable-extensions",
  "--disable-sync",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-pings",
];

export interface Browser {
  cdp: Cdp;
  /** Product and version, such as "HeadlessChrome/155.0.8059.80". */
  version: string;
  close(): Promise<void>;
}

/** Finds Chrome, Chromium, or Edge: the explicit path, then CHROME_PATH, then common install locations. */
export function findChrome(explicit?: string): string | null {
  for (const path of [explicit, process.env.CHROME_PATH]) {
    if (path) return existsSync(path) ? path : null;
  }
  for (const path of INSTALL_PATHS) if (existsSync(path)) return path;
  for (const command of COMMANDS) {
    const path = Bun.which(command);
    if (path) return path;
  }
  return null;
}

/** Starts a headless browser with a temporary profile and connects to it over the DevTools Protocol. */
export async function launchBrowser(executable: string): Promise<Browser> {
  const profile = await mkdtemp(join(tmpdir(), "site-crawler-chrome-"));
  const child = Bun.spawn([executable, ...FLAGS, `--user-data-dir=${profile}`, "about:blank"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  // A crash or Ctrl-C must not leave a browser running or a profile on disk.
  const cleanUp = () => {
    child.kill();
    rmSync(profile, { recursive: true, force: true });
  };
  process.once("exit", cleanUp);

  try {
    const endpoint = await readDevToolsEndpoint(child.stderr);
    const cdp = await Cdp.connect(endpoint);
    const { product } = await cdp.send("Browser.getVersion");
    let closed = false;
    return {
      cdp,
      version: typeof product === "string" ? product : "unknown",
      async close() {
        if (closed) return;
        closed = true;
        await cdp.send("Browser.close").catch(() => undefined);
        cdp.close();
        await Promise.race([child.exited, Bun.sleep(5000)]);
        cleanUp();
        process.removeListener("exit", cleanUp);
      },
    };
  } catch (error) {
    cleanUp();
    process.removeListener("exit", cleanUp);
    throw error;
  }
}

async function readDevToolsEndpoint(stderr: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + START_TIMEOUT_MS;
  let output = "";
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
    if (!chunk || chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
    const endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1];
    if (endpoint) {
      // Keep reading so a full stderr pipe never blocks the browser.
      void drain(reader);
      return endpoint;
    }
  }
  throw new Error(`The browser did not start. Its output was:\n${output.slice(-2000)}`);
}

async function drain(reader: { read(): Promise<{ done: boolean }> }): Promise<void> {
  try {
    while (!(await reader.read()).done) {
      // Discard browser log output.
    }
  } catch {
    // The browser exited.
  }
}
