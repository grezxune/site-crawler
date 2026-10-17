import type { LinkVerdict } from "./link-check.ts";
import {
  clickDepth, findStale, groupBy, LONG_TITLE, PLACEHOLDER, sitemapProblem, summarizeFiles, summarizeLinkChecks,
  THIN_WORDS, toKey, topBy, unique,
} from "./report-checks.ts";
import { type ScriptContentReport, summarizeScriptContent } from "./script-content.ts";
import type { SavedPage, SiteData } from "./site-data.ts";
import { normalizeUrl, pageKey } from "./urls.ts";

type Url = string;
interface Linked { url: Url; linkedFrom: Url[] }

export interface Report {
  site: string;
  startUrl: Url;
  crawledAt: string;
  durationMs: number;
  status: {
    homepage: { status: number | null; ms: number | null; finalUrl: Url | null };
    https: boolean; hsts: boolean; server: string | null; generators: string[];
    robotsTxt: boolean | null; sitemap: boolean | null; sitemapUrls: number;
    blockedByRobots: Url[]; hitPageLimit: boolean;
  };
  totals: {
    fetched: number; saved: number; htmlBytes: number; averageMs: number; medianMs: number;
    outcomes: Record<string, number>;
  };
  broken: (Linked & { status: number | null; error: string | null; inSitemap: boolean })[];
  redirects: (Linked & { finalUrl: Url; offSite: boolean; trailingSlashOnly: boolean; inSitemap: boolean })[];
  thin: { url: Url; words: number; frames: number; files: number }[];
  /** Pages that are both thin and orphaned: the strongest candidates for removal. */
  likelyUseless: Url[];
  duplicates: { words: number; urls: Url[] }[];
  placeholders: { url: Url; match: string }[];
  orphans: Url[];
  stale: { url: Url; updated: string; source: "sitemap" | "last-modified" }[];
  depth: { histogram: Record<string, number>; deep: { url: Url; depth: number }[] };
  seo: {
    missingTitle: Url[]; longTitles: { url: Url; title: string }[];
    duplicateTitles: { title: string; urls: Url[] }[];
    missingDescription: Url[]; duplicateDescriptions: { description: string; urls: Url[] }[];
    missingH1: Url[]; multipleH1: { url: Url; count: number }[];
    noindex: Url[]; canonicalElsewhere: { url: Url; canonical: Url }[]; missingLang: Url[];
  };
  accessibility: {
    images: number; imagesMissingAlt: number;
    pagesMissingAlt: { url: Url; missing: number; images: number }[];
    deadLinks: { url: Url; count: number }[];
  };
  mixedContent: { url: Url; resources: Url[] }[];
  sitemapCoverage: { notInSitemap: Url[]; problems: { url: Url; problem: string }[] };
  performance: { slowest: { url: Url; ms: number }[]; largest: { url: Url; bytes: number }[] };
  files: { total: number; byExtension: Record<string, number>; byHost: Record<string, number>; list: Linked[] };
  external: { host: string; links: number; pages: number }[];
  /** Pages that load content with JavaScript, and what render found on them. */
  scriptContent: ScriptContentReport;
  /** Status of linked files and external pages, when the crawl ran with `--check-links`. */
  linkChecks: {
    checked: boolean; total: number; skipped: number; counts: Record<LinkVerdict, number>;
    problems: (Linked & { status: number | null; verdict: LinkVerdict; error: string | null; kind: "file" | "page" })[];
  };
}

/** Runs every check over a crawl and returns the findings. */
export function buildReport(data: SiteData): Report {
  const { manifest, pages } = data;
  const crawledAt = new Date(manifest.crawledAt);
  const sitemapKeys = new Set(manifest.sitemap.entries.flatMap((e) => toKey(e.loc)));
  const sitemapUrls = new Set(manifest.sitemap.entries.flatMap((e) => normalizeUrl(e.loc)?.href ?? []));
  const isOrphan = (p: SavedPage) => p.key !== pageKey(data.start) && linkedFrom(p.key).length === 0;
  const thin = pages.filter((p) => p.uniqueWords < THIN_WORDS).sort((a, b) => a.uniqueWords - b.uniqueWords);
  const linkedFrom = (key: string) => [...(data.inbound.get(key) ?? [])].sort();
  const byUrl = (a: { url: Url }, b: { url: Url }) => a.url.localeCompare(b.url);
  const timed = pages.map((p) => p.record.ms ?? 0).sort((a, b) => a - b);
  const homeRecord = data.recordsByKey.get(pageKey(data.start));
  const outcomes: Record<string, number> = {};
  for (const record of manifest.pages) outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;

  return {
    site: manifest.site,
    startUrl: manifest.startUrl,
    crawledAt: manifest.crawledAt,
    durationMs: manifest.durationMs,
    status: {
      homepage: { status: homeRecord?.status ?? null, ms: homeRecord?.ms ?? null, finalUrl: homeRecord?.finalUrl ?? null },
      https: (homeRecord?.finalUrl ?? manifest.startUrl).startsWith("https:"),
      hsts: "strict-transport-security" in manifest.startHeaders,
      server: manifest.startHeaders.server ?? null,
      generators: unique(pages.flatMap((p) => p.analysis.generator ?? [])),
      robotsTxt: manifest.robots.checked ? manifest.robots.found : null,
      sitemap: manifest.sitemap.checked ? manifest.sitemap.found : null,
      sitemapUrls: manifest.sitemap.entries.length,
      blockedByRobots: manifest.robots.blocked,
      hitPageLimit: manifest.hitPageLimit,
    },
    totals: {
      fetched: manifest.pages.length,
      saved: pages.length,
      htmlBytes: pages.reduce((sum, p) => sum + (p.record.bytes ?? 0), 0),
      averageMs: timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : 0,
      medianMs: timed[Math.floor(timed.length / 2)] ?? 0,
      outcomes,
    },
    broken: manifest.pages
      .filter((r) => r.outcome === "http-error" || r.outcome === "failed")
      .map((r) => ({
        url: r.url, status: r.status, error: r.error ?? null,
        linkedFrom: linkedFrom(pageKey(new URL(r.url))), inSitemap: sitemapKeys.has(pageKey(new URL(r.url))),
      }))
      .sort(byUrl),
    redirects: manifest.pages
      .filter((r) => r.finalUrl !== null && r.finalUrl !== r.url)
      .map((r) => ({
        url: r.url, finalUrl: r.finalUrl ?? "", offSite: r.outcome === "offsite-redirect",
        trailingSlashOnly: r.finalUrl === `${r.url}/`, inSitemap: sitemapUrls.has(r.url),
        linkedFrom: [...(data.inboundExact.get(r.url) ?? [])].sort(),
      }))
      .sort((a, b) => b.linkedFrom.length - a.linkedFrom.length || a.url.localeCompare(b.url)),
    thin: thin.map((p) => ({ url: p.url.href, words: p.uniqueWords, frames: p.analysis.frames, files: p.fileLinks })),
    likelyUseless: thin.filter(isOrphan).map((p) => p.url.href),
    duplicates: groupBy(pages.filter((p) => p.contentHash), (p) => p.contentHash).map((group) => ({
      words: group[0]?.uniqueWords ?? 0,
      urls: group.map((p) => p.url.href),
    })),
    placeholders: pages.flatMap((p) => {
      const match = PLACEHOLDER.exec([p.analysis.title ?? "", ...p.analysis.textBlocks].join("\n"));
      return match ? [{ url: p.url.href, match: match[0] }] : [];
    }),
    orphans: pages.filter(isOrphan).map((p) => p.url.href),
    stale: findStale(data, crawledAt),
    depth: clickDepth(data),
    seo: {
      missingTitle: pages.filter((p) => !p.analysis.title).map((p) => p.url.href),
      longTitles: pages
        .filter((p) => (p.analysis.title?.length ?? 0) > LONG_TITLE)
        .map((p) => ({ url: p.url.href, title: p.analysis.title ?? "" })),
      duplicateTitles: groupBy(pages.filter((p) => p.analysis.title), (p) => p.analysis.title ?? "").map((g) => ({
        title: g[0]?.analysis.title ?? "", urls: g.map((p) => p.url.href),
      })),
      missingDescription: pages.filter((p) => !p.analysis.metaDescription).map((p) => p.url.href),
      duplicateDescriptions: groupBy(pages.filter((p) => p.analysis.metaDescription), (p) => p.analysis.metaDescription ?? "")
        .map((g) => ({ description: g[0]?.analysis.metaDescription ?? "", urls: g.map((p) => p.url.href) })),
      missingH1: pages.filter((p) => p.analysis.h1.length === 0).map((p) => p.url.href),
      multipleH1: pages.filter((p) => p.analysis.h1.length > 1).map((p) => ({ url: p.url.href, count: p.analysis.h1.length })),
      noindex: pages.filter((p) => /noindex/i.test(p.analysis.metaRobots ?? "")).map((p) => p.url.href),
      canonicalElsewhere: pages.flatMap((p) => {
        const canonical = p.analysis.canonical ? normalizeUrl(p.analysis.canonical, p.url) : null;
        return canonical && pageKey(canonical) !== p.key ? [{ url: p.url.href, canonical: canonical.href }] : [];
      }),
      missingLang: pages.filter((p) => !p.analysis.lang).map((p) => p.url.href),
    },
    accessibility: {
      images: pages.reduce((sum, p) => sum + p.analysis.images, 0),
      imagesMissingAlt: pages.reduce((sum, p) => sum + p.analysis.imagesMissingAlt, 0),
      pagesMissingAlt: pages
        .filter((p) => p.analysis.imagesMissingAlt > 0)
        .map((p) => ({ url: p.url.href, missing: p.analysis.imagesMissingAlt, images: p.analysis.images }))
        .sort((a, b) => b.missing - a.missing),
      deadLinks: pages
        .filter((p) => p.analysis.deadLinks > 0)
        .map((p) => ({ url: p.url.href, count: p.analysis.deadLinks }))
        .sort((a, b) => b.count - a.count),
    },
    mixedContent: pages.flatMap((p) => {
      if (p.url.protocol !== "https:") return [];
      const insecure = unique(p.analysis.resources.flatMap((r) => normalizeUrl(r, p.url)?.href ?? []))
        .filter((r) => r.startsWith("http:"));
      return insecure.length ? [{ url: p.url.href, resources: insecure }] : [];
    }),
    sitemapCoverage: {
      notInSitemap: manifest.sitemap.found ? pages.filter((p) => !sitemapKeys.has(p.key)).map((p) => p.url.href) : [],
      problems: manifest.sitemap.entries.flatMap((e) => sitemapProblem(data, e.loc)),
    },
    performance: {
      slowest: topBy(pages, (p) => p.record.ms).map(([p, ms]) => ({ url: p.url.href, ms })),
      largest: topBy(pages, (p) => p.record.bytes).map(([p, bytes]) => ({ url: p.url.href, bytes })),
    },
    files: summarizeFiles(data),
    external: [...data.external]
      .map(([host, e]) => ({ host, links: e.links, pages: e.linkedFrom.size }))
      .sort((a, b) => b.pages - a.pages || a.host.localeCompare(b.host)),
    linkChecks: summarizeLinkChecks(data),
    scriptContent: summarizeScriptContent(data),
  };
}
