import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChangedPage, Changes } from "./changes.ts";
import { isFoundFile } from "./found-files.ts";
import type { PageAnalysis } from "./html.ts";
import { fetchPage, sleep } from "./http.ts";
import type { FileRecord } from "./manifest.ts";
import { conditionalHeaders, isSafeFile } from "./previous-run.ts";
import type { Robots } from "./robots.ts";
import type { RenderRecord } from "./render.ts";
import { fileUrlToPath, isHostingPath, isSameSite, normalizeUrl, shortHash } from "./urls.ts";

/** Largest file `saveFiles` downloads when no limit is given. */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface SaveFilesOptions {
  outDir: string;
  site: string;
  robots: Robots;
  userAgent: string;
  concurrency: number;
  delayMs: number;
  maxFileBytes?: number;
  /** Files the earlier crawl saved, by URL. A known file is downloaded again only when the server says it changed. */
  previous: Map<string, FileRecord> | null;
  onFile?: (file: FileRecord, done: number) => void;
}

/** Same-site images, media, and documents a page links to or loads, plus any its render found. */
export function filesOnPage(analysis: PageAnalysis, base: URL, site: string, render?: RenderRecord): string[] {
  const found = new Set<string>();
  for (const href of [...analysis.links, ...analysis.resources, ...(render?.files.map((file) => file.url) ?? [])]) {
    const url = normalizeUrl(href, base);
    if (url && isSameSite(url, site) && !isHostingPath(url) && isFoundFile(url)) found.add(url.href);
  }
  return [...found];
}

/**
 * Downloads each same-site file URL into `files/` in the output folder, a few at a time with the crawl's delay.
 * A file the earlier crawl saved is asked for with its `ETag` or `Last-Modified`, and kept without a request
 * when it has neither. A download with the same bytes as the saved copy does not rewrite it.
 */
export async function saveFiles(urls: Iterable<string>, options: SaveFilesOptions): Promise<FileRecord[]> {
  const queue = [...new Set(urls)].sort().flatMap((href) => {
    const url = URL.parse(href);
    return url && isSameSite(url, options.site) && options.robots.isAllowed(url.pathname + url.search) ? [url] : [];
  });
  const paths = new FilePaths(options.previous);
  const records: FileRecord[] = [];
  const worker = async (): Promise<void> => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      const before = options.previous?.get(url.href);
      const keep = before && !before.etag && !before.lastModified;
      const record = keep ? { ...before, change: "unchanged" as const, notRequested: true } : await saveFile(url, before, paths, options);
      records.push(record);
      options.onFile?.(record, records.length);
      if (!keep) await sleep(options.delayMs);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  return records.sort((a, b) => a.url.localeCompare(b.url));
}

async function saveFile(url: URL, before: FileRecord | undefined, paths: FilePaths, options: SaveFilesOptions): Promise<FileRecord> {
  const record: FileRecord = {
    url: url.href, file: null, status: null, outcome: "failed", contentType: null, bytes: null, sha256: null,
    lastModified: null, etag: null,
  };
  try {
    const shouldFollow = (next: URL) => isSameSite(next, options.site);
    const headersFor = (next: URL) => (next.href === url.href ? conditionalHeaders(before) : {});
    const { response } = await fetchPage(url, options.userAgent, shouldFollow, headersFor);
    if (!response) return { ...record, outcome: "offsite-redirect" };
    const header = (name: string) => response.headers.get(name);
    if (response.status === 304 && before) {
      await response.body?.cancel();
      const validators = { lastModified: header("last-modified") ?? before.lastModified, etag: header("etag") ?? before.etag };
      return { ...before, ...validators, change: "unchanged", notModified: true };
    }
    Object.assign(record, {
      status: response.status, contentType: header("content-type"), lastModified: header("last-modified"), etag: header("etag"),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ...record, outcome: "http-error" };
    }
    const bytes = await readCapped(response, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    if (!bytes) return { ...record, outcome: "too-large" };
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const file = paths.claim(url);
    const same = before?.sha256 === sha256 && before.file === file;
    if (!same) {
      const path = join(options.outDir, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    const change = !before ? "new" : same ? "unchanged" : "changed";
    return { ...record, file, outcome: "saved", bytes: bytes.byteLength, sha256, ...(options.previous ? { change } : {}) };
  } catch (error) {
    return { ...record, error: error instanceof Error ? error.message : String(error) };
  }
}

/** New, changed, and removed saved files, from the earlier crawl's saved files and this crawl's. */
export function compareSavedFiles(before: Map<string, FileRecord>, files: FileRecord[]): NonNullable<Changes["savedFiles"]> {
  const saved = files.filter((record) => record.outcome === "saved" && record.file);
  const entry = (record: FileRecord): ChangedPage => ({ url: record.url, file: record.file ?? "" });
  const now = new Map(files.map((record) => [record.url, record]));
  const removed = [...before.values()].filter((record) => now.get(record.url)?.outcome !== "saved").map((record) => {
    const current = now.get(record.url);
    const reason = !current ? "no page links to it anymore"
      : current.outcome === "http-error" ? `HTTP ${current.status ?? "error"}`
      : current.outcome === "failed" ? `request failed: ${current.error ?? "unknown error"}` : current.outcome;
    return { ...entry(record), reason };
  });
  return {
    new: saved.filter((record) => record.change === "new").map(entry),
    changed: saved.filter((record) => record.change === "changed").map(entry),
    removed,
    unchanged: saved.filter((record) => record.change === "unchanged").length,
    notDownloaded: saved.filter((record) => record.notModified || record.notRequested).length,
  };
}

/** Reads the whole body, or returns null as soon as it passes `limit` bytes. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > limit) {
      await response.body.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Gives each file URL one path under `files/`, keeps earlier paths, and splits paths that differ only by case. */
class FilePaths {
  private readonly owners = new Map<string, string>();
  private readonly earlier = new Map<string, string>();

  constructor(previous: Map<string, FileRecord> | null) {
    for (const record of previous?.values() ?? []) {
      if (record.file && isSafeFile(record.file)) {
        this.earlier.set(record.url, record.file);
        this.owners.set(record.file.toLowerCase(), record.url);
      }
    }
  }

  claim(url: URL): string {
    let file = this.earlier.get(url.href) ?? fileUrlToPath(url);
    const owner = this.owners.get(file.toLowerCase());
    if (owner !== undefined && owner !== url.href) {
      const slash = file.lastIndexOf("/");
      file = `${file.slice(0, slash + 1)}${shortHash(url.href)}-${file.slice(slash + 1)}`;
    }
    this.owners.set(file.toLowerCase(), url.href);
    return file;
  }
}
