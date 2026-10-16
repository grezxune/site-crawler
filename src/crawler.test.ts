import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { crawl } from "./crawler.ts";
import type { Manifest } from "./manifest.ts";
import type { Report } from "./report.ts";
import { writeReport } from "./write-report.ts";

const LONG_TEXT = "The village board meets on the first Tuesday of each month at the municipal hall. ".repeat(5);

const html = (title: string, body: string) =>
  new Response(
    `<html lang="en"><head><title>${title}</title></head><body>
      <nav><a href="/">Home</a> <a href="/about">About</a> <a href="/news/">News</a></nav>
      <main>${body}</main><footer>Village of Testville, 1 Main Street</footer></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const HOME_BODY = `<h1>Welcome</h1><p>${LONG_TEXT}</p>
  <a href="https://other.test/x">Off</a> <a href="/minutes.pdf">PDF</a> <a href="/private/secret">Secret</a>
  <a href="/missing">Missing</a> <a href="/old">Old</a> <a href="/leave">Leave</a> <a href="mailto:clerk@x.test">Mail</a>`;

// A small site with a cycle, a redirect, an orphan page only in the sitemap, a robots-blocked
// page, a file link, a 404, links to other hosts, and pages the report should flag.
const ROUTES: Record<string, () => Response> = {
  "/": () => html("Home", HOME_BODY),
  "/home": () => html("Home", HOME_BODY),
  "/about": () => html("About", `<h1>About</h1><p>${LONG_TEXT}</p><img src="/hall.jpg"><a href="/about/">Self</a>`),
  "/news": () => html("News", `<h1>News</h1><a href="/news/item-1">Item</a> <a href="/news?page=2">Next</a>`),
  "/news/item-1": () => html("Item", `<h1>Item</h1><a href="../coming">Soon</a> <a href="/home">Home</a>`),
  "/coming": () => html("Coming", `<h1>Events</h1><p>Coming soon.</p>`),
  "/orphan": () => html("Orphan", `<p>Only in the sitemap. ${LONG_TEXT}</p>`),
  "/private/secret": () => html("Secret", "Should never be fetched"),
  "/minutes.pdf": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
  "/old": () => new Response(null, { status: 301, headers: { location: "/about" } }),
  "/leave": () => new Response(null, { status: 302, headers: { location: "https://other.test/" } }),
  "/robots.txt": () => new Response("User-agent: *\nDisallow: /private\n"),
};

describe("crawl", () => {
  let server: Server<undefined>;
  let outDir: string;
  let manifest: Manifest;
  let report: Report;
  const requested: string[] = [];
  const path = (url: string) => new URL(url).pathname + new URL(url).search;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requested.push(url.pathname + url.search);
        if (url.pathname === "/sitemap.xml") {
          return new Response(`<urlset><url><loc>${url.origin}/orphan</loc><lastmod>2019-01-01</lastmod></url></urlset>`);
        }
        if (url.pathname === "/news" && url.search === "?page=2") return html("News", "<h1>News</h1>Page two");
        const route = ROUTES[url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : "/"];
        return route ? route() : new Response("Not found", { status: 404, headers: { "content-type": "text/html" } });
      },
    });
    outDir = await mkdtemp(join(tmpdir(), "site-crawler-test-"));
    manifest = await crawl({
      startUrl: `http://localhost:${server.port}/`,
      outDir,
      concurrency: 2,
      delayMs: 0,
      maxPages: 100,
      useSitemap: true,
      respectRobots: true,
      userAgent: "site-crawler/test",
      checkLinks: false,
      maxLinkChecks: 0,
    });
    report = await writeReport(outDir);
  });

  afterAll(async () => {
    server.stop(true);
    await rm(outDir, { recursive: true, force: true });
  });

  test("saves every reachable page once", async () => {
    const saved = manifest.pages
      .filter((p) => p.outcome === "saved")
      .map((p) => p.file?.replace(/\.[0-9a-f]{8}\.html$/, ".<hash>.html"))
      .sort();
    expect(saved).toEqual([
      "about/index.html",
      "coming/index.html",
      "home/index.html",
      "index.html",
      "news/index.<hash>.html",
      "news/index.html",
      "news/item-1/index.html",
      "orphan/index.html",
    ]);
    expect(await readFile(join(outDir, "orphan/index.html"), "utf8")).toContain("Only in the sitemap");
  });

  test("records redirects, errors, and blocked pages", () => {
    const outcome = (p: string) => manifest.pages.find((r) => path(r.url) === p)?.outcome;
    expect(outcome("/old")).toBe("duplicate");
    expect(outcome("/leave")).toBe("offsite-redirect");
    expect(outcome("/missing")).toBe("http-error");
    expect(manifest.robots.blocked.map(path)).toEqual(["/private/secret"]);
    expect(manifest.sitemap.entries).toHaveLength(1);
  });

  test("never requests blocked pages, files, or other hosts", () => {
    expect(requested).not.toContain("/private/secret");
    expect(requested).not.toContain("/minutes.pdf");
    expect(requested.filter((p) => p === "/about" || p === "/about/")).toHaveLength(1);
  });

  test("reports broken pages and redirects with the pages that link to them", () => {
    expect(report.broken.map((b) => [path(b.url), b.status, b.linkedFrom.map(path)])).toEqual([
      ["/missing", 404, ["/", "/home"]],
    ]);
    const old = report.redirects.find((r) => path(r.url) === "/old");
    expect(old && [path(old.finalUrl), old.linkedFrom.map(path)]).toEqual(["/about", ["/", "/home"]]);
  });

  test("flags thin, duplicate, placeholder, orphan, and stale pages", () => {
    expect(report.thin.map((t) => path(t.url))).toContain("/coming");
    expect(report.thin.map((t) => path(t.url))).not.toContain("/about");
    expect(report.duplicates.map((d) => d.urls.map(path))).toEqual([["/", "/home"]]);
    expect(report.placeholders.map((p) => [path(p.url), p.match])).toEqual([["/coming", "Coming soon"]]);
    expect(report.orphans.map(path)).toEqual(["/orphan"]);
    expect(report.stale.map((s) => [path(s.url), s.updated])).toEqual([["/orphan", "2019-01-01"]]);
    expect(report.depth.histogram.unreachable).toBe(1);
  });

  test("checks metadata, images, files, and external links", () => {
    expect(report.seo.missingDescription).toHaveLength(8);
    expect(report.seo.duplicateTitles.map((d) => d.urls.map(path))).toContainEqual(["/", "/home"]);
    expect(report.accessibility.imagesMissingAlt).toBe(1);
    expect(report.files.byExtension).toEqual({ pdf: 1 });
    expect(report.external.map((e) => e.host)).toEqual(["other.test"]);
  });

  test("writes the manifest and both report files", async () => {
    const written = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
    expect(written.pages).toHaveLength(manifest.pages.length);
    expect(written.site).toBe(`localhost:${server.port}`);
    expect(await readFile(join(outDir, "report.md"), "utf8")).toContain("## Broken pages");
    expect(JSON.parse(await readFile(join(outDir, "report.json"), "utf8")).broken).toHaveLength(1);
  });
});
