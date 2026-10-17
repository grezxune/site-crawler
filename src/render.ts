import { Buffer } from "node:buffer";
import type { Browser } from "./browser.ts";
import type { CdpEvent } from "./cdp.ts";
import { blockedInRender, isFoundFile, urlsInJson } from "./found-files.ts";
import { normalizeUrl } from "./urls.ts";

const PAGE_TIMEOUT_MS = 20_000;
// The page counts as loaded once the network has been quiet this long.
const IDLE_MS = 1000;
const MIN_WAIT_MS = 1500;
const MAX_FILES = 5000;
const MAX_LINKS = 2000;
const MAX_BODY_CHARS = 20_000_000;
// Requests that stay open by design and must not hold up the idle wait.
const LONG_LIVED_TYPES = new Set(["EventSource", "WebSocket", "Ping", "Media"]);
// Runs in the page. The result comes back by value and is checked as untrusted data.
const LINK_EXPRESSION = `Array.from(document.querySelectorAll("a[href],area[href],iframe[src],frame[src]"),
  (e) => (typeof e.href === "string" && e.href) || e.src || "")`;

export interface FoundFile {
  url: string;
  /** `dom` when a link in the rendered page points at it, `api` when it came from fetched JSON. */
  via: "dom" | "api";
  /** The API URL whose response named the file. */
  source: string | null;
}

export interface RenderRecord {
  ok: boolean;
  error?: string;
  ms: number;
  /** False when the page was still loading at the timeout. Whatever loaded by then is recorded. */
  settled: boolean;
  /** Responses the page received, counted by host. */
  hosts: Record<string, number>;
  /** Requests failed on purpose: images, fonts, media, and file links. */
  blocked: number;
  /** JSON responses the page's scripts fetched, with the number of files each named. */
  apiCalls: { url: string; status: number; files: number }[];
  /** Every link in the rendered page and its frames, absolute. */
  links: string[];
  files: FoundFile[];
  /** True when a page hit the file or link limit. */
  truncated: boolean;
}

interface Response {
  url: string;
  type: string;
  mimeType: string;
  status: number;
}

/** Loads one page in the browser and records what its scripts added. Never throws. */
export async function renderPage(browser: Browser, url: string): Promise<RenderRecord> {
  const { cdp } = browser;
  const started = performance.now();
  const record: RenderRecord = {
    ok: false, ms: 0, settled: false, hosts: {}, blocked: 0, apiCalls: [], links: [], files: [], truncated: false,
  };
  const sessions = new Map<string, "page" | "frame" | "other">();
  const inflight = new Set<string>();
  const responses = new Map<string, Response>();
  const links = new Set<string>();
  const files = new Map<string, FoundFile>();
  const bodyReads: Promise<void>[] = [];
  let lastActivity = performance.now();
  let loaded = false;

  const addFile = (file: FoundFile) => {
    if (files.has(file.url)) return;
    if (files.size >= MAX_FILES) record.truncated = true;
    else files.set(file.url, file);
  };

  const readBody = async (session: string, requestId: unknown, response: Response) => {
    const result = await cdp.send("Network.getResponseBody", { requestId }, session).catch(() => null);
    if (!result || typeof result.body !== "string" || result.body.length > MAX_BODY_CHARS) return;
    const body = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
    let count = 0;
    for (const href of urlsInJson(body)) {
      if (!isFoundFile(new URL(href))) continue;
      addFile({ url: href, via: "api", source: response.url });
      count++;
    }
    record.apiCalls.push({ url: response.url, status: response.status, files: count });
  };

  const setUp = async (session: string, isPage: boolean) => {
    await Promise.all([
      cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, session),
      cdp.send("Network.enable", { maxTotalBufferSize: 200_000_000, maxResourceBufferSize: 50_000_000 }, session),
      cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session),
      ...(isPage ? [cdp.send("Page.enable", {}, session)] : []),
    ]);
  };

  const attachChild = async (params: Record<string, unknown>) => {
    const child = String(params.sessionId);
    const isFrame = (params.targetInfo as { type?: string } | undefined)?.type === "iframe";
    sessions.set(child, isFrame ? "frame" : "other");
    if (isFrame) await setUp(child, false).catch(() => undefined);
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => undefined);
  };

  const onEvent = ({ method, params, sessionId: session }: CdpEvent) => {
    if (!session || !sessions.has(session)) return;
    // Keyed by request ID alone: a frame's document request starts in the parent session and ends in the frame's.
    const key = String(params.requestId);
    if (method === "Fetch.requestPaused") {
      const requestUrl = (params.request as { url?: string } | undefined)?.url ?? "";
      const block = blockedInRender(requestUrl, String(params.resourceType));
      if (block) record.blocked++;
      const command = block ? "Fetch.failRequest" : "Fetch.continueRequest";
      const args = block ? { requestId: params.requestId, errorReason: "BlockedByClient" } : { requestId: params.requestId };
      void cdp.send(command, args, session).catch(() => undefined);
    } else if (method === "Network.requestWillBeSent") {
      if (!LONG_LIVED_TYPES.has(String(params.type))) inflight.add(key);
      lastActivity = performance.now();
    } else if (method === "Network.responseReceived") {
      const response = params.response as { url: string; mimeType: string; status: number };
      responses.set(key, { url: response.url, type: String(params.type), mimeType: response.mimeType, status: response.status });
      const host = normalizeUrl(response.url)?.host;
      if (host) record.hosts[host] = (record.hosts[host] ?? 0) + 1;
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      inflight.delete(key);
      lastActivity = performance.now();
      const response = responses.get(key);
      if (method === "Network.loadingFinished" && response && isDataCall(response)) {
        bodyReads.push(readBody(session, params.requestId, response));
      }
    } else if (method === "Page.loadEventFired" && sessions.get(session) === "page") {
      loaded = true;
    } else if (method === "Target.attachedToTarget") {
      void attachChild(params);
    }
  };

  const unsubscribe = cdp.on(onEvent);
  let targetId: string | null = null;
  try {
    targetId = String((await cdp.send("Target.createTarget", { url: "about:blank" })).targetId);
    const session = String((await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId);
    sessions.set(session, "page");
    await setUp(session, true);
    const navigation = await cdp.send("Page.navigate", { url }, session);
    if (typeof navigation.errorText === "string" && navigation.errorText) throw new Error(navigation.errorText);

    while (performance.now() - started < PAGE_TIMEOUT_MS) {
      await Bun.sleep(100);
      const quiet = inflight.size === 0 && performance.now() - lastActivity >= IDLE_MS;
      if (loaded && quiet && performance.now() - started >= MIN_WAIT_MS) {
        record.settled = true;
        break;
      }
    }

    for (const [frameSession, kind] of sessions) {
      if (kind === "other") continue;
      const result = await cdp.send("Runtime.evaluate", { expression: LINK_EXPRESSION, returnByValue: true }, frameSession)
        .catch(() => null);
      const hrefs = (result?.result as { value?: unknown } | undefined)?.value;
      for (const href of Array.isArray(hrefs) ? hrefs : []) {
        const link = typeof href === "string" ? normalizeUrl(href) : null;
        if (!link) continue;
        if (links.size < MAX_LINKS) links.add(link.href);
        else record.truncated = true;
        if (isFoundFile(link)) addFile({ url: link.href, via: "dom", source: null });
      }
    }
    while (bodyReads.length > 0) await Promise.allSettled(bodyReads.splice(0));
    record.ok = true;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  } finally {
    unsubscribe();
    if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }

  record.ms = Math.round(performance.now() - started);
  record.links = [...links].sort();
  record.files = [...files.values()].sort((a, b) => a.url.localeCompare(b.url));
  record.apiCalls.sort((a, b) => a.url.localeCompare(b.url));
  return record;
}

/** XHR or fetch responses that may carry JSON. */
function isDataCall(response: Response): boolean {
  if (response.type !== "XHR" && response.type !== "Fetch") return false;
  return /json|text\/plain|javascript/i.test(response.mimeType) || /\.json($|\?)/i.test(response.url);
}
