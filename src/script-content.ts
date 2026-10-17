import { DOCUMENT_EXTENSIONS } from "./found-files.ts";
import type { SavedPage, SiteData } from "./site-data.ts";
import { fileExtension, isSameSite, normalizeUrl } from "./urls.ts";

// Widgets known to load meeting listings, calendars, or documents with JavaScript.
const WIDGET_VENDORS: [hostSuffix: string, vendor: string][] = [
  ["heygov.com", "HeyGov"], ["civicplus.com", "CivicPlus"], ["civicengage.com", "CivicPlus"],
  ["civicclerk.com", "CivicClerk"], ["granicus.com", "Granicus"], ["legistar.com", "Legistar"],
  ["boarddocs.com", "BoardDocs"], ["iqm2.com", "iCompass"], ["municode.com", "Municode"],
  ["novusagenda.com", "NovusAGENDA"], ["primegov.com", "PrimeGov"], ["escribemeetings.com", "eSCRIBE"],
];
const PLACEHOLDER = /^(loading|please wait)\b|\bloading\b.{0,60}(\.\.\.|…)|\b(enable|requires?) javascript\b/i;
// A signal or file on at least this share of pages comes from the site template.
const TEMPLATE_SHARE = 0.5;
const TEMPLATE_MIN_PAGES = 3;

export interface ScriptContentReport {
  rendered: boolean;
  browser: string | null;
  /** Signals on most pages, such as a widget script in the site template. Listed once. */
  siteWide: string[];
  /** Links and files render found on most pages, such as a widget's own button. Counted, not listed per page. */
  template: { links: number; files: number };
  pages: {
    url: string;
    signals: string[];
    render: {
      ok: boolean; error: string | null; settled: boolean;
      /** Files render found that the page's HTML did not link and the template does not share. */
      files: number;
      /** Links render found that the page's HTML did not have and the template does not share. */
      newLinks: number;
      apiCalls: { url: string; files: number }[];
    } | null;
  }[];
  /** Files render found that the server HTML did not link, across all pages. */
  totals: { files: number; documents: number; byExtension: Record<string, number>; byHost: Record<string, number> };
}

/** Finds pages that load content with JavaScript, and summarizes what render found on them. */
export function summarizeScriptContent(data: SiteData): ScriptContentReport {
  const { pages } = data;
  const threshold = Math.max(TEMPLATE_MIN_PAGES, Math.ceil(pages.length * TEMPLATE_SHARE));
  const signals = new Map(pages.map((page) => [page, signalsFor(page, data.manifest.site)]));
  const siteWide = sharedBy(pages.map((page) => signals.get(page) ?? []), threshold);
  const renderFiles = new Map(pages.map((page) => [page, newRenderFiles(page)]));
  const templateFiles = new Set(sharedBy(pages.map((page) => renderFiles.get(page) ?? []), threshold));
  const templateLinks = new Set(sharedBy(pages.map((page) => page.renderOnlyLinks), threshold));

  const report: ScriptContentReport = {
    rendered: data.manifest.render?.enabled ?? false,
    browser: data.manifest.render?.browser ?? null,
    siteWide: [...siteWide].sort(),
    template: { links: templateLinks.size, files: templateFiles.size },
    pages: [],
    totals: { files: 0, documents: 0, byExtension: {}, byHost: {} },
  };

  for (const page of pages) {
    const own = (signals.get(page) ?? []).filter((signal) => !siteWide.includes(signal));
    const render = page.render;
    const files = new Set((renderFiles.get(page) ?? []).filter((url) => !templateFiles.has(url)));
    const newLinks = page.renderOnlyLinks.filter((url) => !templateLinks.has(url));
    const findings = render && (files.size > 0 || newLinks.length > 0 || !render.ok);
    if (own.length === 0 && !findings) continue;
    report.pages.push({
      url: page.url.href,
      signals: own,
      render: render && {
        ok: render.ok, error: render.error ?? null, settled: render.settled, files: files.size,
        newLinks: newLinks.length,
        apiCalls: callsNaming(render.files.filter((file) => files.has(file.url))),
      },
    });
  }

  const allFiles = new Set(pages.flatMap((page) => renderFiles.get(page) ?? []));
  for (const href of allFiles) {
    const url = new URL(href);
    const extension = fileExtension(url.pathname) ?? "(none)";
    report.totals.files++;
    if (DOCUMENT_EXTENSIONS.has(extension)) report.totals.documents++;
    report.totals.byExtension[extension] = (report.totals.byExtension[extension] ?? 0) + 1;
    report.totals.byHost[url.host] = (report.totals.byHost[url.host] ?? 0) + 1;
  }
  return report;
}

/** Reasons to think a page loads content after it arrives. Reads only the saved HTML. */
export function signalsFor(page: SavedPage, site: string): string[] {
  const found = new Set<string>();
  const placeholder = page.ownBlocks.find((block) => PLACEHOLDER.test(block));
  if (placeholder) found.add(`Loading text: "${placeholder.slice(0, 80)}"`);
  for (const src of page.analysis.scripts) {
    const url = normalizeUrl(src, page.url);
    const vendor = url ? vendorFor(url.hostname) : null;
    if (url && vendor) found.add(`Script from ${vendor} (${url.host})`);
  }
  for (const src of page.analysis.frameSrcs) {
    const url = normalizeUrl(src, page.url);
    if (url && !isSameSite(url, site)) found.add(`Frame from ${url.host}`);
  }
  for (const href of page.analysis.inlineApiUrls) {
    const url = normalizeUrl(href);
    if (url && !isSameSite(url, site)) found.add(`Inline script names API host ${url.host}`);
  }
  return [...found];
}

function vendorFor(hostname: string): string | null {
  const host = hostname.toLowerCase();
  return WIDGET_VENDORS.find(([suffix]) => host === suffix || host.endsWith(`.${suffix}`))?.[1] ?? null;
}

/** Files render found on a page that its server HTML did not link. */
function newRenderFiles(page: SavedPage): string[] {
  if (!page.render) return [];
  const base = (page.analysis.base !== null ? normalizeUrl(page.analysis.base, page.url) : null) ?? page.url;
  const inHtml = new Set(page.analysis.links.flatMap((href) => normalizeUrl(href, base)?.href ?? []));
  return page.render.files.map((file) => file.url).filter((url) => !inHtml.has(url));
}

/** The API calls that named these files, with how many each named. */
function callsNaming(files: { via: string; source: string | null }[]): { url: string; files: number }[] {
  const counts = new Map<string, number>();
  for (const file of files) if (file.via === "api" && file.source) counts.set(file.source, (counts.get(file.source) ?? 0) + 1);
  return [...counts].map(([url, count]) => ({ url, files: count })).sort((a, b) => b.files - a.files || a.url.localeCompare(b.url));
}

/** Values that appear in at least `threshold` of the lists. */
function sharedBy(lists: string[][], threshold: number): string[] {
  const counts = new Map<string, number>();
  for (const list of lists) for (const value of new Set(list)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].filter(([, count]) => count >= threshold).map(([value]) => value);
}
