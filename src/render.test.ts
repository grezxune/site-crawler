import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "./browser.ts";
import { crawl } from "./crawler.ts";
import type { Manifest } from "./manifest.ts";
import type { Report } from "./report.ts";
import { writeReport } from "./write-report.ts";

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(`<html><body>${body}</body></html>`, { headers: { "content-type": "text/html", ...headers } });
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

// A site whose meetings page fills its list from another host's API, and whose events page
// embeds a calendar iframe from that host. The widget host also serves the files.
function startServers() {
  const siteRequests: string[] = [];
  const widgetRequests: string[] = [];
  const widget = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      widgetRequests.push(url.pathname + url.search);
      const file = (name: string) => `${url.origin}/files/${name}`;
      if (url.pathname === "/api/meetings") {
        const page = Number(url.searchParams.get("page"));
        const ids = page === 1 ? [1, 2, 3] : [4, 5];
        return json(ids.map((id) => ({
          id, agenda_file_url: file(`agenda-${id}.pdf`), meeting_minutes_file_url: null,
          description: id === 1 ? `<a href="${file("notes-1.docx")}">Notes</a>` : "",
        })));
      }
      if (url.pathname === "/embed") {
        return html(`<div id="cal">Loading...</div><script>
          fetch("/api/events").then((r) => r.json()).then((d) => {
            for (const e of d.events) document.getElementById("cal").insertAdjacentHTML("beforeend", '<a href="' + e.attachment + '">Flyer</a>');
          });</script>`);
      }
      if (url.pathname === "/api/events") return json({ events: [{ attachment: file("flyer.pdf") }] });
      return new Response("%PDF", { headers: { "content-type": "application/pdf" } });
    },
  });
  const api = `http://127.0.0.1:${widget.port}`;
  const template = (body: string) => html(`<nav><a href="/">Home</a> <a href="/meetings">Meetings</a>
    <a href="/events">Events</a> <a href="/about">About</a> <a href="#">Top</a></nav>${body}
    <script>window.WidgetApi = "${api}/api";</script>`);
  const site = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      siteRequests.push(url.pathname);
      if (url.pathname === "/") return template("<h1>Welcome</h1>");
      if (url.pathname === "/about") return template(`<h1>About</h1><img src="/logo.png">`);
      if (url.pathname === "/archive") return template("<h1>Archive</h1>");
      if (url.pathname === "/events") return template(`<iframe src="${api}/embed"></iframe>`);
      if (url.pathname === "/meetings") {
        return template(`<p>Loading agendas and minutes...</p><div id="list"></div><script>
          Promise.all([1, 2].map((p) => fetch("${api}/api/meetings?page=" + p).then((r) => r.json()))).then(([first]) => {
            const list = document.getElementById("list");
            for (const m of first.slice(0, 2)) list.insertAdjacentHTML("beforeend", '<a href="' + m.agenda_file_url + '">Agenda</a>');
            list.insertAdjacentHTML("beforeend", '<a href="/archive">Archive</a>');
          });</script>`);
      }
      return new Response("Not found", { status: 404 });
    },
  });
  return { site, widget, api, siteRequests, widgetRequests };
}

const chrome = findChrome();

describe.skipIf(!chrome)("crawl with --render", () => {
  let servers: ReturnType<typeof startServers>;
  let plainDir: string;
  let renderDir: string;
  let plain: Report;
  let manifest: Manifest;
  let report: Report;
  const path = (url: string) => new URL(url).pathname;

  beforeAll(async () => {
    servers = startServers();
    plainDir = await mkdtemp(join(tmpdir(), "site-crawler-plain-"));
    renderDir = await mkdtemp(join(tmpdir(), "site-crawler-render-"));
    const options = {
      startUrl: `http://localhost:${servers.site.port}/`, concurrency: 2, delayMs: 0, maxPages: 50, useSitemap: false,
      respectRobots: false, userAgent: "site-crawler/test", checkLinks: false, maxLinkChecks: 0,
    };
    await crawl({ ...options, outDir: plainDir, render: false });
    plain = await writeReport(plainDir);
    servers.siteRequests.length = 0;
    servers.widgetRequests.length = 0;
    manifest = await crawl({ ...options, outDir: renderDir, render: true });
    report = await writeReport(renderDir);
  }, 90_000);

  afterAll(async () => {
    servers.site.stop(true);
    servers.widget.stop(true);
    await rm(plainDir, { recursive: true, force: true });
    await rm(renderDir, { recursive: true, force: true });
  });

  test("without render, flags pages that load content and lists template signals once", () => {
    expect(plain.scriptContent.rendered).toBe(false);
    expect(Object.fromEntries(plain.scriptContent.pages.map((p) => [path(p.url), p.signals]))).toEqual({
      "/events": [`Frame from 127.0.0.1:${servers.widget.port}`],
      "/meetings": ['Loading text: "Loading agendas and minutes..."'],
    });
    expect(plain.scriptContent.siteWide).toEqual([`Inline script names API host 127.0.0.1:${servers.widget.port}`]);
  });

  test("records every file the page's API calls named, with the call it came from", () => {
    const meetings = manifest.pages.find((p) => path(p.url) === "/meetings")?.render;
    expect(meetings?.ok).toBe(true);
    expect(meetings?.files.map((f) => [path(f.url), f.via, f.source && new URL(f.source).search]).sort()).toEqual([
      ["/files/agenda-1.pdf", "api", "?page=1"],
      ["/files/agenda-2.pdf", "api", "?page=1"],
      ["/files/agenda-3.pdf", "api", "?page=1"],
      ["/files/agenda-4.pdf", "api", "?page=2"],
      ["/files/agenda-5.pdf", "api", "?page=2"],
      ["/files/notes-1.docx", "api", "?page=1"],
    ]);
    expect(meetings?.links.map(path)).toContain("/files/agenda-1.pdf");
  });

  test("captures API calls and links inside a cross-host iframe", () => {
    const events = manifest.pages.find((p) => path(p.url) === "/events")?.render;
    expect(events?.files.map((f) => path(f.url))).toEqual(["/files/flyer.pdf"]);
    expect(events?.apiCalls.map((c) => path(c.url))).toEqual(["/api/events"]);
  });

  test("crawls same-site links that only the rendered page has", () => {
    expect(manifest.pages.find((p) => path(p.url) === "/archive")?.outcome).toBe("saved");
  });

  test("never lets the browser fetch images or files", () => {
    expect(servers.siteRequests).not.toContain("/logo.png");
    expect(servers.widgetRequests.filter((r) => r.startsWith("/files/"))).toEqual([]);
    expect(servers.widgetRequests).toContain("/api/meetings?page=2");
  });

  test("reports what render found and counts the files as linked files", async () => {
    expect(report.scriptContent.totals).toMatchObject({ files: 7, documents: 7, byExtension: { pdf: 6, docx: 1 } });
    expect(report.scriptContent.pages.find((p) => path(p.url) === "/meetings")?.render?.files).toBe(6);
    // `href="#"` renders as a link to the page itself, which must not count as a new link.
    expect(report.scriptContent.pages.map((p) => path(p.url))).toEqual(["/events", "/meetings"]);
    expect(report.files.byExtension).toEqual({ pdf: 6, docx: 1 });
    const markdown = await readFile(join(renderDir, "report.md"), "utf8");
    expect(markdown).toContain("Render found 7 files the server HTML did not link, 7 of them documents.");
  });
});
