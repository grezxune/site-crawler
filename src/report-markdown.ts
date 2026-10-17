import { capped, kb, list, table, yesNo } from "./markdown.ts";
import { linkCheckSection, scriptContentSection } from "./report-sections.ts";
import type { Report } from "./report.ts";
import { MAX_DEPTH, STALE_DAYS, THIN_WORDS } from "./report-checks.ts";

/** Renders the report as Markdown for a person to read. Full lists stay in report.json. */
export function renderMarkdown(report: Report): string {
  const origin = new URL(report.startUrl).origin;
  const path = (url: string) => (url.startsWith(origin) ? url.slice(origin.length) || "/" : url);
  const paths = (urls: string[], max: number) => list(urls.map(path), max);
  const { status, totals, seo, accessibility: a11y, sitemapCoverage: coverage, linkChecks: checks } = report;
  const out: string[] = [];
  const add = (...blocks: string[]) => out.push(...blocks.flatMap((b) => [b.trimEnd(), ""]));
  const heading = (title: string, intro: string, level = 2) => add(`${"#".repeat(level)} ${title}`, intro);
  const unverified = (kind: "file" | "page") => checks.checked
    ? "Their status is under [Broken files and external links](#broken-files-and-external-links)."
    : `They were not requested, so the report cannot tell if they work. Run with \`--check-links\` to check ${kind === "file" ? "them" : "each link"}.`;
  const rowsOrNone = <T>(rows: T[], render: (rows: T[]) => string) => add(rows.length ? capped(rows, render) : "None found.");

  const duration = (report.durationMs / 1000).toFixed(1);
  add(`# ${report.site} site report`);
  add(`Crawled ${report.startUrl} on ${report.crawledAt.slice(0, 16).replace("T", " ")} UTC in ${duration}s.`);

  const robots = status.robotsTxt === null ? "Not checked" : status.robotsTxt ? `Found. ${status.blockedByRobots.length} URLs blocked` : "Missing";
  const sitemap = status.sitemap === null ? "Not checked" : status.sitemap ? `Found. ${status.sitemapUrls} URLs` : "Missing";
  add("## Status", table(["Check", "Result"], [
    ["Homepage", status.homepage.status ? `${status.homepage.status} in ${status.homepage.ms} ms` : "Not reachable"],
    ["HTTPS", `${yesNo(status.https)}. HSTS header: ${yesNo(status.hsts).toLowerCase()}`],
    ["Server", status.server ?? "Not reported"],
    ["Platform", status.generators.join(", ") || "Not reported"],
    ["robots.txt", robots],
    ["Sitemap", sitemap],
    ["Pages saved", `${totals.saved} of ${totals.fetched} URLs fetched`],
    ["HTML size", `${kb(totals.htmlBytes)} total`],
    ["Response time", `${totals.averageMs} ms average, ${totals.medianMs} ms median`],
    ...(status.hitPageLimit ? [["Page limit", "Reached. Some pages were not crawled."]] : []),
  ]));

  const findings: [string, string, number | string][] = [
    ["Broken pages", "broken-pages", report.broken.length],
    ["Broken files and external links", "broken-files-and-external-links",
      checks.checked ? checks.counts.broken + checks.counts.failed : "not checked"],
    ["Pages with script-loaded content", "content-loaded-by-javascript", report.scriptContent.pages.length],
    ["URLs that redirect", "redirects", report.redirects.length],
    ["Likely useless pages", "possibly-useless-pages", report.likelyUseless.length],
    [`Thin pages (under ${THIN_WORDS} words)`, "thin-pages", report.thin.length],
    ["Duplicate page groups", "duplicate-pages", report.duplicates.length],
    ["Placeholder text", "placeholder-text", report.placeholders.length],
    ["Orphan pages", "orphan-pages", report.orphans.length],
    [`Stale pages (over ${STALE_DAYS / 365} years)`, "stale-pages", report.stale.length],
    [`Pages over ${MAX_DEPTH} clicks deep`, "click-depth", report.depth.deep.length],
    ["Pages with search metadata issues", "search-metadata", seoPages(report)],
    ["Images missing alt text", "accessibility", a11y.imagesMissingAlt],
    ["Pages with mixed content", "mixed-content", report.mixedContent.length],
    ["Sitemap problems", "sitemap-coverage", coverage.problems.length + coverage.notInSitemap.length],
  ];
  add("## Findings", table(["Check", "Count"], findings.map(([label, anchor, n]) => [`[${label}](#${anchor})`, String(n)])));

  heading("Broken pages", "Pages that returned an HTTP error or could not be fetched.");
  rowsOrNone(report.broken, (rows) => table(["URL", "Status", "Linked from", "In sitemap"], rows.map((b) => [
    path(b.url), b.status ? String(b.status) : (b.error ?? "failed"),
    b.linkedFrom.length ? paths(b.linkedFrom, 3) : "nothing crawled", yesNo(b.inSitemap),
  ])));

  add(...linkCheckSection(report, path));
  add(...scriptContentSection(report, path));

  const slashOnly = report.redirects.filter((r) => r.trailingSlashOnly).length;
  heading("Redirects", "URLs that redirect. Each one costs visitors an extra round trip. Point links at the final URL.");
  if (slashOnly > 1) {
    add(`${slashOnly} of ${report.redirects.length} redirects only add a trailing slash. The site links to the form without the slash, so most clicks start with a redirect.`);
  }
  rowsOrNone(report.redirects, (rows) => table(["URL", "Redirects to", "Pages linking to it", "In sitemap"], rows.map((r) => [
    path(r.url), path(r.finalUrl) + (r.offSite ? " (other site)" : ""), String(r.linkedFrom.length), yesNo(r.inSitemap),
  ])));

  heading("Possibly useless pages", report.likelyUseless.length
    ? `Strongest candidates, both thin and linked from nowhere: ${paths(report.likelyUseless, 10)}.`
    : "No page is both thin and linked from nowhere.");
  heading("Thin pages", `Pages with fewer than ${THIN_WORDS} words of their own. Text shared by most pages, such as the menu and footer, does not count. A page that embeds a frame or mostly links to a file may be fine.`, 3);
  rowsOrNone(report.thin, (rows) => table(["URL", "Own words", "Frames", "Files linked"], rows.map((t) => [
    path(t.url), String(t.words), String(t.frames), String(t.files),
  ])));
  heading("Duplicate pages", "Groups of pages whose own text is identical. Keep one and redirect the others.", 3);
  rowsOrNone(report.duplicates, (rows) => table(["Pages", "Own words"], rows.map((d) => [paths(d.urls, 10), String(d.words)])));
  heading("Placeholder text", "Pages that contain placeholder or error wording but returned 200.", 3);
  rowsOrNone(report.placeholders, (rows) => table(["URL", "Matched"], rows.map((p) => [path(p.url), p.match])));
  heading("Orphan pages", "Pages no crawled page links to. The crawl found them only in the sitemap.", 3);
  rowsOrNone(report.orphans, (rows) => rows.map((u) => `- ${path(u)}`).join("\n"));
  heading("Stale pages", `Pages last updated more than ${STALE_DAYS / 365} years before this crawl, by sitemap lastmod or the Last-Modified header.`, 3);
  rowsOrNone(report.stale, (rows) => table(["URL", "Last updated", "Source"], rows.map((s) => [path(s.url), s.updated, s.source])));

  heading("Click depth", `Clicks from the homepage to each saved page. Pages over ${MAX_DEPTH} clicks deep are hard to find.`);
  const depthRows = Object.entries(report.depth.histogram).sort(([a], [b]) => depthOrder(a) - depthOrder(b));
  add(table(["Clicks", "Pages"], depthRows.map(([bucket, count]) => [bucket, String(count)])));
  if (report.depth.deep.length) add(capped(report.depth.deep, (rows) => table(["URL", "Clicks"], rows.map((d) => [path(d.url), String(d.depth)]))));

  const seoRows: [string, string[]][] = [
    ["Missing `<title>`", seo.missingTitle],
    ["Title over 65 characters", seo.longTitles.map((t) => t.url)],
    ["Shared title", seo.duplicateTitles.flatMap((d) => d.urls)],
    ["Missing meta description", seo.missingDescription],
    ["Shared meta description", seo.duplicateDescriptions.flatMap((d) => d.urls)],
    ["No `<h1>`", seo.missingH1],
    ["More than one `<h1>`", seo.multipleH1.map((m) => m.url)],
    ["Marked noindex", seo.noindex],
    ["Canonical points to another page", seo.canonicalElsewhere.map((c) => c.url)],
    ["Missing `lang` attribute", seo.missingLang],
  ];
  heading("Search metadata", "What search engines and link previews read from each page.");
  add(table(["Check", "Pages", "Examples"], seoRows.map(([label, urls]) => [label, String(urls.length), paths(urls, 3)])));
  if (seo.duplicateTitles.length) {
    add(capped(seo.duplicateTitles, (rows) => table(["Shared title", "Pages"], rows.map((d) => [d.title, paths(d.urls, 5)]))));
  }
  if (seo.canonicalElsewhere.length) {
    add(capped(seo.canonicalElsewhere, (rows) => table(["URL", "Canonical"], rows.map((c) => [path(c.url), path(c.canonical)]))));
  }

  const deadLinks = a11y.deadLinks.reduce((sum, d) => sum + d.count, 0);
  heading("Accessibility", `${a11y.imagesMissingAlt} of ${a11y.images} images have no alt attribute. ${deadLinks} links go nowhere (\`#\` or \`javascript:\`), which screen readers announce as links.`);
  if (a11y.pagesMissingAlt.length) {
    add(capped(a11y.pagesMissingAlt, (rows) => table(["URL", "Images missing alt", "Images"], rows.map((p) => [path(p.url), String(p.missing), String(p.images)]))));
  }
  const deadCounts = new Set(a11y.deadLinks.map((d) => d.count));
  if (deadCounts.size === 1 && a11y.deadLinks.length >= totals.saved / 2) {
    add(`Each of ${a11y.deadLinks.length} pages has ${[...deadCounts][0]}, so they likely come from the shared template.`);
  } else if (a11y.deadLinks.length) {
    add(capped(a11y.deadLinks, (rows) => table(["URL", "Links that go nowhere"], rows.map((d) => [path(d.url), String(d.count)]))));
  }

  heading("Mixed content", "HTTPS pages that load resources over plain HTTP. Browsers block or warn on these.");
  rowsOrNone(report.mixedContent, (rows) => table(["URL", "Insecure resources"], rows.map((m) => [path(m.url), list(m.resources, 3)])));

  heading("Sitemap coverage", "The sitemap should list every page at its final URL.");
  const slashEntries = coverage.problems.filter((p) => p.problem === `redirects to ${p.url}/`).length;
  if (slashEntries > 1) add(`${slashEntries} entries only lack the trailing slash the server redirects to.`);
  if (coverage.problems.length) {
    add("Sitemap entries with problems:", capped(coverage.problems, (rows) => table(["URL", "Problem"], rows.map((p) => [
      path(p.url), p.problem.replaceAll(origin, ""),
    ]))));
  }
  if (coverage.notInSitemap.length) {
    add("Saved pages missing from the sitemap:", capped(coverage.notInSitemap, (rows) => rows.map((u) => `- ${path(u)}`).join("\n")));
  }
  if (!coverage.problems.length && !coverage.notInSitemap.length) add("None found.");

  heading("Performance", "Measured by the crawler while it made several requests at once. Use these to compare pages with each other.");
  add(table(["Slowest pages", "ms"], report.performance.slowest.map((s) => [path(s.url), String(s.ms)])));
  add(table(["Largest pages", "Size"], report.performance.largest.map((l) => [path(l.url), kb(l.bytes)])));

  heading("Linked files", `${report.files.total} distinct files such as PDFs and images are linked. ${unverified("file")} The full list is in report.json.`);
  add(table(["Type", "Files"], Object.entries(report.files.byExtension).map(([k, v]) => [k, String(v)])));
  add(table(["Host", "Files"], Object.entries(report.files.byHost).map(([k, v]) => [k, String(v)])));

  heading("External links", `Other sites this site links to. ${unverified("page")}`);
  rowsOrNone(report.external, (rows) => table(["Host", "Links", "Pages linking"], rows.map((e) => [e.host, String(e.links), String(e.pages)])));

  return out.join("\n");
}

function seoPages(report: Report): number {
  const { seo } = report;
  return new Set([
    ...seo.missingTitle, ...seo.longTitles.map((t) => t.url), ...seo.missingDescription, ...seo.missingH1,
    ...seo.multipleH1.map((m) => m.url), ...seo.noindex, ...seo.canonicalElsewhere.map((c) => c.url),
    ...seo.duplicateTitles.flatMap((d) => d.urls), ...seo.duplicateDescriptions.flatMap((d) => d.urls),
    ...seo.missingLang,
  ]).size;
}

function depthOrder(bucket: string): number {
  return bucket === "unreachable" ? Number.MAX_SAFE_INTEGER : Number(bucket);
}
