import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzePage, type PageAnalysis } from "./html.ts";
import { type Manifest, type PageRecord, readManifest } from "./manifest.ts";
import type { RenderRecord } from "./render.ts";
import { fileExtension, isHostingPath, isSameSite, looksLikePage, normalizeUrl, pageKey, shortHash } from "./urls.ts";

// Text that appears on at least this share of pages is template text: header, menu, footer.
const TEMPLATE_SHARE = 0.5;
const TEMPLATE_MIN_PAGES = 3;

export interface SavedPage {
  record: PageRecord;
  /** The URL the page was served from, after redirects. */
  url: URL;
  key: string;
  analysis: PageAnalysis;
  /** Words on the page outside the shared template text. */
  uniqueWords: number;
  /** Hash of the page's own text, for finding duplicate pages. Empty when it has none. */
  contentHash: string;
  /** Page keys this page links to on the same site, itself excluded. */
  outLinks: Set<string>;
  /** Distinct files such as PDFs this page links to, in its HTML or found by render. */
  fileLinks: number;
  /** Text blocks outside the shared template text. */
  ownBlocks: string[];
  render: RenderRecord | null;
  /** Links in the rendered page that the server HTML did not have. */
  renderOnlyLinks: string[];
}

export interface LinkedFile {
  url: string;
  extension: string;
  host: string;
  onSite: boolean;
  linkedFrom: Set<string>;
  /** `html` when a saved page links to it, `render` when the render browser found it. */
  foundBy: Set<"html" | "render">;
}

export interface SiteData {
  manifest: Manifest;
  start: URL;
  pages: SavedPage[];
  /** Every fetched record, keyed by both its requested and final page key. */
  recordsByKey: Map<string, PageRecord>;
  /** Page key to the URLs of pages that link to it. */
  inbound: Map<string, Set<string>>;
  /** Exact link target to the URLs of pages that link to it. */
  inboundExact: Map<string, Set<string>>;
  /** Links to files such as PDFs and images, on this site or elsewhere. */
  files: Map<string, LinkedFile>;
  /** Other hosts linked as pages, with the pages that link to them. */
  external: Map<string, { links: number; linkedFrom: Set<string> }>;
  /** Each file or external page URL, with the pages that link to it. Matches the link check's URLs. */
  outbound: Map<string, Set<string>>;
}

/** Loads a crawl's manifest and saved HTML, and builds the link graph the report needs. */
export async function loadSiteData(outDir: string): Promise<SiteData> {
  const manifest = await readManifest(outDir);
  const start = new URL(manifest.startUrl);
  const recordsByKey = new Map<string, PageRecord>();
  for (const record of manifest.pages) {
    recordsByKey.set(pageKey(new URL(record.url)), record);
    if (record.finalUrl) recordsByKey.set(pageKey(new URL(record.finalUrl)), record);
  }

  const data: SiteData = {
    manifest, start, pages: [], recordsByKey,
    inbound: new Map(), inboundExact: new Map(), files: new Map(), external: new Map(), outbound: new Map(),
  };

  for (const record of manifest.pages) {
    if (record.outcome !== "saved" || !record.file) continue;
    const url = new URL(record.finalUrl ?? record.url);
    const analysis = await analyzePage(await readFile(join(outDir, record.file), "utf8"));
    const page: SavedPage = {
      record, url, key: pageKey(url), analysis, uniqueWords: 0, contentHash: "", outLinks: new Set(), fileLinks: 0,
      ownBlocks: [], render: record.render ?? null, renderOnlyLinks: [],
    };
    const base = (analysis.base !== null ? normalizeUrl(analysis.base, url) : null) ?? url;
    const htmlLinks = analysis.links.flatMap((href) => normalizeUrl(href, base) ?? []);
    const fileUrls = new Set<string>();
    addLinks(data, page, htmlLinks, "html", fileUrls);
    if (page.render) {
      const inHtml = new Set(htmlLinks.map((link) => link.href));
      // The browser resolves `href="#"` to the page itself. The HTML analysis drops those, so render does too.
      page.renderOnlyLinks = page.render.links.filter((href) => !inHtml.has(href) && pageKey(new URL(href)) !== page.key);
      // Only what the server HTML lacked, so links in both are not counted twice.
      const found = [...page.renderOnlyLinks, ...page.render.files.map((file) => file.url)];
      addLinks(data, page, found.flatMap((href) => normalizeUrl(href) ?? []), "render", fileUrls);
    }
    page.fileLinks = fileUrls.size;
    data.pages.push(page);
  }
  measureUniqueText(data.pages);
  return data;
}

function addLinks(data: SiteData, page: SavedPage, links: URL[], foundBy: "html" | "render", fileUrls: Set<string>): void {
  const from = page.url.href;
  for (const link of links) {
    if (isHostingPath(link)) continue;
    const onSite = isSameSite(link, data.manifest.site);
    if (!looksLikePage(link)) {
      const file = data.files.get(link.href) ?? {
        url: link.href, extension: fileExtension(link.pathname) ?? "", host: link.host, onSite,
        linkedFrom: new Set<string>(), foundBy: new Set<"html" | "render">(),
      };
      file.linkedFrom.add(from);
      file.foundBy.add(foundBy);
      data.files.set(link.href, file);
      fileUrls.add(link.href);
      addTo(data.outbound, link.href, from);
    } else if (!onSite) {
      const host = link.host.toLowerCase();
      const entry = data.external.get(host) ?? { links: 0, linkedFrom: new Set<string>() };
      entry.links++;
      entry.linkedFrom.add(from);
      data.external.set(host, entry);
      addTo(data.outbound, link.href, from);
    } else {
      const key = pageKey(link);
      if (key === page.key) continue;
      page.outLinks.add(key);
      addTo(data.inbound, key, from);
      addTo(data.inboundExact, link.href, from);
    }
  }
}

/** Splits each page's text into template text and its own text, then counts and hashes its own. */
function measureUniqueText(pages: SavedPage[]): void {
  const pageCounts = new Map<string, number>();
  for (const page of pages) {
    for (const block of new Set(page.analysis.textBlocks)) pageCounts.set(block, (pageCounts.get(block) ?? 0) + 1);
  }
  const threshold = Math.max(TEMPLATE_MIN_PAGES, Math.ceil(pages.length * TEMPLATE_SHARE));
  for (const page of pages) {
    const own = page.analysis.textBlocks.filter((block) => (pageCounts.get(block) ?? 0) < threshold);
    page.ownBlocks = own;
    page.uniqueWords = own.reduce((sum, block) => sum + countWords(block), 0);
    page.contentHash = page.uniqueWords > 0 ? shortHash(own.join("\n")) : "";
  }
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}
