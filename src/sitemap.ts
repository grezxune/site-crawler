import { decodeEntities } from "./html.ts";

const MAX_SITEMAPS = 50;
const TIMEOUT_MS = 20_000;

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export interface Sitemap {
  /** True when at least one sitemap loaded. */
  found: boolean;
  entries: SitemapEntry[];
}

/** Reads the `<url>` or `<sitemap>` entries from a sitemap or sitemap index. */
export function parseSitemap(xml: string): { isIndex: boolean; entries: SitemapEntry[] } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const entries: SitemapEntry[] = [];
  for (const match of xml.matchAll(/<(url|sitemap)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
    const body = match[2] ?? "";
    const loc = readTag(body, "loc");
    if (loc) entries.push({ loc, lastmod: readTag(body, "lastmod") });
  }
  return { isIndex, entries };
}

/** Loads sitemaps, following sitemap indexes, and returns every page entry they list. */
export async function loadSitemap(sitemapUrls: string[], userAgent: string): Promise<Sitemap> {
  const pending = [...sitemapUrls];
  const visited = new Set<string>();
  const sitemap: Sitemap = { found: false, entries: [] };

  while (pending.length > 0 && visited.size < MAX_SITEMAPS) {
    const sitemapUrl = pending.shift();
    if (sitemapUrl === undefined || visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);
    try {
      const response = await fetch(sitemapUrl, {
        headers: { "User-Agent": userAgent },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }
      const { isIndex, entries } = parseSitemap(await response.text());
      sitemap.found = true;
      if (isIndex) pending.push(...entries.map((entry) => entry.loc));
      else sitemap.entries.push(...entries);
    } catch {
      // A broken sitemap only means fewer seed URLs. Link discovery still runs.
    }
  }
  return sitemap;
}

function readTag(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?\\s*([^<\\]]+?)\\s*(?:\\]\\]>)?\\s*</${tag}>`, "i");
  const value = decodeEntities(pattern.exec(xml)?.[1] ?? "").trim();
  return value || null;
}
