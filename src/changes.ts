import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Manifest, PageRecord } from "./manifest.ts";
import type { PreviousRun } from "./previous-run.ts";
import { buildSiteData, type SiteData } from "./site-data.ts";
import { CHANGES_DIR, normalizeUrl, pageKey } from "./urls.ts";

export const CHANGES_FILE = "changes.json";

export type PageChange = "new" | "changed" | "unchanged";

export interface ChangedPage {
  url: string;
  /** Path of the saved HTML, relative to the output folder and to the changes folder. */
  file: string;
}

export interface RemovedPage extends ChangedPage {
  /** Why the page is gone, such as `HTTP 404` or `redirects to https://example.org/b`. */
  reason: string;
}

/** A file such as a PDF, with where the crawl found it. */
export interface FileEntry {
  url: string;
  /** Pages that link to the file, or whose render found it. */
  pages: string[];
  foundBy: ("html" | "render")[];
  /** API URLs whose JSON named the file. */
  sources: string[];
}

/** What changed between the earlier crawl in a folder and this one. */
export interface Changes {
  /** When the earlier crawl ran. */
  since: string;
  /** Folder inside the output folder with copies of the new and changed pages and `changes.json`. Null when nothing changed. */
  dir: string | null;
  /**
   * False when only one of the two crawls used render. Then only files the server HTML links are compared,
   * and no page is listed as unlinked, since render finds links the server HTML lacks.
   */
  sameRender: boolean;
  pages: {
    new: ChangedPage[];
    changed: ChangedPage[];
    /** Pages the earlier crawl saved that no longer load. */
    removed: RemovedPage[];
    /** Pages that still load, but that no page or the sitemap links to anymore. Visitors cannot click to them. */
    unlinked: ChangedPage[];
    unchanged: number;
    /** Unchanged pages the server answered with 304, so no body was downloaded. */
    notModified: number;
  };
  files: { new: FileEntry[]; removed: FileEntry[] };
}

/** Compares this crawl, already saved to disk, with the earlier crawl, and writes the changes folder when something changed. */
export async function recordChanges(outDir: string, previous: PreviousRun, manifest: Manifest): Promise<Changes> {
  return writeChanges(outDir, manifest, compareRuns(previous, manifest, await buildSiteData(outDir, manifest)));
}

/** Every file a crawl found, by URL, with the pages and API calls that led to it. */
export function fileEntries(data: SiteData): Map<string, FileEntry> {
  const sources = new Map<string, Set<string>>();
  for (const page of data.pages) {
    for (const file of page.render?.files ?? []) {
      if (file.source) sources.set(file.url, (sources.get(file.url) ?? new Set()).add(file.source));
    }
  }
  const entries = [...data.files.values()].sort((a, b) => a.url.localeCompare(b.url)).map((file): FileEntry => ({
    url: file.url,
    pages: [...file.linkedFrom].sort(),
    foundBy: [...file.foundBy].sort(),
    sources: [...(sources.get(file.url) ?? [])].sort(),
  }));
  return new Map(entries.map((entry) => [entry.url, entry]));
}

/** Page keys a visitor can reach: linked from a saved page, directly or through a redirect, in the sitemap, or the start page. */
export function linkedPages(data: SiteData): Set<string> {
  const linked = new Set<string>();
  const add = (key: string) => {
    linked.add(key);
    const finalUrl = data.recordsByKey.get(key)?.finalUrl;
    if (finalUrl) linked.add(pageKey(new URL(finalUrl)));
  };
  add(pageKey(data.start));
  for (const key of data.inbound.keys()) add(key);
  for (const entry of data.manifest.sitemap.entries) {
    const url = normalizeUrl(entry.loc);
    if (url) add(pageKey(url));
  }
  return linked;
}

function compareRuns(previous: PreviousRun, manifest: Manifest, current: SiteData): Changes {
  const keyOf = (record: PageRecord) => pageKey(new URL(record.finalUrl ?? record.url));
  const saved = manifest.pages.filter((record) => record.outcome === "saved" && record.file);
  const entry = (record: PageRecord): ChangedPage => ({ url: record.finalUrl ?? record.url, file: record.file ?? "" });
  const savedKeys = new Set(saved.map(keyOf));
  const removed = [...previous.pages]
    .filter(([key]) => !savedKeys.has(key))
    .map(([key, record]) => ({ ...entry(record), reason: removalReason(key, manifest) }));

  // Links and files only render finds would all look gone, or all new, when one crawl ran without it.
  const sameRender = Boolean(previous.manifest.render?.enabled) === Boolean(manifest.render?.enabled);
  const linkedNow = linkedPages(current);
  const unlinked = sameRender
    ? saved.filter((record) => previous.pages.has(keyOf(record)) && previous.linked.has(keyOf(record)) && !linkedNow.has(keyOf(record)))
    : [];
  const comparable = (file: FileEntry) => sameRender || file.foundBy.includes("html");
  const before = [...previous.files.values()].filter(comparable);
  const now = [...fileEntries(current).values()].filter(comparable);
  const beforeUrls = new Set(before.map((file) => file.url));
  const nowUrls = new Set(now.map((file) => file.url));

  return {
    since: previous.manifest.crawledAt,
    dir: null,
    sameRender,
    pages: {
      new: saved.filter((record) => record.change === "new").map(entry),
      changed: saved.filter((record) => record.change === "changed").map(entry),
      removed,
      unlinked: unlinked.map(entry),
      unchanged: saved.filter((record) => record.change === "unchanged").length,
      notModified: saved.filter((record) => record.notModified).length,
    },
    files: {
      new: now.filter((file) => !beforeUrls.has(file.url)),
      removed: before.filter((file) => !nowUrls.has(file.url)),
    },
  };
}

/** Copies the new and changed pages to `changes/<time>/` and writes `changes.json` there, unless nothing changed. */
async function writeChanges(outDir: string, manifest: Manifest, changes: Changes): Promise<Changes> {
  const { pages, files } = changes;
  const lists = [pages.new, pages.changed, pages.removed, pages.unlinked, files.new, files.removed];
  if (lists.every((list) => list.length === 0)) return changes;

  const dir = `${CHANGES_DIR}/${manifest.crawledAt.slice(0, 19).replaceAll(":", "-")}Z`;
  await mkdir(join(outDir, dir), { recursive: true });
  for (const page of [...pages.new, ...pages.changed]) {
    const target = join(outDir, dir, page.file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(outDir, page.file), target);
  }
  const written = { ...changes, dir };
  const file = { site: manifest.site, crawledAt: manifest.crawledAt, ...written };
  await writeFile(join(outDir, dir, CHANGES_FILE), `${JSON.stringify(file, null, 2)}\n`);
  return written;
}

/** Why a page the earlier crawl saved is not saved this time. */
function removalReason(key: string, manifest: Manifest): string {
  const keyOf = (url: string) => pageKey(new URL(url));
  const record = manifest.pages.find((r) => keyOf(r.url) === key) ?? manifest.pages.find((r) => r.finalUrl && keyOf(r.finalUrl) === key);
  if (!record) {
    if (manifest.robots.blocked.some((url) => keyOf(url) === key)) return "blocked by robots.txt";
    return manifest.hitPageLimit ? "not reached before --max-pages" : "not requested";
  }
  if (record.finalUrl && keyOf(record.finalUrl) !== key) return `redirects to ${record.finalUrl}`;
  if (record.outcome === "http-error") return `HTTP ${record.status ?? "error"}`;
  if (record.outcome === "not-html") return `not HTML: ${record.contentType ?? "no content type"}`;
  if (record.outcome === "failed") return `request failed: ${record.error ?? "unknown error"}`;
  return record.outcome;
}
