# Changelog

## Unreleased

- Added incremental crawls. A crawl into a folder with an earlier crawl of the same site sends `If-None-Match` and `If-Modified-Since`, keeps pages the server says are not modified, and leaves pages with the same text and links unwritten. It writes `changes/<time>/` with copies of the new and changed pages and a `changes.json` that lists new, changed, and removed pages and new and removed file URLs. `--fresh` ignores the earlier crawl. The report adds a "Changes since the last crawl" section.
- A second crawl requests every page the earlier crawl saved, even pages nothing links to anymore. Pages that no longer load are listed as removed. Pages that still load but lost every link are listed as unlinked, and the CLI, the report's findings table, and a "Pages no longer linked" table call them out.
- The manifest records each page's `ETag`.
- A page at `/changes` now saves to `changes_/index.html`, so no page lands in the changes folder.
- Added `prds/incremental-crawl.md`.

- Added `--render`. Each saved page also loads in a local headless Chrome over the DevTools Protocol, with no npm dependency. The manifest records the links in the rendered page and its frames, and every document or media file URL in the JSON the page's scripts fetched. The browser blocks images, fonts, media, and file downloads. Same-site links that only the rendered page has get crawled.
- Added the "Content loaded by JavaScript" report section. Every report flags pages with loading placeholders, widget scripts, cross-host frames, or API hosts in inline scripts. With `--render` it lists what render found per page.
- Added `prds/script-loaded-content.md`.

- Added the crawler CLI. `bun run crawl <url>` saves every HTML page on one site to `runs/<site name>/`, with a `manifest.json` of every URL fetched. It reads `robots.txt` and the sitemap, stays on the starting site, and skips file links.
- Added the site report. Each crawl writes `report.md` and `report.json` covering broken pages, redirects, thin, duplicate, orphan, and stale pages, click depth, search metadata, accessibility basics, mixed content, sitemap coverage, performance, linked files, and external links. `bun run report <dir>` rebuilds it without fetching.
- Added `--check-links`. After the crawl it checks every linked file and external page with a HEAD request, confirms errors with a 1-byte GET, and adds a "Broken files and external links" section to the report.
- Added the MIT license.
