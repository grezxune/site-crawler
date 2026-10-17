import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LinkCheckResult } from "./link-check.ts";
import type { RenderRecord } from "./render.ts";
import type { SitemapEntry } from "./sitemap.ts";

export const MANIFEST_FILE = "manifest.json";

export type PageOutcome = "saved" | "not-html" | "http-error" | "offsite-redirect" | "duplicate" | "failed";

export interface PageRecord {
  url: string;
  /** Where the request ended up after redirects. */
  finalUrl: string | null;
  status: number | null;
  outcome: PageOutcome;
  /** Path of the saved HTML, relative to the output folder. */
  file: string | null;
  contentType: string | null;
  /** Size of the saved HTML in bytes. */
  bytes: number | null;
  /** Time from request start to the full body, in milliseconds. */
  ms: number | null;
  /** The `Last-Modified` response header. */
  lastModified: string | null;
  error?: string;
  /** What the render browser found on this page, when the crawl ran with `render`. */
  render?: RenderRecord;
}

export interface CrawlSettings {
  concurrency: number;
  delayMs: number;
  maxPages: number;
  useSitemap: boolean;
  respectRobots: boolean;
  userAgent: string;
  /** Check linked files and external links with HEAD requests after the crawl. */
  checkLinks: boolean;
  maxLinkChecks: number;
  /** Load each page in a headless browser and record what its scripts add. */
  render: boolean;
}

/** Everything a crawl learned. The report is built from this file plus the saved HTML. */
export interface Manifest {
  site: string;
  startUrl: string;
  crawledAt: string;
  durationMs: number;
  settings: CrawlSettings;
  robots: { checked: boolean; found: boolean; crawlDelay: number | null; blocked: string[] };
  sitemap: { checked: boolean; found: boolean; entries: SitemapEntry[] };
  hitPageLimit: boolean;
  /** Missing in manifests from before render mode existed. */
  render?: { enabled: boolean; browser: string | null };
  /** Selected response headers from the start page, such as `server` and `strict-transport-security`. */
  startHeaders: Record<string, string>;
  pages: PageRecord[];
  /** Status of linked files and external links. Missing in manifests from before the check existed. */
  linkChecks?: LinkCheckResult;
}

/** Copies only the settings fields, so extra crawl options never leak into the manifest. */
export function crawlSettings(options: CrawlSettings, delayMs: number): CrawlSettings {
  const { concurrency, maxPages, useSitemap, respectRobots, userAgent, checkLinks, maxLinkChecks, render } = options;
  return { concurrency, delayMs, maxPages, useSitemap, respectRobots, userAgent, checkLinks, maxLinkChecks, render };
}

export async function writeManifest(outDir: string, manifest: Manifest): Promise<void> {
  await writeFile(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function readManifest(outDir: string): Promise<Manifest> {
  const text = await readFile(join(outDir, MANIFEST_FILE), "utf8");
  const manifest = JSON.parse(text) as Manifest;
  if (!Array.isArray(manifest.pages) || typeof manifest.startUrl !== "string") {
    throw new Error(`${join(outDir, MANIFEST_FILE)} is not a crawl manifest. Run the crawl again.`);
  }
  return manifest;
}
