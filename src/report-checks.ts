import { type LinkVerdict, NOT_CHECKED } from "./link-check.ts";
import type { PageRecord } from "./manifest.ts";
import type { Report } from "./report.ts";
import type { SavedPage, SiteData } from "./site-data.ts";
import { isSameSite, looksLikePage, normalizeUrl, pageKey } from "./urls.ts";

export const THIN_WORDS = 50;
export const STALE_DAYS = 730;
export const MAX_DEPTH = 3;
export const LONG_TITLE = 65;
export const PLACEHOLDER =
  /lorem ipsum|coming soon|under construction|page not found|file not found|content goes here|placeholder/i;

type Url = string;

export function findStale(data: SiteData, crawledAt: Date): Report["stale"] {
  const lastmods = new Map(data.manifest.sitemap.entries.flatMap((e) => (e.lastmod ? toKey(e.loc).map((k) => [k, e.lastmod] as const) : [])));
  const cutoff = crawledAt.getTime() - STALE_DAYS * 86_400_000;
  return data.pages
    .flatMap((p) => {
      const fromSitemap = lastmods.get(p.key);
      const updated = fromSitemap ?? p.record.lastModified;
      const time = updated ? Date.parse(updated) : NaN;
      if (!updated || Number.isNaN(time) || time >= cutoff) return [];
      return [{ url: p.url.href, updated: new Date(time).toISOString().slice(0, 10), source: fromSitemap ? "sitemap" as const : "last-modified" as const }];
    })
    .sort((a, b) => a.updated.localeCompare(b.updated));
}

/** Breadth-first clicks from the start page. Pages no link path reaches count as unreachable. */
export function clickDepth(data: SiteData): Report["depth"] {
  const byKey = new Map(data.pages.map((p) => [p.key, p]));
  const depths = new Map<string, number>([[pageKey(data.start), 0]]);
  const queue = [pageKey(data.start)];
  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    for (const next of byKey.get(key)?.outLinks ?? []) {
      if (depths.has(next) || !byKey.has(next)) continue;
      depths.set(next, (depths.get(key) ?? 0) + 1);
      queue.push(next);
    }
  }
  const histogram: Record<string, number> = {};
  const deep: { url: Url; depth: number }[] = [];
  for (const page of data.pages) {
    const depth = depths.get(page.key);
    const bucket = depth === undefined ? "unreachable" : String(depth);
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
    if (depth !== undefined && depth > MAX_DEPTH) deep.push({ url: page.url.href, depth });
  }
  return { histogram, deep: deep.sort((a, b) => b.depth - a.depth) };
}

export function sitemapProblem(data: SiteData, loc: string): { url: Url; problem: string }[] {
  const url = normalizeUrl(loc);
  if (!url) return [{ url: loc, problem: "not a valid http(s) URL" }];
  if (!isSameSite(url, data.manifest.site)) return [{ url: loc, problem: "points to another host" }];
  if (!looksLikePage(url)) return [{ url: loc, problem: "is a file, not a page" }];
  if (data.manifest.robots.blocked.some((b) => toKey(b)[0] === pageKey(url))) return [{ url: loc, problem: "blocked by robots.txt" }];
  const record: PageRecord | undefined = data.recordsByKey.get(pageKey(url));
  if (!record) return [{ url: loc, problem: "not fetched (page limit reached)" }];
  if (record.outcome !== "saved" && record.outcome !== "duplicate") {
    return [{ url: loc, problem: `${record.outcome}${record.status ? ` (${record.status})` : ""}` }];
  }
  const redirected = record.url === url.href ? record.finalUrl !== url.href : pageKey(new URL(record.finalUrl ?? url)) !== pageKey(url);
  if (record.finalUrl && redirected) return [{ url: loc, problem: `redirects to ${record.finalUrl}` }];
  return [];
}

export function summarizeFiles(data: SiteData): Report["files"] {
  const files = [...data.files.values()];
  const count = (pick: (f: (typeof files)[number]) => string) =>
    Object.fromEntries(Object.entries(Object.groupBy(files, pick)).map(([k, v]) => [k, v?.length ?? 0]).sort((a, b) => Number(b[1]) - Number(a[1])));
  return {
    total: files.length,
    byExtension: count((f) => f.extension || "(none)"),
    byHost: count((f) => f.host),
    list: files.map((f) => ({ url: f.url, linkedFrom: [...f.linkedFrom].sort() })).sort((a, b) => a.url.localeCompare(b.url)),
  };
}

export function toKey(raw: string): string[] {
  const url = normalizeUrl(raw);
  return url ? [pageKey(url)] : [];
}

export function groupBy(pages: SavedPage[], key: (p: SavedPage) => string): SavedPage[][] {
  return Object.values(Object.groupBy(pages, key)).flatMap((g) => (g && g.length > 1 ? [g] : []));
}

export function topBy(pages: SavedPage[], value: (p: SavedPage) => number | null, count = 10): [SavedPage, number][] {
  return pages
    .flatMap((p): [SavedPage, number][] => { const v = value(p); return v === null ? [] : [[p, v]]; })
    .sort((a, b) => b[1] - a[1])
    .slice(0, count);
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const VERDICT_ORDER: LinkVerdict[] = ["broken", "failed", "blocked", "ok"];

/** Joins link check results with the pages that link to each URL. */
export function summarizeLinkChecks(data: SiteData): Report["linkChecks"] {
  const result = data.manifest.linkChecks ?? NOT_CHECKED;
  const counts: Record<LinkVerdict, number> = { ok: 0, broken: 0, blocked: 0, failed: 0 };
  for (const check of result.checks) counts[check.verdict]++;
  const problems = result.checks
    .filter((check) => check.verdict !== "ok")
    .map((check) => ({
      url: check.url,
      status: check.status,
      verdict: check.verdict,
      error: check.error ?? null,
      kind: data.files.has(check.url) ? ("file" as const) : ("page" as const),
      linkedFrom: [...(data.outbound.get(check.url) ?? [])].sort(),
    }))
    .sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) || a.url.localeCompare(b.url));
  return { checked: result.checked, total: result.checks.length, skipped: result.skipped, counts, problems };
}
