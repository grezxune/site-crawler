# Site Crawler

Crawls every page on one website, saves each page's HTML to disk, and writes a report on the site's health: broken pages and links, redirects, thin and orphaned pages, search metadata, accessibility basics, and more.

It runs on [Bun](https://bun.sh) and has no runtime dependencies.

## Usage

```bash
bun install
bun run crawl https://example.org/
bun run crawl https://example.org/ --check-links
bun run crawl https://example.org/ --render
```

Output goes to `runs/<site name>/`. `example.org` saves to `runs/example/`. The `runs/` folder is gitignored.

To rebuild the report from a finished crawl without fetching anything:

```bash
bun run report runs/example
```

| Option | Default | What it does |
| --- | --- | --- |
| `--out <dir>` | `runs/<site name>` | Output folder |
| `--concurrency <n>` | `3` | Parallel requests |
| `--delay <ms>` | `250` | Pause per worker after each request. Raised to the site's `Crawl-delay` if larger. |
| `--max-pages <n>` | `5000` | Stop queueing new pages after this many |
| `--no-sitemap` | off | Skip seeding the crawl from the sitemap |
| `--ignore-robots` | off | Skip reading `robots.txt` |
| `--check-links` | off | After the crawl, check every linked file and external link |
| `--max-link-checks <n>` | `2000` | Most links to check |
| `--render` | off | Also load each page in a local headless Chrome and record the links and file URLs its scripts add |
| `--chrome <path>` | found automatically | Browser for `--render`. `CHROME_PATH` works too. |
| `--fresh` | off | Ignore an earlier crawl in the output folder. See [Crawling again](#crawling-again). |

## How it works

1. Reads `robots.txt` and skips any path it disallows.
2. Seeds the queue with the start URL and every page in the sitemap, so pages with no inbound links still get saved.
3. Fetches pages breadth-first and follows `a`, `area`, `frame`, and `iframe` links.
4. Stays on one site. `www.example.org` and `example.org` count as the same site. Redirects to other hosts are recorded and never followed.
5. Skips links to files such as PDFs, images, and stylesheets. Only `text/html` responses are saved.
6. With `--render`, loads each saved page in a local headless Chrome, Chromium, or Edge over the DevTools Protocol. See [Render mode](#render-mode).
7. With `--check-links`, sends one HEAD request to each linked file and external page after the crawl. Any error is confirmed with a 1-byte ranged GET, because some servers answer HEAD wrongly. No file is downloaded in full. Each host gets at most 2 requests at a time.

## Render mode

Many sites load their most useful content with JavaScript after the page arrives: meeting agendas from a vendor API, or a calendar in an iframe from another host. The server HTML holds only a "Loading..." placeholder, so a plain crawl cannot see it. Every report flags pages that show signs of this.

`--render` loads each page the crawl saves in a headless browser and records:

- every link in the rendered page and in its frames, including frames from other hosts
- every document or media file URL in the JSON the page's scripts fetched, with the API URL it came from
- the API calls and the hosts the page reached

A widget often fetches every record and shows ten, so render reads the JSON responses, not only the rendered list. Same-site pages that only the rendered page links to get crawled too. With `--check-links`, the files render found are checked as well.

Render needs Chrome, Chromium, or Edge installed. It uses no npm package. It starts the browser with a temporary profile and deletes the profile when the crawl ends. The page's own scripts may reach other hosts, as they would in any browser. The browser fails every request for images, fonts, media, and files such as PDFs before it leaves the machine, so render records file URLs and never downloads them. It adds about 2 to 4 seconds per page.

## Crawling again

Run the same command again to get only what changed. When the output folder already holds a crawl of the same site, the crawler compares against it:

1. It asks for each page with the `ETag` or `Last-Modified` from the last crawl. A page the server says is not modified keeps its saved copy and is not downloaded.
2. It requests every page the last crawl saved, even pages nothing links to anymore. That is how it tells a page that is gone from a page that only lost its links.
3. A page that comes back in full counts as changed only if its title, description, visible text, or links differ. A token or timestamp that differs on every request does not count, and the saved file is not rewritten.
4. It updates the output folder in place, then writes `changes/<time>/` with copies of the new and changed pages and a `changes.json`.

`changes.json` lists:

- new and changed pages, with their saved file
- removed pages, which no longer load, with the reason, such as `HTTP 404` or `redirects to https://example.org/b`
- unlinked pages, which still load but that no page or the sitemap links to anymore, so visitors cannot click to them
- new and removed file URLs, such as PDFs, with the pages they were found on, whether the HTML or render found them, and the API calls that named them

The CLI, the report's findings table, and the report's "Pages no longer linked" table call out unlinked pages apart from removed ones. A page linked only through a redirect still counts as linked. A page that was already unlinked in the last crawl is checked again but not listed again. The report's orphan pages section lists it.

Files are compared by URL, so none are downloaded. With `--render`, every page loads again even when its HTML did not change, because script-loaded lists such as meeting archives change while the page stays the same. If only one of the two crawls used `--render`, only files the server HTML links are compared, and no page is listed as unlinked, since render finds links the server HTML lacks.

When nothing changed, no changes folder is written. The report gets a "Changes since the last crawl" section. `--fresh` ignores the earlier crawl and fetches every page in full. A folder that holds another site's crawl stops the crawl before any request.

## Output

Each page becomes `<path>/index.html`, so a page and its child pages never collide.

```
runs/example/
  index.html                  https://example.org/
  about/index.html            https://example.org/about
  news/index.html             https://example.org/news
  news/spring-cleanup/index.html
  manifest.json
  report.md
  report.json
  changes/
    2026-11-02T15-04-05Z/     written by a later crawl
      changes.json
      news/index.html         a page that changed since the crawl before
```

URLs with a query string get a short hash in the file name, such as `news/index.257a9712.html`. No page is saved under `changes/`. A page at `/changes` saves to `changes_/index.html`.

`manifest.json` lists every URL the crawler fetched with its final URL, HTTP status, outcome, and saved file. Outcomes are `saved`, `not-html`, `http-error`, `offsite-redirect`, `duplicate`, and `failed`.

## Report

`report.md` is for reading. `report.json` holds the same findings with full lists. The report covers:

| Section | What it checks |
| --- | --- |
| Status | Homepage status and speed, HTTPS, HSTS, server, robots.txt, sitemap, totals |
| Changes since the last crawl | After a crawl into a folder with an earlier crawl: new, changed, and removed pages, pages that still load but lost every link, and new and removed files |
| Broken pages | 4xx, 5xx, and failed requests, with the pages that link to each |
| Content loaded by JavaScript | Pages with loading placeholders, widget scripts, cross-host frames, or API hosts in inline scripts. With `--render`: the files, links, and API calls render found on each page. |
| Broken files and external links | With `--check-links`: linked files and external pages that return an error or never answer, with the pages that link to each. Servers that refuse automated checks (401, 403, 429) are listed apart for a person to confirm. |
| Redirects | URLs that redirect, how many pages link to each, and whether the sitemap lists them |
| Possibly useless pages | Thin pages (under 50 words of their own), duplicate pages, placeholder text, orphan pages, and pages not updated in 2 years. Pages that are both thin and orphaned are listed first. |
| Click depth | Clicks from the homepage to each page, and pages no link path reaches |
| Search metadata | Missing or long titles, shared titles, missing descriptions, `<h1>` count, noindex, canonical, `lang` |
| Accessibility | Images without alt text and links that go nowhere |
| Mixed content | HTTP resources on HTTPS pages |
| Sitemap coverage | Sitemap entries that fail or redirect, and pages missing from the sitemap |
| Performance | Slowest and largest pages |
| Linked files and external links | Counts by type and host. Without `--check-links` their status is unknown. |

"Own words" excludes text that appears on at least half the pages, such as the menu, header, and footer. That is how the report tells a thin page from a page with a large template.

Without `--render`, the crawler does not run JavaScript. A page that loads its content with scripts or an iframe can look thin. The thin-page table shows frame and file-link counts to help spot these.

Pages removed from the site stay on disk until you delete them. The manifest and the report leave them out.

## Responsible use

The crawler reads `robots.txt`, honors `Crawl-delay`, waits between requests, and identifies itself as `site-crawler/0.1`. Render loads only pages the crawl itself fetches, one browser tab per worker. Keep those defaults when you crawl a site you do not run, and follow the site's terms.

## Development

```bash
bun run check
```

Runs the typecheck, lint, tests, and build.

## License

[MIT](LICENSE)
