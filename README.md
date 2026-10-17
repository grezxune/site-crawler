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
```

URLs with a query string get a short hash in the file name, such as `news/index.257a9712.html`.

`manifest.json` lists every URL the crawler fetched with its final URL, HTTP status, outcome, and saved file. Outcomes are `saved`, `not-html`, `http-error`, `offsite-redirect`, `duplicate`, and `failed`.

## Report

`report.md` is for reading. `report.json` holds the same findings with full lists. The report covers:

| Section | What it checks |
| --- | --- |
| Status | Homepage status and speed, HTTPS, HSTS, server, robots.txt, sitemap, totals |
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

Running a crawl again overwrites pages in place. Pages removed from the site stay on disk until you delete the folder.

## Responsible use

The crawler reads `robots.txt`, honors `Crawl-delay`, waits between requests, and identifies itself as `site-crawler/0.1`. Render loads only pages the crawl itself fetches, one browser tab per worker. Keep those defaults when you crawl a site you do not run, and follow the site's terms.

## Development

```bash
bun run check
```

Runs the typecheck, lint, tests, and build.

## License

[MIT](LICENSE)
