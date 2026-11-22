import { createHash } from "node:crypto";

// Links with these extensions are files, not pages, so the crawler never fetches them.
const FILE_EXTENSIONS = new Set([
  "7z", "avi", "bmp", "css", "csv", "doc", "docx", "eot", "exe", "gif", "gz", "ico",
  "jpeg", "jpg", "js", "json", "m4a", "mov", "mp3", "mp4", "mpeg", "odt", "otf", "pdf",
  "png", "ppt", "pptx", "rar", "rss", "rtf", "svg", "tar", "tif", "tiff", "ttf", "txt",
  "wav", "webm", "webp", "woff", "woff2", "xls", "xlsx", "xml", "zip",
]);

// Paths that hosting layers inject, such as Cloudflare's email obfuscation links.
const SKIPPED_PATH_PREFIXES = ["/cdn-cgi/"];

const PAGE_EXTENSIONS = new Set(["html", "htm"]);

/** The folder inside the output folder that holds each crawl's changes. No page is saved under it. */
export const CHANGES_DIR = "changes";

/** The folder inside the output folder that holds files saved with `--save-files`. No page is saved under it. */
export const FILES_DIR = "files";

// First path segments a page may not use, since the crawl writes its own folders there.
const RESERVED_DIRS = new Set([CHANGES_DIR, FILES_DIR]);

/** The site identity for a host: lowercase, with a leading `www.` removed. */
export function siteKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** The output folder name for a host, e.g. `example` for `www.example.org`. */
export function siteDirName(hostname: string): string {
  const labels = siteKey(hostname).split(".");
  if (labels.length > 1) labels.pop();
  return sanitizeSegment(labels.join("."));
}

/** Resolves a link against its page and returns a clean http(s) URL, or null if it is not one. */
export function normalizeUrl(raw: string, base?: string | URL): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.username = "";
  url.password = "";
  return url;
}

export function isSameSite(url: URL, site: string): boolean {
  return siteKey(url.host) === site;
}

/** True for paths a hosting layer injects rather than the site's own pages or files. */
export function isHostingPath(url: URL): boolean {
  return SKIPPED_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

/** True when a URL might be an HTML page worth fetching. */
export function looksLikePage(url: URL): boolean {
  if (isHostingPath(url)) return false;
  const extension = fileExtension(url.pathname);
  return extension === null || !FILE_EXTENSIONS.has(extension);
}

/** The key the crawler dedupes on. `/a` and `/a/` and `www.` variants count as one page. */
export function pageKey(url: URL): string {
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  return `${siteKey(url.host)}${path}${url.search}`;
}

/**
 * Maps a page URL to a relative file path inside the output folder.
 * Each page becomes `<path>/index.html` so a page and its child pages never collide.
 * Query strings add a short hash to the file name.
 */
export function urlToFilePath(url: URL): string {
  const segments = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => sanitizeSegment(safeDecode(segment)));

  let fileName = "index.html";
  const last = segments.at(-1);
  if (last !== undefined && PAGE_EXTENSIONS.has(fileExtension(last) ?? "")) {
    segments.pop();
    fileName = last;
  }
  // Lowercase, since `Changes/` and `changes/` are one folder on macOS.
  if (isReservedDir(segments[0])) segments[0] = `${segments[0]}_`;

  return [...segments, withQueryHash(fileName, url.search)].join("/");
}

/**
 * Maps a file URL, such as an image or a PDF, to a relative path under `files/` in the output folder.
 * The path mirrors the URL's path. Query strings add a short hash to the file name.
 */
export function fileUrlToPath(url: URL): string {
  const segments = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => sanitizeSegment(safeDecode(segment)));
  const fileName = segments.pop() ?? "_";
  return [FILES_DIR, ...segments, withQueryHash(fileName, url.search)].join("/");
}

/** True when a first path segment is a folder the crawl writes itself, such as `changes`. */
export function isReservedDir(segment: string | undefined): boolean {
  return segment !== undefined && RESERVED_DIRS.has(segment.toLowerCase());
}

/**
 * Removes the named query parameters from a URL. Sort and filter parameters such as `order` make
 * many URLs for one list, so stripping them folds those copies into one page.
 */
export function stripParams(url: URL, names: readonly string[]): URL {
  if (names.length === 0 || !url.search) return url;
  const stripped = new URL(url);
  for (const name of names) stripped.searchParams.delete(name);
  if (stripped.searchParams.size === 0) stripped.search = "";
  return stripped;
}

function withQueryHash(fileName: string, search: string): string {
  if (!search) return fileName;
  const dot = fileName.lastIndexOf(".");
  return dot > 0
    ? `${fileName.slice(0, dot)}.${shortHash(search)}${fileName.slice(dot)}`
    : `${fileName}.${shortHash(search)}`;
}

export function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

/** The lowercase extension of the last path segment, or null if it has none. */
export function fileExtension(path: string): string | null {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Keeps a path segment safe on disk: no separators, no `..`, no control characters. */
function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return /^\.+$/.test(cleaned) || cleaned === "" ? "_" : cleaned;
}
