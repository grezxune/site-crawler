---
title: Script-loaded content
status: approved
---

## Problem
The crawler reads only the HTML a server sends. Many sites, municipal sites above all, load their most useful content with JavaScript after the page arrives. Meeting agendas, minutes, and event calendars come from a vendor API or a cross-host iframe. In a crawl of one such site, the meetings page HTML held only a "Loading..." placeholder, while a browser loaded about 270 meetings and 600 PDF links from the vendor's API. The crawl recorded none of them, and its report gave no sign they existed. Anyone using the report to inventory a site's documents gets an incomplete answer and no warning.

## Goals
- Every crawl warns about pages that likely load content it could not see. On the site above, the meetings and events pages are flagged without any extra flag.
- With `--render`, the manifest lists 100% of the file URLs found in the JSON responses the page's own scripts requested. On the site above, that means all ~600 meeting files.
- Render mode adds no npm dependency and under 5 seconds per page at the median.

## Non-goals
- Vendor adapters that read listing APIs directly (HeyGov, CivicPlus, Granicus/Legistar). They would find content without a browser, but each needs its own API knowledge. That work gets a later PRD.
- Following API pagination the page does not request. Render records what the page loads. If a widget shows 10 rows and fetches only 10, render sees only 10.
- Bundling or downloading a browser. Render uses a Chrome, Chromium, or Edge that is already installed.
- Running page scripts without a browser. A JS engine without a DOM breaks on real widgets.
- Downloading the files render finds. Render records file URLs, and `--check-links` can check them.

## Users and flows
A person auditing a site, often a municipal site, wants to know every document it publishes.

1. They run `bun run crawl https://example.org/`.
2. The report's "Content loaded by JavaScript" section lists pages with signs of script-loaded content and says why.
3. They run `bun run crawl https://example.org/ --render`.
4. The crawler loads each page in headless Chrome, records the links in the rendered page and the file URLs in the JSON the page fetched, and crawls any new same-site links.
5. The report lists, per page, the files and links render found and the API calls they came from. `--check-links` checks those files too.

## Requirements

### R1 (P0): Every crawl flags pages that likely load content it could not see
- Given a page whose own text includes a loading placeholder such as "Loading agendas and minutes...", when the report runs, then the page appears in "Content loaded by JavaScript" with that text as the reason.
- Given a page that loads a script from a known widget vendor, embeds a frame from another host, or has an inline script that names an API host, when the report runs, then the page appears with each reason.
- Given a placeholder that appears on most pages (template text), then it does not flag every page.
- The check reads only saved HTML, so `bun run report` produces it offline.

### R2 (P0): `--render` loads each crawled page in a local Chrome
- Given Chrome, Chromium, or Edge is installed, when the crawl runs with `--render`, then the crawler starts it headless with a throwaway profile, drives it over the DevTools Protocol through Bun's built-in WebSocket, and closes it and deletes the profile when the crawl ends, fails, or is interrupted.
- Given no browser is found, then the crawl stops before fetching anything and says how to point at one with `--chrome <path>` or `CHROME_PATH`.
- Given a page fails to render or times out after 20 seconds, then its manifest entry records the error and the crawl continues.

### R3 (P0): Render records links from the rendered page and files from fetched JSON
- Given a page's scripts add links to the DOM, then the manifest records each link, absolute and deduplicated.
- Given a page's scripts fetch JSON with XHR or fetch, including from a cross-host iframe, then every document or media file URL in that JSON (PDF, Office, CSV, image, audio, video) is recorded once, with the API URL it came from.
- Given the meetings page above, then the manifest lists all ~600 meeting files, not only the rows the page displays.

### R4 (P0): The report shows what render found
- Given a crawl with `--render`, then "Content loaded by JavaScript" lists, per page, the files and new links render found and the API endpoints it saw, with totals by file type and host.
- Then "Linked files" counts files found by render, and `--check-links` checks them.

### R5 (P0): Render stays polite and records instead of fetching files
- Render loads only pages the crawl itself would fetch: same site, allowed by robots.txt, within `--max-pages`.
- The browser never requests images, fonts, media, or file links such as PDFs. It fails those requests before they leave the machine.
- Render uses at most one browser tab per crawl worker and keeps the crawl's delay between pages.

### R6 (P1): Same-site links found by render get crawled
- Given the rendered DOM links to a same-site page the server HTML did not, then the crawler queues it and the click-depth and orphan checks count that link.

## Constraints
- Security: rendered pages run untrusted scripts. The browser keeps its sandbox on, uses a fresh temporary profile with no cookies or saved logins, and never receives credentials. The crawler never evaluates page-supplied code in its own process. JSON bodies are parsed as data only.
- Requests to other hosts: render mode lets each page's own scripts reach the hosts a browser would reach, such as script CDNs and vendor APIs. The `AGENTS.md` rules allow this only under `--render`.
- Size: the manifest stores at most 5,000 files and 2,000 links per page and records when it truncates.
- The repo is public. Tests use example.org-style fixtures and never name a crawled site.

## Decisions
- 2026-10-17: Drive Chrome over the DevTools Protocol with Bun's WebSocket instead of Puppeteer or Playwright. It keeps the project free of runtime dependencies, and the crawler needs only about ten protocol commands.
- 2026-10-17: Read file URLs from JSON responses, not only the rendered DOM. Widgets often fetch every record and show a page of them. A test render of the site above found about 600 files in the API responses and 166 in the DOM.
- 2026-10-17: Attach to cross-host iframe targets so their API calls are captured. A test render of an events page caught the calendar iframe's month-by-month API calls this way.
- 2026-10-17: The project owner approved the `AGENTS.md` rule change. A page's own scripts may reach other hosts under `--render`. The crawler never points the browser at another host, and the browser blocks images, fonts, media, and file links.
- 2026-10-17: Render records file URLs and never downloads them. The project owner chose record only.
