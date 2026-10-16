import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { crawl } from "./crawler.ts";
import { checkLinks, verdictFor } from "./link-check.ts";
import type { Manifest } from "./manifest.ts";
import type { Report } from "./report.ts";
import { writeReport } from "./write-report.ts";

const htmlResponse = (body: string) =>
  new Response(`<html><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });

describe("verdictFor", () => {
  test("separates broken links from servers that refuse checks", () => {
    expect([200, 206, 301, 404, 410, 500, 401, 403, 429].map(verdictFor)).toEqual([
      "ok", "ok", "ok", "broken", "broken", "broken", "blocked", "blocked", "blocked",
    ]);
  });
});

describe("crawl with --check-links", () => {
  let site: Server<undefined>;
  let other: Server<undefined>;
  let outDir: string;
  let manifest: Manifest;
  let report: Report;
  const otherRequests: { method: string; path: string; range: string | null }[] = [];
  const siteRequests: string[] = [];

  beforeAll(async () => {
    // A second server on another port counts as another host.
    other = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        otherRequests.push({ method: request.method, path: url.pathname, range: request.headers.get("range") });
        if (url.pathname === "/ok.pdf") return new Response("%PDF", { headers: { "content-type": "application/pdf" } });
        if (url.pathname === "/moved") return Response.redirect(`${url.origin}/ok.pdf`, 301);
        if (url.pathname === "/no-head.pdf") {
          return request.method === "HEAD" ? new Response(null, { status: 405 }) : new Response("%", { status: 206 });
        }
        if (url.pathname === "/head-404") {
          return new Response(request.method === "HEAD" ? null : "ok", { status: request.method === "HEAD" ? 404 : 200 });
        }
        if (url.pathname === "/members") return new Response("Forbidden", { status: 403 });
        if (url.pathname === "/page") return htmlResponse("An external page");
        return new Response("Not found", { status: 404 });
      },
    });
    const ext = `http://127.0.0.1:${other.port}`;
    site = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        siteRequests.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/") {
          return htmlResponse(`<a href="/about">About</a> <a href="/agenda.pdf">Agenda</a>
            <a href="${ext}/ok.pdf">OK</a> <a href="${ext}/gone.pdf">Gone</a> <a href="${ext}/no-head.pdf">No HEAD</a>
            <a href="${ext}/moved">Moved</a> <a href="${ext}/members">Members</a> <a href="${ext}/page">Page</a>
            <a href="${ext}/head-404">HEAD says 404</a>`);
        }
        if (url.pathname === "/about") return htmlResponse(`<a href="${ext}/gone.pdf">Gone again</a>`);
        if (url.pathname === "/agenda.pdf") return new Response("%PDF", { headers: { "content-type": "application/pdf" } });
        return new Response("Not found", { status: 404 });
      },
    });
    outDir = await mkdtemp(join(tmpdir(), "site-crawler-links-"));
    manifest = await crawl({
      startUrl: `http://localhost:${site.port}/`,
      outDir,
      concurrency: 2,
      delayMs: 0,
      maxPages: 100,
      useSitemap: false,
      respectRobots: false,
      userAgent: "site-crawler/test",
      checkLinks: true,
      maxLinkChecks: 100,
    });
    report = await writeReport(outDir);
  });

  afterAll(async () => {
    site.stop(true);
    other.stop(true);
    await rm(outDir, { recursive: true, force: true });
  });

  test("records a verdict for every file and external link", () => {
    const verdicts = Object.fromEntries(manifest.linkChecks?.checks.map((c) => [new URL(c.url).pathname, c.verdict]) ?? []);
    expect(verdicts).toEqual({
      "/agenda.pdf": "ok",
      "/ok.pdf": "ok",
      "/gone.pdf": "broken",
      "/no-head.pdf": "ok",
      "/moved": "ok",
      "/members": "blocked",
      "/page": "ok",
      "/head-404": "ok",
    });
  });

  test("uses HEAD, and a 1-byte ranged GET only when HEAD returns an error", () => {
    const gets = otherRequests.filter((r) => r.method === "GET").map((r) => [r.path, r.range]);
    expect(gets.sort()).toEqual([
      ["/gone.pdf", "bytes=0-0"],
      ["/head-404", "bytes=0-0"],
      ["/members", "bytes=0-0"],
      ["/no-head.pdf", "bytes=0-0"],
    ]);
    expect(siteRequests).toContain("HEAD /agenda.pdf");
    expect(siteRequests).not.toContain("GET /agenda.pdf");
  });

  test("checks each URL once even when many pages link to it", () => {
    expect(otherRequests.filter((r) => r.path === "/gone.pdf").map((r) => r.method)).toEqual(["HEAD", "GET"]);
  });

  test("reports problems with the pages that link to them", async () => {
    expect(report.linkChecks.counts).toEqual({ ok: 6, broken: 1, blocked: 1, failed: 0 });
    const gone = report.linkChecks.problems.find((p) => p.url.endsWith("/gone.pdf"));
    expect(gone?.linkedFrom.map((u) => new URL(u).pathname)).toEqual(["/", "/about"]);
    expect(gone?.kind).toBe("file");
    const markdown = await readFile(join(outDir, "report.md"), "utf8");
    expect(markdown).toContain("## Broken files and external links");
    expect(markdown).toContain("refused the check");
  });

  test("stops at the check limit and counts the rest as skipped", async () => {
    const base = `http://127.0.0.1:${other.port}`;
    const result = await checkLinks([`${base}/ok.pdf`, `${base}/page`, `${base}/ok.pdf`, `${base}/x`], {
      userAgent: "site-crawler/test",
      maxChecks: 2,
      perHostDelayMs: 0,
    });
    expect(result.checks).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });

  test("reports an unreachable host as failed", async () => {
    const result = await checkLinks(["http://127.0.0.1:1/file.pdf"], {
      userAgent: "site-crawler/test",
      maxChecks: 10,
      perHostDelayMs: 0,
    });
    expect(result.checks[0]?.verdict).toBe("failed");
    expect(result.checks[0]?.error).toBeTruthy();
  });
});
