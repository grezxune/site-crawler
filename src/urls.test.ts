import { describe, expect, test } from "bun:test";
import { isSameSite, looksLikePage, normalizeUrl, pageKey, siteDirName, siteKey, urlToFilePath } from "./urls.ts";

function url(raw: string): URL {
  const parsed = normalizeUrl(raw);
  if (!parsed) throw new Error(`bad test URL ${raw}`);
  return parsed;
}

describe("site identity", () => {
  test("treats www and the bare domain as one site", () => {
    expect(siteKey("WWW.Example.org")).toBe("example.org");
    expect(isSameSite(url("https://www.example.org/a"), "example.org")).toBe(true);
    expect(isSameSite(url("https://other.org/"), "example.org")).toBe(false);
  });

  test("names the output folder after the domain without its TLD", () => {
    expect(siteDirName("example.org")).toBe("example");
    expect(siteDirName("www.example.org")).toBe("example");
    expect(siteDirName("localhost")).toBe("localhost");
  });
});

describe("normalizeUrl", () => {
  test("resolves relative links and drops fragments", () => {
    expect(normalizeUrl("../b#top", "https://x.org/a/c")?.href).toBe("https://x.org/b");
  });

  test("rejects non-http links", () => {
    expect(normalizeUrl("mailto:a@b.org")).toBeNull();
    expect(normalizeUrl("javascript:void(0)")).toBeNull();
    expect(normalizeUrl("tel:555")).toBeNull();
  });
});

describe("looksLikePage", () => {
  test("skips files and Cloudflare paths", () => {
    expect(looksLikePage(url("https://x.org/minutes.pdf"))).toBe(false);
    expect(looksLikePage(url("https://x.org/theme.css?v=1"))).toBe(false);
    expect(looksLikePage(url("https://x.org/cdn-cgi/l/email-protection"))).toBe(false);
  });

  test("keeps extensionless and server-script pages", () => {
    expect(looksLikePage(url("https://x.org/events"))).toBe(true);
    expect(looksLikePage(url("https://x.org/page.php?id=2"))).toBe(true);
    expect(looksLikePage(url("https://x.org/about.html"))).toBe(true);
  });
});

describe("pageKey", () => {
  test("ignores trailing slashes, protocol, and www", () => {
    expect(pageKey(url("https://x.org/events/"))).toBe(pageKey(url("http://www.x.org/events")));
    expect(pageKey(url("https://x.org/"))).toBe("x.org/");
  });

  test("keeps query strings distinct", () => {
    expect(pageKey(url("https://x.org/news?page=2"))).not.toBe(pageKey(url("https://x.org/news")));
  });
});

describe("urlToFilePath", () => {
  test("maps each page to a folder with index.html", () => {
    expect(urlToFilePath(url("https://x.org/"))).toBe("index.html");
    expect(urlToFilePath(url("https://x.org/events"))).toBe("events/index.html");
    expect(urlToFilePath(url("https://x.org/news-and-notices/notice-5/"))).toBe("news-and-notices/notice-5/index.html");
  });

  test("keeps .html file names", () => {
    expect(urlToFilePath(url("https://x.org/old/about.html"))).toBe("old/about.html");
  });

  test("adds a hash for query strings", () => {
    expect(urlToFilePath(url("https://x.org/news?page=2"))).toMatch(/^news\/index\.[0-9a-f]{8}\.html$/);
  });

  test("cannot escape the output folder", () => {
    expect(urlToFilePath(url("https://x.org/%2e%2e/%2e%2e/etc/passwd"))).toBe("etc/passwd/index.html");
    expect(urlToFilePath(url("https://x.org/a%2F..%2Fb"))).toBe("a_.._b/index.html");
  });
});
