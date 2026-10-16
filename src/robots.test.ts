import { describe, expect, test } from "bun:test";
import { parseRobots } from "./robots.ts";

const UA = "site-crawler/0.1";

describe("parseRobots", () => {
  test("an empty Disallow allows everything", () => {
    const robots = parseRobots("User-agent: *\nDisallow:", UA);
    expect(robots.isAllowed("/anything")).toBe(true);
  });

  test("applies the * group with longest match and wildcards", () => {
    const robots = parseRobots(
      ["User-agent: *", "Disallow: /admin", "Allow: /admin/public", "Disallow: /*.php$", "Crawl-delay: 2"].join("\n"),
      UA,
    );
    expect(robots.isAllowed("/admin/users")).toBe(false);
    expect(robots.isAllowed("/admin/public/page")).toBe(true);
    expect(robots.isAllowed("/index.php")).toBe(false);
    expect(robots.isAllowed("/index.php?x=1")).toBe(true);
    expect(robots.isAllowed("/events")).toBe(true);
    expect(robots.crawlDelay).toBe(2);
  });

  test("prefers a group that names our agent", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: site-crawler\nDisallow: /private", UA);
    expect(robots.isAllowed("/events")).toBe(true);
    expect(robots.isAllowed("/private/x")).toBe(false);
  });

  test("collects sitemap lines from anywhere in the file", () => {
    const robots = parseRobots("Sitemap: https://x.org/sitemap.xml\nUser-agent: *\nDisallow:", UA);
    expect(robots.sitemaps).toEqual(["https://x.org/sitemap.xml"]);
  });
});
