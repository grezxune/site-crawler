import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Browser, findChrome, launchBrowser } from "./browser.ts";
import { Frontier } from "./frontier.ts";
import { analyzePage } from "./html.ts";
import { fetchPage, sleep } from "./http.ts";
import { checkLinks, type LinkCheck, NOT_CHECKED } from "./link-check.ts";
import {
  crawlSettings, type CrawlSettings, type Manifest, type PageOutcome, type PageRecord, writeManifest,
} from "./manifest.ts";
import { renderPage } from "./render.ts";
import { ALLOW_ALL, loadRobots } from "./robots.ts";
import { loadSitemap, type Sitemap } from "./sitemap.ts";
import { isSameSite, normalizeUrl, pageKey, siteKey } from "./urls.ts";

// Start-page headers worth keeping for the report.
const START_HEADERS = ["server", "strict-transport-security", "x-powered-by", "content-security-policy"];

export interface CrawlOptions extends CrawlSettings {
  startUrl: string;
  outDir: string;
  /** Browser executable for `render`. Found automatically when omitted. */
  chromePath?: string;
  onPage?: (page: PageRecord, done: number) => void;
  onLinkCheck?: (check: LinkCheck) => void;
}

/** Crawls one site breadth-first from `startUrl`, saves every HTML page under `outDir`, and writes the manifest. */
export async function crawl(options: CrawlOptions): Promise<Manifest> {
  const start = normalizeUrl(options.startUrl);
  if (!start) throw new Error(`Not an http(s) URL: ${options.startUrl}`);
  // The browser starts first, so a missing browser stops the crawl before any request.
  const browser = options.render ? await startBrowser(options.chromePath) : null;
  try {
    return await crawlSite(options, start, browser);
  } finally {
    await browser?.close();
  }
}

async function startBrowser(chromePath?: string): Promise<Browser> {
  const executable = findChrome(chromePath);
  if (executable) return launchBrowser(executable);
  throw new Error(chromePath
    ? `No browser found at ${chromePath}.`
    : "--render needs Chrome, Chromium, or Edge. Install one, or pass --chrome <path> or set CHROME_PATH.");
}

async function crawlSite(options: CrawlOptions, start: URL, browser: Browser | null): Promise<Manifest> {
  const began = performance.now();
  const site = siteKey(start.host);
  const startKey = pageKey(start);
  const robots = options.respectRobots ? await loadRobots(start.origin, options.userAgent) : ALLOW_ALL;
  const delayMs = Math.max(options.delayMs, (robots.crawlDelay ?? 0) * 1000);
  const frontier = new Frontier(site, robots, options.maxPages);
  const pages: PageRecord[] = [];
  const startHeaders: Record<string, string> = {};

  const processPage = async (url: URL): Promise<PageRecord> => {
    const record: PageRecord = {
      url: url.href, finalUrl: null, status: null, outcome: "failed", file: null,
      contentType: null, bytes: null, ms: null, lastModified: null,
    };
    const requestKey = pageKey(url);
    // Follow a redirect only to this site, and only to a page no other worker has claimed.
    const shouldFollow = (next: URL): boolean =>
      isSameSite(next, site) && (pageKey(next) === requestKey || frontier.claim(pageKey(next)));
    const requestStart = performance.now();
    const elapsed = () => Math.round(performance.now() - requestStart);

    try {
      const { response, finalUrl } = await fetchPage(url, options.userAgent, shouldFollow);
      record.finalUrl = finalUrl.href;
      if (!response) {
        return { ...record, ms: elapsed(), outcome: isSameSite(finalUrl, site) ? "duplicate" : "offsite-redirect" };
      }
      record.status = response.status;
      record.contentType = response.headers.get("content-type");
      record.lastModified = response.headers.get("last-modified");
      if (requestKey === startKey) {
        for (const name of START_HEADERS) {
          const value = response.headers.get(name);
          if (value) startHeaders[name] = value;
        }
      }
      if (!response.ok) return discard(response, { ...record, ms: elapsed() }, "http-error");
      if (!/text\/html|application\/xhtml\+xml/i.test(record.contentType ?? "")) {
        return discard(response, { ...record, ms: elapsed() }, "not-html");
      }

      const html = await response.text();
      record.ms = elapsed();
      record.bytes = Buffer.byteLength(html);
      const file = frontier.claimFile(finalUrl);
      const path = join(options.outDir, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, html);
      record.file = file;
      record.outcome = "saved";

      const { base, links } = await analyzePage(html);
      const baseUrl = (base !== null ? normalizeUrl(base, finalUrl) : null) ?? finalUrl;
      for (const href of links) {
        const link = normalizeUrl(href, baseUrl);
        if (link) frontier.addLink(link);
      }
      if (browser) {
        record.render = await renderPage(browser, finalUrl.href);
        for (const href of [...record.render.links, ...record.render.files.map((file) => file.url)]) {
          const link = normalizeUrl(href);
          if (link) frontier.addLink(link);
        }
      }
    } catch (error) {
      record.outcome = "failed";
      record.ms ??= elapsed();
      record.error = error instanceof Error ? error.message : String(error);
    }
    return record;
  };

  frontier.enqueue(start);
  let sitemap: Sitemap = { found: false, entries: [] };
  if (options.useSitemap) {
    const sitemapUrls = robots.sitemaps.length > 0 ? robots.sitemaps : [new URL("/sitemap.xml", start.origin).href];
    sitemap = await loadSitemap(sitemapUrls, options.userAgent);
    for (const entry of sitemap.entries) {
      const url = normalizeUrl(entry.loc);
      if (url) frontier.enqueue(url);
    }
  }

  let active = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const url = frontier.queue.shift();
      if (!url) {
        if (active === 0) return;
        await sleep(50);
        continue;
      }
      active++;
      const record = await processPage(url).finally(() => active--);
      pages.push(record);
      options.onPage?.(record, pages.length);
      await sleep(delayMs);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));

  pages.sort((a, b) => a.url.localeCompare(b.url));
  const linkChecks = options.checkLinks
    ? await checkLinks([...frontier.outbound], {
      userAgent: options.userAgent,
      maxChecks: options.maxLinkChecks,
      perHostDelayMs: delayMs,
      onCheck: options.onLinkCheck,
    })
    : NOT_CHECKED;

  const manifest: Manifest = {
    site,
    startUrl: start.href,
    crawledAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - began),
    settings: crawlSettings(options, delayMs),
    robots: {
      checked: options.respectRobots, found: robots.found, crawlDelay: robots.crawlDelay, blocked: frontier.blocked,
    },
    sitemap: { checked: options.useSitemap, found: sitemap.found, entries: sitemap.entries },
    hitPageLimit: frontier.hitPageLimit,
    render: { enabled: browser !== null, browser: browser?.version ?? null },
    startHeaders,
    pages,
    linkChecks,
  };
  await mkdir(options.outDir, { recursive: true });
  await writeManifest(options.outDir, manifest);
  return manifest;
}

async function discard(response: Response, record: PageRecord, outcome: PageOutcome): Promise<PageRecord> {
  await response.body?.cancel();
  return { ...record, outcome };
}
