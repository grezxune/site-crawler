import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { CHANGES_FILE } from "./changes.ts";
import { crawl, type CrawlOptions } from "./crawler.ts";
import type { Manifest } from "./manifest.ts";
import { conditionalHeaders, isSafeFile } from "./previous-run.ts";
import { writeReport } from "./write-report.ts";

const TEXT = "The village board meets on the first Tuesday of each month at the municipal hall. ".repeat(5);
const NEWS_DATES = ["Mon, 05 Oct 2026 10:00:00 GMT", "Mon, 02 Nov 2026 10:00:00 GMT"];

const page = (title: string, body: string, headers: Record<string, string> = {}) => new Response(
  `<html><head><title>${title}</title></head><body>
    <nav><a href="/">Home</a> <a href="/about">About</a> <a href="/news">News</a></nav>
    <main>${body}</main></body></html>`,
  { headers: { "content-type": "text/html", ...headers } },
);

// A site that changes between crawls. Version 2 edits /news, adds /news/new-item and b.pdf,
// drops the links to /gone (which still loads) and to c.pdf, links /target only through a redirect,
// and makes /old-page return 404.
let version = 1;
let conditionalRequests = 0;
let notModified = 0;
const requested: string[] = [];

function route(request: Request): Response {
  const { pathname } = new URL(request.url);
  const ifNoneMatch = request.headers.get("if-none-match");
  const ifModifiedSince = request.headers.get("if-modified-since");
  if (ifNoneMatch || ifModifiedSince) conditionalRequests++;
  const unchanged = (fresh: boolean) => {
    if (fresh) notModified++;
    return fresh ? new Response(null, { status: 304 }) : null;
  };

  if (pathname === "/") {
    return unchanged(ifNoneMatch === '"home-1"')
      ?? page("Home", `<p>${TEXT}</p><a href="/old-page">Old</a> <a href="/changes">Changes</a>`, { etag: '"home-1"' });
  }
  // A token that differs on every request, as many CMS pages have.
  if (pathname === "/about") return page("About", `<p>${TEXT}</p><script>var token = "${crypto.randomUUID()}";</script>`);
  if (pathname === "/news") {
    const lastModified = NEWS_DATES[version - 1] ?? "";
    const body = version === 1
      ? `<p>Spring cleanup is May 2.</p><a href="/gone">Gone</a> <a href="/target">Target</a>
         <a href="/files/a.pdf">A</a> <a href="/files/c.pdf">C</a>`
      : `<p>Spring cleanup moved to May 9.</p><a href="/news/new-item">New</a> <a href="/redirect">Target</a>
         <a href="/files/a.pdf">A</a> <a href="/files/b.pdf">B</a>`;
    return unchanged(ifModifiedSince === lastModified) ?? page("News", body, { "last-modified": lastModified });
  }
  if (pathname === "/news/new-item" && version === 2) return page("New item", `<p>Brush pickup starts June 1.</p>`);
  if (pathname === "/gone") return page("Gone", `<p>Still here, but nothing links to it.</p>`);
  if (pathname === "/target") return page("Target", `<p>Reached directly, then through a redirect.</p>`);
  if (pathname === "/redirect") return new Response(null, { status: 301, headers: { location: "/target" } });
  if (pathname === "/old-page" && version === 1) return page("Old", `<p>Old page.</p>`);
  if (pathname === "/changes") return page("Changes", `<p>A page that shares the changes folder name.</p>`);
  return new Response("Not found", { status: 404, headers: { "content-type": "text/html" } });
}

let server: Server<undefined>;
const tempDirs: string[] = [];

const options = (outDir: string, extra: Partial<CrawlOptions> = {}): CrawlOptions => ({
  startUrl: `http://localhost:${server.port}/`, outDir, concurrency: 2, delayMs: 0, maxPages: 100,
  useSitemap: false, respectRobots: false, userAgent: "site-crawler/test", checkLinks: false, maxLinkChecks: 0,
  render: false, ...extra,
});
const path = (url: string) => new URL(url).pathname;
const record = (manifest: Manifest, pathname: string) => manifest.pages.find((r) => path(r.url) === pathname);
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "site-crawler-changes-"));
  tempDirs.push(dir);
  return dir;
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      requested.push(new URL(request.url).pathname);
      return route(request);
    },
  });
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("a second crawl", () => {
  let outDir: string;
  let first: Manifest;
  let second: Manifest;
  let aboutBefore: string;

  beforeAll(async () => {
    version = 1;
    outDir = await tempDir();
    first = await crawl(options(outDir));
    aboutBefore = await readFile(join(outDir, "about/index.html"), "utf8");
    version = 2;
    notModified = 0;
    second = await crawl(options(outDir));
  });

  test("the first crawl records validators and no changes", () => {
    expect(first.changes).toBeUndefined();
    expect(record(first, "/")?.etag).toBe('"home-1"');
    expect(record(first, "/")?.change).toBeUndefined();
  });

  test("keeps a page the server says is not modified", () => {
    const home = record(second, "/");
    expect(notModified).toBe(1);
    expect(home).toMatchObject({ status: 200, outcome: "saved", change: "unchanged", notModified: true, file: "index.html" });
    expect(second.changes?.pages.notModified).toBe(1);
  });

  test("does not rewrite a page whose content is the same", async () => {
    expect(record(second, "/about")?.change).toBe("unchanged");
    expect(await readFile(join(outDir, "about/index.html"), "utf8")).toBe(aboutBefore);
  });

  test("lists new, changed, and removed pages", () => {
    const changes = second.changes;
    expect(changes?.since).toBe(first.crawledAt);
    expect(changes?.pages.new.map((p) => [path(p.url), p.file])).toEqual([["/news/new-item", "news/new-item/index.html"]]);
    expect(changes?.pages.changed.map((p) => path(p.url))).toEqual(["/news"]);
    expect(changes?.pages.removed.map((p) => [path(p.url), p.reason])).toEqual([["/old-page", "HTTP 404"]]);
    expect(changes?.pages.unchanged).toBe(5);
  });

  test("re-checks a page nothing links to anymore and lists it apart from removed pages", () => {
    expect(requested.filter((p) => p === "/gone")).toHaveLength(2);
    expect(record(second, "/gone")).toMatchObject({ outcome: "saved", change: "unchanged" });
    expect(second.changes?.pages.unlinked.map((p) => [path(p.url), p.file])).toEqual([["/gone", "gone/index.html"]]);
  });

  test("counts a page reached through a redirect as linked", () => {
    expect(record(second, "/redirect")).toMatchObject({ outcome: "duplicate" });
    expect(record(second, "/target")?.outcome).toBe("saved");
    expect(second.changes?.pages.unlinked.map((p) => path(p.url))).not.toContain("/target");
  });

  test("lists new and removed files without requesting them", () => {
    const files = second.changes?.files;
    expect(second.changes?.sameRender).toBe(true);
    expect(files?.new.map((f) => [path(f.url), f.pages.map(path), f.foundBy])).toEqual([["/files/b.pdf", ["/news"], ["html"]]]);
    expect(files?.removed.map((f) => path(f.url))).toEqual(["/files/c.pdf"]);
    expect(requested.some((p) => p.startsWith("/files/"))).toBe(false);
  });

  test("copies only new and changed pages to the changes folder", async () => {
    const dir = second.changes?.dir ?? "";
    expect(dir).toMatch(/^changes\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ$/);
    const copied = (await readdir(join(outDir, dir), { recursive: true })).filter((f) => f.endsWith(".html")).sort();
    expect(copied).toEqual(["news/index.html", "news/new-item/index.html"]);
    expect(await readFile(join(outDir, dir, "news/index.html"), "utf8")).toContain("moved to May 9");
    expect(await readFile(join(outDir, "news/index.html"), "utf8")).toContain("moved to May 9");
    const written = JSON.parse(await readFile(join(outDir, dir, CHANGES_FILE), "utf8"));
    expect(written).toEqual({ site: second.site, crawledAt: second.crawledAt, ...second.changes });
  });

  test("keeps pages out of the changes folder", async () => {
    expect(record(second, "/changes")?.file).toBe("changes_/index.html");
    expect(await readdir(join(outDir, "changes"))).toEqual([(second.changes?.dir ?? "").slice("changes/".length)]);
  });

  test("the report lists the changes", async () => {
    await writeReport(outDir);
    const markdown = await readFile(join(outDir, "report.md"), "utf8");
    expect(markdown).toContain("## Changes since the last crawl");
    expect(markdown).toContain("| /news/new-item | new |");
    expect(markdown).toContain("| /files/b.pdf | new | /news |");
    expect(markdown).toContain("| No longer linked (still loads) | 1 |  |");
    expect(markdown).toContain("### Pages no longer linked");
    expect(markdown).toContain("| /gone | gone/index.html |");
    expect(markdown).toContain("| [Pages no longer linked since the last crawl](#pages-no-longer-linked) | 1 |");
  });

  test("a third crawl with nothing new writes no changes folder", async () => {
    notModified = 0;
    const third = await crawl(options(outDir));
    expect(third.changes?.dir).toBeNull();
    // /gone was already unlinked in the crawl before, so it is checked again but not listed again.
    expect(record(third, "/gone")?.outcome).toBe("saved");
    expect(third.changes?.pages).toMatchObject({ new: [], changed: [], removed: [], unlinked: [], unchanged: 7 });
    expect(third.changes?.files).toMatchObject({ new: [], removed: [] });
    expect(notModified).toBe(2);
    expect(await readdir(join(outDir, "changes"))).toHaveLength(1);
  });

  test("--fresh ignores the earlier crawl", async () => {
    conditionalRequests = 0;
    const fresh = await crawl(options(outDir, { fresh: true }));
    expect(fresh.changes).toBeUndefined();
    expect(record(fresh, "/news")?.change).toBeUndefined();
    expect(conditionalRequests).toBe(0);
  });
});

describe("comparing crawls", () => {
  test("refuses a folder that holds another site's crawl, before any request", async () => {
    const outDir = await tempDir();
    await writeFile(join(outDir, "manifest.json"), JSON.stringify({ site: "other.test", startUrl: "https://other.test/", pages: [] }));
    const before = requested.length;
    await expect(crawl(options(outDir))).rejects.toThrow("holds a crawl of other.test");
    expect(requested.length).toBe(before);
  });

  test("compares only HTML file links, and lists no unlinked page, when one crawl used render", async () => {
    version = 1;
    const outDir = await tempDir();
    const first = await crawl(options(outDir));
    // Pretend the first crawl ran with render and found a file the HTML does not link.
    const home = first.pages.find((r) => path(r.url) === "/");
    if (home) home.render = { ...emptyRender(), files: [{ url: `${first.startUrl}files/render-only.pdf`, via: "api", source: null }] };
    first.render = { enabled: true, browser: "test" };
    await writeFile(join(outDir, "manifest.json"), JSON.stringify(first));

    version = 2;
    const second = await crawl(options(outDir));
    expect(second.changes?.sameRender).toBe(false);
    expect(second.changes?.files.removed.map((f) => path(f.url))).toEqual(["/files/c.pdf"]);
    expect(second.changes?.pages.unlinked).toEqual([]);
  });

  test("fetches a page in full when its saved file path is unsafe", async () => {
    const outDir = await tempDir();
    const first = await crawl(options(outDir));
    const news = first.pages.find((r) => path(r.url) === "/news");
    if (news) news.file = "../news.html";
    await writeFile(join(outDir, "manifest.json"), JSON.stringify(first));

    const second = await crawl(options(outDir));
    expect(record(second, "/news")).toMatchObject({ change: "new", file: "news/index.html" });
  });

  test("only safe validators and paths come from the earlier manifest", () => {
    expect(isSafeFile("news/index.html")).toBe(true);
    for (const bad of ["../x.html", "/etc/passwd", "a/../../b", "a\\b", "", "a//b"]) expect(isSafeFile(bad)).toBe(false);
    const base = { url: "https://x.test/", finalUrl: null, status: 200, outcome: "saved" as const, file: "index.html",
      contentType: "text/html", bytes: 1, ms: 1 };
    expect(conditionalHeaders({ ...base, lastModified: "Mon, 05 Oct 2026 10:00:00 GMT", etag: '"a"' }))
      .toEqual({ "If-None-Match": '"a"', "If-Modified-Since": "Mon, 05 Oct 2026 10:00:00 GMT" });
    expect(conditionalHeaders({ ...base, lastModified: "bad\r\nX-Injected: 1", etag: null })).toEqual({});
  });
});

function emptyRender() {
  return { ok: true, ms: 0, settled: true, hosts: {}, blocked: 0, apiCalls: [], links: [], files: [], truncated: false };
}
