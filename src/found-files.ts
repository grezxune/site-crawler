import { fileExtension, normalizeUrl } from "./urls.ts";

/** File types render records when it finds them in a rendered page or in fetched JSON. */
export const DOCUMENT_EXTENSIONS = new Set([
  "csv", "doc", "docx", "odp", "ods", "odt", "pdf", "ppt", "pptx", "rtf", "txt", "xls", "xlsx", "zip",
]);
export const MEDIA_EXTENSIONS = new Set([
  "bmp", "gif", "jpeg", "jpg", "m4a", "mov", "mp3", "mp4", "mpeg", "png", "svg", "tif", "tiff", "wav", "webm", "webp",
]);

// Browser resource types render never lets leave the machine.
const BLOCKED_RESOURCE_TYPES = new Set(["Image", "Media", "Font"]);

// Walking JSON stops here, so a hostile response cannot exhaust memory or the stack.
const MAX_JSON_DEPTH = 64;
const MAX_JSON_STRINGS = 200_000;

/** True for a document or media file URL, the kind render records. */
export function isFoundFile(url: URL): boolean {
  const extension = fileExtension(url.pathname);
  return extension !== null && (DOCUMENT_EXTENSIONS.has(extension) || MEDIA_EXTENSIONS.has(extension));
}

/** True when the render browser must fail a request: images, fonts, media, and file links. */
export function blockedInRender(rawUrl: string, resourceType: string): boolean {
  if (BLOCKED_RESOURCE_TYPES.has(resourceType)) return true;
  const url = normalizeUrl(rawUrl);
  return url !== null && isFoundFile(url);
}

/**
 * Finds every http(s) URL in a JSON body, including URLs inside HTML snippets in string values.
 * Falls back to scanning the raw text when the body is not valid JSON.
 */
export function urlsInJson(text: string): string[] {
  const found = new Set<string>();
  const collect = (value: string) => {
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) {
      const url = normalizeUrl(match[0]);
      if (url) found.add(url.href);
    }
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    collect(text.replace(/\\\//g, "/"));
    return [...found];
  }

  let strings = 0;
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH || strings > MAX_JSON_STRINGS) return;
    if (typeof value === "string") {
      strings++;
      if (value.includes("http")) collect(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
    } else if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(parsed, 0);
  return [...found];
}

/** URLs in script source that point at an API host (`api.`) or path (`/api`). */
export function apiUrlsInScript(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.replace(/\\\//g, "/").matchAll(/https?:\/\/[^\s"'`<>\\)]+/g)) {
    const url = normalizeUrl(match[0]);
    if (url && (url.hostname.startsWith("api.") || /(^|\/)api(\/|$)/.test(url.pathname))) found.add(url.href);
  }
  return [...found];
}
