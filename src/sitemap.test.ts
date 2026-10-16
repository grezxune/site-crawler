import { describe, expect, test } from "bun:test";
import { parseSitemap } from "./sitemap.ts";

describe("parseSitemap", () => {
  test("reads page URLs and lastmod dates and decodes entities", () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://x.org/a?b=1&amp;c=2</loc><lastmod>2026-06-25T14:26:06+00:00</lastmod></url>
      <url><loc> https://x.org/d </loc></url></urlset>`;
    expect(parseSitemap(xml)).toEqual({
      isIndex: false,
      entries: [
        { loc: "https://x.org/a?b=1&c=2", lastmod: "2026-06-25T14:26:06+00:00" },
        { loc: "https://x.org/d", lastmod: null },
      ],
    });
  });

  test("detects a sitemap index", () => {
    const xml = `<sitemapindex><sitemap><loc><![CDATA[https://x.org/s1.xml]]></loc></sitemap></sitemapindex>`;
    expect(parseSitemap(xml)).toEqual({ isIndex: true, entries: [{ loc: "https://x.org/s1.xml", lastmod: null }] });
  });
});
