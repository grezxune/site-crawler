import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type FileEntry, fileEntries, linkedPages, type PageChange } from "./changes.ts";
import { analyzePage, type PageAnalysis } from "./html.ts";
import { type Manifest, MANIFEST_FILE, type PageRecord, readManifest } from "./manifest.ts";
import { buildSiteData } from "./site-data.ts";
import { CHANGES_DIR, normalizeUrl, pageKey } from "./urls.ts";

/** What a crawl needs from the earlier crawl in the same folder. */
export interface PreviousRun {
  manifest: Manifest;
  /** Saved pages by the page key they were served from. */
  pages: Map<string, PageRecord>;
  /** The URL of every saved page, so the crawl requests each one again even when nothing links to it. */
  urls: URL[];
  /** Page keys a link, a redirect, or the sitemap led to. */
  linked: Set<string>;
  /** Files such as PDFs the earlier crawl found, by URL. */
  files: Map<string, FileEntry>;
}

/**
 * Reads the earlier crawl in `outDir`, or returns null when there is none.
 * Throws when it is a crawl of another site, so one site's folder never gets another's pages.
 */
export async function loadPreviousRun(outDir: string, site: string): Promise<PreviousRun | null> {
  if (!(await Bun.file(join(outDir, MANIFEST_FILE)).exists())) return null;
  let manifest: Manifest;
  try {
    manifest = await readManifest(outDir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read the earlier crawl in ${outDir}: ${reason} Pass --fresh to crawl without comparing.`, {
      cause: error,
    });
  }
  if (manifest.site !== site) {
    throw new Error(`${outDir} holds a crawl of ${manifest.site}. Pass --out with another folder.`);
  }

  // A page whose saved file is missing or unsafe counts as never saved, so it is fetched in full.
  // Records with URLs that do not parse are dropped, since the manifest may have been edited by hand.
  const kept: PageRecord[] = [];
  const pages = new Map<string, PageRecord>();
  const urls: URL[] = [];
  for (const record of manifest.pages) {
    const url = normalizeUrl(record.finalUrl ?? record.url);
    if (!url || !normalizeUrl(record.url)) continue;
    if (record.outcome !== "saved") {
      kept.push(record);
    } else if (record.file && isReusableFile(record.file) && (await Bun.file(join(outDir, record.file)).exists())) {
      kept.push(record);
      pages.set(pageKey(url), record);
      urls.push(url);
    }
  }
  manifest.pages = kept;
  const data = await buildSiteData(outDir, manifest);
  return { manifest, pages, urls, linked: linkedPages(data), files: fileEntries(data) };
}

/** The saved file for each page key, so pages keep their paths across crawls. */
export function savedFiles(previous: PreviousRun | null): Map<string, string> {
  const files = new Map<string, string>();
  for (const [key, record] of previous?.pages ?? []) if (record.file) files.set(key, record.file);
  return files;
}

/** `If-None-Match` and `If-Modified-Since` from the earlier crawl's copy of a page. */
export function conditionalHeaders(record: PageRecord | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  // The manifest is a file on disk and may have been edited, so only clean header values go out.
  const clean = (value: string | null | undefined): value is string => !!value && /^[\x20-\x7e]{1,512}$/.test(value);
  if (clean(record?.etag)) headers["If-None-Match"] = record.etag;
  if (clean(record?.lastModified)) headers["If-Modified-Since"] = record.lastModified;
  return headers;
}

/** A page record's response fields. After a 304, the saved copy's values fill in what the 304 leaves out. */
export function responseFields(
  response: Response, kept: PageRecord | null,
): Pick<PageRecord, "status" | "contentType" | "lastModified" | "etag" | "notModified"> {
  const header = (name: string) => response.headers.get(name);
  return {
    status: kept?.status ?? response.status,
    contentType: header("content-type") ?? kept?.contentType ?? null,
    lastModified: header("last-modified") ?? kept?.lastModified ?? null,
    etag: header("etag") ?? kept?.etag ?? null,
    ...(kept ? { notModified: true } : {}),
  };
}

export async function readSavedPage(outDir: string, record: PageRecord): Promise<string> {
  if (!record.file || !isSafeFile(record.file)) throw new Error(`Unsafe saved file path for ${record.url}`);
  return readFile(join(outDir, record.file), "utf8");
}

/** Whether a page fetched in full is new, changed, or unchanged since the earlier crawl saved `before`. */
export async function compareWithSaved(
  outDir: string, before: PageRecord | undefined, html: string, analysis: PageAnalysis,
): Promise<PageChange> {
  if (!before) return "new";
  const saved = await readSavedPage(outDir, before).catch(() => null);
  if (saved === null) return "changed";
  return saved === html || sameContent(analysis, await analyzePage(saved)) ? "unchanged" : "changed";
}

/** True when two copies of a page have the same title, description, text, base, and links. */
function sameContent(a: PageAnalysis, b: PageAnalysis): boolean {
  const view = (p: PageAnalysis) => JSON.stringify([p.title, p.metaDescription, p.base, p.textBlocks, p.links]);
  return view(a) === view(b);
}

/**
 * A saved path the crawl may keep using. Crawls from before the changes folder existed could save
 * a `/changes` page under `changes/`, so those pages get fetched in full and saved to their new path.
 */
function isReusableFile(file: string): boolean {
  return isSafeFile(file) && file.split("/")[0]?.toLowerCase() !== CHANGES_DIR;
}

/** A relative path with no `..` segment, so joining it to the output folder stays inside it. */
export function isSafeFile(file: string): boolean {
  if (isAbsolute(file) || file.includes("\\") || file.includes("\0")) return false;
  return file.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
