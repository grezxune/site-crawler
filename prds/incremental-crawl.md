---
title: Incremental crawl
status: approved
---

## Problem
People crawl a site again to find what changed since the last crawl. Today a second crawl downloads every page again, overwrites the folder, and says nothing about what is new. On a municipal site with about 30 pages and 650 meeting documents, the person importing the site into a rebuild has to compare two crawls by hand to find the new agendas, minutes, and page edits. Anything they miss is missing from the new site at launch.

## Goals
- A second crawl of an unchanged site downloads no page bodies from servers that answer conditional requests, and rewrites no page files.
- One `changes.json` lists every page that is new, changed, removed, or no longer linked, and every document URL that is new or removed since the last crawl. One folder holds copies of the new and changed pages.
- A second crawl with `--render` does no more work than the first, apart from one request and one render for each earlier page that nothing links to anymore.

## Non-goals
- Downloading documents. The crawler records document URLs and never downloads them, as decided in `prds/script-loaded-content.md`. The delta lists the new URLs, and the import downloads those.
- Finding changes inside a document whose URL stays the same. That needs a download. A file replaced at a new URL shows up as one new and one removed.
- Skipping render on unchanged pages. Script-loaded content changes while the page HTML stays the same, so render loads every page on every crawl.
- Deleting removed pages from disk. They stay, as today, and `changes.json` lists them.
- Keeping a full copy of every past crawl. The output folder holds the latest crawl, and each changes folder holds only what changed.

## Users and flows
A person keeping a site import current, often for a municipal rebuild, wants only what is new since their last crawl.

1. They run `bun run crawl https://example.org/ --render`. The crawl saves every page to `runs/example/`.
2. Weeks later they run the same command.
3. The crawler reads `runs/example/manifest.json` and asks the server for each page only if it changed since then. It checks every page the last crawl saved, even ones no page links to anymore.
4. It updates `runs/example/` in place and writes `runs/example/changes/<time>/` with the new and changed pages and `changes.json`.
5. The CLI prints how many pages are new, changed, unchanged, removed, and still live but no longer linked, how many documents are new and removed, and the changes folder.
6. They feed `changes.json` to their import, which downloads only the new documents. They decide whether each page that lost its links should be linked again, redirected, or left out of the rebuild.

## Requirements

### R1 (P0): A crawl into a folder with an earlier crawl compares against it
- Given `runs/example/manifest.json` exists for the same site, when the crawl runs, then it compares against that crawl with no extra flag.
- Given `--fresh`, then the crawl ignores the earlier crawl, fetches every page in full, and writes no changes folder.
- Given the folder holds a crawl of another site, then the crawl stops before any request and names that site.
- Given no earlier crawl, then the crawl behaves as before.

### R2 (P0): Unchanged pages are not downloaded again or rewritten
- Given the earlier crawl recorded an `ETag` or `Last-Modified` for a page, then the request sends `If-None-Match` or `If-Modified-Since`.
- Given the server answers 304, then the crawler keeps the saved file, reads its links from disk, and marks the page unchanged.
- Given the server answers 200 with the same title, description, text, and links as the saved copy, then the page is unchanged, the saved file is not rewritten, and it is not copied to the changes folder.
- Unchanged pages keep the file path they had.

### R3 (P0): New and changed pages are copied to a changes folder
- Given at least one page or document changed, then the crawl writes `changes/<time>/` inside the output folder, with each new and changed page at the same relative path it has in the output folder.
- Then `changes/<time>/changes.json` lists the new, changed, and removed pages with their URL and file, and counts the unchanged pages.
- Given a removed page, then its entry says why: an HTTP error, a redirect, a failed request, robots.txt, or the page limit.
- Given nothing changed, then no changes folder is written and the CLI says so.

### R4 (P0): New document URLs are listed
- Given a file URL appears in this crawl and not the earlier one, then `changes.json` lists it with the pages it was found on, whether the HTML or render found it, and the API URLs that named it. Files are the ones the report's "Linked files" section counts: PDFs, Office files, images, and the like.
- Given a file URL from the earlier crawl is gone, then `changes.json` lists it as removed.
- Given only one of the two crawls used `--render`, then only files the HTML links are compared, and `changes.json` says so. Files only render found are never reported removed because render was off.
- No file is requested to build the list.

### R5 (P1): The report shows changes since the last crawl
- Given a crawl that compared against an earlier one, then `report.md` has a "Changes since the last crawl" section with the counts, the new, changed, and removed pages, and the new and removed files.
- `bun run report` rebuilds it offline from `manifest.json`.

### R6 (P0): A second crawl re-checks every earlier page and calls out pages no page links to anymore
- Given a page the earlier crawl saved, when no page or the sitemap links to it now, then the crawl still requests it, with the same conditional headers, robots.txt rules, and page limit as any page.
- Given that page still loads, then it is not reported removed. `changes.json` lists it under `unlinked`, apart from removed pages.
- Given that page no longer loads, then it is reported removed with the reason, such as `HTTP 404`.
- A page counts as linked when a saved page links to it, directly or through a redirect, when the sitemap lists it, or when it is the start page.
- Given a page that was already unlinked in the earlier crawl, then it is not listed again. The report's orphan pages section covers it.
- Given only one of the two crawls used `--render`, then no page is listed as unlinked, since render finds links the server HTML lacks.
- Then the CLI summary, the report's "Changes since the last crawl" section, and the report's findings table each show the unlinked pages apart from removed pages.

## Constraints
- Requests to other hosts: none added. The document lists come from URLs the crawl already records. Conditional requests go only to the crawled site.
- Politeness: a 304 has no body, so a second crawl sends less data. The delay, robots.txt, and concurrency rules do not change.
- Paths: a page whose first path segment is `changes` would land inside the changes folders. `urlToFilePath` renames that segment, and the tests check it.
- Untrusted input: the earlier manifest could be edited by hand. A saved file path from it is used only when it is relative and has no `..` segment, so reads and writes stay inside the output folder. Tests cover a path that tries to escape. ETag and Last-Modified values are sent only when they are printable ASCII.
- The repo is public. Tests use local fixtures and never name a crawled site.

## Decisions
- 2026-11-02: Documents are listed, not downloaded. The project owner kept the record-only rule. The import downloads the new URLs.
- 2026-11-02: The output folder stays a full copy of the latest crawl, and each second crawl adds `changes/<time>/` with only the delta. The report needs the full copy, and the import needs only the delta. The project owner chose this layout.
- 2026-11-02: A crawl compares against the earlier one by default, and `--fresh` opts out. A 304 or a matching page can only save work, so there is little reason to opt in.
- 2026-11-02: Pages are compared on title, description, visible text, `<base>`, and links, not raw bytes. Many CMS pages change a token, a cache-busting query string, or a timestamp on every request, which would mark every page changed.
- 2026-11-02: A second crawl re-checks every page the earlier crawl saved (R6). On the municipal site, a test run reported 8 pages removed because nothing linked to them. Seven were past event pages that dropped off the events widget and likely still load. The project owner asked to tell "gone" apart from "no longer linked", and to call out the second kind.
- 2026-11-02: Re-checked pages are rendered like any other page, so files found on them stay comparable. The project owner kept this over a faster crawl. On the municipal site, a second crawl took 67 seconds against 49 for the first. About 11 seconds came from rendering 9 re-checked pages, and the rest from slower page loads that day. The goal above changed from "no longer than the first" to match.
- 2026-11-02: Render still loads every page. On the municipal site in `prds/script-loaded-content.md`, the meetings page HTML stays the same while the vendor API adds meetings.
