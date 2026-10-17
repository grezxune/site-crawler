import { capped, list, table } from "./markdown.ts";
import type { Report } from "./report.ts";

// Report sections that each return Markdown blocks. `path` shortens same-site URLs.
type PathFormatter = (url: string) => string;

export function linkCheckSection(report: Report, path: PathFormatter): string[] {
  const checks = report.linkChecks;
  const paths = (urls: string[]) => list(urls.map(path), 3);
  const skippedNote = checks.skipped ? ` ${checks.skipped} more were left out by --max-link-checks.` : "";
  const blocks = ["## Broken files and external links", checks.checked
    ? `Checked ${checks.total} linked files and external pages with a HEAD request. Any error was confirmed with a 1-byte GET.${skippedNote}`
    : "Not checked. Run the crawl with `--check-links` to check every linked file and external page."];
  if (!checks.checked) return blocks;

  blocks.push(table(["Result", "Links"], [
    ["Works", String(checks.counts.ok)],
    ["Broken (HTTP error)", String(checks.counts.broken)],
    ["No response (DNS, connection, or timeout)", String(checks.counts.failed)],
    ["Refused the automated check (401, 403, 429)", String(checks.counts.blocked)],
  ]));
  const status = (p: (typeof checks.problems)[number]) => (p.status ? String(p.status) : (p.error ?? "no response"));
  const broken = checks.problems.filter((p) => p.verdict !== "blocked");
  const refused = checks.problems.filter((p) => p.verdict === "blocked");
  if (broken.length) {
    blocks.push(capped(broken, (rows) => table(["URL", "Type", "Status", "Linked from"], rows.map((p) => [
      path(p.url), p.kind, status(p), paths(p.linkedFrom),
    ]))));
  }
  if (refused.length) {
    blocks.push("These servers refused the check. Open them in a browser to confirm they work.", capped(refused, (rows) =>
      table(["URL", "Status", "Linked from"], rows.map((p) => [path(p.url), status(p), paths(p.linkedFrom)]))));
  }
  return blocks;
}

export function scriptContentSection(report: Report, path: PathFormatter): string[] {
  const content = report.scriptContent;
  const blocks = ["## Content loaded by JavaScript"];
  blocks.push(content.rendered
    ? `Each page was also loaded in ${content.browser ?? "a headless browser"}. The crawler recorded the links in the rendered page and the file URLs in the JSON its scripts fetched. Files were recorded, not downloaded.`
    : "Pages that likely load content after they arrive. The crawl reads only server HTML, so it could not see that content. Run the crawl with `--render` to load each page in a local Chrome and record what its scripts add.");
  if (content.siteWide.length) {
    blocks.push(`On most pages, so not listed per page: ${content.siteWide.join("; ")}.`);
  }
  if (content.rendered) {
    const { totals, template } = content;
    blocks.push(`Render found ${totals.files} files the server HTML did not link, ${totals.documents} of them documents.`);
    if (template.links || template.files) {
      blocks.push(`Render also found ${template.links} links and ${template.files} files on most pages, such as a widget's own controls. They are counted here and not listed per page.`);
    }
    if (totals.files) {
      blocks.push(table(["Type", "Files"], sortedEntries(totals.byExtension)));
      blocks.push(table(["Host", "Files"], sortedEntries(totals.byHost)));
    }
  }
  if (content.pages.length === 0) {
    blocks.push("No page shows signs of content the crawl missed.");
    return blocks;
  }
  if (!content.rendered) {
    blocks.push(capped(content.pages, (rows) => table(["URL", "Signs"], rows.map((p) => [path(p.url), p.signals.join("; ")]))));
    return blocks;
  }
  blocks.push(capped(content.pages, (rows) => table(["URL", "New files", "New links", "API calls with files", "Signs"],
    rows.map(({ url, render, signals }) => [
      path(url),
      render ? (render.ok ? String(render.files) : `render failed: ${render.error ?? "unknown"}`) : "not rendered",
      render?.ok ? String(render.newLinks) : "",
      render?.apiCalls.length ? list(render.apiCalls.map((call) => `${call.url} (${call.files})`), 3) : "",
      signals.join("; ") + (render && !render.settled ? `${signals.length ? "; " : ""}still loading at timeout` : ""),
    ]))));
  return blocks;
}

function sortedEntries(counts: Record<string, number>): string[][] {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => [k, String(v)]);
}

