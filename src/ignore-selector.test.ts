import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { crawl, type CrawlOptions } from "./crawler.ts";
import type { Manifest } from "./manifest.ts";

// A product page with a block of other products picked at random on every request, as many shop platforms show.
let pick = 0;
let requests = 0;
const page = (body: string) => new Response(`<html><head><title>Cue</title></head><body>${body}</body></html>`, {
  headers: { "content-type": "text/html" },
});

let server: Server<undefined>;
const tempDirs: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      requests++;
      const { pathname } = new URL(request.url);
      if (pathname === "/") return page(`<a href="/cue">Cue</a>`);
      if (pathname === "/cue") {
        pick++;
        return page(`<main><h1>0925-93</h1><p>Spalted maple on zircote.</p></main>
          <section class="related"><h2>Other cues</h2><a href="/cue-${pick}">Cue ${pick}</a></section>`);
      }
      if (pathname.startsWith("/cue-")) return page("<h1>Another cue</h1>");
      return new Response("Not found", { status: 404 });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const options = (outDir: string, extra: Partial<CrawlOptions> = {}): CrawlOptions => ({
  startUrl: `http://localhost:${server.port}/`, outDir, concurrency: 1, delayMs: 0, maxPages: 100,
  useSitemap: false, respectRobots: false, userAgent: "site-crawler/test", checkLinks: false, maxLinkChecks: 0,
  render: false, ...extra,
});
const change = (manifest: Manifest, pathname: string) =>
  manifest.pages.find((record) => new URL(record.url).pathname === pathname)?.change;
const twice = async (extra: Partial<CrawlOptions>) => {
  const outDir = await mkdtemp(join(tmpdir(), "site-crawler-ignore-"));
  tempDirs.push(outDir);
  await crawl(options(outDir, extra));
  return crawl(options(outDir, extra));
};

describe("--ignore-selector", () => {
  test("a page whose only difference is in an ignored block is unchanged", async () => {
    const manifest = await twice({ ignoreSelectors: ["section.related"] });
    expect(change(manifest, "/cue")).toBe("unchanged");
    expect(manifest.settings.ignoreSelectors).toEqual(["section.related"]);
  });

  test("still follows the links inside an ignored block", async () => {
    const manifest = await twice({ ignoreSelectors: ["section.related"] });
    expect(manifest.pages.some((record) => new URL(record.url).pathname.startsWith("/cue-"))).toBe(true);
  });

  test("without it, the same page counts as changed", async () => {
    expect(change(await twice({}), "/cue")).toBe("changed");
  });

  test("refuses a selector it cannot match, before any request", async () => {
    const before = requests;
    const outDir = await mkdtemp(join(tmpdir(), "site-crawler-ignore-"));
    tempDirs.push(outDir);
    await expect(crawl(options(outDir, { ignoreSelectors: ["section[["] }))).rejects.toThrow("Not a CSS selector");
    expect(requests).toBe(before);
  });
});
